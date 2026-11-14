import type { Ctx } from './ctx';
import { getSetting } from '../db/repo';
import { listTasks, type Scope, type Task } from './tasks';
import { openBlockerMap } from './dependencies';
import { effectiveEstimate, loadLearnedRates, loadRates } from './size';
import { formatLocal } from '../time';

export interface ViewItem {
  task: Task;
  /** one plain-English line saying why the task is in this view */
  reason: string;
  /** minutes of work still to do (estimate minus logged), when known */
  minutes: number | null;
}

export interface ViewSettings {
  dueSoonHours: number;
  quickWinMinutes: number;
  /** High Grade Impact: days until due at which urgency is 0.5 */
  impactUrgencyDays: number;
  /** High Grade Impact: hours of remaining work that halve the score */
  impactEffortHours: number;
  /** High Grade Impact: minutes assumed for a task with no estimate */
  impactDefaultMinutes: number;
  /** High Grade Impact: how many items to show */
  impactLimit: number;
}

export const DEFAULT_VIEW_SETTINGS: ViewSettings = { dueSoonHours: 72, quickWinMinutes: 20, impactUrgencyDays: 7, impactEffortHours: 4, impactDefaultMinutes: 60, impactLimit: 10 };

/** Settable with `config set <key> <positive number>`. */
export const VIEW_KEYS = ['views_due_soon_hours', 'views_quick_win_minutes', 'impact_urgency_days', 'impact_effort_hours', 'impact_default_minutes', 'impact_limit'];
export function checkViewSetting(key: string, value: string): string {
  const n = Number(value);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error(`${key} must be a positive number.`);
  return String(n);
}

export function loadViewSettings(ctx: Ctx): ViewSettings {
  const num = (key: string, d: number) => {
    const v = getSetting(ctx.db, key);
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const d = DEFAULT_VIEW_SETTINGS;
  return {
    dueSoonHours: num('views_due_soon_hours', d.dueSoonHours), quickWinMinutes: num('views_quick_win_minutes', d.quickWinMinutes),
    impactUrgencyDays: num('impact_urgency_days', d.impactUrgencyDays), impactEffortHours: num('impact_effort_hours', d.impactEffortHours),
    impactDefaultMinutes: num('impact_default_minutes', d.impactDefaultMinutes), impactLimit: Math.floor(num('impact_limit', d.impactLimit)),
  };
}

/** "3 hours", "2 days 4 hours", "35 min": plain English for a span. */
export function spanText(ms: number): string {
  const min = Math.round(Math.abs(ms) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}${min % 60 >= 30 ? ' 30 min' : ''}`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d} days${rh ? ` ${rh} hours` : ''}`;
}

export const dueText = (dueMs: number, nowMs: number): string => (dueMs < nowMs ? `overdue by ${spanText(nowMs - dueMs)}` : `due in ${spanText(dueMs - nowMs)}`);

/**
 * High Grade Impact score: weight% x urgency x effort_factor.
 *   urgency       = 1 / (1 + daysLeft / impactUrgencyDays)      (due now = 1, overdue never gets here)
 *   effort_factor = 1 / (1 + remainingHours / impactEffortHours)
 */
export function impactScore(weightPct: number, daysLeft: number, remainingHours: number, s: Pick<ViewSettings, 'impactUrgencyDays' | 'impactEffortHours'>): number {
  const urgency = 1 / (1 + Math.max(0, daysLeft) / s.impactUrgencyDays);
  const effort = 1 / (1 + Math.max(0, remainingHours) / s.impactEffortHours);
  return weightPct * urgency * effort;
}

export const effortText = (minutes: number): string => (minutes >= 90 ? `~${Math.round((minutes / 60) * 2) / 2} hours of work` : `~${minutes} min of work`);

/** Open tasks in scope with their remaining minutes: the common input of every view. */
function openWithMinutes(ctx: Ctx, scope?: Scope) {
  const { all } = loadRates(ctx);
  const learned = loadLearnedRates(ctx, all);
  return listTasks(ctx, { status: 'open', scope }).map((t) => {
    const e = effectiveEstimate(t, all, learned);
    const minutes = e.minutes == null ? null : Math.max(0, e.minutes - (t.actual_minutes ?? 0));
    return { task: t, minutes };
  });
}

export interface Views {
  dueSoon: ViewItem[];
  highImpact: (ViewItem & { score: number })[];
  quickWins: ViewItem[];
  blocked: ViewItem[];
}

export interface ViewOptions {
  scope?: Scope;
}

/**
 * The computed views (nothing is sorted by hand). One query layer for the CLI and, later, the UI. Scoped like
 * every other list: the current term plus term-less tasks, unless a scope says otherwise.
 */
export function computeViews(ctx: Ctx, opts: ViewOptions = {}): Views {
  const nowMs = ctx.clock.now().getTime();
  const s = loadViewSettings(ctx);
  const blockers = openBlockerMap(ctx);
  const rows = openWithMinutes(ctx, opts.scope);
  const name = (t: Task) => `#${t.id} ${t.title}`;

  const dueSoon = rows
    .filter(({ task: t }) => t.due_date && new Date(t.due_date).getTime() <= nowMs + s.dueSoonHours * 3_600_000)
    .sort((a, b) => a.task.due_date!.localeCompare(b.task.due_date!) || a.task.id - b.task.id)
    .map(({ task: t, minutes }) => {
      const parts = [dueText(new Date(t.due_date!).getTime(), nowMs)];
      if (minutes != null) parts.push(effortText(minutes));
      if (blockers.has(t.id)) parts.push(`blocked by ${name(blockers.get(t.id)![0])}`);
      if (t.time_assumed) parts.push('time assumed');
      return { task: t, reason: parts.join(', '), minutes };
    });

  const quickWins = rows
    .filter(({ task: t, minutes }) => minutes != null && minutes > 0 && minutes <= s.quickWinMinutes && !blockers.has(t.id) && !t.deadline_only)
    .sort((a, b) => a.minutes! - b.minutes! || (a.task.due_date ?? '9999').localeCompare(b.task.due_date ?? '9999') || a.task.id - b.task.id)
    .map(({ task: t, minutes }) => ({
      task: t,
      reason: `${minutes} min, ${t.due_date ? dueText(new Date(t.due_date).getTime(), nowMs) : 'no due date'}`,
      minutes,
    }));

  const blocked = rows
    .filter(({ task: t }) => blockers.has(t.id))
    .sort((a, b) => (a.task.due_date ?? '9999').localeCompare(b.task.due_date ?? '9999') || a.task.id - b.task.id)
    .map(({ task: t, minutes }) => {
      const bs = blockers.get(t.id)!;
      return { task: t, reason: `waiting on ${bs.map((b) => `${name(b)}${b.due_date ? ` (due ${formatLocal(b.due_date, ctx.tz)})` : ''}`).join(', ')}`, minutes };
    });

  // High Grade Impact: open, graded (weight > 0), unblocked, with a due date that has not passed. Overdue tasks stay in Due Soon only.
  const highImpact = rows
    .filter(({ task: t }) => (t.grade_weight ?? 0) > 0 && t.due_date && new Date(t.due_date).getTime() > nowMs && !blockers.has(t.id))
    .map(({ task: t, minutes }) => {
      const assumed = minutes == null || minutes === 0;
      const mins = assumed ? s.impactDefaultMinutes : minutes!;
      const dueMs = new Date(t.due_date!).getTime();
      const score = impactScore(t.grade_weight!, (dueMs - nowMs) / 86_400_000, mins / 60, s);
      return { task: t, minutes, score, reason: `worth ${t.grade_weight}%, ${dueText(dueMs, nowMs)}, ${effortText(mins)}${assumed ? ' (assumed: no estimate)' : ''}` };
    })
    .sort((a, b) => b.score - a.score || a.task.id - b.task.id)
    .slice(0, s.impactLimit);

  return { dueSoon, highImpact, quickWins, blocked };
}
