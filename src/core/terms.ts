import { DateTime } from 'luxon';
import type { Ctx } from './ctx';
import { nowIso } from './ctx';
import type { Term } from '../db/repo';

export type { Term };

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;

export function listTerms(ctx: Ctx, opts: { includeArchived?: boolean } = {}): Term[] {
  return ctx.db.all<Term>(`SELECT * FROM terms ${opts.includeArchived === false ? 'WHERE archived_at IS NULL' : ''} ORDER BY start_date, id`);
}

export function currentTerm(ctx: Ctx): Term | undefined {
  return ctx.db.get<Term>('SELECT * FROM terms WHERE is_current = 1 AND archived_at IS NULL');
}

export function getTermByName(ctx: Ctx, name: string): Term {
  const t = ctx.db.get<Term>('SELECT * FROM terms WHERE name = ? COLLATE NOCASE', [name.trim()]);
  if (!t) {
    const known = listTerms(ctx).map((x) => `"${x.name}"`).join(', ') || '(none yet)';
    throw new Error(`No term named "${name}". Known terms: ${known}.`);
  }
  return t;
}

export function createTerm(ctx: Ctx, t: { name: string; start_date: string; end_date: string }, opts: { makeCurrent?: boolean } = {}): Term {
  const name = t.name.trim();
  if (!name) throw new Error('Term name is required.');
  if (!validDate(t.start_date) || !validDate(t.end_date)) throw new Error('Term dates must be real dates like 2026-08-31.');
  if (t.end_date < t.start_date) throw new Error('Term end date is before its start date.');
  if (ctx.db.get('SELECT 1 FROM terms WHERE name = ? COLLATE NOCASE', [name])) throw new Error(`A term named "${name}" already exists.`);
  return ctx.db.transaction(() => {
    const hasCurrent = !!currentTerm(ctx);
    const makeCurrent = opts.makeCurrent || !hasCurrent;
    if (makeCurrent) ctx.db.run('UPDATE terms SET is_current = 0');
    ctx.db.run('INSERT INTO terms(name, start_date, end_date, is_current) VALUES(?,?,?,?)', [name, t.start_date, t.end_date, makeCurrent ? 1 : 0]);
    return getTermByName(ctx, name);
  });
}

export function useTerm(ctx: Ctx, name: string): Term {
  const t = getTermByName(ctx, name);
  if (t.archived_at) throw new Error(`Term "${t.name}" is archived. Unarchive it first (term unarchive).`);
  ctx.db.transaction(() => {
    ctx.db.run('UPDATE terms SET is_current = 0');
    ctx.db.run('UPDATE terms SET is_current = 1 WHERE id = ?', [t.id]);
  });
  return getTermByName(ctx, name);
}

/** Hides a term from default views, search and the scheduler. Never deletes data. */
export function archiveTerm(ctx: Ctx, name: string): Term {
  const t = getTermByName(ctx, name);
  if (t.archived_at) throw new Error(`Term "${t.name}" is already archived.`);
  ctx.db.run('UPDATE terms SET archived_at = ?, is_current = 0 WHERE id = ?', [nowIso(ctx), t.id]);
  return getTermByName(ctx, name);
}

export function unarchiveTerm(ctx: Ctx, name: string): Term {
  const t = getTermByName(ctx, name);
  if (!t.archived_at) throw new Error(`Term "${t.name}" is not archived.`);
  ctx.db.run('UPDATE terms SET archived_at = NULL WHERE id = ?', [t.id]);
  return getTermByName(ctx, name);
}
