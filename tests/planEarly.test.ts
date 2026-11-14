import { describe, it, expect } from 'vitest';
import { planSchedule, type PlanParams } from '../src/schedule/plan';
import type { SchedTask, PlanBlock } from '../src/schedule/types';
import { loc, iv, fmt } from './helpers';

const BASE: PlanParams = {
  minBlock: 15, maxBlock: 120, buffer: 10, slackMin: 120, leadMin: 30, longTaskMinutes: 60, longTaskMinBlock: 30, spreadMinutes: 240, spreadDailyMax: 120,
  spreadDaysBefore: 1, examPrepEndBefore: 120, examPrepDailyMax: 180, tz: 'America/Detroit',
  placement: 'early', earlyLeadDays: 3, finishBefore: 240, maxDailyWork: 300,
};
const LATE: PlanParams = { ...BASE, placement: 'late' };
const t = (id: number, due: string, minutes: number, o: Partial<SchedTask> = {}): SchedTask => ({ id, title: `t${id}`, course: null, dueMs: loc(due), minutes, weight: null, ...o });
const run = (tasks: SchedTask[], windows: any[], now: string, p = BASE) => planSchedule({ nowMs: loc(now), tasks, windows, params: p });
const dateOf = (i: number, from: string) => new Date(Date.parse(`${from}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
const week = (from: string, n: number) => Array.from({ length: n }, (_, i) => iv(`${dateOf(i, from)}T09:00`, `${dateOf(i, from)}T22:00`));
const starts = (bs: PlanBlock[]) => bs.map((b) => fmt(b.start));
const mins = (bs: PlanBlock[]) => bs.reduce((s, b) => s + (b.end - b.start) / 60_000, 0);
const perDay = (bs: PlanBlock[]) => {
  const m = new Map<string, number>();
  for (const b of bs) m.set(fmt(b.start).slice(0, 10), (m.get(fmt(b.start).slice(0, 10)) ?? 0) + (b.end - b.start) / 60_000);
  return m;
};

const WINS = week('2026-11-07', 10); // Sat Nov 7 .. Mon Nov 16, 9:00-22:00 each day
const NOW = '2026-11-07T08:00';

describe('early placement', () => {
  it('a weekly assignment due Thursday 11 PM starts Monday, not Thursday', () => {
    const r = run([t(1, '2026-11-12T23:00', 60)], WINS, NOW);
    expect(r.problems).toEqual([]);
    expect(starts(r.blocks)).toEqual(['2026-11-09T09:00']);
  });
  it('late mode is the old behaviour: as late as possible, ending slack before the deadline', () => {
    const r = run([t(1, '2026-11-12T23:00', 60)], WINS, NOW, LATE);
    expect(starts(r.blocks)).toEqual(['2026-11-12T20:00']); // due 23:00 minus 2h slack = 21:00
  });
  it('finishes at least finish_before_deadline_minutes before the deadline', () => {
    const win = [iv('2026-11-09T09:00', '2026-11-09T13:00')];
    const ok = run([t(1, '2026-11-09T14:00', 60)], win, '2026-11-09T08:00'); // must end by 10:00
    expect(ok.blocks).toHaveLength(1);
    expect(fmt(ok.blocks[0].end) <= '2026-11-09T10:00').toBe(true);
    const none = run([t(1, '2026-11-09T12:00', 60)], win, '2026-11-09T08:00'); // must end by 08:00: impossible
    expect(none.blocks).toEqual([]);
    expect(none.problems[0].kind).toBe('unplaced');
  });
  it('never schedules before now + lead time, and never in the past', () => {
    const r = run([t(1, '2026-11-12T23:00', 60)], WINS, '2026-11-09T09:40');
    expect(fmt(r.blocks[0].start)).toBe('2026-11-09T10:10'); // 09:40 + 30 min lead
  });
  it('available_from later than the lead-days start delays the task', () => {
    const r = run([t(1, '2026-11-12T23:00', 60, { availableMs: loc('2026-11-11T00:00') })], WINS, NOW);
    expect(starts(r.blocks)).toEqual(['2026-11-11T09:00']);
  });
  it('available_from earlier than the lead-days start changes nothing (lead days still apply)', () => {
    const r = run([t(1, '2026-11-12T23:00', 60, { availableMs: loc('2026-11-07T00:00') })], WINS, NOW);
    expect(starts(r.blocks)).toEqual(['2026-11-09T09:00']);
  });
  it('a task not released until after its finish-by time is reported, not scheduled', () => {
    const r = run([t(1, '2026-11-12T10:00', 60, { availableMs: loc('2026-11-13T00:00') })], WINS, NOW);
    expect(r.blocks).toEqual([]);
    expect(r.problems[0].reason).toMatch(/not available/);
  });
  it('available_from is also respected in late mode', () => {
    const r = run([t(1, '2026-11-12T23:00', 60, { availableMs: loc('2026-11-12T21:30') })], WINS, NOW, LATE);
    expect(r.blocks).toEqual([]); // nothing fits between the release and due-2h
  });
  it('applies to every type: a reading and a discussion post start early too', () => {
    const r = run([t(1, '2026-11-12T23:00', 45), t(2, '2026-11-12T23:00', 30)], WINS, NOW);
    expect(starts(r.blocks).every((s) => s.startsWith('2026-11-09'))).toBe(true);
  });
});

describe('daily workload cap', () => {
  it('keeps each day at or under max_daily_work_minutes when there is room elsewhere', () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((i) => t(i, '2026-11-12T23:00', 100));
    const r = run(tasks, WINS, NOW);
    expect(r.problems).toEqual([]);
    for (const m of perDay(r.blocks).values()) expect(m).toBeLessThanOrEqual(300);
    expect(r.blocks.some((b) => b.overCap)).toBe(false);
  });
  it('is soft: exceeded only when the work would not otherwise fit, and those blocks are flagged', () => {
    const tasks = [1, 2, 3, 4].map((i) => t(i, '2026-11-09T23:00', 100)); // 400 min; only Monday is open
    const r = run(tasks, [iv('2026-11-09T09:00', '2026-11-09T19:00')], '2026-11-09T08:00');
    expect(r.problems).toEqual([]);
    expect(mins(r.blocks)).toBe(400);
    expect(r.blocks.some((b) => b.overCap)).toBe(true);
    expect(mins(r.blocks.filter((b) => !b.overCap))).toBeLessThanOrEqual(300);
  });
});

describe('big tasks', () => {
  it('a 420-minute task becomes eligible ceil(420/120)+2 = 6 days out and is spread at <= 2h/day', () => {
    const r = run([t(1, '2026-11-20T23:00', 420)], week('2026-11-07', 20), NOW);
    expect(r.problems).toEqual([]);
    expect(mins(r.blocks)).toBe(420);
    const days = perDay(r.blocks);
    for (const m of days.values()) expect(m).toBeLessThanOrEqual(120);
    expect([...days.keys()][0]).toBe('2026-11-14'); // Nov 20 minus 6 days
    expect(fmt(Math.max(...r.blocks.map((b) => b.end))) <= '2026-11-20T19:00').toBe(true);
  });
  it('a small task uses only early_lead_days (3)', () => {
    const r = run([t(1, '2026-11-20T23:00', 100)], week('2026-11-07', 20), NOW);
    expect(starts(r.blocks)[0].slice(0, 10)).toBe('2026-11-17');
  });
});

describe('exam prep keeps its rules and starts early', () => {
  it('3h/day cap, ends 2h before the exam, starts ceil(360/120)+2 = 5 days out', () => {
    const r = run([t(1, '2026-11-14T18:00', 360, { isExam: true })], week('2026-11-07', 10), NOW);
    expect(r.problems).toEqual([]);
    expect(mins(r.blocks)).toBe(360);
    for (const m of perDay(r.blocks).values()) expect(m).toBeLessThanOrEqual(180);
    expect([...perDay(r.blocks).keys()][0]).toBe('2026-11-09');
    expect(fmt(Math.max(...r.blocks.map((b) => b.end))) <= '2026-11-14T16:00').toBe(true);
  });
  it('may use the last two hours before the exam (finish-before is 2h for exams, not 4h)', () => {
    const r = run([t(1, '2026-11-09T20:00', 60, { isExam: true })], [iv('2026-11-09T17:00', '2026-11-09T18:30')], '2026-11-09T08:00', { ...BASE, spreadMinutes: 60 });
    expect(r.blocks).toHaveLength(1);
    expect(fmt(r.blocks[0].end) <= '2026-11-09T18:00').toBe(true);
  });
});

describe('fragmented free time', () => {
  it('fills every usable stretch rather than giving up when an even split does not fit (300 min exam prep, 70 + 240 + 45 min free)', () => {
    const wins = [iv('2026-11-10T21:20', '2026-11-10T22:30'), iv('2026-11-11T11:00', '2026-11-11T15:00'), iv('2026-11-11T17:15', '2026-11-11T18:00')];
    const r = run([t(1, '2026-11-11T20:00', 300, { isExam: true })], wins, '2026-11-10T20:49', { ...BASE, examPrepDailyMax: 240 });
    expect(r.problems).toEqual([]);
    expect(mins(r.blocks)).toBe(300);
    for (const b of r.blocks) expect((b.end - b.start) / 60000).toBeGreaterThanOrEqual(30); // long-task minimum block
  });
});

describe('a free stretch that cannot hold the whole remainder', () => {
  it('uses it for what fits and reports only the small remainder (Exam 2 case: 245 placed, a 45-minute stretch left)', () => {
    const wins = [iv('2026-11-10T21:45', '2026-11-10T22:30'), iv('2026-11-11T11:00', '2026-11-11T14:30'), iv('2026-11-11T17:15', '2026-11-11T18:00')];
    const r = run([t(1, '2026-11-11T20:00', 300, { isExam: true })], wins, '2026-11-10T21:10', { ...BASE, examPrepDailyMax: 240 });
    expect(r.blocks.some((b) => fmt(b.start) === '2026-11-11T17:15')).toBe(true); // the 45-minute stretch is used
    expect(mins(r.blocks)).toBeGreaterThanOrEqual(285);
    for (const p of r.problems) expect(p.neededMinutes - p.placedMinutes).toBeLessThanOrEqual(15);
  });
});
