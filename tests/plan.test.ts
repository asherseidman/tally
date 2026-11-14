import { describe, it, expect } from 'vitest';
import { planSchedule, chunkSizes, type PlanParams } from '../src/schedule/plan';
import type { SchedTask } from '../src/schedule/types';
import { loc, iv, fmt } from './helpers';

// Rules added later (lead time, long-task minimum block, multi-day spreading) are OFF here so the
// original placement behavior stays pinned; the new rules are tested in their own sections below.
const P: PlanParams = { minBlock: 15, maxBlock: 120, buffer: 10, slackMin: 120, leadMin: 0, longTaskMinutes: 0, longTaskMinBlock: 30, spreadMinutes: 0, spreadDailyMax: 120, spreadDaysBefore: 1, examPrepEndBefore: 120, examPrepDailyMax: 180, tz: 'America/Detroit' };
const PN: PlanParams = { ...P, leadMin: 30, longTaskMinutes: 60, spreadMinutes: 240 };
const t = (id: number, due: string, minutes: number, weight: number | null = null): SchedTask => ({
  id, title: `t${id}`, course: null, dueMs: loc(due), minutes, weight,
});
const NOW = loc('2026-11-09T09:00');
const run = (tasks: SchedTask[], windows: any[], now = NOW, p = P) => planSchedule({ nowMs: now, tasks, windows, params: p });
const span = (b: { start: number; end: number }) => `${fmt(b.start)}..${fmt(b.end)}`;

describe('chunkSizes', () => {
  it('pads short tasks to the minimum block', () => {
    expect(chunkSizes(5, 15, 120)).toEqual([15]);
    expect(chunkSizes(10, 25, 120)).toEqual([25]);
  });
  it('keeps tasks within max as one block', () => {
    expect(chunkSizes(45, 15, 120)).toEqual([45]);
    expect(chunkSizes(120, 15, 120)).toEqual([120]);
  });
  it('splits evenly on a 5-minute grid, never above max, sum >= need', () => {
    expect(chunkSizes(240, 15, 120)).toEqual([120, 120]);
    expect(chunkSizes(300, 15, 120)).toEqual([100, 100, 100]);
    expect(chunkSizes(600, 15, 120)).toEqual([120, 120, 120, 120, 120]);
    expect(chunkSizes(125, 15, 120)).toEqual([65, 60]);
    expect(chunkSizes(121, 15, 120)).toEqual([65, 60]);
    for (const m of [130, 250, 480, 605, 777]) {
      const c = chunkSizes(m, 15, 120);
      expect(Math.max(...c)).toBeLessThanOrEqual(120);
      expect(Math.min(...c)).toBeGreaterThanOrEqual(15);
      expect(c.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(m);
      expect(c.reduce((a, b) => a + b, 0)).toBeLessThan(m + 10);
    }
  });
});

describe('placement', () => {
  const day = [iv('2026-11-10T09:00', '2026-11-10T22:30')];

  it('places as late as possible, ending slack (120 min) before the due time', () => {
    const r = run([t(1, '2026-11-10T22:00', 60)], day);
    expect(r.problems).toEqual([]);
    expect(r.blocks.map(span)).toEqual(['2026-11-10T19:00..2026-11-10T20:00']); // due 22:00 - 2h = 20:00
  });
  it('never ends after the end of working time even if the due time is later', () => {
    const r = run([t(1, '2026-11-12T23:59', 60)], day);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].end).toBeLessThanOrEqual(loc('2026-11-10T22:30'));
  });
  it('never schedules in the past (start rounds up to the next 5 minutes)', () => {
    const now = loc('2026-11-10T15:07');
    const r = run([t(1, '2026-11-10T17:30', 20)], day, now); // deadline 15:30
    expect(r.blocks.map(span)).toEqual(['2026-11-10T15:10..2026-11-10T15:30']);
    expect(r.blocks.every((b) => b.start >= now)).toBe(true);
  });
  it('does not squeeze a task into time that has already passed', () => {
    const now = loc('2026-11-10T15:07');
    const r = run([t(1, '2026-11-10T17:30', 30)], day, now); // only 20 minutes left before the deadline
    expect(r.blocks.every((b) => b.start >= now)).toBe(true);
    expect(r.problems[0]).toMatchObject({ taskId: 1 });
  });
  it('reports a task whose deadline (minus slack) is already past instead of dropping it', () => {
    const r = run([t(1, '2026-11-10T16:00', 30)], day, loc('2026-11-10T15:00'));
    expect(r.blocks).toEqual([]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ taskId: 1, kind: 'unplaced', placedMinutes: 0, neededMinutes: 30 });
    expect(r.problems[0].reason).toMatch(/before/i);
  });
  it('orders by deadline: earlier deadline gets its latest slot; later one lands after it', () => {
    const r = run([t(2, '2026-11-10T22:30', 60), t(1, '2026-11-10T18:00', 60)], day);
    const b1 = r.blocks.find((b) => b.taskId === 1)!, b2 = r.blocks.find((b) => b.taskId === 2)!;
    expect(span(b1)).toBe('2026-11-10T15:00..2026-11-10T16:00'); // 18:00 - 2h = 16:00
    expect(b2.start).toBeGreaterThanOrEqual(b1.end);
    expect(b2.end).toBeLessThanOrEqual(loc('2026-11-11T00:30'));
  });
  it('ties on deadline break by grade weight: heavier is placed first (gets the later slot)', () => {
    const r = run([t(1, '2026-11-10T22:30', 60, 5), t(2, '2026-11-10T22:30', 60, 20)], day);
    const light = r.blocks.find((b) => b.taskId === 1)!, heavy = r.blocks.find((b) => b.taskId === 2)!;
    expect(heavy.start).toBeGreaterThan(light.start);
  });
  it('keeps the buffer between any two planner blocks', () => {
    const r = run([t(1, '2026-11-10T22:30', 60), t(2, '2026-11-10T22:30', 60), t(3, '2026-11-10T22:30', 60)], day);
    const bs = [...r.blocks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < bs.length; i++) expect(bs[i].start - bs[i - 1].end).toBeGreaterThanOrEqual(10 * 60000);
  });
  it('splits a long task into blocks no longer than max, in chronological parts', () => {
    const r = run([t(1, '2026-11-10T22:30', 300)], day);
    expect(r.problems).toEqual([]);
    const bs = r.blocks.filter((b) => b.taskId === 1).sort((a, b) => a.start - b.start);
    expect(bs.map((b) => (b.end - b.start) / 60000)).toEqual([100, 100, 100]);
    expect(bs.map((b) => [b.part, b.parts])).toEqual([[1, 3], [2, 3], [3, 3]]);
  });
  it('pads a 5-minute task to a 15-minute block and says so', () => {
    const r = run([t(1, '2026-11-10T22:30', 5)], day);
    expect((r.blocks[0].end - r.blocks[0].start) / 60000).toBe(15);
    expect(r.blocks[0].padded).toBe(true);
  });
  it('spreads across windows when no single window fits', () => {
    const ws = [iv('2026-11-10T09:00', '2026-11-10T10:00'), iv('2026-11-10T13:00', '2026-11-10T14:00')];
    const r = run([t(1, '2026-11-10T23:59', 100)], ws);
    expect(r.problems).toEqual([]);
    const total = r.blocks.reduce((s, b) => s + (b.end - b.start) / 60000, 0);
    expect(total).toBeGreaterThanOrEqual(100);
    for (const b of r.blocks) expect(ws.some((w) => b.start >= w.start && b.end <= w.end)).toBe(true);
  });
  it('reports partial placement with the shortfall', () => {
    const ws = [iv('2026-11-10T09:00', '2026-11-10T10:00')];
    const r = run([t(1, '2026-11-10T23:59', 120)], ws);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ taskId: 1, kind: 'partial', neededMinutes: 120 });
    expect(r.problems[0].placedMinutes).toBeGreaterThan(0);
    expect(r.problems[0].placedMinutes).toBeLessThan(120);
  });
  it('reports a task that cannot fit anywhere as unplaced', () => {
    const r = run([t(1, '2026-11-10T11:00', 60)], [iv('2026-11-10T09:00', '2026-11-10T22:30')], loc('2026-11-10T09:00'));
    // deadline 09:00 == now: nothing before it
    expect(r.problems[0].kind).toBe('unplaced');
  });
  it('blocks stay inside windows, on the 5-minute grid, and never overlap (mixed workload)', () => {
    const ws = [iv('2026-11-10T14:30', '2026-11-10T16:00'), iv('2026-11-10T17:00', '2026-11-10T22:30'), iv('2026-11-11T09:00', '2026-11-11T20:30')];
    const tasks = [t(1, '2026-11-11T23:59', 180, 5), t(2, '2026-11-11T18:00', 45), t(3, '2026-11-10T23:59', 70, 2), t(4, '2026-11-11T23:59', 25), t(5, '2026-11-11T12:00', 95)];
    const r = run(tasks, ws, loc('2026-11-10T14:30'));
    const bs = [...r.blocks].sort((a, b) => a.start - b.start);
    for (const b of bs) {
      expect(ws.some((w) => b.start >= w.start && b.end <= w.end)).toBe(true);
      expect(b.start % (5 * 60000)).toBe(0);
      expect(b.end).toBeLessThanOrEqual(tasks.find((x) => x.id === b.taskId)!.dueMs);
    }
    for (let i = 1; i < bs.length; i++) expect(bs[i].start - bs[i - 1].end).toBeGreaterThanOrEqual(10 * 60000);
  });
  it('every block ends before its own due time minus slack (or the working window end)', () => {
    const r = run([t(1, '2026-11-10T20:00', 90)], day);
    expect(r.blocks.every((b) => b.end <= loc('2026-11-10T18:00'))).toBe(true);
  });
});

describe('minimum lead time', () => {
  const day = [iv('2026-11-10T09:00', '2026-11-10T22:30')];
  it('does not schedule anything within the lead time of now (rounded up to the 5-minute grid)', () => {
    const now = loc('2026-11-10T15:07');
    const r = run([t(1, '2026-11-10T19:00', 20)], day, now, PN); // deadline 17:00
    expect(r.blocks.map(span)).toEqual(['2026-11-10T16:40..2026-11-10T17:00']);
    const tight = run([t(2, '2026-11-10T17:30', 20)], day, now, PN); // deadline 15:30; earliest start 15:40
    expect(tight.blocks).toEqual([]);
    expect(tight.problems[0].kind).toBe('unplaced');
  });
  it('every block starts at least leadMin after now', () => {
    const now = loc('2026-11-10T15:07');
    const r = run([t(1, '2026-11-10T22:30', 120), t(2, '2026-11-10T22:30', 40)], [iv('2026-11-10T15:00', '2026-11-10T17:00')], now, PN);
    for (const b of r.blocks) expect(b.start).toBeGreaterThanOrEqual(now + 30 * 60000);
  });
});

describe('no short blocks for tasks of 60+ minutes', () => {
  it('chunk sizes respect the larger minimum', () => {
    expect(chunkSizes(65, 30, 120)).toEqual([65]);
    expect(chunkSizes(130, 30, 120)).toEqual([65, 65]);
    expect(chunkSizes(20, 15, 120)).toEqual([20]);
  });
  it('a 60-minute task never gets a block under 30 minutes: it is reported instead', () => {
    const r = run([t(1, '2026-11-10T22:00', 60)], [iv('2026-11-10T14:00', '2026-11-10T14:50')], loc('2026-11-10T09:00'), PN);
    expect(r.blocks.every((b) => (b.end - b.start) / 60000 >= 30)).toBe(true);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ taskId: 1, kind: 'partial', placedMinutes: 30 });
  });
  it('windows of 15-25 minutes are not used for a 90-minute task, but are for a 20-minute one', () => {
    const ws = [iv('2026-11-10T10:00', '2026-11-10T10:25'), iv('2026-11-10T12:00', '2026-11-10T12:25')];
    const long = run([t(1, '2026-11-10T22:00', 90)], ws, loc('2026-11-10T09:00'), PN);
    expect(long.blocks).toEqual([]);
    const short = run([t(2, '2026-11-10T22:00', 20)], ws, loc('2026-11-10T09:00'), PN);
    expect(short.blocks).toHaveLength(1);
  });
  it('holds across a mixed workload (property)', () => {
    const ws = [iv('2026-11-10T14:30', '2026-11-10T16:00'), iv('2026-11-10T17:00', '2026-11-10T22:30'), iv('2026-11-11T09:00', '2026-11-11T20:30')];
    const tasks = [t(1, '2026-11-11T23:59', 150), t(2, '2026-11-11T18:00', 65), t(3, '2026-11-10T23:59', 90), t(4, '2026-11-11T23:59', 20)];
    const r = run(tasks, ws, loc('2026-11-10T14:30'), PN);
    for (const b of r.blocks) {
      const need = tasks.find((x) => x.id === b.taskId)!.minutes;
      if (need >= 60) expect((b.end - b.start) / 60000).toBeGreaterThanOrEqual(30);
    }
  });
});

describe('big tasks (240+ min) are spread over several days', () => {
  const week = ['09', '10', '11', '12', '13'].map((d) => iv(`2026-11-${d}T09:00`, `2026-11-${d}T22:30`)); // Mon-Fri
  const mondayMorning = loc('2026-11-09T08:00');
  const dayOf = (ms: number) => fmt(ms).slice(0, 10);
  const perDay = (bs: { start: number; end: number }[]) => {
    const m = new Map<string, number>();
    for (const b of bs) m.set(dayOf(b.start), (m.get(dayOf(b.start)) ?? 0) + (b.end - b.start) / 60000);
    return m;
  };

  it('puts at most 2 hours of the task on any one day, using several days, last block a day before the deadline', () => {
    const r = run([t(1, '2026-11-13T20:00', 360)], week, mondayMorning, PN); // due Fri 8 PM
    expect(r.problems).toEqual([]);
    const m = perDay(r.blocks);
    expect(m.size).toBe(3);
    for (const v of m.values()) expect(v).toBeLessThanOrEqual(120);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(360);
    expect(Math.max(...r.blocks.map((b) => b.end))).toBeLessThanOrEqual(loc('2026-11-12T20:00')); // Thu 8 PM = a day before
    expect([...m.keys()].sort()).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']); // as late as possible, one day each
  });
  it('the last block ends a full day before the deadline even when the 2-hour slack alone would allow later', () => {
    const r = run([t(1, '2026-11-12T12:00', 240)], week, mondayMorning, PN);
    expect(Math.max(...r.blocks.map((b) => b.end))).toBeLessThanOrEqual(loc('2026-11-11T12:00'));
  });
  it('without the rule (below 240 minutes) all the work may land on the last day', () => {
    const r = run([t(1, '2026-11-13T23:59', 235)], week, mondayMorning, PN);
    expect(perDay(r.blocks).size).toBe(1);
    expect([...perDay(r.blocks).keys()]).toEqual(['2026-11-13']);
  });
  it('exactly 240 minutes triggers the rule', () => {
    const r = run([t(1, '2026-11-13T23:59', 240)], week, mondayMorning, PN);
    expect(perDay(r.blocks).size).toBe(2);
  });
  it('reports what does not fit when there are not enough days', () => {
    const two = [iv('2026-11-11T09:00', '2026-11-11T22:30'), iv('2026-11-12T09:00', '2026-11-12T22:30')];
    const r = run([t(1, '2026-11-13T20:00', 360)], two, mondayMorning, PN);
    expect(r.problems[0]).toMatchObject({ taskId: 1, kind: 'partial', neededMinutes: 360 });
    expect(r.problems[0].placedMinutes).toBeLessThanOrEqual(240);
    for (const v of perDay(r.blocks).values()) expect(v).toBeLessThanOrEqual(120);
  });
  it('other tasks are not limited by the per-day cap and can share the same days', () => {
    const r = run([t(1, '2026-11-13T20:00', 360), t(2, '2026-11-12T23:59', 180)], week, mondayMorning, PN);
    const big = r.blocks.filter((b) => b.taskId === 1);
    for (const v of perDay(big).values()) expect(v).toBeLessThanOrEqual(120);
    expect(r.blocks.filter((b) => b.taskId === 2).reduce((s, b) => s + (b.end - b.start) / 60000, 0)).toBeGreaterThanOrEqual(180);
    const bs = [...r.blocks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < bs.length; i++) expect(bs[i].start - bs[i - 1].end).toBeGreaterThanOrEqual(10 * 60000);
  });
  it('can be switched off (spreadMinutes 0)', () => {
    const r = run([t(1, '2026-11-13T23:59', 360)], week, mondayMorning, { ...PN, spreadMinutes: 0 });
    expect(perDay(r.blocks).size).toBe(1);
  });
});

describe('exam prep spreading: ends 2h before the exam, up to 3h a day', () => {
  const days = ['09', '10', '11'].map((d) => iv(`2026-11-${d}T09:00`, `2026-11-${d}T22:30`)); // Mon-Wed
  const mon8 = loc('2026-11-09T08:00');
  const exam = (id: number, due: string, minutes: number): SchedTask => ({ ...t(id, due, minutes), isExam: true });
  const dayOf = (ms: number) => fmt(ms).slice(0, 10);
  const perDay = (bs: { start: number; end: number }[]) => {
    const m = new Map<string, number>();
    for (const b of bs) m.set(dayOf(b.start), (m.get(dayOf(b.start)) ?? 0) + (b.end - b.start) / 60000);
    return m;
  };

  it('360 minutes of prep before a Wed 8 PM exam fits, with study on the exam day itself, ending by 6 PM', () => {
    const r = run([exam(1, '2026-11-11T20:00', 360)], days, mon8, PN);
    expect(r.problems).toEqual([]);
    expect(r.blocks.reduce((s, b) => s + (b.end - b.start) / 60000, 0)).toBeGreaterThanOrEqual(360);
    expect(Math.max(...r.blocks.map((b) => b.end))).toBeLessThanOrEqual(loc('2026-11-11T18:00'));
    expect(r.blocks.some((b) => dayOf(b.start) === '2026-11-11')).toBe(true); // not forced a full day earlier
    for (const v of perDay(r.blocks).values()) expect(v).toBeLessThanOrEqual(180);
  });
  it('uses the full 3 hours a day when it must (only two days available)', () => {
    const two = days.slice(1);
    const r = run([exam(1, '2026-11-11T20:00', 360)], two, mon8, PN);
    expect(r.problems).toEqual([]);
    expect([...perDay(r.blocks).values()].sort()).toEqual([180, 180]);
    const bs = [...r.blocks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < bs.length; i++) expect(bs[i].start - bs[i - 1].end).toBeGreaterThanOrEqual(10 * 60000);
  });
  it('a non-exam task of the same size keeps the stricter rule (2h a day, a day of margin)', () => {
    const r = run([t(1, '2026-11-11T20:00', 360)], days, mon8, PN);
    expect(Math.max(...r.blocks.map((b) => b.end))).toBeLessThanOrEqual(loc('2026-11-10T20:00'));
    for (const v of perDay(r.blocks).values()) expect(v).toBeLessThanOrEqual(120);
  });
  it('both numbers are settings', () => {
    const r = run([exam(1, '2026-11-11T20:00', 360)], days, mon8, { ...PN, examPrepEndBefore: 30, examPrepDailyMax: 240 });
    expect(Math.max(...r.blocks.map((b) => b.end))).toBeLessThanOrEqual(loc('2026-11-11T19:30'));
    expect(Math.max(...r.blocks.map((b) => b.end))).toBeGreaterThan(loc('2026-11-11T18:00'));
    for (const v of perDay(r.blocks).values()) expect(v).toBeLessThanOrEqual(240);
  });
  it('an exam under the spreading threshold is planned like any other task (2h slack)', () => {
    const r = run([exam(1, '2026-11-11T20:00', 180)], days, mon8, PN);
    expect(Math.max(...r.blocks.map((b) => b.end))).toBeLessThanOrEqual(loc('2026-11-11T18:00'));
    expect(r.blocks.some((b) => dayOf(b.start) === '2026-11-11')).toBe(true);
  });
  it('still reports what does not fit', () => {
    const one = days.slice(2);
    const r = run([exam(1, '2026-11-11T20:00', 360)], one, mon8, PN);
    expect(r.problems[0]).toMatchObject({ kind: 'partial' });
    expect(r.problems[0].placedMinutes).toBeLessThanOrEqual(180);
  });
});
