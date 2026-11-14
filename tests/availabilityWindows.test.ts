import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { makeCtx } from './helpers';
import {
  parseRange, parseTarget, resolveDay, buildFreeIntervals, addWindow, setWindow, clearDate, copyWeek, loadWindows, wallToMs, showWeek,
  type WindowRow,
} from '../src/schedule/availabilityWindows';

const TZ = 'America/Detroit';
const row = (o: Partial<WindowRow> & { start: string; end: string }): WindowRow => ({ date: null, weekday: null, kind: 'free', ...o });
const hm = (ms: number) => DateTime.fromMillis(ms, { zone: TZ }).toFormat('HH:mm');
const spans = (iv: { start: number; end: number }[]) => iv.map((i) => `${hm(i.start)}-${hm(i.end)}`);

describe('parsing', () => {
  it('parses ranges, targets and rejects nonsense', () => {
    expect(parseRange('9:00-12:30')).toEqual({ start: '09:00', end: '12:30' });
    expect(parseRange('18:00-24:00')).toEqual({ start: '18:00', end: '24:00' });
    expect(() => parseRange('12:00-09:00')).toThrow(/after the start/);
    expect(() => parseRange('25:00-26:00')).toThrow(/valid 24-hour/);
    expect(() => parseRange('noon')).toThrow(/time range/);
    expect(parseTarget('2026-11-14')).toEqual({ date: '2026-11-14' });
    expect(parseTarget('Thu')).toEqual({ weekday: 4 });
    expect(parseTarget('sunday')).toEqual({ weekday: 7 });
    expect(() => parseTarget('2026-13-45')).toThrow();
  });
});

describe('precedence', () => {
  const rows: WindowRow[] = [
    row({ weekday: 1, start: '09:00', end: '17:00' }), // Mondays
    row({ date: '2026-11-16', start: '13:00', end: '15:00' }), // Mon Nov 16 has its own windows
  ];
  it('the template applies when a date has no windows of its own', () => {
    const d = resolveDay(rows, '2026-11-09', TZ);
    expect(d.source).toBe('template');
    expect(spans(d.free)).toEqual(['09:00-17:00']);
  });
  it('any per-date window fully replaces the template for that date', () => {
    const d = resolveDay(rows, '2026-11-16', TZ);
    expect(d.source).toBe('date');
    expect(spans(d.free)).toEqual(['13:00-15:00']);
  });
  it('a date with only blocked windows has no free time (the template is still replaced)', () => {
    const d = resolveDay([...rows, row({ date: '2026-11-23', start: '00:00', end: '24:00', kind: 'blocked' }), row({ weekday: 1, start: '09:00', end: '17:00' })], '2026-11-23', TZ);
    expect(d.free).toEqual([]);
  });
  it('a day with nothing set reports none', () => {
    expect(resolveDay(rows, '2026-11-10', TZ)).toMatchObject({ source: 'none', free: [] });
  });
});

describe('overlap merging and blocked windows', () => {
  it('overlapping and touching free windows merge; blocked wins over free', () => {
    const rs = [
      row({ weekday: 2, start: '09:00', end: '12:00' }),
      row({ weekday: 2, start: '11:00', end: '14:00' }),
      row({ weekday: 2, start: '14:00', end: '16:00' }),
      row({ weekday: 2, start: '10:00', end: '10:30', kind: 'blocked' }),
    ];
    expect(spans(resolveDay(rs, '2026-11-10', TZ).free)).toEqual(['09:00-10:00', '10:30-16:00']);
  });
  it('addWindow: same kind merges, the newest edit wins against the opposite kind', () => {
    let w = addWindow([], row({ weekday: 1, start: '09:00', end: '12:00' }));
    w = addWindow(w, row({ weekday: 1, start: '11:00', end: '13:00' }));
    expect(w.map((r) => `${r.start}-${r.end}`)).toEqual(['09:00-13:00']);
    w = addWindow(w, row({ weekday: 1, start: '10:00', end: '11:00', kind: 'blocked' }));
    expect(w.map((r) => `${r.start}-${r.end} ${r.kind}`)).toEqual(['09:00-10:00 free', '10:00-11:00 blocked', '11:00-13:00 free']);
    w = addWindow(w, row({ weekday: 1, start: '09:30', end: '10:30', kind: 'free' })); // paint free over part of the blocked window
    expect(w.map((r) => `${r.start}-${r.end} ${r.kind}`)).toEqual(['09:00-10:30 free', '10:30-11:00 blocked', '11:00-13:00 free']);
    const free = resolveDay(w.map((r) => ({ ...r, date: '2026-11-09' })), '2026-11-09', TZ).free;
    expect(spans(free)).toEqual(['09:00-10:30', '11:00-13:00']);
  });
});

describe('free time minus busy time', () => {
  it('subtracts busy events, clips to now, and drops pieces shorter than the minimum block', () => {
    const rows = [row({ weekday: 1, start: '09:00', end: '17:00' })];
    const mon = (h: string) => wallToMs('2026-11-09', h, TZ);
    const free = buildFreeIntervals(rows, mon('10:00'), mon('23:00'), TZ, [{ start: mon('12:00'), end: mon('16:50') }], 15);
    expect(spans(free)).toEqual(['10:00-12:00']); // 16:50-17:00 is only 10 min
  });
});

describe('DST', () => {
  it('spring forward (Mar 14 2027): a 00:00-24:00 window is 23 hours; 09:00 stays 09:00 local', () => {
    const rows = [row({ date: '2027-03-14', start: '00:00', end: '24:00' }), row({ date: '2027-03-15', start: '09:00', end: '10:00' })];
    const d = resolveDay(rows, '2027-03-14', TZ);
    expect((d.free[0].end - d.free[0].start) / 3_600_000).toBe(23);
    expect(hm(resolveDay(rows, '2027-03-15', TZ).free[0].start)).toBe('09:00');
  });
  it('fall back (Nov 1 2026): a 00:00-24:00 window is 25 hours', () => {
    const d = resolveDay([row({ date: '2026-11-01', start: '00:00', end: '24:00' })], '2026-11-01', TZ);
    expect((d.free[0].end - d.free[0].start) / 3_600_000).toBe(25);
  });
  it('a window inside the skipped hour (02:30-03:30 on Mar 14 2027) collapses to a real, non-negative span', () => {
    const d = resolveDay([row({ date: '2027-03-14', start: '02:30', end: '03:30' })], '2027-03-14', TZ);
    expect(d.free.every((w) => w.end > w.start)).toBe(true);
  });
  it('the same weekday template gives the same local times on both sides of a DST change', () => {
    const rows = [row({ weekday: 7, start: '13:00', end: '22:30' })];
    expect(spans(resolveDay(rows, '2026-10-25', TZ).free)).toEqual(['13:00-22:30']); // before fall back
    expect(spans(resolveDay(rows, '2026-11-01', TZ).free)).toEqual(['13:00-22:30']); // the fall-back day itself
    expect(spans(resolveDay(rows, '2026-11-08', TZ).free)).toEqual(['13:00-22:30']); // after
  });
});

describe('stored windows', () => {
  it('setWindow on a date copies the template first so blocking an hour keeps the rest of the day', () => {
    const ctx = makeCtx();
    setWindow(ctx, { weekday: 1 }, { start: '09:00', end: '17:00' }, 'free');
    const r = setWindow(ctx, { date: '2026-11-09' }, { start: '12:00', end: '13:00' }, 'blocked');
    expect(r.materialized).toBe(true);
    expect(spans(resolveDay(loadWindows(ctx), '2026-11-09', ctx.tz).free)).toEqual(['09:00-12:00', '13:00-17:00']);
    expect(resolveDay(loadWindows(ctx), '2026-11-16', ctx.tz).source).toBe('template');
  });
  it('clearDate returns a date to the template; copyWeek copies effective windows (template or dated)', () => {
    const ctx = makeCtx();
    setWindow(ctx, { weekday: 1 }, { start: '09:00', end: '17:00' }, 'free');
    setWindow(ctx, { weekday: 3 }, { start: '10:00', end: '12:00' }, 'free');
    setWindow(ctx, { date: '2026-11-11' }, { start: '14:00', end: '15:00' }, 'free'); // Wed Nov 11 differs
    const out = copyWeek(ctx, '2026-11-09', '2026-11-23');
    expect(out.days).toBe(2);
    const rows = loadWindows(ctx);
    expect(spans(resolveDay(rows, '2026-11-23', ctx.tz).free)).toEqual(['09:00-17:00']);
    expect(resolveDay(rows, '2026-11-23', ctx.tz).source).toBe('date');
    expect(spans(resolveDay(rows, '2026-11-25', ctx.tz).free)).toEqual(['10:00-12:00', '14:00-15:00']);
    expect(clearDate(ctx, '2026-11-23')).toBeGreaterThan(0);
    expect(resolveDay(loadWindows(ctx), '2026-11-23', ctx.tz).source).toBe('template');
    expect(showWeek(ctx, '2026-11-23')[0]).toMatch(/weekly template/);
  });
});

describe('paint-erase and undo', () => {
  it('erase cuts free time without adding a blocked window, copies the template first, and can be undone exactly', async () => {
    const { eraseWindow, targetRows, restoreRows } = await import('../src/schedule/availabilityWindows');
    const ctx = makeCtx();
    setWindow(ctx, { weekday: 1 }, { start: '09:00', end: '17:00' }, 'free');
    const before = targetRows(ctx, { date: '2026-11-09' });
    expect(before).toEqual([]);
    const r = eraseWindow(ctx, { date: '2026-11-09' }, { start: '12:00', end: '13:30' });
    expect(r.materialized).toBe(true);
    const rows = loadWindows(ctx).filter((x) => x.date === '2026-11-09');
    expect(rows.map((x) => `${x.start}-${x.end} ${x.kind}`)).toEqual(['09:00-12:00 free', '13:30-17:00 free']);
    expect(resolveDay(loadWindows(ctx), '2026-11-16', ctx.tz).source).toBe('template'); // other Mondays untouched
    restoreRows(ctx, { date: '2026-11-09' }, before);
    expect(resolveDay(loadWindows(ctx), '2026-11-09', ctx.tz).source).toBe('template'); // undo = back to the template
  });
  it('erasing on the weekly template changes every such weekday; painting then erasing the same range round-trips', async () => {
    const { eraseWindow } = await import('../src/schedule/availabilityWindows');
    const ctx = makeCtx();
    setWindow(ctx, { weekday: 3 }, { start: '10:00', end: '12:00' }, 'free');
    eraseWindow(ctx, { weekday: 3 }, { start: '10:30', end: '11:00' });
    expect(spans(resolveDay(loadWindows(ctx), '2026-11-11', ctx.tz).free)).toEqual(['10:00-10:30', '11:00-12:00']);
    setWindow(ctx, { weekday: 3 }, { start: '10:30', end: '11:00' }, 'free');
    expect(spans(resolveDay(loadWindows(ctx), '2026-11-11', ctx.tz).free)).toEqual(['10:00-12:00']);
  });
});
