import type { Ctx } from './ctx';
import { nowIso } from './ctx';
import { getTask } from './tasks';

export function sessionMinutes(startedAt: string, endedAt: string): number {
  return Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000);
}

export function startSession(ctx: Ctx, taskId: number): number {
  const t = getTask(ctx, taskId);
  if (!t) throw new Error(`No task #${taskId}.`);
  const id = ctx.db.run('INSERT INTO time_sessions(task_id, started_at) VALUES(?,?)', [taskId, nowIso(ctx)]).lastInsertRowid;
  if (t.status === 'todo') ctx.db.run("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?", [nowIso(ctx), taskId]);
  return id;
}

/** Ends the session and sets the task's actual_minutes to the sum of all finished sessions. */
export function stopSession(ctx: Ctx, sessionId: number): { minutes: number; total: number } {
  const s = ctx.db.get<{ task_id: number; started_at: string; ended_at: string | null }>('SELECT * FROM time_sessions WHERE id = ?', [sessionId]);
  if (!s) throw new Error(`No session #${sessionId}.`);
  if (s.ended_at) throw new Error(`Session #${sessionId} already stopped.`);
  const end = nowIso(ctx);
  ctx.db.run('UPDATE time_sessions SET ended_at = ? WHERE id = ?', [end, sessionId]);
  const total = recomputeActual(ctx, s.task_id);
  return { minutes: sessionMinutes(s.started_at, end), total };
}

/** actual_minutes = sum of all finished sessions. */
function recomputeActual(ctx: Ctx, taskId: number): number {
  const sessions = ctx.db.all<{ started_at: string; ended_at: string }>('SELECT started_at, ended_at FROM time_sessions WHERE task_id = ? AND ended_at IS NOT NULL', [taskId]);
  const total = sessions.reduce((sum, x) => sum + sessionMinutes(x.started_at, x.ended_at), 0);
  ctx.db.run('UPDATE tasks SET actual_minutes = ?, updated_at = ? WHERE id = ?', [total, nowIso(ctx), taskId]);
  return total;
}

/**
 * Log work done without the timer: a finished session of `minutes` that started at `startIso` (default: that many
 * minutes ago). The scheduler plans only the REMAINING estimate (estimate minus logged time).
 */
export function logWork(ctx: Ctx, taskId: number, minutes: number, startIso?: string): { total: number; startedAt: string; endedAt: string } {
  if (!getTask(ctx, taskId)) throw new Error(`No task #${taskId}.`);
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error('Minutes must be a positive whole number.');
  const start = startIso ? new Date(startIso) : new Date(ctx.clock.now().getTime() - minutes * 60_000);
  const end = new Date(start.getTime() + minutes * 60_000);
  if (end.getTime() > ctx.clock.now().getTime() + 60_000) throw new Error('That work would end in the future. Give an earlier --start.');
  ctx.db.run('INSERT INTO time_sessions(task_id, started_at, ended_at) VALUES(?,?,?)', [taskId, start.toISOString(), end.toISOString()]);
  return { total: recomputeActual(ctx, taskId), startedAt: start.toISOString(), endedAt: end.toISOString() };
}

/** Sessions left open (e.g. after a crash). They are never counted toward actual_minutes. */
export function openSessions(ctx: Ctx, taskId?: number) {
  return ctx.db.all<{ id: number; task_id: number; started_at: string }>(
    `SELECT id, task_id, started_at FROM time_sessions WHERE ended_at IS NULL ${taskId ? 'AND task_id = ?' : ''}`,
    taskId ? [taskId] : [],
  );
}
