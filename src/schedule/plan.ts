import { DateTime } from 'luxon';
import type { Interval, PlanBlock, PlanProblem, PlanResult, SchedTask } from './types';

const MIN = 60_000;
const DAY = 86_400_000;
const GRID = 5 * MIN;
const ceil5 = (m: number) => Math.ceil(m / 5) * 5;

export interface PlanParams {
  minBlock: number;
  maxBlock: number;
  buffer: number;
  slackMin: number;
  /** nothing is scheduled sooner than this many minutes from now */
  leadMin: number;
  /** tasks of at least this many minutes (0 = off) never get a block shorter than longTaskMinBlock */
  longTaskMinutes: number;
  longTaskMinBlock: number;
  /** tasks of at least this many minutes (0 = off) are spread over days */
  spreadMinutes: number;
  spreadDailyMax: number;
  spreadDaysBefore: number;
  /** exam-type tasks that are spread: last block ends this many minutes before the exam starts */
  examPrepEndBefore: number;
  /** exam-type tasks that are spread: at most this many minutes per local day */
  examPrepDailyMax: number;
  tz: string;
  /** 'late' = latest free slots before the deadline (the original behaviour); 'early' = earliest free slots from the eligible date */
  placement?: 'early' | 'late';
  /** early: a task becomes eligible this many days before its deadline (big tasks get ceil(minutes/120)+2 if larger) */
  earlyLeadDays?: number;
  /** early: work ends at least this many minutes before the deadline (exam prep keeps examPrepEndBefore) */
  finishBefore?: number;
  /** early: soft cap on scheduled minutes per local day, all tasks together */
  maxDailyWork?: number;
}

export interface PlanInput {
  nowMs: number;
  tasks: SchedTask[];
  windows: Interval[];
  params: PlanParams;
}

/**
 * Block lengths (minutes, chronological) for a task: padded up to the minimum block, or split
 * evenly on a 5-minute grid so no block exceeds the maximum.
 */
export function chunkSizes(minutes: number, min: number, max: number): number[] {
  const need = Math.max(ceil5(minutes), 5);
  const minB = ceil5(min);
  const maxB = Math.floor(max / 5) * 5;
  if (need <= maxB) return [Math.max(need, minB)];
  const n = Math.ceil(need / maxB);
  const size = ceil5(need / n);
  const out: number[] = [];
  let left = need;
  for (let i = 0; i < n - 1; i++) {
    out.push(size);
    left -= size;
  }
  out.push(Math.max(left, minB));
  return out;
}

type Accept = (slot: Interval, sizeMin: number) => boolean;

function findLatestSlot(wins: Interval[], size: number, limit: number, accept: Accept, floor = -Infinity): Interval | undefined {
  for (let i = wins.length - 1; i >= 0; i--) {
    const w = wins[i];
    if (w.start >= limit || w.end <= floor) continue;
    const hi = Math.floor(Math.min(w.end, limit) / GRID) * GRID;
    if (hi - size < Math.max(w.start, Math.ceil(floor / GRID) * GRID)) continue;
    const slot = { start: hi - size, end: hi };
    if (accept(slot, size / MIN)) return slot;
  }
  return undefined;
}

function findEarliestSlot(wins: Interval[], size: number, from: number, limit: number, accept: Accept): Interval | undefined {
  for (const w of wins) {
    if (w.end <= from) continue;
    if (w.start >= limit) break;
    const lo = Math.ceil(Math.max(w.start, from) / GRID) * GRID;
    if (lo + size > Math.min(w.end, limit)) continue;
    const slot = { start: lo, end: lo + size };
    if (accept(slot, size / MIN)) return slot;
  }
  return undefined;
}

/** Remove a block plus its buffer on both sides from the free windows. */
function consume(wins: Interval[], slot: Interval, buf: number, minLen: number): Interval[] {
  const out: Interval[] = [];
  const lo = slot.start - buf;
  const hi = slot.end + buf;
  for (const w of wins) {
    if (w.end <= lo || w.start >= hi) {
      out.push(w);
      continue;
    }
    if (w.start < lo) out.push({ start: w.start, end: lo });
    if (w.end > hi) out.push({ start: hi, end: w.end });
  }
  return out.filter((w) => w.end - w.start >= minLen);
}

/**
 * Greedy planner. Tasks go in order of due time, then heavier grade weight first. Each task is
 * placed as late as possible: its work must END at least `slackMin` before it is due, never
 * sooner than `leadMin` from now, always inside the free windows, with a buffer between any two
 * blocks. Extra rules:
 *  - tasks of `longTaskMinutes`+ never get a block shorter than `longTaskMinBlock`;
 *  - tasks of `spreadMinutes`+ get at most `spreadDailyMax` minutes per local day, and their last
 *    block ends at least `spreadDaysBefore` days before the deadline; for exam-type tasks the cap is
 *    `examPrepDailyMax` and the last block may end as late as `examPrepEndBefore` minutes before the exam.
 * Work that does not fit is reported, never dropped.
 */
export function planSchedule(input: PlanInput): PlanResult {
  if (input.params.placement === 'early') return planEarly(input);
  const { params: p } = input;
  const buf = p.buffer * MIN;
  const baseMinLen = p.minBlock * MIN;
  const earliest = Math.ceil((input.nowMs + p.leadMin * MIN) / GRID) * GRID;
  let wins = input.windows
    .map((w) => ({ start: Math.max(w.start, earliest), end: w.end }))
    .filter((w) => w.end - w.start >= baseMinLen)
    .sort((a, b) => a.start - b.start);

  const order = [...input.tasks].sort((a, b) => a.dueMs - b.dueMs || (b.weight ?? 0) - (a.weight ?? 0) || a.id - b.id);
  const blocks: PlanBlock[] = [];
  const problems: PlanProblem[] = [];
  const dayOf = (ms: number) => DateTime.fromMillis(ms, { zone: p.tz }).toISODate()!;

  for (const task of order) {
    const isLong = p.longTaskMinutes > 0 && task.minutes >= p.longTaskMinutes;
    const minB = isLong ? Math.max(p.minBlock, p.longTaskMinBlock) : p.minBlock;
    const isSpread = p.spreadMinutes > 0 && task.minutes >= p.spreadMinutes;
    const isExamPrep = isSpread && !!task.isExam;
    const dailyCap = isExamPrep ? p.examPrepDailyMax : p.spreadDailyMax;
    const maxB = isSpread ? Math.min(p.maxBlock, dailyCap) : p.maxBlock;
    let deadline = task.dueMs - p.slackMin * MIN;
    if (isExamPrep) deadline = task.dueMs - p.examPrepEndBefore * MIN;
    else if (isSpread) deadline = Math.min(deadline, task.dueMs - p.spreadDaysBefore * DAY);

    if (deadline - earliest < minB * MIN) {
      problems.push({ taskId: task.id, kind: 'unplaced', placedMinutes: 0, neededMinutes: task.minutes, reason: 'no working time left before the deadline (due time minus slack has already passed)' });
      continue;
    }

    const usedPerDay = new Map<string, number>();
    const accept: Accept = isSpread ? (slot, mins) => (usedPerDay.get(dayOf(slot.start)) ?? 0) + mins <= dailyCap : () => true;

    const placeChunk = (sizeMin: number): { placed: Interval[]; unplaced: number } => {
      const slot = findLatestSlot(wins, sizeMin * MIN, deadline, accept, task.availableMs);
      if (slot) {
        wins = consume(wins, slot, buf, baseMinLen);
        if (isSpread) usedPerDay.set(dayOf(slot.start), (usedPerDay.get(dayOf(slot.start)) ?? 0) + sizeMin);
        return { placed: [slot], unplaced: 0 };
      }
      const second = ceil5(sizeMin / 2);
      const first = sizeMin - second;
      if (first >= minB && second >= minB) {
        const a = placeChunk(second);
        const b = placeChunk(first);
        return { placed: [...a.placed, ...b.placed], unplaced: a.unplaced + b.unplaced };
      }
      return { placed: [], unplaced: sizeMin };
    };

    const chunks = chunkSizes(task.minutes, minB, maxB);
    const padded = chunks.reduce((a, b) => a + b, 0) > ceil5(task.minutes) || task.minutes < minB;
    const placed: Interval[] = [];
    let unplaced = 0;
    for (let i = chunks.length - 1; i >= 0; i--) {
      const r = placeChunk(chunks[i]);
      placed.push(...r.placed);
      unplaced += r.unplaced;
    }
    placed.sort((a, b) => a.start - b.start);
    placed.forEach((s, idx) => blocks.push({ taskId: task.id, start: s.start, end: s.end, part: idx + 1, parts: placed.length, padded }));
    if (unplaced > 0) {
      const placedMinutes = placed.reduce((s, x) => s + (x.end - x.start) / MIN, 0);
      problems.push({
        taskId: task.id,
        kind: placed.length ? 'partial' : 'unplaced',
        placedMinutes,
        neededMinutes: task.minutes,
        reason: isSpread ? `not enough free working time before the deadline (big tasks: at most ${dailyCap / 60}h/day${isExamPrep ? '' : ' and a day of margin'})` : 'not enough free working time before the deadline',
      });
    }
  }
  blocks.sort((a, b) => a.start - b.start || a.taskId - b.taskId);
  return { blocks, problems };
}

const dayStartMs = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).startOf('day').toMillis();

/**
 * Early placement. A task becomes eligible `lead` days before its deadline (lead = early_lead_days, or for big
 * tasks ceil(minutes / 120) + 2 when larger), never before its available_from date or before now + lead time.
 * Its blocks go into the EARLIEST free slots from there, ending at least `finishBefore` minutes before the deadline
 * (exam prep: `examPrepEndBefore`). Spread rules still cap a big task per day. All tasks together stay under a soft
 * per-day work cap, which is exceeded only when the work would otherwise not fit (those blocks are flagged).
 */
function planEarly(input: PlanInput): PlanResult {
  const { params: p } = input;
  const buf = p.buffer * MIN;
  const baseMinLen = p.minBlock * MIN;
  const earliest = Math.ceil((input.nowMs + p.leadMin * MIN) / GRID) * GRID;
  const leadDays = p.earlyLeadDays ?? 3;
  const finishBefore = p.finishBefore ?? 240;
  const dayCap = p.maxDailyWork ?? 300;
  let wins = input.windows
    .map((w) => ({ start: Math.max(w.start, earliest), end: w.end }))
    .filter((w) => w.end - w.start >= baseMinLen)
    .sort((a, b) => a.start - b.start);

  const order = [...input.tasks].sort((a, b) => a.dueMs - b.dueMs || (b.weight ?? 0) - (a.weight ?? 0) || a.id - b.id);
  const blocks: PlanBlock[] = [];
  const problems: PlanProblem[] = [];
  const dayOf = (ms: number) => DateTime.fromMillis(ms, { zone: p.tz }).toISODate()!;
  const usedTotal = new Map<string, number>();

  for (const task of order) {
    const isLong = p.longTaskMinutes > 0 && task.minutes >= p.longTaskMinutes;
    const minB = isLong ? Math.max(p.minBlock, p.longTaskMinBlock) : p.minBlock;
    const isSpread = p.spreadMinutes > 0 && task.minutes >= p.spreadMinutes;
    const isExamPrep = isSpread && !!task.isExam;
    const spreadCap = isExamPrep ? p.examPrepDailyMax : p.spreadDailyMax;
    const maxB = isSpread ? Math.min(p.maxBlock, spreadCap) : p.maxBlock;
    const deadline = task.dueMs - (isExamPrep ? p.examPrepEndBefore : finishBefore) * MIN;
    const lead = isSpread ? Math.max(leadDays, Math.ceil(task.minutes / 120) + 2) : leadDays;
    const eligible = Math.max(earliest, task.availableMs ?? -Infinity, DateTime.fromMillis(dayStartMs(task.dueMs, p.tz), { zone: p.tz }).minus({ days: lead }).toMillis());

    if (deadline - Math.max(eligible, earliest) < minB * MIN) {
      problems.push({
        taskId: task.id, kind: 'unplaced', placedMinutes: 0, neededMinutes: task.minutes,
        reason: task.availableMs != null && task.availableMs > deadline - minB * MIN ? 'it is not available until after its finish-by time' : 'no working time left before the deadline (due time minus the finish-before margin has already passed)',
      });
      continue;
    }

    const usedTask = new Map<string, number>();
    const taskOk = (slot: Interval, mins: number) => !isSpread || (usedTask.get(dayOf(slot.start)) ?? 0) + mins <= spreadCap;
    const strict: Accept = (slot, mins) => taskOk(slot, mins) && (usedTotal.get(dayOf(slot.start)) ?? 0) + mins <= dayCap;
    const lenient: Accept = (slot, mins) => taskOk(slot, mins);

    const commit = (slot: Interval, sizeMin: number) => {
      wins = consume(wins, slot, buf, baseMinLen);
      const d = dayOf(slot.start);
      usedTask.set(d, (usedTask.get(d) ?? 0) + sizeMin);
      usedTotal.set(d, (usedTotal.get(d) ?? 0) + sizeMin);
    };
    // Place `sizeMin` minutes in the earliest slot that holds all of it; otherwise fill the earliest free
    // stretch with as much as fits (never leaving a remainder shorter than the minimum block) and continue.
    const place = (sizeMin: number, accept: Accept, strictCap: boolean): { placed: Interval[]; unplaced: number } => {
      const slot = findEarliestSlot(wins, sizeMin * MIN, eligible, deadline, accept);
      if (slot) {
        commit(slot, sizeMin);
        return { placed: [slot], unplaced: 0 };
      }
      let fallback: { part: Interval; piece: number } | undefined;
      for (const w of wins) {
        if (w.end <= eligible) continue;
        if (w.start >= deadline) break;
        const lo = Math.ceil(Math.max(w.start, eligible) / GRID) * GRID;
        const hi = Math.floor(Math.min(w.end, deadline) / GRID) * GRID;
        const d = dayOf(lo);
        let room = (hi - lo) / MIN;
        if (isSpread) room = Math.min(room, spreadCap - (usedTask.get(d) ?? 0));
        if (strictCap) room = Math.min(room, dayCap - (usedTotal.get(d) ?? 0));
        room = Math.floor(room / 5) * 5;
        if (room < minB || room >= sizeMin) continue;
        let piece = room;
        if (sizeMin - piece < minB) piece = sizeMin - minB; // keep the remainder at least a minimum block
        if (piece < minB) {
          // This stretch can hold a usable block but would leave a sliver: remember it as a last resort.
          if (!fallback && accept({ start: lo, end: lo + room * MIN }, room)) fallback = { part: { start: lo, end: lo + room * MIN }, piece: room };
          continue;
        }
        const part = { start: lo, end: lo + piece * MIN };
        if (!accept(part, piece)) continue;
        commit(part, piece);
        const rest = place(sizeMin - piece, accept, strictCap);
        return { placed: [part, ...rest.placed], unplaced: rest.unplaced };
      }
      if (fallback) {
        // Nothing else holds it all: use the stretch for as much as fits and report the small remainder honestly.
        commit(fallback.part, fallback.piece);
        const left = sizeMin - fallback.piece;
        const padded = place(minB, accept, strictCap); // a remainder shorter than the minimum block is padded up to it
        return padded.unplaced === 0 ? { placed: [fallback.part, ...padded.placed], unplaced: 0 } : { placed: [fallback.part], unplaced: left };
      }
      return { placed: [], unplaced: sizeMin };
    };

    const chunks = chunkSizes(task.minutes, minB, maxB);
    const padded = chunks.reduce((a, b) => a + b, 0) > ceil5(task.minutes) || task.minutes < minB;
    const placed: Interval[] = [];
    const overSlots = new Set<number>();
    let unplaced = 0;
    for (const size of chunks) {
      let r = place(size, strict, true);
      if (r.unplaced > 0) {
        // would not fit under the soft cap: retry that piece ignoring it, and flag it
        const r2 = place(r.unplaced, lenient, false);
        r2.placed.forEach((s) => overSlots.add(s.start));
        r = { placed: [...r.placed, ...r2.placed], unplaced: r2.unplaced };
      }
      placed.push(...r.placed);
      unplaced += r.unplaced;
    }
    placed.sort((a, b) => a.start - b.start);
    placed.forEach((s, idx) => blocks.push({ taskId: task.id, start: s.start, end: s.end, part: idx + 1, parts: placed.length, padded, ...(overSlots.has(s.start) ? { overCap: true } : {}) }));
    if (unplaced > 0) {
      const placedMinutes = placed.reduce((s, x) => s + (x.end - x.start) / MIN, 0);
      problems.push({
        taskId: task.id, kind: placed.length ? 'partial' : 'unplaced', placedMinutes, neededMinutes: task.minutes,
        reason: isSpread ? `not enough free working time between when it can start and its deadline (big tasks: at most ${spreadCap / 60}h/day)` : 'not enough free working time between when it can start and its deadline',
      });
    }
  }
  blocks.sort((a, b) => a.start - b.start || a.taskId - b.taskId);
  return { blocks, problems };
}
