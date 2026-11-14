import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import { nowIso } from '../core/ctx';
import { getTask, listTasks, type Task } from '../core/tasks';
import { currentTerm } from '../core/terms';
import type { Interval } from './types';
import { loadWindows, resolveDay } from './availabilityWindows';
import { mergeIntervals, subtractIntervals } from './availability';
import { examBusyIntervals } from './exams';
import { loadScheduleSettings } from './params';
import { loadWorkingHours } from './settings';
import { eventTitle } from './eventTitle';

/**
 * Pinned blocks: a block you moved or resized by hand. The planner treats a pin as fixed (never moves or removes it), as busy
 * time for every other task, and counts its minutes toward its own task. Apply writes it at the pinned time. A pin whose task
 * is done or deleted, or that now ends after the task's due time, is NOT kept silently: the plan leaves it out and warns.
 */
export interface PinRow { id: number; task_id: number; start: string; end: string; created_at: string; updated_at: string }
export interface ActivePin { id: number; taskId: number; start: number; end: number; task: Task }
export interface PinWarning { pinId: number; taskId: number; title: string; start: number; end: number; reason: 'done' | 'deleted' | 'after_due' | 'busy'; message: string }
export interface Slot { start: string; end: string; label: string }
export type PinCheck =
  | { ok: true }
  | { ok: false; reason: 'task' | 'grid' | 'length' | 'past' | 'after_due' | 'blocked' | 'outside' | 'busy' | 'exam' | 'pin' | 'block'; message: string; suggestions: Slot[] };

const MIN = 60_000;
const GRID = 5 * MIN;
const STEP = 15 * MIN;

export const listPins = (ctx: Ctx): PinRow[] => ctx.db.all<PinRow>('SELECT * FROM pins ORDER BY start, id');
export const getPin = (ctx: Ctx, id: number): PinRow | undefined => ctx.db.get<PinRow>('SELECT * FROM pins WHERE id = ?', [id]);

const fmt = (ms: number, tz: string, f: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat(f);
export const spanText = (start: number, end: number, tz: string) => `${fmt(start, tz, 'ccc LLL d, h:mm a')}–${fmt(end, tz, 'h:mm a')}`;
const timeText = (start: number, end: number, tz: string) => `${fmt(start, tz, 'h:mm a')}–${fmt(end, tz, 'h:mm a')}`;
const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** Pins that are still ahead (or running now), split into the ones the plan keeps and the ones it must warn about. */
export function pinsForPlan(ctx: Ctx, nowMs: number, busy: Interval[] = []): { active: ActivePin[]; warnings: PinWarning[] } {
  const active: ActivePin[] = [];
  const warnings: PinWarning[] = [];
  for (const p of listPins(ctx)) {
    const start = Date.parse(p.start), end = Date.parse(p.end);
    if (end <= nowMs) continue; // history
    const t = getTask(ctx, p.task_id, { includeDeleted: true });
    const title = t ? eventTitle({ course: t.course, title: t.title, isExam: t.type === 'exam' }) : `#${p.task_id}`;
    const warn = (reason: PinWarning['reason'], message: string) => warnings.push({ pinId: p.id, taskId: p.task_id, title, start, end, reason, message });
    if (!t || t.deleted_at) { warn('deleted', `Pinned block ${spanText(start, end, ctx.tz)} belongs to a deleted task, so it is left out. Unpin it.`); continue; }
    if (t.status === 'done') { warn('done', `“${title}” is done, so its pinned block ${spanText(start, end, ctx.tz)} is left out. Unpin it (or reopen the task).`); continue; }
    if (t.due_date && end > Date.parse(t.due_date)) { warn('after_due', `“${title}” is now due ${fmt(Date.parse(t.due_date), ctx.tz, 'ccc LLL d, h:mm a')}, before its pinned block ${spanText(start, end, ctx.tz)} ends, so the block is left out. Move it earlier, or move it back to automatic.`); continue; }
    active.push({ id: p.id, taskId: p.task_id, start, end, task: t });
    const hit = busy.find((b) => overlaps(b, { start, end }));
    if (hit) warn('busy', `“${title}” is pinned at ${spanText(start, end, ctx.tz)}, which now overlaps busy time on your calendar (${timeText(Math.max(hit.start, start), Math.min(hit.end, end), ctx.tz)}). It is kept where you put it.`);
  }
  return { active, warnings };
}

interface Obstacles { blocked: Interval[]; free: Interval[]; busy: Interval[]; exams: { start: number; end: number; title: string }[]; pins: { start: number; end: number; title: string }[]; blocks: { start: number; end: number; title: string }[] }

function obstacles(ctx: Ctx, taskId: number, pinId: number | undefined, fromMs: number, toMs: number, busy: Interval[]): Obstacles {
  const rows = loadWindows(ctx);
  const free: Interval[] = [];
  const blocked: Interval[] = [];
  for (let d = DateTime.fromMillis(fromMs, { zone: ctx.tz }).startOf('day'); d.toMillis() < toMs; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    const r = resolveDay(rows, date, ctx.tz);
    free.push(...r.free);
    for (const w of r.rows.filter((x) => x.kind === 'blocked')) {
      blocked.push({ start: DateTime.fromISO(`${date}T${w.start}`, { zone: ctx.tz }).toMillis(), end: w.end === '24:00' ? d.plus({ days: 1 }).toMillis() : DateTime.fromISO(`${date}T${w.end}`, { zone: ctx.tz }).toMillis() });
    }
  }
  const { hours } = loadScheduleSettings(ctx, loadWorkingHours(ctx, currentTerm(ctx)?.id).hours);
  const exams = examBusyIntervals(listTasks(ctx, { status: 'open', scope: { allTerms: true } }), hours.exam_duration_minutes, 0).windows
    .map((w) => ({ start: w.start, end: w.end, title: eventTitle({ course: w.course ?? null, title: w.title, isExam: false }) }));
  const pins = listPins(ctx).filter((p) => p.id !== pinId).map((p) => {
    const t = getTask(ctx, p.task_id, { includeDeleted: true });
    return { start: Date.parse(p.start), end: Date.parse(p.end), title: t ? eventTitle({ course: t.course, title: t.title, isExam: t.type === 'exam' }) : `#${p.task_id}`, live: !!t && !t.deleted_at && t.status !== 'done' };
  }).filter((p) => p.live);
  const blocks = ctx.db.all<{ start: string; end: string; task_id: number; pin_id: number | null; title: string; course: string | null; type: string }>(
    `SELECT b.start, b."end", b.task_id, b.pin_id, t.title, t.course, t.type FROM scheduled_blocks b JOIN tasks t ON t.id = b.task_id
      WHERE b."end" > ? AND b.task_id <> ? AND t.status <> 'done' AND t.deleted_at IS NULL`, [new Date(Math.max(fromMs, ctx.clock.now().getTime())).toISOString(), taskId],
  ).filter((b) => b.pin_id == null || b.pin_id !== pinId).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end), title: eventTitle({ course: b.course, title: b.title, isExam: b.type === 'exam' }) }));
  return { blocked, free: mergeIntervals(free), busy, exams, pins, blocks };
}

/** Free places of the same length for a refused drop: on the same day first, then the next days, closest to where it was dropped. */
function suggest(ctx: Ctx, o: Obstacles, startMs: number, durMs: number, latestEnd: number, nowMs: number): Slot[] {
  const taken = mergeIntervals([...o.busy, ...o.exams, ...o.pins, ...o.blocks]);
  const open = subtractIntervals(o.free, taken).map((w) => ({ start: Math.max(w.start, nowMs), end: Math.min(w.end, latestEnd) })).filter((w) => w.end - w.start >= durMs);
  const cands: number[] = [];
  for (const w of open) {
    for (let s = Math.ceil(w.start / STEP) * STEP; s + durMs <= w.end; s += STEP) cands.push(s);
  }
  const day = (ms: number) => fmt(ms, ctx.tz, 'yyyy-MM-dd');
  const same = day(startMs);
  cands.sort((a, b) => (day(a) === same ? 0 : 1) - (day(b) === same ? 0 : 1) || Math.abs(a - startMs) - Math.abs(b - startMs));
  const out: Slot[] = [];
  for (const s of cands) {
    if (out.some((x) => Math.abs(Date.parse(x.start) - s) < durMs)) continue; // spread the suggestions out
    out.push({ start: new Date(s).toISOString(), end: new Date(s + durMs).toISOString(), label: spanText(s, s + durMs, ctx.tz) });
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Can this block be pinned here? `busy` is the Google busy time (free/busy only) for the days involved, fetched by the caller.
 * Refusals say why in plain words and suggest where it can go.
 */
export function checkPin(ctx: Ctx, input: { taskId: number; start: number; end: number; pinId?: number }, busy: Interval[]): PinCheck {
  const tz = ctx.tz;
  const nowMs = ctx.clock.now().getTime();
  const { start, end, taskId } = input;
  const t = getTask(ctx, taskId);
  const dur = end - start;
  const dueMs = t?.due_date ? Date.parse(t.due_date) : Infinity;
  const fromMs = DateTime.fromMillis(start, { zone: tz }).startOf('day').toMillis();
  const toMs = Math.max(DateTime.fromMillis(end, { zone: tz }).endOf('day').toMillis() + 1, fromMs + 3 * 86_400_000);
  const o = obstacles(ctx, taskId, input.pinId, fromMs, toMs, busy);
  const no = (reason: Exclude<PinCheck, { ok: true }>['reason'], message: string): PinCheck => ({ ok: false, reason, message, suggestions: dur > 0 && t ? suggest(ctx, o, start, dur, dueMs, nowMs) : [] });
  if (!t) return { ok: false, reason: 'task', message: `No open task #${taskId}.`, suggestions: [] };
  if (t.status === 'done') return { ok: false, reason: 'task', message: `“${t.title}” is done, so there is nothing to pin.`, suggestions: [] };
  if (start % GRID || end % GRID) return no('grid', 'Pinned blocks start and end on 5-minute marks.');
  const { hours } = loadScheduleSettings(ctx, loadWorkingHours(ctx, currentTerm(ctx)?.id).hours);
  if (dur < hours.min_block_minutes * MIN || dur > hours.max_block_minutes * MIN) {
    return no('length', `A block must be between ${hours.min_block_minutes} and ${hours.max_block_minutes} minutes long (Settings, Scheduling: shortest and longest block); this one is ${Math.round(dur / MIN)}.`);
  }
  if (start < nowMs) return no('past', 'That time has already started. Pick a time that is still ahead.');
  if (end > dueMs) return no('after_due', `That ends after “${t.title}” is due (${fmt(dueMs, tz, 'ccc LLL d, h:mm a')}).`);
  const span = { start, end };
  const bl = o.blocked.find((b) => overlaps(b, span));
  if (bl) return no('blocked', `That lands in time you blocked in Availability (${timeText(bl.start, bl.end, tz)}).`);
  if (subtractIntervals([span], o.free).length) {
    const day = DateTime.fromMillis(start, { zone: tz }).toISODate()!;
    const freeToday = o.free.filter((f) => fmt(f.start, tz, 'yyyy-MM-dd') === day).map((f) => timeText(f.start, f.end, tz));
    return no('outside', `That is outside your available time on ${fmt(start, tz, 'cccc')} (${freeToday.length ? `free: ${freeToday.join(', ')}` : 'no free time set'}). Add the time in Availability first, or pick one of the suggested times.`);
  }
  const bz = o.busy.find((b) => overlaps(b, span));
  if (bz) return no('busy', `That overlaps busy time on your calendar (${timeText(Math.max(bz.start, start), Math.min(bz.end, end), tz)}), such as a class or the gym.`);
  const ex = o.exams.find((b) => overlaps(b, span));
  if (ex) return no('exam', `That overlaps the exam “${ex.title}” (${timeText(ex.start, ex.end, tz)}).`);
  const pn = o.pins.find((b) => overlaps(b, span));
  if (pn) return no('pin', `That overlaps another pinned block, “${pn.title}” (${timeText(pn.start, pn.end, tz)}).`);
  const bk = o.blocks.find((b) => overlaps(b, span));
  if (bk) return no('block', `That overlaps a planned block, “${bk.title}” (${timeText(bk.start, bk.end, tz)}).`);
  return { ok: true };
}

export function createPin(ctx: Ctx, taskId: number, start: number, end: number): PinRow {
  const now = nowIso(ctx);
  const id = ctx.db.run('INSERT INTO pins(task_id, start, "end", created_at, updated_at) VALUES(?,?,?,?,?)', [taskId, new Date(start).toISOString(), new Date(end).toISOString(), now, now]).lastInsertRowid;
  return getPin(ctx, id)!;
}

export function movePin(ctx: Ctx, pinId: number, start: number, end: number): PinRow {
  ctx.db.run('UPDATE pins SET start = ?, "end" = ?, updated_at = ? WHERE id = ?', [new Date(start).toISOString(), new Date(end).toISOString(), nowIso(ctx), pinId]);
  return getPin(ctx, pinId)!;
}

/**
 * Stop pinning a block. Its Google event (if it was written) stays where it is until the next Apply, which then places the task's
 * work automatically again. "Unpin" and "Move back to automatic" both do this; the window shows the automatic placement right away
 * for the second one.
 */
export function removePin(ctx: Ctx, pinId: number): PinRow {
  const p = getPin(ctx, pinId);
  if (!p) throw new Error(`No pinned block #${pinId}.`);
  ctx.db.transaction(() => {
    ctx.db.run('UPDATE scheduled_blocks SET pin_id = NULL WHERE pin_id = ?', [pinId]);
    ctx.db.run('DELETE FROM pins WHERE id = ?', [pinId]);
  });
  return p;
}
