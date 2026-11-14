import { describe, it, expect } from 'vitest';
import { buildAvailability, classifyDay, firstClass, type ClassRules } from '../src/schedule/availability';
import { parseWorkingHours } from '../src/schedule/workingHours';
import { routineJson, loc, iv, fmt, TZ } from './helpers';

const hours = (parseWorkingHours(routineJson()) as any).data;
const win = (from: string, to: string, extra: any = {}) =>
  buildAvailability({ fromMs: loc(from), toMs: loc(to), tz: TZ, hours, overrides: {}, busy: [], classBusy: [], ...extra });
const show = (ws: { start: number; end: number }[]) => ws.map((w) => `${fmt(w.start)}..${fmt(w.end)}`);

// Week of Mon Nov 9 2026
describe('daily rules from the routine', () => {
  it('weekday starts when the FIRST class ends (no work before class), and gaps between later classes are usable', () => {
    const classes = [iv('2026-11-09T10:00', '2026-11-09T11:00'), iv('2026-11-09T13:00', '2026-11-09T14:30')];
    const w = win('2026-11-09T00:00', '2026-11-10T00:00', { classBusy: classes, busy: classes });
    expect(show(w)).toEqual(['2026-11-09T11:00..2026-11-09T13:00', '2026-11-09T14:30..2026-11-09T22:30']);
  });
  it('non-class busy time is subtracted but does not move the start', () => {
    const classes = [iv('2026-11-09T13:00', '2026-11-09T14:30')];
    const dentist = iv('2026-11-09T16:00', '2026-11-09T17:00');
    const w = win('2026-11-09T00:00', '2026-11-10T00:00', { classBusy: classes, busy: [...classes, dentist] });
    expect(show(w)).toEqual(['2026-11-09T14:30..2026-11-09T16:00', '2026-11-09T17:00..2026-11-09T22:30']);
  });
  it('the Tue/Thu gym block that also shows as busy on the class calendar is NOT a class', () => {
    const gym = iv('2026-11-10T08:30', '2026-11-10T10:30');
    const cls = iv('2026-11-10T11:30', '2026-11-10T14:30');
    // with a real class after the gym: start = end of that class, not of the gym
    expect(show(win('2026-11-10T00:00', '2026-11-11T00:00', { classBusy: [gym, cls], busy: [gym, cls] }))).toEqual(['2026-11-10T14:30..2026-11-10T22:30']);
    // gym only: no class that day, so the default 9:00 start (gym window then removes until 10:30)
    expect(show(win('2026-11-10T00:00', '2026-11-11T00:00', { classBusy: [gym], busy: [gym] }))).toEqual(['2026-11-10T10:30..2026-11-10T22:30']);
  });
  it('busy blocks shorter than 45 minutes are not classes (but still block that time)', () => {
    const short = iv('2026-11-09T12:30', '2026-11-09T13:00'); // 30 min
    expect(show(win('2026-11-09T00:00', '2026-11-10T00:00', { classBusy: [short], busy: [short] }))).toEqual(['2026-11-09T09:00..2026-11-09T12:30', '2026-11-09T13:00..2026-11-09T22:30']);
    const exactly45 = iv('2026-11-09T12:00', '2026-11-09T12:45');
    expect(show(win('2026-11-09T00:00', '2026-11-10T00:00', { classBusy: [exactly45], busy: [exactly45] }))[0]).toBe('2026-11-09T12:45..2026-11-09T22:30');
  });
  it('a weekday with no class starts at default_start, and Tue gym 8:30-10:30 is unavailable', () => {
    expect(show(win('2026-11-10T00:00', '2026-11-11T00:00'))).toEqual(['2026-11-10T10:30..2026-11-10T22:30']);
  });
  it('Wednesday gym 4-5 PM splits the evening', () => {
    const classes = [iv('2026-11-11T10:00', '2026-11-11T12:00')];
    expect(show(win('2026-11-11T00:00', '2026-11-12T00:00', { classBusy: classes, busy: classes }))).toEqual([
      '2026-11-11T12:00..2026-11-11T16:00',
      '2026-11-11T17:00..2026-11-11T22:30',
    ]);
  });
  it('Thursday ends 8:30 PM (going out) and has Tue/Thu morning gym', () => {
    expect(show(win('2026-11-12T00:00', '2026-11-13T00:00'))).toEqual(['2026-11-12T10:30..2026-11-12T20:30']);
  });
  it('Friday ends 8:30 PM', () => {
    expect(show(win('2026-11-13T00:00', '2026-11-14T00:00'))).toEqual(['2026-11-13T09:00..2026-11-13T20:30']);
  });
  it('Saturday: 2-hour gym window, nothing after 8 PM (stricter than the 8:30 Thu/Fri/Sat limit)', () => {
    expect(show(win('2026-11-14T00:00', '2026-11-15T00:00'))).toEqual(['2026-11-14T09:00..2026-11-14T11:00', '2026-11-14T13:00..2026-11-14T20:00']);
  });
  it('Sunday catch-up: full afternoon from 1 PM until 10:30 PM', () => {
    expect(show(win('2026-11-15T00:00', '2026-11-16T00:00'))).toEqual(['2026-11-15T13:00..2026-11-15T22:30']);
  });
});

describe('per-date overrides', () => {
  it('marks a day fully unavailable (game day)', () => {
    const w = win('2026-11-14T00:00', '2026-11-16T00:00', { overrides: { '2026-11-14': { unavailable: true, label: 'game day' } } });
    expect(show(w)).toEqual(['2026-11-15T13:00..2026-11-15T22:30']);
  });
  it('can narrow hours and add a blocked window for one date', () => {
    const w = win('2026-11-13T00:00', '2026-11-14T00:00', {
      overrides: { '2026-11-13': { start: '12:00', end: '18:00', unavailable_windows: [{ start: '14:00', end: '15:00' }] } },
    });
    expect(show(w)).toEqual(['2026-11-13T12:00..2026-11-13T14:00', '2026-11-13T15:00..2026-11-13T18:00']);
  });
});

const rules: ClassRules = { cutoff: '18:00', minMinutes: 45, fixed: [] };
describe('first class detection', () => {
  const day = '2026-11-09';
  it('is the earliest-starting qualifying block; a later class does not move it', () => {
    const cls = [iv('2026-11-09T13:00', '2026-11-09T14:30'), iv('2026-11-09T10:00', '2026-11-09T11:00')];
    expect(firstClass(day, cls, TZ, rules)).toEqual(iv('2026-11-09T10:00', '2026-11-09T11:00'));
  });
  it('ignores blocks that start at/after the cutoff (an evening exam is not a class)', () => {
    const cls = [iv('2026-11-09T18:00', '2026-11-09T20:00')];
    expect(firstClass(day, cls, TZ, rules)).toBeUndefined();
  });
  it('ignores day-spanning (all-day) blocks and other days', () => {
    const cls = [iv('2026-11-09T00:00', '2026-11-10T00:00'), iv('2026-11-10T09:00', '2026-11-10T10:00')];
    expect(firstClass(day, cls, TZ, rules)).toBeUndefined();
  });
  it('classifyDay explains every block it ignored', () => {
    const cls = [
      iv('2026-11-10T08:30', '2026-11-10T10:30'), // gym
      iv('2026-11-10T11:30', '2026-11-10T14:30'), // class
      iv('2026-11-10T17:00', '2026-11-10T17:30'), // 30 min
      iv('2026-11-10T18:30', '2026-11-10T20:00'), // evening
    ];
    const r = classifyDay('2026-11-10', cls, TZ, { ...rules, fixed: [{ start: '08:30', end: '10:30' }] });
    expect(r.first).toEqual(iv('2026-11-10T11:30', '2026-11-10T14:30'));
    expect(r.counted).toEqual([iv('2026-11-10T11:30', '2026-11-10T14:30')]);
    const why = Object.fromEntries(r.ignored.map((i) => [fmt(i.block.start).slice(11), i.reason]));
    expect(why['08:30']).toMatch(/fixed|gym/i);
    expect(why['17:00']).toMatch(/shorter than 45/);
    expect(why['18:30']).toMatch(/cutoff/);
  });
  it('a block only partly inside a fixed window still counts as a class (Wed 3:00-5:15 PM vs gym 4-5 PM)', () => {
    const r = classifyDay('2026-11-11', [iv('2026-11-11T15:00', '2026-11-11T17:15')], TZ, { ...rules, fixed: [{ start: '16:00', end: '17:00' }] });
    expect(r.first).toEqual(iv('2026-11-11T15:00', '2026-11-11T17:15'));
  });
  it('evening exam stays busy (subtracted) but does not push the start', () => {
    const exam = iv('2026-11-09T18:00', '2026-11-09T20:00');
    expect(show(win('2026-11-09T00:00', '2026-11-10T00:00', { classBusy: [exam], busy: [exam] }))).toEqual([
      '2026-11-09T09:00..2026-11-09T18:00',
      '2026-11-09T20:00..2026-11-09T22:30',
    ]);
  });
  it('an all-day busy event blanks the day', () => {
    const allDay = iv('2026-11-09T00:00', '2026-11-10T00:00');
    expect(win('2026-11-09T00:00', '2026-11-10T00:00', { busy: [allDay], classBusy: [allDay] })).toEqual([]);
  });
  it('first class ending after the day end leaves nothing', () => {
    const late = [iv('2026-11-12T17:00', '2026-11-12T21:00')]; // Thursday ends 20:30
    expect(win('2026-11-12T00:00', '2026-11-13T00:00', { classBusy: late, busy: late })).toEqual([]);
  });
});

describe('edges', () => {
  it('drops windows shorter than the minimum block', () => {
    const busy = [iv('2026-11-13T09:10', '2026-11-13T20:30')]; // leaves 09:00-09:10
    expect(win('2026-11-13T00:00', '2026-11-14T00:00', { busy })).toEqual([]);
    const ok = [iv('2026-11-13T09:15', '2026-11-13T20:30')];
    expect(show(win('2026-11-13T00:00', '2026-11-14T00:00', { busy: ok }))).toEqual(['2026-11-13T09:00..2026-11-13T09:15']);
  });
  it('clips to the requested range', () => {
    expect(show(win('2026-11-15T15:00', '2026-11-15T18:00'))).toEqual(['2026-11-15T15:00..2026-11-15T18:00']);
  });
  it('uses local times across fall-back (Sun Nov 1 2026 is a 25-hour day)', () => {
    const w = win('2026-11-01T00:00', '2026-11-02T00:00');
    expect(show(w)).toEqual(['2026-11-01T13:00..2026-11-01T22:30']);
    expect((w[0].end - w[0].start) / 60000).toBe(570);
  });
  it('uses local times across spring-forward (Sun Mar 14 2027)', () => {
    const w = win('2027-03-14T00:00', '2027-03-15T00:00');
    expect(show(w)).toEqual(['2027-03-14T13:00..2027-03-14T22:30']);
  });
});
