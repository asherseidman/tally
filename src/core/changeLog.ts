import type { Ctx } from './ctx';
import { nowIso } from './ctx';

/**
 * Change history for edits made on the user's behalf (the Claude connector). A change is recorded by snapshotting the
 * tasks, dependencies and time sessions before and after the operation and keeping the difference, so it works the same
 * for every core function (including ones that touch several rows, like completing a repeating task or an import).
 * Undo puts those rows back, and refuses if any of them was changed again since (so it never overwrites newer edits).
 */

type Row = Record<string, unknown>;

export interface ChangeDetails {
  tasks: { id: number; before: Row | null; after: Row | null }[];
  depsAdded: [number, number][];
  depsRemoved: [number, number][];
  sessionsAdded: Row[];
  sessionsRemoved: Row[];
  /** a time session that existed before and was changed (a timer that was stopped) */
  sessionsChanged?: { id: number; before: Row; after: Row }[];
  /** lists created, renamed or removed */
  lists?: { id: number; before: Row | null; after: Row | null }[];
  /** rate settings changed (Rates screen): value before and after, null = not set */
  settings?: { key: string; before: string | null; after: string | null }[];
}

/** Only these settings are tracked by the change log (everything else changes all the time and is not an "edit"). */
export const TRACKED_SETTINGS = ['size_rates', 'rate_defaults', 'points_min_minutes', 'rate_groups', 'rate_multiplier_off', 'rate_multiplier_reset', 'rate_group_snapshot'];

export interface ChangeEntry {
  id: number;
  at: string;
  actor: string;
  tool: string;
  summary: string;
  undone: boolean;
  tasks: number;
}

/** What a change did, in plain terms (returned to the caller of a write so it can say exactly what happened). */
export interface ChangeReport {
  changeId: number;
  summary: string;
  created: { id: number; title: string }[];
  updated: { id: number; title: string; changes: Record<string, { from: unknown; to: unknown }> }[];
  dependenciesAdded: { task: number; blockedBy: number }[];
  dependenciesRemoved: { task: number; blockedBy: number }[];
  listsChanged: { id: number; from: string | null; to: string | null }[];
  timers: { task: number; action: 'started' | 'stopped' }[];
  workLogged: { task: number; minutes: number }[];
  undo: string;
}

const key = (a: number, b: number) => `${a}>${b}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// bookkeeping columns: never worth reporting as "what changed"
const QUIET = new Set(['updated_at']);

interface Snap {
  tasks: Map<number, Row>;
  deps: Set<string>;
  sessions: Map<number, Row>;
  lists: Map<number, Row>;
  settings: Map<string, string>;
}

function snapshot(ctx: Ctx): Snap {
  return {
    tasks: new Map(ctx.db.all<Row>('SELECT * FROM tasks').map((r) => [r.id as number, r])),
    deps: new Set(ctx.db.all<{ a: number; b: number }>('SELECT task_id a, blocked_by_task_id b FROM dependencies').map((r) => key(r.a, r.b))),
    sessions: new Map(ctx.db.all<Row>('SELECT * FROM time_sessions').map((r) => [r.id as number, r])),
    lists: new Map(ctx.db.all<Row>('SELECT * FROM lists').map((r) => [r.id as number, r])),
    settings: new Map(ctx.db.all<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key IN (${TRACKED_SETTINGS.map(() => '?').join(',')})`, TRACKED_SETTINGS).map((r) => [r.key, r.value])),
  };
}

function diff(before: Snap, after: Snap): ChangeDetails {
  const tasks: ChangeDetails['tasks'] = [];
  for (const [id, a] of after.tasks) {
    const b = before.tasks.get(id) ?? null;
    if (!b || !same(a, b)) tasks.push({ id, before: b, after: a });
  }
  const pairs = (s: Set<string>) => [...s].map((k) => k.split('>').map(Number) as [number, number]);
  const sessionsChanged = [...after.sessions].filter(([id, a]) => before.sessions.has(id) && !same(before.sessions.get(id), a)).map(([id, a]) => ({ id, before: before.sessions.get(id)!, after: a }));
  const lists: NonNullable<ChangeDetails['lists']> = [];
  for (const id of new Set([...before.lists.keys(), ...after.lists.keys()])) {
    const b = before.lists.get(id) ?? null;
    const a = after.lists.get(id) ?? null;
    if (!same(a, b)) lists.push({ id, before: b, after: a });
  }
  const settings: NonNullable<ChangeDetails['settings']> = [];
  for (const k of TRACKED_SETTINGS) {
    const b = before.settings.get(k) ?? null;
    const a = after.settings.get(k) ?? null;
    if (b !== a) settings.push({ key: k, before: b, after: a });
  }
  return {
    tasks,
    sessionsChanged, lists, settings,
    depsAdded: pairs(new Set([...after.deps].filter((k) => !before.deps.has(k)))),
    depsRemoved: pairs(new Set([...before.deps].filter((k) => !after.deps.has(k)))),
    sessionsAdded: [...after.sessions].filter(([id]) => !before.sessions.has(id)).map(([, r]) => r),
    sessionsRemoved: [...before.sessions].filter(([id]) => !after.sessions.has(id)).map(([, r]) => r),
  };
}

const isEmpty = (d: ChangeDetails) => !d.tasks.length && !d.sessionsChanged?.length && !d.lists?.length && !d.settings?.length && !d.depsAdded.length && !d.depsRemoved.length && !d.sessionsAdded.length && !d.sessionsRemoved.length;

function report(id: number, summary: string, d: ChangeDetails): ChangeReport {
  const created = d.tasks.filter((t) => !t.before).map((t) => ({ id: t.id, title: String(t.after!.title) }));
  const updated = d.tasks.filter((t) => t.before).map((t) => {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(t.after!)) if (!QUIET.has(k) && !same(t.before![k], t.after![k])) changes[k] = { from: t.before![k] ?? null, to: t.after![k] ?? null };
    return { id: t.id, title: String(t.after!.title), changes };
  }).filter((u) => Object.keys(u.changes).length > 0);
  const minutes = (r: Row) => Math.round((Date.parse(String(r.ended_at)) - Date.parse(String(r.started_at))) / 60_000);
  return {
    changeId: id, summary, created, updated,
    dependenciesAdded: d.depsAdded.map(([task, blockedBy]) => ({ task, blockedBy })),
    dependenciesRemoved: d.depsRemoved.map(([task, blockedBy]) => ({ task, blockedBy })),
    listsChanged: (d.lists ?? []).map((l) => ({ id: l.id, from: l.before ? String(l.before.name) : null, to: l.after ? String(l.after.name) : null })),
    timers: [
      ...d.sessionsAdded.filter((s) => !s.ended_at).map((s) => ({ task: s.task_id as number, action: 'started' as const })),
      ...(d.sessionsChanged ?? []).filter((s) => !s.before.ended_at && s.after.ended_at).map((s) => ({ task: s.after.task_id as number, action: 'stopped' as const })),
    ],
    workLogged: d.sessionsAdded.filter((s) => s.ended_at).map((s) => ({ task: s.task_id as number, minutes: minutes(s) })),
    undo: `npm run plan -- changes undo ${id}   (or Settings, General, Claude connector, Undo)`,
  };
}

export interface Tracker {
  /** Record what changed since the tracker was made. Returns null (and records nothing) if nothing changed. */
  finish(meta: { actor: string; tool: string; summary: string }): ChangeReport | null;
}

/** Take the "before" snapshot now; call finish() after the operation has written. */
export function trackChanges(ctx: Ctx): Tracker {
  const before = snapshot(ctx);
  return {
    finish(meta) {
      const d = diff(before, snapshot(ctx));
      if (isEmpty(d)) return null;
      const id = ctx.db.run('INSERT INTO change_log(at, actor, tool, summary, details) VALUES(?,?,?,?,?)', [nowIso(ctx), meta.actor, meta.tool, meta.summary, JSON.stringify(d)]).lastInsertRowid;
      return report(id, meta.summary, d);
    },
  };
}

/** Run `fn` (a core operation) in one transaction and record the change. */
export function recordChange<T>(ctx: Ctx, meta: { actor: string; tool: string; summary: (result: T) => string }, fn: () => T): { result: T; change: ChangeReport | null } {
  return ctx.db.transaction(() => {
    const t = trackChanges(ctx);
    const result = fn();
    return { result, change: t.finish({ actor: meta.actor, tool: meta.tool, summary: meta.summary(result) }) };
  });
}

export function listChanges(ctx: Ctx, opts: { limit?: number } = {}): ChangeEntry[] {
  return ctx.db.all<{ id: number; at: string; actor: string; tool: string; summary: string; details: string; undone_at: string | null }>(
    'SELECT * FROM change_log ORDER BY id DESC LIMIT ?', [Math.min(Math.max(opts.limit ?? 20, 1), 200)],
  ).map((r) => ({ id: r.id, at: r.at, actor: r.actor, tool: r.tool, summary: r.summary, undone: !!r.undone_at, tasks: (JSON.parse(r.details) as ChangeDetails).tasks.length }));
}

const COLS_SKIP = new Set(['id']);

/** Put the rows a change touched back as they were. Refuses if any of them changed again since. */
export function undoChange(ctx: Ctx, id: number): { summary: string } {
  const row = ctx.db.get<{ summary: string; details: string; undone_at: string | null }>('SELECT * FROM change_log WHERE id = ?', [id]);
  if (!row) throw new Error(`No change #${id}. List them with: npm run plan -- changes`);
  if (row.undone_at) throw new Error(`Change #${id} was already undone.`);
  const d = JSON.parse(row.details) as ChangeDetails;
  const now = snapshot(ctx);
  const moved: string[] = [];
  for (const t of d.tasks) if (!same(now.tasks.get(t.id) ?? null, t.after)) moved.push(`task #${t.id}`);
  for (const s of d.sessionsAdded) if (!now.sessions.has(s.id as number)) moved.push(`time entry #${s.id}`);
  for (const s of d.sessionsChanged ?? []) if (!same(now.sessions.get(s.id) ?? null, s.after)) moved.push(`time entry #${s.id}`);
  for (const l of d.lists ?? []) {
    if (!same(now.lists.get(l.id) ?? null, l.after)) moved.push(`list #${l.id}`);
    // a list this change created can only go away if nothing live is still in it
    else if (!l.before && ctx.db.get('SELECT 1 FROM tasks WHERE list_id = ? AND deleted_at IS NULL', [l.id])) moved.push(`list #${l.id} (it has tasks in it now)`);
  }
  for (const s of d.settings ?? []) if ((now.settings.get(s.key) ?? null) !== s.after) moved.push(`setting ${s.key}`);
  if (moved.length) throw new Error(`Can't undo change #${id}: ${moved.join(', ')} changed again since. Nothing was touched. Undo the newer change first, or fix it by hand.`);

  const t = nowIso(ctx);
  ctx.db.transaction(() => {
    for (const x of d.tasks) {
      if (!x.before) {
        ctx.db.run('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, x.id]); // a task this change created: soft-delete it (like `rm`)
        continue;
      }
      const cols = Object.keys(x.before).filter((c) => !COLS_SKIP.has(c));
      ctx.db.run(`UPDATE tasks SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => x.before![c]), x.id]);
    }
    // lists first (a restored list must exist before tasks point at it); a list this change created goes last (nothing may still point at it)
    for (const l of d.lists ?? []) if (l.before) ctx.db.run('INSERT INTO lists(id, name, term_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, term_id = excluded.term_id', [l.id, l.before.name, l.before.term_id]);
    for (const [a, b] of d.depsAdded) ctx.db.run('DELETE FROM dependencies WHERE task_id = ? AND blocked_by_task_id = ?', [a, b]);
    for (const [a, b] of d.depsRemoved) ctx.db.run('INSERT OR IGNORE INTO dependencies(task_id, blocked_by_task_id) VALUES(?,?)', [a, b]);
    for (const s of d.sessionsAdded) ctx.db.run('DELETE FROM time_sessions WHERE id = ?', [s.id]);
    for (const s of d.sessionsChanged ?? []) ctx.db.run('UPDATE time_sessions SET started_at = ?, ended_at = ? WHERE id = ?', [s.before.started_at, s.before.ended_at, s.id]);
    for (const s of d.sessionsRemoved) ctx.db.run('INSERT INTO time_sessions(id, task_id, started_at, ended_at) VALUES(?,?,?,?)', [s.id, s.task_id, s.started_at, s.ended_at]);
    for (const l of d.lists ?? []) if (!l.before) {
      ctx.db.run('UPDATE tasks SET list_id = NULL WHERE list_id = ? AND deleted_at IS NOT NULL', [l.id]); // only already-deleted tasks can still point at it
      ctx.db.run('DELETE FROM lists WHERE id = ?', [l.id]);
    }
    for (const s of d.settings ?? []) {
      if (s.before === null) ctx.db.run('DELETE FROM settings WHERE key = ?', [s.key]);
      else ctx.db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [s.key, s.before]);
    }
    ctx.db.run('UPDATE change_log SET undone_at = ? WHERE id = ?', [t, id]);
  });
  return { summary: row.summary };
}
