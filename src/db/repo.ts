import type { Db } from './index';
import type { ExistingTask, Snapshot } from '../import/diff';

export interface Term {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  is_current: number;
  archived_at: string | null;
}

export function getSetting(db: Db, key: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

export function findTermByName(db: Db, name: string): Term | undefined {
  return db.get<Term>('SELECT * FROM terms WHERE name = ? COLLATE NOCASE', [name.trim()]);
}

export function listTasksForImport(db: Db, termId: number): ExistingTask[] {
  const rows = db.all<any>('SELECT * FROM tasks WHERE term_id = ? AND import_key IS NOT NULL', [termId]);
  const deps = new Map<number, string[]>();
  for (const d of db.all<{ t: number; k: string }>('SELECT d.task_id t, b.import_key k FROM dependencies d JOIN tasks b ON b.id = d.blocked_by_task_id WHERE b.import_key IS NOT NULL')) deps.set(d.t, [...(deps.get(d.t) ?? []), d.k]);
  return rows.map((r) => ({
    depends_on: deps.get(r.id)?.sort().join(',') ?? null,
    parent_task_id: r.parent_task_id,
    id: r.id,
    import_key: r.import_key,
    course: r.course,
    title: r.title,
    type: r.type,
    due_date: r.due_date,
    time_assumed: !!r.time_assumed,
    grade_weight: r.grade_weight,
    notes: r.notes,
    source_quote: r.source_quote,
    estimated_minutes: r.estimated_minutes,
    size_amount: r.size_amount,
    size_unit: r.size_unit,
    available_from: r.available_from,
    optional: !!r.optional,
    deadline_only: !!r.deadline_only,
    status: r.status,
    deleted_at: r.deleted_at,
    import_snapshot: r.import_snapshot ? (JSON.parse(r.import_snapshot) as Snapshot) : null,
  }));
}
