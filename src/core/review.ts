import { DateTime } from 'luxon';
import type { Ctx } from './ctx';
import { nowIso } from './ctx';
import { getSetting, setSetting } from '../db/repo';
import { scopeClause, getTask, completeTask, editTask, deleteTask, type EditPatch } from './tasks';
import { SIZE_UNITS } from './size';
import { logWork } from './timer';
import { recordChange } from './changeLog';

/**
 * The weekly review: a guided look back (what you finished), at what slipped, at what the planner cannot plan yet, and then a
 * replan. READING (`getReview`) never writes. Each step changes things only when its decisions are sent to `applyStep`, which
 * goes through the same core functions as the rest of the app and is recorded in the shared change history (so it can be undone).
 * The replan step reuses the Schedule screen's preview and its Apply confirmation; it is not duplicated here.
 */
export const REVIEW_LAST_KEY = 'review_last_at';
export const REVIEW_FIRST_SEEN_KEY = 'review_first_seen';
export const REVIEW_DUE_DAYS = 7;
export const REVIEW_AHEAD_DAYS = 14;
const MAX_ROWS = 60;

export interface ReviewState {
  lastReviewAt: string | null;
  daysSince: number | null;
  /** a review is due (a week since the last one, or since Tally was first used when there has never been one) */
  due: boolean;
}

/** Pure read. The first-seen date is written by the app (`ensureReviewClock`), never by a read. */
export function reviewState(ctx: Ctx): ReviewState {
  const last = getSetting(ctx.db, REVIEW_LAST_KEY) ?? null;
  const base = last ?? getSetting(ctx.db, REVIEW_FIRST_SEEN_KEY) ?? null;
  if (!base) return { lastReviewAt: null, daysSince: null, due: false };
  const days = (ctx.clock.now().getTime() - Date.parse(base)) / 86_400_000;
  return { lastReviewAt: last, daysSince: last ? Math.floor(days) : null, due: days >= REVIEW_DUE_DAYS };
}

/** Called by the app: remembers when Tally was first used, so a brand-new install is not "due" at once. */
export function ensureReviewClock(ctx: Ctx): void {
  if (!getSetting(ctx.db, REVIEW_FIRST_SEEN_KEY)) setSetting(ctx.db, REVIEW_FIRST_SEEN_KEY, nowIso(ctx));
}

export interface ReviewBlock { blockId: number; taskId: number; title: string; course: string | null; start: string; end: string; minutes: number; taskStatus: string }
export interface ReviewDueItem { taskId: number; title: string; course: string | null; due: string; status: string; timeAssumed: boolean }
export interface ReviewSlipped { taskId: number; title: string; course: string | null; due: string | null; reason: 'overdue' | 'missed_block'; detail: string }
export type ReviewProblem = 'no_estimate' | 'no_size' | 'time_assumed';
export interface ReviewNeedsInfo { taskId: number; title: string; course: string | null; due: string; problems: ReviewProblem[]; estimatedMinutes: number | null; sizeUnit: string | null; sizeAmount: number | null; timeAssumed: boolean }
export interface ReviewData {
  state: ReviewState;
  now: string;
  /** the look-back window starts here: the last review, or 7 days ago when there has been none */
  since: string;
  sinceIsLastReview: boolean;
  finished: { blocks: ReviewBlock[]; dueItems: ReviewDueItem[] };
  slipped: ReviewSlipped[];
  needsInfo: ReviewNeedsInfo[];
  aheadDays: number;
}

interface TRow { id: number; title: string; course: string | null; due_date: string | null; status: string; time_assumed: number; estimated_minutes: number | null; size_unit: string | null; size_amount: number | null; type: string }

/** Everything the review shows. Writes nothing. */
export function getReview(ctx: Ctx): ReviewData {
  const state = reviewState(ctx);
  const now = ctx.clock.now();
  const nowMs = now.getTime();
  const since = state.lastReviewAt ? new Date(state.lastReviewAt) : new Date(nowMs - REVIEW_DUE_DAYS * 86_400_000);
  const sc = scopeClause(ctx, {}, 't.term_id');
  const nowStr = now.toISOString();
  const sinceStr = since.toISOString();
  const aheadStr = new Date(nowMs + REVIEW_AHEAD_DAYS * 86_400_000).toISOString();

  const blocks = ctx.db.all<{ id: number; task_id: number; start: string; end: string; title: string; course: string | null; status: string }>(
    `SELECT b.id, b.task_id, b.start, b."end" "end", t.title, t.course, t.status FROM scheduled_blocks b JOIN tasks t ON t.id = b.task_id
      WHERE t.deleted_at IS NULL AND ${sc.sql} AND b."end" > ? AND b."end" <= ? ORDER BY b.start LIMIT ${MAX_ROWS}`, [...sc.params, sinceStr, nowStr]);
  const dueItems = ctx.db.all<TRow>(
    `SELECT t.* FROM tasks t WHERE t.deleted_at IS NULL AND ${sc.sql} AND t.deadline_only = 0 AND t.due_date > ? AND t.due_date <= ? ORDER BY t.due_date LIMIT ${MAX_ROWS}`, [...sc.params, sinceStr, nowStr]);

  const overdue = ctx.db.all<TRow>(
    `SELECT t.* FROM tasks t WHERE t.deleted_at IS NULL AND ${sc.sql} AND t.status <> 'done' AND t.deadline_only = 0 AND t.due_date IS NOT NULL AND t.due_date < ? ORDER BY t.due_date LIMIT ${MAX_ROWS}`, [...sc.params, nowStr]);
  const missed = ctx.db.all<TRow & { n: number }>(
    `SELECT t.*, COUNT(b.id) n FROM scheduled_blocks b JOIN tasks t ON t.id = b.task_id
      WHERE t.deleted_at IS NULL AND ${sc.sql} AND t.status <> 'done' AND b."end" < ? AND b."end" > ?
      GROUP BY t.id ORDER BY MIN(b.start) LIMIT ${MAX_ROWS}`, [...sc.params, nowStr, sinceStr]);
  const local = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(ctx.tz);
  const slipped: ReviewSlipped[] = overdue.map((t) => {
    const days = Math.max(0, Math.floor((nowMs - Date.parse(t.due_date!)) / 86_400_000));
    return { taskId: t.id, title: t.title, course: t.course, due: t.due_date, reason: 'overdue' as const, detail: `was due ${local(t.due_date!).toFormat('ccc LLL d')}${days >= 1 ? ` (${days} day${days === 1 ? '' : 's'} ago)` : ''}` };
  });
  const have = new Set(slipped.map((s) => s.taskId));
  for (const t of missed) if (!have.has(t.id)) slipped.push({ taskId: t.id, title: t.title, course: t.course, due: t.due_date, reason: 'missed_block', detail: `${t.n} planned block${t.n === 1 ? '' : 's'} passed without it being finished` });

  const ahead = ctx.db.all<TRow>(
    `SELECT t.* FROM tasks t WHERE t.deleted_at IS NULL AND ${sc.sql} AND t.status <> 'done' AND t.deadline_only = 0 AND t.optional = 0 AND t.type <> 'attendance'
        AND t.due_date IS NOT NULL AND t.due_date >= ? AND t.due_date <= ? ORDER BY t.due_date LIMIT ${MAX_ROWS}`, [...sc.params, nowStr, aheadStr]);
  const needsInfo: ReviewNeedsInfo[] = [];
  for (const t of ahead) {
    const problems: ReviewProblem[] = [];
    if (t.estimated_minutes == null && t.size_amount == null) problems.push('no_estimate');
    if (t.size_unit && t.size_amount == null) problems.push('no_size');
    if (t.time_assumed) problems.push('time_assumed');
    if (problems.length) needsInfo.push({ taskId: t.id, title: t.title, course: t.course, due: t.due_date!, problems, estimatedMinutes: t.estimated_minutes, sizeUnit: t.size_unit, sizeAmount: t.size_amount, timeAssumed: !!t.time_assumed });
  }

  return {
    state, now: nowStr, since: sinceStr, sinceIsLastReview: !!state.lastReviewAt,
    finished: {
      blocks: blocks.map((b) => ({ blockId: b.id, taskId: b.task_id, title: b.title, course: b.course, start: b.start, end: b.end, minutes: Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000), taskStatus: b.status })),
      dueItems: dueItems.map((t) => ({ taskId: t.id, title: t.title, course: t.course, due: t.due_date!, status: t.status, timeAssumed: !!t.time_assumed })),
    },
    slipped, needsInfo, aheadDays: REVIEW_AHEAD_DAYS,
  };
}

// ---- decisions (what the person chose; nothing is written until a step is applied) ----
export type StepA = { taskId: number; blockId?: number; result: 'done' | 'partly' | 'not'; minutes?: number };
export type StepB = { taskId: number; action: 'reschedule' | 'done' | 'drop' | 'keep'; due?: string };
export type StepC = { taskId: number; estimate?: number; sizeAmount?: number; sizeUnit?: string; due?: string };
export type StepResult = { step: 'a' | 'b' | 'c'; summary: string; counts: Record<string, number>; changeId: number | null; skipped: string[] };

const label = (ctx: Ctx, id: number) => { const t = getTask(ctx, id); return t ? `#${t.id} “${t.title}”` : `#${id}`; };

/** Check every decision first, so a bad one refuses the whole step before anything is written. */
function need(ctx: Ctx, taskId: number) {
  const t = getTask(ctx, taskId);
  if (!t) throw new Error(`Task #${taskId} no longer exists. Reload the review.`);
  return t;
}

export function applyStep(ctx: Ctx, step: 'a' | 'b' | 'c', decisions: unknown[]): StepResult {
  if (!Array.isArray(decisions) || decisions.length === 0) throw new Error('Nothing was chosen for this step, so nothing was changed.');
  if (decisions.length > 200) throw new Error('Too many decisions at once (200 at most).');
  const counts: Record<string, number> = {};
  const skipped: string[] = [];
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  const seen = new Set<number>();
  const once = (id: number) => { if (seen.has(id)) throw new Error(`${label(ctx, id)} appears twice in this step.`); seen.add(id); };

  const body = (): void => {
    if (step === 'a') {
      for (const d of decisions as StepA[]) {
        const t = need(ctx, d.taskId); once(d.taskId);
        if (d.result === 'done') { if (t.status === 'done') { skipped.push(`${label(ctx, t.id)} was already done`); continue; } completeTask(ctx, t.id); bump('done'); }
        else if (d.result === 'partly') {
          const block = d.blockId ? ctx.db.get<{ start: string; end: string }>('SELECT start, "end" "end" FROM scheduled_blocks WHERE id = ? AND task_id = ?', [d.blockId, t.id]) : undefined;
          const mins = d.minutes ?? (block ? Math.max(5, Math.round((Date.parse(block.end) - Date.parse(block.start)) / 120_000 / 5) * 5) : undefined);
          if (!mins || !Number.isInteger(mins) || mins <= 0) throw new Error(`Say how many minutes you did on ${label(ctx, t.id)}.`);
          logWork(ctx, t.id, mins); bump('partly');
        } else if (d.result === 'not') bump('not done');
        else throw new Error(`Unknown answer for ${label(ctx, t.id)}.`);
      }
    } else if (step === 'b') {
      for (const d of decisions as StepB[]) {
        const t = need(ctx, d.taskId); once(d.taskId);
        if (d.action === 'reschedule') {
          if (!d.due?.trim()) throw new Error(`Give a new due date for ${label(ctx, t.id)}.`);
          editTask(ctx, t.id, { due: d.due.trim() }); bump('rescheduled');
        } else if (d.action === 'done') { if (t.status !== 'done') completeTask(ctx, t.id); bump('done'); }
        else if (d.action === 'drop') { deleteTask(ctx, t.id); bump('dropped'); }
        else if (d.action === 'keep') bump('kept');
        else throw new Error(`Unknown choice for ${label(ctx, t.id)}.`);
      }
    } else {
      for (const d of decisions as StepC[]) {
        const t = need(ctx, d.taskId); once(d.taskId);
        const patch: EditPatch = {};
        if (d.estimate != null) patch.est = d.estimate;
        if (d.sizeAmount != null) {
          const unit = (d.sizeUnit ?? t.size_unit) as string | null;
          if (!unit || !(SIZE_UNITS as readonly string[]).includes(unit)) throw new Error(`Choose what ${label(ctx, t.id)} is measured in (pages, video minutes, problems or items).`);
          patch.size = { amount: d.sizeAmount, unit: unit as never };
        }
        if (d.due?.trim()) patch.due = d.due.trim();
        if (Object.keys(patch).length === 0) { skipped.push(`${label(ctx, t.id)}: nothing entered`); continue; }
        editTask(ctx, t.id, patch);
        bump('fixed');
      }
    }
  };

  const name = { a: 'what you finished', b: 'overdue and slipped tasks', c: 'missing details' }[step];
  const { change } = recordChange(ctx, { actor: 'review', tool: `review_step_${step}`, summary: () => `Weekly review: ${name} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no changes'})` }, () => { body(); return null; });
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no changes';
  return { step, summary, counts, changeId: change?.changeId ?? null, skipped };
}

/** The person finished the review: remember when (this clears the "review due" marker). */
export function finishReview(ctx: Ctx): ReviewState {
  setSetting(ctx.db, REVIEW_LAST_KEY, nowIso(ctx));
  return reviewState(ctx);
}
