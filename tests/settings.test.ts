import { describe, it, expect } from 'vitest';
import { makeCtx, routineJson } from './helpers';
import { loadWorkingHours, loadOverrides } from '../src/schedule/settings';
import { createTerm } from '../src/core/terms';
import { getSetting } from '../src/db/repo';

const legacy = () => {
  const j = routineJson();
  for (const k of ['mon', 'tue', 'wed', 'thu', 'fri']) j.days[k].start = 'after_last_class';
  return j;
};

describe('saved settings migration', () => {
  it('upgrades saved working hours from after_last_class to after_first_class and persists the change', () => {
    const ctx = makeCtx();
    ctx.db.run("INSERT INTO settings(key,value) VALUES('working_hours', ?)", [JSON.stringify(legacy())]);
    const { hours } = loadWorkingHours(ctx);
    expect(hours.days.mon.start).toBe('after_first_class');
    expect(hours.days.fri.start).toBe('after_first_class');
    const raw = getSetting(ctx.db, 'working_hours')!;
    expect(raw).not.toContain('after_last_class');
    expect(raw).toContain('after_first_class');
  });
  it('upgrades a per-term override and per-date overrides too', () => {
    const ctx = makeCtx();
    const t = createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
    ctx.db.run("INSERT INTO settings(key,value) VALUES('working_hours', ?)", [JSON.stringify(routineJson())]);
    ctx.db.run('INSERT INTO settings(key,value) VALUES(?, ?)', [`working_hours.term.${t.id}`, JSON.stringify({ days: { sat: { start: 'after_last_class', end: '20:00' } } })]);
    ctx.db.run("INSERT INTO settings(key,value) VALUES('schedule_overrides', ?)", [JSON.stringify({ '2026-11-14': { start: 'after_last_class' } })]);
    expect(loadWorkingHours(ctx, t.id).hours.days.sat.start).toBe('after_first_class');
    expect(loadOverrides(ctx)['2026-11-14'].start).toBe('after_first_class');
    expect(getSetting(ctx.db, `working_hours.term.${t.id}`)).not.toContain('after_last_class');
    expect(getSetting(ctx.db, 'schedule_overrides')).not.toContain('after_last_class');
  });
  it('current settings are left untouched', () => {
    const ctx = makeCtx();
    const before = JSON.stringify(routineJson());
    ctx.db.run("INSERT INTO settings(key,value) VALUES('working_hours', ?)", [before]);
    loadWorkingHours(ctx);
    expect(getSetting(ctx.db, 'working_hours')).toBe(before);
  });
});

import { addAwayWindow, addAway, removeAway } from '../src/schedule/settings';

describe('per-date blocked time windows', () => {
  it('stores a window for one date without making the whole day unavailable', () => {
    const ctx = makeCtx();
    addAwayWindow(ctx, '2026-11-09', '16:00', '18:00', 'before midterm');
    const o = loadOverrides(ctx)['2026-11-09'];
    expect(o.unavailable).toBeFalsy();
    expect(o.unavailable_windows).toEqual([{ start: '16:00', end: '18:00', label: 'before midterm' }]);
  });
  it('several windows on one date accumulate; the whole-day flag and windows coexist', () => {
    const ctx = makeCtx();
    addAwayWindow(ctx, '2026-11-09', '09:00', '10:00');
    addAwayWindow(ctx, '2026-11-09', '16:00', '18:00');
    expect(loadOverrides(ctx)['2026-11-09'].unavailable_windows).toHaveLength(2);
    addAway(ctx, '2026-11-09', 'sick');
    expect(loadOverrides(ctx)['2026-11-09']).toMatchObject({ unavailable: true, label: 'sick' });
    expect(loadOverrides(ctx)['2026-11-09'].unavailable_windows).toHaveLength(2);
  });
  it('rejects bad times and end-before-start', () => {
    const ctx = makeCtx();
    expect(() => addAwayWindow(ctx, '2026-11-09', '4pm', '18:00')).toThrow(/HH:mm/);
    expect(() => addAwayWindow(ctx, '2026-11-09', '18:00', '16:00')).toThrow(/after/);
    expect(() => addAwayWindow(ctx, 'tomorrow', '16:00', '18:00')).toThrow(/date/);
  });
  it('away rm removes the date, windows included', () => {
    const ctx = makeCtx();
    addAwayWindow(ctx, '2026-11-09', '16:00', '18:00');
    expect(removeAway(ctx, '2026-11-09')).toBe(true);
    expect(loadOverrides(ctx)['2026-11-09']).toBeUndefined();
  });
});
