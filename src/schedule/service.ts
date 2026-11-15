import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import { currentTerm } from '../core/terms';
import { listTasks, type Task } from '../core/tasks';
import { buildLearning } from '../core/learning';
import { effectiveEstimate, loadLearnedRates, loadRates } from '../core/size';
import type { CalendarClient } from './calendar';
import type { Interval, PlanBlock, PlanProblem, SchedTask } from './types';
import { buildFreeIntervals, loadWindows, type WindowRow } from './availabilityWindows';
import { planSchedule, type PlanParams } from './plan';
import { subtractIntervals } from './availability';
import { openBlockerMap } from '../core/dependencies';
import { eventTitle } from './eventTitle';
import { examBusyIntervals, type ExamWindow } from './exams';
import { splitLongBusy, type FlaggedBlock } from './busy';
import { getBusyCalendars, getClassCalendars, loadWorkingHours } from './settings';
import { loadScheduleSettings, type PlacementSettings } from './params';
import type { WorkingHours } from './workingHours';
import { pinsForPlan, type PinWarning } from './pins';

const DAY = 86_400_000;
const MAX_HORIZON_DAYS = 90;

export interface PlannedTask extends SchedTask {
  task: Task;
  /** the estimate as entered (or size-based) before any multiplier */
  baseMinutes: number;
  multiplier: number | null;
  multiplierApplied: boolean;
  trackedMinutes: number;
  estimateSource: 'manual' | 'size';
  /** "5 problems x 15 min = 75 min (default rate)" for size-based estimates */
  formula?: string;
}
export interface TentativeBlock extends PlanBlock {
  waitingOn: number[];
}
export interface SkippedTask {
  task: Task;
  reason: string;
}

export interface PlanReport {
  nowMs: number;
  tz: string;
  /** numeric knobs (min/max block, buffer, slack, lead...) with plain settings applied */
  hours: WorkingHours;
  placement: PlacementSettings;
  /** the availability windows the plan was built from */
  windowRows: WindowRow[];
  /** blocks starting inside the horizon: what is shown and what apply would write */
  blocks: PlanBlock[];
  horizonEndMs: number;
  totalPlannedBlocks: number;
  problems: PlanProblem[];
  /** blocked tasks projected as if their blockers finish at the end of their planned blocks; NEVER written to Google */
  tentative: TentativeBlock[];
  /** tentative tasks that would not fit (shown under DOES NOT FIT, labeled tentative) */
  tentativeProblems: PlanProblem[];
  /** tentative task id -> its open blockers */
  waitingOn: Map<number, Task[]>;
  skipped: SkippedTask[];
  tasks: Map<number, PlannedTask>;
  classBusy: Interval[];
  /** selected free time minus busy time */
  windows: Interval[];
  /** exams with a real time, blocked as busy */
  examWindows: ExamWindow[];
  /** all-day-length busy blocks that were ignored (see ignore_busy_at_least_hours) */
  ignoredBusy: FlaggedBlock[];
  /** pinned blocks the plan did not keep (task done or deleted, due date moved before the pin) or that now overlap busy time */
  pinWarnings: PinWarning[];
}

export interface PlanOptions {
  days?: number;
  /** use these class calendars instead of the saved setting (simulated-calendar previews) */
  classCalendarIds?: string[];
}

export const NO_AVAILABILITY = 'No availability is set yet, so there is nowhere to put work.\nCreate it from your current routine and calendar: npm run plan -- availability seed\nor set it by hand: npm run plan -- availability set mon 09:00-17:00';

export async function computePlan(ctx: Ctx, calendar: CalendarClient, opts: PlanOptions = {}): Promise<PlanReport> {
  const nowMs = ctx.clock.now().getTime();
  const days = opts.days ?? 7;
  const term = currentTerm(ctx);
  const { hours, placement } = loadScheduleSettings(ctx, loadWorkingHours(ctx, term?.id).hours);
  const windowRows = loadWindows(ctx);
  if (!windowRows.length) throw new Error(NO_AVAILABILITY);
  const classIds = opts.classCalendarIds ?? getClassCalendars(ctx) ?? [];

  // Which open tasks can be planned, and why the others cannot.
  const learning = buildLearning(ctx);
  const rates = loadRates(ctx).all;
  const learned = loadLearnedRates(ctx, rates);
  const tasks = new Map<number, PlannedTask>();
  const skipped: SkippedTask[] = [];
  const openTasks = listTasks(ctx, { status: 'open' });
  const blockerMap = openBlockerMap(ctx);
  const stepCounts = new Map(ctx.db.all<{ p: number; n: number }>("SELECT parent_task_id p, COUNT(*) n FROM tasks WHERE parent_task_id IS NOT NULL AND status <> 'done' AND deleted_at IS NULL GROUP BY parent_task_id").map((r) => [r.p, r.n]));
  // Why a task cannot be planned, or the planned task. Blocked tasks go through the same checks: if they pass, they are
  // projected as TENTATIVE below (planned as if their blockers finish at the end of their own planned blocks).
  const evaluate = (t: Task): { skip: string } | { planned: PlannedTask } => {
    const eff = effectiveEstimate(t, rates, learned);
    if (t.type === 'attendance') return { skip: 'attendance tasks are not scheduled' };
    if (!t.due_date) return { skip: 'no due date' };
    if (t.optional && !placement.include_optional_tasks) return { skip: 'optional (set include_optional_tasks true to schedule these)' };
    if (eff.minutes == null) {
      return { skip: t.size_unit && t.size_amount == null ? `size unknown: add it with  edit ${t.id} --size <amount> ${t.size_unit}` : t.size_amount ? `no rate for ${t.size_unit} in ${t.course ?? 'this course'} (config set size_rates)` : 'no estimate (add one with: edit <id> --est <minutes>)' };
    }
    if (new Date(t.due_date).getTime() <= nowMs) return { skip: 'due date has already passed (overdue)' };
    // size-based estimates are never multiplied again by the per-type multiplier (no double counting)
    const m = eff.source === 'size' ? { minutes: eff.minutes, applied: false, multiplier: null as number | null } : learning.apply(eff.minutes, t);
    const tracked = t.actual_minutes ?? 0;
    const remaining = m.minutes - tracked;
    if (remaining <= 0) return { skip: `estimate already used up (${tracked} of ${m.minutes} min tracked); raise the estimate or mark it done` };
    return {
      planned: {
        id: t.id, title: t.title, course: t.course, dueMs: new Date(t.due_date).getTime(), minutes: remaining, weight: t.grade_weight,
        task: t, isExam: t.type === 'exam', baseMinutes: eff.minutes, multiplier: m.multiplier, multiplierApplied: m.applied, trackedMinutes: tracked,
        estimateSource: eff.source!, formula: eff.formula,
        availableMs: t.available_from ? DateTime.fromISO(t.available_from, { zone: ctx.tz }).startOf('day').toMillis() : undefined,
      },
    };
  };
  const waiting = new Map<number, { planned: PlannedTask; blockers: Task[] }>();
  const blockedReason = (blockers: Task[], extra = '') => `blocked by ${blockers.slice(0, 2).map((b) => `#${b.id} ${b.title}`).join(', ')}${blockers.length > 2 ? ` and ${blockers.length - 2} more` : ''} (scheduled once ${blockers.length > 1 ? 'they are' : 'it is'} done)${extra}`;
  for (const t of openTasks) {
    if (t.deadline_only) continue; // a deadline or event, not work: neither planned nor listed as not scheduled
    if (stepCounts.get(t.id)) {
      skipped.push({ task: t, reason: `its work is planned as ${stepCounts.get(t.id)} step task(s) (see: show ${t.id})` });
      continue;
    }
    const r = evaluate(t);
    const blockers = blockerMap.get(t.id);
    if ('skip' in r) skipped.push({ task: t, reason: blockers?.length ? blockedReason(blockers) : r.skip });
    else if (blockers?.length) waiting.set(t.id, { planned: r.planned, blockers });
    else tasks.set(t.id, r.planned);
  }

  const calendars = await calendar.listCalendars(); // first call: surfaces an expired connection early
  for (const id of calendar.unavailable ? [] : classIds) {
    if (!calendars.some((c) => c.id === id)) {
      throw new Error(`Class calendar "${id}" was not found. Available: ${calendars.map((c) => `${c.id} (${c.summary})`).join(', ') || '(none)'}`);
    }
  }
  const plannerId = await calendar.findPlannerCalendarId();
  // Planner Blocks is never busy time: its future events are deleted and rewritten by apply, so a dry run matches an apply.
  const busyIds = [...new Set([...(getBusyCalendars(ctx) ?? calendars.map((c) => c.id)), ...classIds])].filter((id) => id !== plannerId);

  const maxDue = Math.max(nowMs, ...[...tasks.values()].map((t) => t.dueMs));
  const toMs = Math.min(maxDue + DAY, nowMs + MAX_HORIZON_DAYS * DAY);
  const exams = examBusyIntervals(openTasks, hours.exam_duration_minutes, hours.buffer_minutes);
  let busy: Interval[] = [...exams.busy];
  let classBusy: Interval[] = [];
  const ignoredBusy: FlaggedBlock[] = [];
  if (tasks.size && busyIds.length) {
    const fb = await calendar.freeBusy(busyIds, nowMs, toMs);
    const kept: Record<string, Interval[]> = {};
    for (const id of busyIds) {
      const s = splitLongBusy(fb[id] ?? [], hours.ignore_busy_at_least_hours);
      kept[id] = s.kept;
      for (const b of s.ignored) ignoredBusy.push({ calendarId: id, calendar: calendars.find((c) => c.id === id)?.summary ?? id, start: b.start, end: b.end, hours: (b.end - b.start) / 3_600_000 });
    }
    busy = [...exams.busy, ...busyIds.flatMap((id) => kept[id])];
    classBusy = classIds.flatMap((id) => kept[id] ?? []);
  }

  // Pinned blocks (moved by hand): fixed. They are busy time for every other task (with the usual gap around them), their minutes
  // count toward their own task, and they are written exactly where they are. Pins the plan cannot keep come back as warnings.
  const pinInfo = pinsForPlan(ctx, nowMs, busy.filter((b) => !exams.busy.includes(b)));
  const pinCredit = new Map<number, number>();
  for (const p of pinInfo.active) pinCredit.set(p.taskId, (pinCredit.get(p.taskId) ?? 0) + (p.end - Math.max(p.start, nowMs)) / 60_000);
  const covered = new Set<number>();
  const credit = (pt: PlannedTask) => {
    const c = pinCredit.get(pt.id);
    if (!c) return;
    pt.minutes = Math.max(0, Math.round(pt.minutes - c));
    if (pt.minutes <= 0) covered.add(pt.id);
  };
  for (const pt of tasks.values()) credit(pt);
  for (const w of waiting.values()) credit(w.planned);
  for (const p of pinInfo.active) {
    if (tasks.has(p.taskId) || waiting.has(p.taskId)) continue;
    // a pinned task the planner would not schedule by itself (no estimate, ...): it still needs a name for the event
    const t = p.task;
    tasks.set(t.id, {
      id: t.id, title: t.title, course: t.course, dueMs: t.due_date ? Date.parse(t.due_date) : p.end, minutes: 0, weight: t.grade_weight, task: t, isExam: t.type === 'exam',
      baseMinutes: 0, multiplier: null, multiplierApplied: false, trackedMinutes: t.actual_minutes ?? 0, estimateSource: 'manual',
    });
    covered.add(t.id);
  }
  const pad = hours.buffer_minutes * 60_000;
  busy = [...busy, ...pinInfo.active.map((p) => ({ start: p.start - pad, end: p.end + pad }))];
  const pinnedBlocks: PlanBlock[] = pinInfo.active.map((p) => ({ taskId: p.taskId, start: p.start, end: p.end, part: 1, parts: 1, padded: false, pinned: true, pinId: p.id }));

  const windows = buildFreeIntervals(windowRows, nowMs, toMs, ctx.tz, busy, hours.min_block_minutes);
  const params: PlanParams = {
      minBlock: hours.min_block_minutes, maxBlock: hours.max_block_minutes, buffer: hours.buffer_minutes, slackMin: hours.deadline_slack_minutes,
      leadMin: hours.min_lead_minutes, longTaskMinutes: hours.long_task_minutes, longTaskMinBlock: hours.long_task_min_block_minutes,
      spreadMinutes: hours.spread_threshold_minutes, spreadDailyMax: hours.spread_daily_max_minutes, spreadDaysBefore: hours.spread_days_before_deadline,
      examPrepEndBefore: hours.exam_prep_end_before_minutes, examPrepDailyMax: hours.exam_prep_daily_max_minutes, tz: ctx.tz,
      placement: placement.placement_style, earlyLeadDays: placement.early_lead_days, finishBefore: placement.finish_before_deadline_minutes, maxDailyWork: placement.max_daily_work_minutes,
  };
  const plan = planSchedule({ nowMs, windows, tasks: [...tasks.values()].filter((t) => !covered.has(t.id)), params });

  // TENTATIVE projections: blocked tasks planned as if each blocker finishes at the end of its own planned blocks, in
  // the time the real plan leaves free. Never written to Google. Chains resolve layer by layer.
  const tentative: TentativeBlock[] = [];
  const tentativeProblems: PlanProblem[] = [];
  const waitingOn = new Map<number, Task[]>();
  const finishOf = new Map<number, number>();
  for (const b of [...plan.blocks, ...pinnedBlocks]) finishOf.set(b.taskId, Math.max(finishOf.get(b.taskId) ?? 0, b.end));
  let free = subtractIntervals(windows, plan.blocks.map((b) => ({ start: b.start - hours.buffer_minutes * 60_000, end: b.end + hours.buffer_minutes * 60_000 })));
  const pending = new Map(waiting);
  while (pending.size) {
    const layer = [...pending.values()].filter((w) => w.blockers.every((b) => finishOf.has(b.id)));
    if (!layer.length) break;
    const sched = layer.filter((w) => !covered.has(w.planned.id)).map((w) => ({ ...w.planned, availableMs: Math.max(w.planned.availableMs ?? 0, ...w.blockers.map((b) => finishOf.get(b.id)!)) }));
    const res = planSchedule({ nowMs, windows: free, tasks: sched, params });
    for (const w of layer) {
      pending.delete(w.planned.id);
      tasks.set(w.planned.id, w.planned);
      waitingOn.set(w.planned.id, w.blockers);
    }
    for (const b of res.blocks) {
      tentative.push({ ...b, waitingOn: waiting.get(b.taskId)!.blockers.map((x) => x.id) });
      finishOf.set(b.taskId, Math.max(finishOf.get(b.taskId) ?? 0, b.end));
    }
    tentativeProblems.push(...res.problems);
    free = subtractIntervals(free, res.blocks.map((b) => ({ start: b.start - hours.buffer_minutes * 60_000, end: b.end + hours.buffer_minutes * 60_000 })));
  }
  for (const w of pending.values()) skipped.push({ task: w.planned.task, reason: blockedReason(w.blockers, '; its blocker has no planned time yet, so it cannot be projected') });
  tentative.sort((a, b) => a.start - b.start || a.taskId - b.taskId);

  const horizonEndMs = nowMs + days * DAY;
  // Pinned blocks are always included (whatever the horizon), so an apply never takes one off the calendar. Parts are renumbered
  // per task across automatic and pinned blocks so event titles read "part 1 of 3" in time order.
  const blocks = [...plan.blocks.filter((b) => b.start < horizonEndMs), ...pinnedBlocks].sort((a, b) => a.start - b.start || a.taskId - b.taskId);
  const allByTask = new Map<number, PlanBlock[]>();
  for (const b of [...plan.blocks, ...pinnedBlocks].sort((a, b) => a.start - b.start)) allByTask.set(b.taskId, [...(allByTask.get(b.taskId) ?? []), b]);
  for (const list of allByTask.values()) list.forEach((b, i) => { b.part = i + 1; b.parts = list.length; });
  return {
    nowMs, tz: ctx.tz, hours, placement, windowRows, horizonEndMs, totalPlannedBlocks: plan.blocks.length + pinnedBlocks.length, pinWarnings: pinInfo.warnings,
    blocks, problems: plan.problems, tentative, tentativeProblems, waitingOn, skipped, tasks, classBusy, windows, examWindows: exams.windows, ignoredBusy,
  };
}

export interface OldBlockRow {
  taskId: number;
  start: string;
  end: string;
  missed: boolean;
}
export interface MovedEntry {
  taskId: number;
  reason: 'missed' | 'shifted' | 'removed';
  from: { start: number; end: number }[];
  to: { start: number; end: number }[];
}

/** What changed for tasks that already had planner blocks: missed ones, shifted ones, ones that no longer have any. */
export function describeMoves(old: OldBlockRow[], next: PlanBlock[]): MovedEntry[] {
  const byTask = new Map<number, OldBlockRow[]>();
  for (const r of old) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const out: MovedEntry[] = [];
  for (const [taskId, rows] of byTask) {
    const from = rows.map((r) => ({ start: Date.parse(r.start), end: Date.parse(r.end) })).sort((a, b) => a.start - b.start);
    const to = next.filter((b) => b.taskId === taskId).map((b) => ({ start: b.start, end: b.end })).sort((a, b) => a.start - b.start);
    const same = from.length === to.length && from.every((f, i) => f.start === to[i].start && f.end === to[i].end);
    if (rows.some((r) => r.missed)) out.push({ taskId, reason: 'missed', from, to });
    else if (!to.length) out.push({ taskId, reason: 'removed', from, to });
    else if (!same) out.push({ taskId, reason: 'shifted', from, to });
  }
  return out.sort((a, b) => a.taskId - b.taskId);
}

/** A block that was in progress (started, not finished, task still open) when the plan was made. */
export interface TrimEntry {
  taskId: number;
  title: string;
  course?: string | null;
  block: { start: number; end: number };
  /** 'trimmed': the part already elapsed is kept as history, ending now. 'removed': too little had elapsed to keep. */
  action: 'trimmed' | 'removed';
  keptMinutes: number;
}

export interface ApplyResult {
  deleted: number;
  created: number;
  missedRemoved: number;
  moved: MovedEntry[];
  trimmed: TrimEntry[];
}

interface BlockRow {
  id: number;
  task_id: number;
  start: string;
  end: string;
  google_event_id: string | null;
  status: string | null;
  title: string | null;
  course: string | null;
  /** the pin this written block belongs to, if that pin still exists */
  live_pin: number | null;
}

/**
 * Replace this app's future planner blocks with the report's blocks. Writes go only to the Planner
 * Blocks calendar. Past blocks stay as history, except with `replan`, which also removes blocks
 * that were missed (in the past, task still open) so their work is re-placed.
 */
function selectDoomed(ctx: Ctx, nowMs: number, replan: boolean) {
  const nowStr = new Date(nowMs).toISOString();
  const rows = ctx.db.all<BlockRow>(
    `SELECT b.id, b.task_id, b.start, b."end", b.google_event_id, t.status, t.title, t.course, p.id AS live_pin
       FROM scheduled_blocks b LEFT JOIN tasks t ON t.id = b.task_id LEFT JOIN pins p ON p.id = b.pin_id`,
  );
  const future = rows.filter((r) => r.start >= nowStr);
  // a pinned block in the past is history, even on replan (it was where you put it)
  const missed = replan ? rows.filter((r) => r.end < nowStr && r.status && r.status !== 'done' && r.live_pin == null) : [];
  // Started but not finished, task still open: the rest of it is replaced by the new plan, so it must not linger.
  // A pinned one is rewritten whole from its pin instead of being trimmed.
  const running = rows.filter((r) => r.start < nowStr && r.end > nowStr && r.status && r.status !== 'done');
  const inProgress = running.filter((r) => r.live_pin == null);
  const runningPinned = running.filter((r) => r.live_pin != null);
  return { future, missed, inProgress, doomed: [...future, ...runningPinned, ...missed] };
}

const trimEntry = (r: BlockRow, nowMs: number, minBlockMin: number): TrimEntry => {
  const kept = Math.floor((nowMs - Date.parse(r.start)) / 60_000);
  return { taskId: r.task_id, title: r.title ?? `#${r.task_id}`, course: r.course, block: { start: Date.parse(r.start), end: Date.parse(r.end) }, action: kept >= minBlockMin ? 'trimmed' : 'removed', keptMinutes: kept >= minBlockMin ? kept : 0 };
};

/** What apply would trim: in-progress blocks (for dry runs). */
export function previewTrims(ctx: Ctx, report: PlanReport): TrimEntry[] {
  return selectDoomed(ctx, report.nowMs, false).inProgress.map((r) => trimEntry(r, report.nowMs, report.hours.min_block_minutes));
}

/** How many earlier blocks an apply would remove, for the confirm step. */
export function previewRemoveCount(ctx: Ctx, report: PlanReport, replan: boolean): number {
  return selectDoomed(ctx, report.nowMs, replan).future.length;
}

/** What a replan would move, without touching anything (for dry runs). */
export function previewMoves(ctx: Ctx, report: PlanReport, replan: boolean): { moved: MovedEntry[]; missedCount: number } {
  const { doomed, missed } = selectDoomed(ctx, report.nowMs, replan);
  return { moved: describeMoves(doomed.map((r) => ({ taskId: r.task_id, start: r.start, end: r.end, missed: missed.includes(r) })), report.blocks), missedCount: missed.length };
}

export async function applyPlan(ctx: Ctx, calendar: CalendarClient, report: PlanReport, opts: { replan?: boolean } = {}): Promise<ApplyResult> {
  const { future, missed, doomed, inProgress } = selectDoomed(ctx, report.nowMs, !!opts.replan);

  // In-progress blocks: keep the elapsed part as history (ending now) or drop the block if hardly any has elapsed.
  // Elapsed time is NOT credited as work done; the user logs that (`log <id> <minutes>`), and planning uses the remaining estimate.
  const trimmed: TrimEntry[] = [];
  for (const r of inProgress) {
    const e = trimEntry(r, report.nowMs, report.hours.min_block_minutes);
    if (r.google_event_id) await calendar.deletePlannerEvent(r.google_event_id);
    if (e.action === 'trimmed') {
      const endMs = Math.floor(report.nowMs / 60_000) * 60_000;
      const id = await calendar.createPlannerEvent({ summary: `${e.course ? `${e.course}: ` : ''}${e.title} (stopped early)`, description: `task #${r.task_id}\nA planned block that was in progress when the plan was rewritten; trimmed to the time that had elapsed.\nPlanned by todo-planner.`, startMs: Date.parse(r.start), endMs, timeZone: ctx.tz });
      ctx.db.run('UPDATE scheduled_blocks SET "end" = ?, google_event_id = ? WHERE id = ?', [new Date(endMs).toISOString(), id, r.id]);
    } else ctx.db.run('DELETE FROM scheduled_blocks WHERE id = ?', [r.id]);
    trimmed.push(e);
  }

  for (const r of doomed) {
    if (r.google_event_id) await calendar.deletePlannerEvent(r.google_event_id);
    ctx.db.run('DELETE FROM scheduled_blocks WHERE id = ?', [r.id]);
  }

  let created = 0;
  for (const b of report.blocks) {
    const t = report.tasks.get(b.taskId)!;
    const summary = eventTitle({ course: t.course, title: t.title, isExam: !!t.isExam, part: b.part, parts: b.parts });
    const description = [t.course, `task #${t.id}`, `due ${new Date(t.dueMs).toISOString()}`, b.padded ? `block padded to the minimum length` : null, 'Planned by todo-planner; rewritten on every schedule run.']
      .filter(Boolean).join('\n');
    const eventId = await calendar.createPlannerEvent({ summary, description: b.pinned ? description.replace('rewritten on every schedule run.', 'pinned by hand at this time.') : description, startMs: b.start, endMs: b.end, timeZone: ctx.tz });
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end", google_event_id, pin_id) VALUES(?,?,?,?,?)', [b.taskId, new Date(b.start).toISOString(), new Date(b.end).toISOString(), eventId, b.pinned ? b.pinId ?? null : null]);
    created++;
  }
  const moved = describeMoves(doomed.map((r) => ({ taskId: r.task_id, start: r.start, end: r.end, missed: missed.includes(r) })), report.blocks);
  return { deleted: future.length, created, missedRemoved: missed.length, moved, trimmed };
}


