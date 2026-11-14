import type { Ctx } from './ctx';
import { nowIso } from './ctx';
import { currentTerm, getTermByName } from './terms';
import { getTask, type Task } from './tasks';

export interface List {
  id: number;
  name: string;
  term_id: number | null;
}

export function listLists(ctx: Ctx, opts: { allTerms?: boolean } = {}): List[] {
  if (opts.allTerms) return ctx.db.all<List>('SELECT * FROM lists ORDER BY name COLLATE NOCASE');
  const cur = currentTerm(ctx);
  return ctx.db.all<List>('SELECT * FROM lists WHERE term_id IS NULL OR term_id = ? ORDER BY name COLLATE NOCASE', [cur?.id ?? -1]);
}

/** Lookup by name; prefers a list tied to the current term over a cross-term one. */
export function findList(ctx: Ctx, name: string): List | undefined {
  const cur = currentTerm(ctx);
  return ctx.db.get<List>(
    `SELECT * FROM lists WHERE name = ? COLLATE NOCASE
     ORDER BY (term_id = ?) DESC, (term_id IS NULL) DESC, id LIMIT 1`,
    [name.trim(), cur?.id ?? -1],
  );
}

export function requireList(ctx: Ctx, name: string): List {
  const l = findList(ctx, name);
  if (!l) throw new Error(`No list named "${name}". Create it with: list new "${name}"`);
  return l;
}

export function createList(ctx: Ctx, name: string, opts: { term?: string } = {}): List {
  const n = name.trim();
  if (!n) throw new Error('List name is required.');
  const termId = opts.term ? getTermByName(ctx, opts.term).id : null;
  if (ctx.db.get('SELECT 1 FROM lists WHERE name = ? COLLATE NOCASE AND term_id IS ?', [n, termId])) throw new Error(`A list named "${n}" already exists${termId ? ' in that term' : ''}.`);
  const id = ctx.db.run('INSERT INTO lists(name, term_id) VALUES(?,?)', [n, termId]).lastInsertRowid;
  return ctx.db.get<List>('SELECT * FROM lists WHERE id = ?', [id])!;
}

export function renameList(ctx: Ctx, oldName: string, newName: string): List {
  const l = requireList(ctx, oldName);
  const n = newName.trim();
  if (!n) throw new Error('New list name is required.');
  if (ctx.db.get('SELECT 1 FROM lists WHERE name = ? COLLATE NOCASE AND term_id IS ? AND id <> ?', [n, l.term_id, l.id])) throw new Error(`A list named "${n}" already exists.`);
  ctx.db.run('UPDATE lists SET name = ? WHERE id = ?', [n, l.id]);
  return { ...l, name: n };
}

/** Deletes the list only; its tasks are kept and simply lose their list. */
export function deleteList(ctx: Ctx, name: string): { tasksUnlinked: number } {
  const l = requireList(ctx, name);
  return ctx.db.transaction(() => {
    const r = ctx.db.run('UPDATE tasks SET list_id = NULL, updated_at = ? WHERE list_id = ?', [nowIso(ctx), l.id]);
    ctx.db.run('DELETE FROM lists WHERE id = ?', [l.id]);
    return { tasksUnlinked: r.changes };
  });
}

export function moveTask(ctx: Ctx, taskId: number, listName: string | null): Task {
  const t = getTask(ctx, taskId);
  if (!t) throw new Error(`No task #${taskId}.`);
  const listId = listName == null ? null : requireList(ctx, listName).id;
  ctx.db.run('UPDATE tasks SET list_id = ?, updated_at = ? WHERE id = ?', [listId, nowIso(ctx), taskId]);
  return getTask(ctx, taskId)!;
}
