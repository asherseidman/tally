import type { Db } from '../db/index';
import type { Ctx } from './ctx';
import { getTask, type Task } from './tasks';

/** True if making `taskId` wait on `blockerId` would create a cycle (the blocker already, directly or not, waits on the task). */
export function wouldCycle(db: Db, taskId: number, blockerId: number): boolean {
  if (taskId === blockerId) return true;
  const seen = new Set<number>();
  const stack = [blockerId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of db.all<{ b: number }>('SELECT blocked_by_task_id b FROM dependencies WHERE task_id = ?', [cur])) stack.push(r.b);
  }
  return false;
}

/** "taskId is blocked by blockerId". Both must exist and not be deleted; cycles are refused with the path. */
export function addDependency(ctx: Ctx, taskId: number, blockerId: number): void {
  const t = getTask(ctx, taskId);
  const b = getTask(ctx, blockerId);
  if (!t) throw new Error(`No task #${taskId}.`);
  if (!b) throw new Error(`No task #${blockerId}.`);
  if (taskId === blockerId) throw new Error('A task cannot be blocked by itself.');
  if (wouldCycle(ctx.db, taskId, blockerId)) {
    throw new Error(`That would make a cycle: #${blockerId} "${b.title}" already waits (directly or through other tasks) on #${taskId} "${t.title}".`);
  }
  ctx.db.run('INSERT OR IGNORE INTO dependencies(task_id, blocked_by_task_id) VALUES(?,?)', [taskId, blockerId]);
}

export function removeDependency(ctx: Ctx, taskId: number, blockerId: number): boolean {
  return ctx.db.run('DELETE FROM dependencies WHERE task_id = ? AND blocked_by_task_id = ?', [taskId, blockerId]).changes > 0;
}

/** Tasks that still hold `taskId` back: blockers that are not done and not deleted. Completing a blocker releases the task automatically. */
export function openBlockers(ctx: Ctx, taskId: number): Task[] {
  return ctx.db.all<Task>(
    `SELECT t.* FROM dependencies d JOIN tasks t ON t.id = d.blocked_by_task_id
      WHERE d.task_id = ? AND t.status <> 'done' AND t.deleted_at IS NULL ORDER BY t.due_date IS NULL, t.due_date, t.id`,
    [taskId],
  );
}

/** Every blocker, open or not (for display). */
export function allBlockers(ctx: Ctx, taskId: number): (Task & { open: boolean })[] {
  return ctx.db
    .all<Task>(`SELECT t.* FROM dependencies d JOIN tasks t ON t.id = d.blocked_by_task_id WHERE d.task_id = ? ORDER BY t.id`, [taskId])
    .map((t) => ({ ...t, open: t.status !== 'done' && !t.deleted_at }));
}

export function dependents(ctx: Ctx, blockerId: number): Task[] {
  return ctx.db.all<Task>(
    `SELECT t.* FROM dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.blocked_by_task_id = ? AND t.deleted_at IS NULL ORDER BY t.id`,
    [blockerId],
  );
}

/** Map of task id -> its open blockers, for every task that has any (one query, for the scheduler and the views). */
export function openBlockerMap(ctx: Ctx): Map<number, Task[]> {
  const rows = ctx.db.all<Task & { dep_for: number }>(
    `SELECT t.*, d.task_id AS dep_for FROM dependencies d JOIN tasks t ON t.id = d.blocked_by_task_id
      WHERE t.status <> 'done' AND t.deleted_at IS NULL ORDER BY t.due_date IS NULL, t.due_date, t.id`,
  );
  const m = new Map<number, Task[]>();
  for (const r of rows) m.set(r.dep_for, [...(m.get(r.dep_for) ?? []), r]);
  return m;
}
