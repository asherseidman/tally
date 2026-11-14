import type { Ctx } from '../core/ctx';
import { getTask } from '../core/tasks';
import { startSession, stopSession, openSessions } from '../core/timer';

/** Shared by the window (timer.* channels) and the menu-bar icon, so both follow the same rule: one timer at a time. */
export interface RunningTimer { sessionId: number; taskId: number; title: string; startedAtMs: number }

export function runningTimers(ctx: Ctx): RunningTimer[] {
  return openSessions(ctx).map((s) => ({ sessionId: s.id, taskId: s.task_id, title: getTask(ctx, s.task_id)?.title ?? `#${s.task_id}`, startedAtMs: Date.parse(s.started_at) }));
}

/** Stop (and record) anything running, then start the task. */
export function startExclusive(ctx: Ctx, taskId: number): number {
  stopAll(ctx);
  return startSession(ctx, taskId);
}

/** Stop and record every running timer; returns what was recorded. */
export function stopAll(ctx: Ctx): { taskId: number; minutes: number; total: number }[] {
  return openSessions(ctx).map((s) => ({ taskId: s.task_id, ...stopSession(ctx, s.id) }));
}
