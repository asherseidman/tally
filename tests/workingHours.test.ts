import { describe, it, expect } from 'vitest';
import { parseWorkingHours, resolveWorkingHours, DEFAULT_WORKING_HOURS, parseOverrides, migrateLegacyHours } from '../src/schedule/workingHours';
import { routineJson } from './helpers';

describe('working hours schema', () => {
  it('accepts the proposed routine file and fills defaults', () => {
    const r = parseWorkingHours(routineJson());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.min_block_minutes).toBe(15);
    expect(r.data.max_block_minutes).toBe(120);
    expect(r.data.buffer_minutes).toBe(10);
    expect(r.data.deadline_slack_minutes).toBe(120);
    expect(r.data.days.mon.start).toBe('after_first_class');
    expect(r.data.days.sat.start).toBeUndefined(); // falls back to default_start
    expect(r.data.days.wed.unavailable).toEqual([{ start: '16:00', end: '17:00', label: 'gym' }]);
    expect(r.data.days.fri.unavailable).toEqual([]);
  });
  it('encodes the stated routine: weekday latest ends, Saturday stricter than Thu/Fri', () => {
    const d = (parseWorkingHours(routineJson()) as any).data.days;
    expect(['mon', 'tue', 'wed', 'sun'].map((k) => d[k].end)).toEqual(['22:30', '22:30', '22:30', '22:30']);
    expect(['thu', 'fri'].map((k) => d[k].end)).toEqual(['20:30', '20:30']);
    expect(d.sat.end).toBe('20:00');
    expect(d.sun.start).toBe('13:00');
  });
  it('built-in default is valid and needs no calendar', () => {
    const r = parseWorkingHours(DEFAULT_WORKING_HOURS);
    expect(r.ok).toBe(true);
    expect(Object.values(DEFAULT_WORKING_HOURS.days).some((d: any) => d.start === 'after_first_class')).toBe(false);
  });
  it('reports readable errors naming the field', () => {
    const bad = routineJson();
    bad.days.mon.end = '25:00';
    bad.days.tue.unavailable[0].end = '08:00'; // before its start
    bad.buffer_minutes = 500;
    delete bad.days.fri;
    const r = parseWorkingHours(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.join('\n');
    expect(text).toMatch(/days\.mon\.end/);
    expect(text).toMatch(/days\.tue\.unavailable\[0\]/);
    expect(text).toMatch(/buffer_minutes/);
    expect(text).toMatch(/days\.fri/);
  });
  it('rejects a minimum block longer than the maximum', () => {
    const bad = routineJson();
    bad.min_block_minutes = 200;
    const r = parseWorkingHours(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/min_block_minutes.*max_block_minutes/);
  });
  it('rejects non-objects and end before start', () => {
    expect(parseWorkingHours('x').ok).toBe(false);
    const bad = routineJson();
    bad.days.sun.start = '23:00';
    expect(parseWorkingHours(bad).ok).toBe(false);
  });
  it('per-term override merges over global, day by day', () => {
    const g = (parseWorkingHours(routineJson()) as any).data;
    const merged = resolveWorkingHours(g, { max_block_minutes: 90, days: { sun: { start: '10:00', end: '21:00' } } });
    expect(merged.max_block_minutes).toBe(90);
    expect(merged.min_block_minutes).toBe(15);
    expect(merged.days.sun.start).toBe('10:00');
    expect(merged.days.sun.end).toBe('21:00');
    expect(merged.days.mon.end).toBe('22:30');
    expect(() => resolveWorkingHours(g, { max_block_minutes: 5 })).toThrow(/min_block/);
  });
});

describe('new scheduling defaults', () => {
  it('class detection, lead time, long-task and spreading rules default to the agreed values', () => {
    const d = (parseWorkingHours(routineJson()) as any).data;
    expect(d.min_class_minutes).toBe(45);
    expect(d.min_lead_minutes).toBe(30);
    expect([d.long_task_minutes, d.long_task_min_block_minutes]).toEqual([60, 30]);
    expect([d.spread_threshold_minutes, d.spread_daily_max_minutes, d.spread_days_before_deadline]).toEqual([240, 120, 1]);
    expect([d.exam_prep_end_before_minutes, d.exam_prep_daily_max_minutes]).toEqual([120, 180]);
  });
  it('validates the exam prep settings', () => {
    const bad = routineJson();
    bad.exam_prep_daily_max_minutes = 5;
    bad.exam_prep_end_before_minutes = -1;
    const r = parseWorkingHours(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/exam_prep_daily_max_minutes[\s\S]*exam_prep_end_before_minutes|exam_prep_end_before_minutes[\s\S]*exam_prep_daily_max_minutes/);
  });
  it('rejects the old rule name with a message that says how to fix it', () => {
    const bad = routineJson();
    bad.days.mon.start = 'after_last_class';
    const r = parseWorkingHours(bad);
    expect(r.ok).toBe(false);
  });
});

describe('legacy migration (after_last_class -> after_first_class)', () => {
  it('renames the rule in days, term overrides and per-date overrides, and reports a change', () => {
    const old = { ...routineJson(), days: { ...routineJson().days, mon: { start: 'after_last_class', end: '22:30' } } };
    const m = migrateLegacyHours(old);
    expect(m.changed).toBe(true);
    expect((m.data as any).days.mon.start).toBe('after_first_class');
    const ov = migrateLegacyHours({ '2026-11-14': { start: 'after_last_class' } });
    expect(ov.changed).toBe(true);
    expect((ov.data as any)['2026-11-14'].start).toBe('after_first_class');
  });
  it('leaves current data alone and is idempotent', () => {
    const cur = routineJson();
    expect(migrateLegacyHours(cur).changed).toBe(false);
    const once = migrateLegacyHours({ days: { mon: { start: 'after_last_class', end: '22:00' } } });
    expect(migrateLegacyHours(once.data).changed).toBe(false);
  });
  it('does not touch unrelated strings', () => {
    const m = migrateLegacyHours({ days: { sat: { end: '20:00', unavailable: [{ start: '11:00', end: '13:00', label: 'after_last_class gym?' }] } } });
    expect(m.changed).toBe(false);
  });
});

describe('per-date overrides', () => {
  it('parses unavailable days, partial hours and labels', () => {
    const r = parseOverrides({
      '2026-11-14': { unavailable: true, label: 'game day' },
      '2026-11-16': { start: '12:00', end: '18:00', unavailable_windows: [{ start: '14:00', end: '15:00' }] },
    });
    expect(r.ok).toBe(true);
  });
  it('rejects bad dates and times with a readable message', () => {
    const r = parseOverrides({ 'next friday': { unavailable: true }, '2026-11-15': { start: '9am' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/next friday|2026-11-15/);
  });
  it('empty is fine', () => expect(parseOverrides({}).ok).toBe(true));
});
