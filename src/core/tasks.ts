import { DateTime } from 'luxon';
import { loadRates, loadLearnedRates, sizeEstimate, SIZE_UNITS, type SizeUnit } from './size';
import type { Ctx } from './ctx';
import { nowIso } from './ctx';
import { parseNaturalDue } from './naturalDate';
import { currentTerm, getTermByName } from './terms';
import { requireList } from './lists';
import { parseRecurrence, serializeRule, deserializeRule, nextOccurrence } from './recurrence';

export const TASK_TYPES = ['homework', 'project', 'exam', 'quiz', 'reading', 'attendance', 'other'] as const;
export const STATUSES = ['todo', 'in_progress', 'done'] as const;

export interface Task {
  id: number;
  title: string;
  notes: string | null;
  term_id: number | null;
  course: string | null;
  type: string;
  due_date: string | null;
  time_assumed: number;
  grade_weight: number | null;
  estimated_minutes: number | null;
  estimate_source: string | null;
  actual_minutes: number | null;
  status: string;
  completed_at: string | null;
  deleted_at: string | null;
  source: string;
  import_key: string | null;
  source_quote: string | null;
  confidence: string | null;
  list_id: number | null;
  parent_task_id: number | null;
  recurrence_rule: string | null;
  created_at: string;
  updated_at: string;
  size_amount: number | null;
  size_unit: string | null;
  /** local date (YYYY-MM-DD) before which the scheduler may not start this task */
  available_from: string | null;
  optional: number;
  deadline_only: number;
}

export function getTask(ctx: Ctx, id: number, opts: { includeDeleted?: boolean } = {}): Task | undefined {
  return ctx.db.get<Task>(`SELECT * FROM tasks WHERE id = ? ${opts.includeDeleted ? '' : 'AND deleted_at IS NULL'}`, [id]);
}

function requireTask(ctx: Ctx, id: number): Task {
  const t = getTask(ctx, id);
  if (!t) throw new Error(`No task #${id} (it may not exist or may be deleted; see: ls --deleted).`);
  return t;
}

const checkType = (type: string) => {
  if (!(TASK_TYPES as readonly string[]).includes(type)) throw new Error(`Invalid type "${type}". Use one of: ${TASK_TYPES.join(', ')}.`);
};
const checkEst = (n: number) => {
  if (!Number.isInteger(n) || n <= 0) throw new Error('Estimate must be a positive whole number of minutes.');
};
const checkWeight = (n: number) => {
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Grade weight must be between 0 and 100.');
};

export interface AddInput {
  title: string;
  notes?: string;
  due?: string;
  list?: string;
  course?: string;
  type?: string;
  est?: number;
  weight?: number;
  repeat?: string;
  term?: string;
}

export function addTask(ctx: Ctx, input: AddInput): Task {
  const title = input.title?.trim();
  if (!title) throw new Error('A task needs a title.');
  const type = input.type ?? 'other';
  checkType(type);
  if (input.est != null) checkEst(input.est);
  if (input.weight != null) checkWeight(input.weight);

  let due: { dueUtc: string | null; timeAssumed: boolean } = { dueUtc: null, timeAssumed: false };
  if (input.due) due = parseNaturalDue(input.due, ctx.tz, ctx.clock, ctx.defaultTime);
  let rule: string | null = null;
  if (input.repeat) {
    if (!due.dueUtc) throw new Error('A repeating task needs a due date (--due).');
    rule = serializeRule(parseRecurrence(input.repeat));
  }

  const list = input.list ? requireList(ctx, input.list) : undefined;
  let termId: number | null = null;
  if (input.term) {
    const t = getTermByName(ctx, input.term);
    if (t.archived_at) throw new Error(`Term "${t.name}" is archived.`);
    termId = t.id;
  } else if (list?.term_id) {
    termId = list.term_id;
  } else if (input.course) {
    const cur = currentTerm(ctx);
    if (!cur) throw new Error('No current term. Create one first (term new <name> --start D --end D), or pass --term.');
    termId = cur.id;
  }

  const now = nowIso(ctx);
  const id = ctx.db.run(
    `INSERT INTO tasks(title, notes, term_id, course, type, due_date, time_assumed, grade_weight, estimated_minutes, estimate_source,
       status, source, list_id, recurrence_rule, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?, 'todo','manual',?,?,?,?)`,
    [title, input.notes ?? null, termId, input.course?.trim() || null, type, due.dueUtc, due.timeAssumed ? 1 : 0, input.weight ?? null,
      input.est ?? null, input.est != null ? 'manual' : null, list?.id ?? null, rule, now, now],
  ).lastInsertRowid;
  if (input.est == null) refreshSizeEstimate(ctx, id); // a group's flat (per-assignment) rate applies from the start; a manual estimate always wins
  return getTask(ctx, id)!;
}

/** A step: a small task that belongs to a parent task (shown under it in the task detail). It takes the parent's term, course and list; one level only. */
export function addStep(ctx: Ctx, parentId: number, title: string, opts: { est?: number } = {}): Task {
  const parent = getTask(ctx, parentId);
  if (!parent) throw new Error(`No task #${parentId}.`);
  if (parent.parent_task_id) throw new Error(`Task #${parentId} is itself a step; steps can't have steps. Add it to #${parent.parent_task_id} instead.`);
  const t = title?.trim();
  if (!t) throw new Error('A step needs a title.');
  if (opts.est != null) checkEst(opts.est);
  const now = nowIso(ctx);
  const id = ctx.db.run(
    `INSERT INTO tasks(title, term_id, course, type, estimated_minutes, estimate_source, status, source, list_id, parent_task_id, created_at, updated_at)
     VALUES(?,?,?,'other',?,?, 'todo','manual',?,?,?,?)`,
    [t, parent.term_id, parent.course, opts.est ?? null, opts.est != null ? 'manual' : null, parent.list_id, parentId, now, now],
  ).lastInsertRowid;
  return getTask(ctx, id)!;
}

export interface EditPatch {
  title?: string;
  notes?: string | null;
  /** natural-language date, or 'none' to clear */
  due?: string;
  /** list name, or 'none' */
  list?: string;
  /** course, or 'none' */
  course?: string;
  type?: string;
  est?: number | null;
  weight?: number | null;
  /** recurrence text, or 'none' */
  repeat?: string;
  term?: string;
  /** amount + unit, or null to clear */
  size?: { amount: number; unit: SizeUnit } | null;
  /** YYYY-MM-DD or a natural date, or 'none' */
  availableFrom?: string;
  optional?: boolean;
  /** an event or deadline to show, not work to schedule: the scheduler ignores it silently */
  deadlineOnly?: boolean;
  /** switch the estimate to the size-based one (replaces a manual estimate; only when asked) */
  estFromSize?: boolean;
}

const isNone = (s: string) => s.trim().toLowerCase() === 'none';

export function editTask(ctx: Ctx, id: number, patch: EditPatch): Task {
  const t = requireTask(ctx, id);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };

  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new Error('Title cannot be empty.');
    set('title', patch.title.trim());
  }
  if (patch.notes !== undefined) set('notes', patch.notes);
  let newDue = t.due_date;
  if (patch.due !== undefined) {
    if (isNone(patch.due)) {
      set('due_date', null);
      set('time_assumed', 0);
      newDue = null;
    } else {
      const d = parseNaturalDue(patch.due, ctx.tz, ctx.clock, ctx.defaultTime);
      set('due_date', d.dueUtc);
      set('time_assumed', d.timeAssumed ? 1 : 0);
      newDue = d.dueUtc;
    }
  }
  if (patch.list !== undefined) set('list_id', isNone(patch.list) ? null : requireList(ctx, patch.list).id);
  if (patch.course !== undefined) {
    if (isNone(patch.course)) set('course', null);
    else {
      set('course', patch.course.trim());
      if (t.term_id == null && patch.term === undefined) {
        const cur = currentTerm(ctx);
        if (!cur) throw new Error('No current term to attach this course to.');
        set('term_id', cur.id);
      }
    }
  }
  if (patch.term !== undefined) set('term_id', isNone(patch.term) ? null : getTermByName(ctx, patch.term).id);
  if (patch.type !== undefined) {
    checkType(patch.type);
    set('type', patch.type);
  }
  if (patch.est !== undefined) {
    if (patch.est !== null) checkEst(patch.est);
    set('estimated_minutes', patch.est);
    set('estimate_source', patch.est === null ? null : 'manual');
  }
  if (patch.weight !== undefined) {
    if (patch.weight !== null) checkWeight(patch.weight);
    set('grade_weight', patch.weight);
  }
  if (patch.repeat !== undefined) {
    if (isNone(patch.repeat)) set('recurrence_rule', null);
    else {
      if (!newDue) throw new Error('A repeating task needs a due date (--due).');
      set('recurrence_rule', serializeRule(parseRecurrence(patch.repeat)));
    }
  } else if (t.recurrence_rule && !newDue) {
    throw new Error('This task repeats, so it needs a due date. Clear the repeat first (--repeat none).');
  }

  if (patch.size !== undefined) {
    if (patch.size === null) {
      set('size_amount', null);
      set('size_unit', null);
    } else {
      if (!(SIZE_UNITS as readonly string[]).includes(patch.size.unit) || !(patch.size.amount > 0)) throw new Error('Size needs a positive amount and a unit.');
      set('size_amount', patch.size.amount);
      set('size_unit', patch.size.unit);
    }
  }
  if (patch.availableFrom !== undefined) {
    if (isNone(patch.availableFrom)) set('available_from', null);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(patch.availableFrom.trim()) && DateTime.fromISO(patch.availableFrom.trim()).isValid) set('available_from', patch.availableFrom.trim());
    else {
      const d = parseNaturalDue(patch.availableFrom, ctx.tz, ctx.clock, ctx.defaultTime);
      set('available_from', DateTime.fromISO(d.dueUtc!, { zone: 'utc' }).setZone(ctx.tz).toISODate());
    }
  }
  if (patch.optional !== undefined) set('optional', patch.optional ? 1 : 0);
  if (patch.deadlineOnly !== undefined) set('deadline_only', patch.deadlineOnly ? 1 : 0);

  if (!sets.length && !patch.estFromSize) return t;
  if (sets.length) {
    set('updated_at', nowIso(ctx));
    ctx.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
  }
  if (patch.size !== undefined || patch.estFromSize || patch.course !== undefined || patch.title !== undefined || patch.est === null) refreshSizeEstimate(ctx, id, !!patch.estFromSize);
  return getTask(ctx, id)!;
}

/**
 * Keep a task's stored estimate in line with its size. A manual (or imported) estimate is left alone unless
 * `force` (the user asked to switch); a size-sourced estimate follows the size, and is dropped if the size goes.
 */
export function refreshSizeEstimate(ctx: Ctx, id: number, force = false): void {
  const t = getTask(ctx, id);
  if (!t) return;
  const { all } = loadRates(ctx);
  const est = sizeEstimate(t, all, loadLearnedRates(ctx, all));
  if (force) {
    if (!est) throw new Error(t.size_amount ? `No rate applies to ${t.size_amount} ${t.size_unit} here; add one with: config set size_rates <json>` : 'This task has no size to estimate from (edit <id> --size 12 pages).');
    ctx.db.run("UPDATE tasks SET estimated_minutes = ?, estimate_source = 'size', updated_at = ? WHERE id = ?", [est.minutes, nowIso(ctx), id]);
    return;
  }
  const manual = t.estimated_minutes != null && t.estimate_source !== 'size';
  if (manual) return;
  if (est) ctx.db.run("UPDATE tasks SET estimated_minutes = ?, estimate_source = 'size', updated_at = ? WHERE id = ?", [est.minutes, nowIso(ctx), id]);
  else if (t.estimate_source === 'size') ctx.db.run('UPDATE tasks SET estimated_minutes = NULL, estimate_source = NULL, updated_at = ? WHERE id = ?', [nowIso(ctx), id]);
}

/** Marks done. A recurring task spawns its next occurrence (skipping any already in the past). */
export function completeTask(ctx: Ctx, id: number): { completed: Task; next?: Task } {
  const t = requireTask(ctx, id);
  if (t.status === 'done') return { completed: t };
  const now = nowIso(ctx);
  return ctx.db.transaction(() => {
    ctx.db.run("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    let next: Task | undefined;
    if (t.recurrence_rule && t.due_date) {
      const due = nextOccurrence(t.due_date, deserializeRule(t.recurrence_rule), ctx.tz, ctx.clock.now());
      const nid = ctx.db.run(
        `INSERT INTO tasks(title, notes, term_id, course, type, due_date, time_assumed, grade_weight, estimated_minutes, estimate_source,
           status, source, list_id, recurrence_rule, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?, 'todo','manual',?,?,?,?)`,
        [t.title, t.notes, t.term_id, t.course, t.type, due, t.time_assumed, t.grade_weight, t.estimated_minutes, t.estimate_source, t.list_id, t.recurrence_rule, now, now],
      ).lastInsertRowid;
      next = getTask(ctx, nid)!;
    }
    return { completed: getTask(ctx, id)!, next };
  });
}

/** Re-opens a done task. If completing it spawned the next occurrence and that is untouched, it is soft-deleted. */
export function uncompleteTask(ctx: Ctx, id: number): Task {
  const t = requireTask(ctx, id);
  if (t.status !== 'done') throw new Error(`Task #${id} is not done.`);
  const now = nowIso(ctx);
  ctx.db.transaction(() => {
    if (t.recurrence_rule && t.completed_at) {
      ctx.db.run(
        `UPDATE tasks SET deleted_at = ?, updated_at = ?
         WHERE created_at = ? AND title = ? AND recurrence_rule = ? AND term_id IS ? AND status = 'todo'
           AND deleted_at IS NULL AND id <> ? AND source = 'manual'`,
        [now, now, t.completed_at, t.title, t.recurrence_rule, t.term_id, id],
      );
    }
    ctx.db.run("UPDATE tasks SET status = 'todo', completed_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
  });
  return getTask(ctx, id)!;
}

export function deleteTask(ctx: Ctx, id: number): Task {
  const t = requireTask(ctx, id);
  ctx.db.run('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(ctx), nowIso(ctx), id]);
  return t;
}

/** Restores a soft-deleted task: the given id, or the most recently deleted one. */
export function undoDelete(ctx: Ctx, id?: number): Task {
  const row =
    id != null
      ? ctx.db.get<Task>('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NOT NULL', [id])
      : ctx.db.get<Task>('SELECT * FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC LIMIT 1');
  if (!row) throw new Error(id != null ? `Task #${id} is not deleted.` : 'Nothing to undo: no deleted tasks.');
  ctx.db.run('UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?', [nowIso(ctx), row.id]);
  return getTask(ctx, row.id)!;
}

export interface Scope {
  /** a single named term (archived allowed) plus term-less tasks */
  term?: string;
  /** every term, archived included */
  allTerms?: boolean;
}

export interface TaskFilter {
  scope?: Scope;
  list?: string;
  course?: string;
  /** a status, or 'open' for everything not done */
  status?: 'todo' | 'in_progress' | 'done' | 'open';
  from?: string;
  to?: string;
  text?: string;
  deleted?: boolean;
}

/** SQL fragment limiting rows to the active scope. Default = current term + term-less tasks. */
export function scopeClause(ctx: Ctx, scope: Scope = {}, col = 't.term_id'): { sql: string; params: unknown[] } {
  if (scope.allTerms) return { sql: '1=1', params: [] };
  if (scope.term) return { sql: `(${col} = ? OR ${col} IS NULL)`, params: [getTermByName(ctx, scope.term).id] };
  const cur = currentTerm(ctx);
  return cur ? { sql: `(${col} = ? OR ${col} IS NULL)`, params: [cur.id] } : { sql: `${col} IS NULL`, params: [] };
}

function rangeBound(ctx: Ctx, text: string, edge: 'start' | 'end'): string {
  const r = parseNaturalDue(text, ctx.tz, ctx.clock, ctx.defaultTime);
  const local = DateTime.fromISO(r.dueUtc!, { zone: 'utc' }).setZone(ctx.tz);
  // A bound without a stated time covers the whole local day.
  const adj = r.timeAssumed ? (edge === 'start' ? local.startOf('day') : local.endOf('day')) : local;
  return adj.toUTC().toISO()!;
}

export function listTasks(ctx: Ctx, f: TaskFilter = {}): Task[] {
  const where: string[] = [f.deleted ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL'];
  const params: unknown[] = [];
  const sc = scopeClause(ctx, f.scope);
  where.push(sc.sql);
  params.push(...sc.params);
  if (f.list) {
    const ids = ctx.db.all<{ id: number }>('SELECT id FROM lists WHERE name = ? COLLATE NOCASE', [f.list.trim()]);
    if (!ids.length) throw new Error(`No list named "${f.list}".`);
    where.push(`t.list_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids.map((i) => i.id));
  }
  if (f.course) {
    where.push('t.course = ? COLLATE NOCASE');
    params.push(f.course.trim());
  }
  if (f.status === 'open') where.push("t.status <> 'done'");
  else if (f.status) {
    where.push('t.status = ?');
    params.push(f.status);
  }
  if (f.from) {
    where.push('t.due_date >= ?');
    params.push(rangeBound(ctx, f.from, 'start'));
  }
  if (f.to) {
    where.push('t.due_date <= ?');
    params.push(rangeBound(ctx, f.to, 'end'));
  }
  if (f.text) {
    const like = `%${f.text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\' OR t.course LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  return ctx.db.all<Task>(`SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.due_date IS NULL, t.due_date, t.id`, params);
}
