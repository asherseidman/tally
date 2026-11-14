import type { Db } from '../db/index';
import type { Clock } from '../clock';
import { findTermByName } from '../db/repo';
import type { Candidate, ChangedItem, ImportField, Snapshot } from './diff';
import { IMPORT_FIELDS, snapshotOf } from './diff';
import type { ImportFile } from './schema';
import { resolveDue } from '../time';
import { makeImportKey } from './importKey';
import { findParentInDb } from './plan';
import { wouldCycle } from '../core/dependencies';

/** Convert a validated file into candidates (UTC dates, import keys). */
export function buildCandidates(file: ImportFile, tz: string, defaultTime: string): Candidate[] {
  return file.items.map((it) => {
    const { dueUtc, timeAssumed } = resolveDue(it.due_date, tz, defaultTime);
    return {
      import_key: makeImportKey(file.term.name, it.course, it.title),
      course: it.course,
      title: it.title,
      type: it.type,
      due_date: dueUtc,
      time_assumed: timeAssumed,
      grade_weight: it.grade_weight,
      notes: it.notes,
      source_quote: it.source_quote,
      estimated_minutes: it.estimated_minutes,
      size_amount: it.size?.amount ?? null,
      size_unit: it.size?.unit ?? null,
      available_from: it.available_from,
      optional: it.optional,
      deadline_only: it.deadline_only,
      confidence: it.confidence,
      expanded_from_recurring: it.expanded_from_recurring,
    };
  });
}

export interface ApprovedPlan {
  new: Candidate[];
  changed: ChangedItem[];
}

export interface ApplyResult {
  termId: number;
  termCreated: boolean;
  inserted: number;
  updated: number;
  skippedConflicts: { taskId: number; fields: ImportField[] }[];
}

/**
 * Write approved items in a single transaction. Changed items only update fields the user
 * has not edited locally; the stored snapshot is advanced to the file's values so an
 * acknowledged local edit is not flagged again on the next re-import.
 */
export function applyImport(db: Db, file: ImportFile, plan: ApprovedPlan, clock: Clock): ApplyResult {
  const now = clock.now().toISOString();
  return db.transaction(() => {
    let term = findTermByName(db, file.term.name);
    let termCreated = false;
    if (!term) {
      const anyCurrent = db.get('SELECT 1 AS x FROM terms WHERE is_current = 1 AND archived_at IS NULL');
      const r = db.run('INSERT INTO terms(name, start_date, end_date, is_current) VALUES(?,?,?,?)', [
        file.term.name,
        file.term.start_date,
        file.term.end_date,
        anyCurrent ? 0 : 1,
      ]);
      term = findTermByName(db, file.term.name)!;
      void r;
      termCreated = true;
    }
    const termId = term.id;

    let inserted = 0;
    const parentId = (c: Candidate) => (c.parent ? findParentInDb(db, file.term.name, c.parent.course, c.parent.title)?.id ?? null : null);
    // parents (ordinary items) first, then their plan steps
    for (const c of [...plan.new].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0))) {
      db.run(
        `INSERT INTO tasks(title, notes, term_id, course, type, due_date, time_assumed, grade_weight, estimated_minutes,
           estimate_source, status, source, import_key, source_quote, import_snapshot, confidence, expanded_from_recurring,
           created_at, updated_at, size_amount, size_unit, available_from, optional, parent_task_id, deadline_only)
         VALUES(?,?,?,?,?,?,?,?,?,?, 'todo','import',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          c.title, c.notes, termId, c.course, c.type, c.due_date, c.time_assumed ? 1 : 0, c.grade_weight,
          c.estimated_minutes, c.estimated_minutes != null ? 'imported' : null,
          c.import_key, c.source_quote, JSON.stringify(snapshotOf(c)), c.confidence, c.expanded_from_recurring ? 1 : 0,
          now, now, c.size_amount, c.size_unit, c.available_from, c.optional ? 1 : 0, parentId(c), c.deadline_only ? 1 : 0,
        ],
      );
      inserted++;
    }

    let updated = 0;
    const rewire: unknown[] = [];
    const skippedConflicts: ApplyResult['skippedConflicts'] = [];
    for (const ch of plan.changed) {
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const f of ch.fields) {
        if (ch.conflicts.includes(f.field)) continue;
        if (f.field === 'depends_on') {
          rewire.push(ch.existing.id, ch.candidate);
          continue;
        }
        sets.push(`${f.field} = ?`);
        const v = f.to;
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
        if (f.field === 'estimated_minutes') {
          sets.push('estimate_source = ?');
          vals.push(v != null ? 'imported' : null);
        }
      }
      const snap = { ...(ch.existing.import_snapshot ?? {}) } as Snapshot;
      for (const f of IMPORT_FIELDS) snap[f] = ((ch.candidate[f] as Snapshot[ImportField] | undefined) ?? null) as Snapshot[ImportField];
      sets.push('import_snapshot = ?', 'updated_at = ?');
      vals.push(JSON.stringify(snap), now, ch.existing.id);
      db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, vals);
      updated++;
      if (ch.conflicts.length) skippedConflicts.push({ taskId: ch.existing.id, fields: ch.conflicts });
    }

    // Plan-step dependencies: make the step-to-step links match the file (links to tasks outside the plan are never touched).
    const steps: { id: number; c: Candidate }[] = [];
    for (const c of plan.new) if (c.parent) steps.push({ id: db.get<{ id: number }>('SELECT id FROM tasks WHERE import_key = ?', [c.import_key])!.id, c });
    for (let i = 0; i < rewire.length; i += 2) steps.push({ id: rewire[i] as number, c: rewire[i + 1] as Candidate });
    for (const { id, c } of steps) {
      const pid = db.get<{ p: number | null }>('SELECT parent_task_id p FROM tasks WHERE id = ?', [id])?.p;
      if (pid) db.run('DELETE FROM dependencies WHERE task_id = ? AND blocked_by_task_id IN (SELECT id FROM tasks WHERE parent_task_id = ?)', [id, pid]);
      for (const key of c.depends_on ? c.depends_on.split(',') : []) {
        const b = db.get<{ id: number }>('SELECT id FROM tasks WHERE import_key = ?', [key]);
        if (!b) continue;
        if (wouldCycle(db, id, b.id)) throw new Error(`Step "${c.title}" cannot wait on "${db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ?', [b.id])!.title}": it would create a dependency loop with tasks already in your database. Nothing was imported.`);
        db.run('INSERT OR IGNORE INTO dependencies(task_id, blocked_by_task_id) VALUES(?,?)', [id, b.id]);
      }
    }

    const byCourse = new Map<string, typeof file.grading_breakdown>();
    for (const b of file.grading_breakdown) byCourse.set(b.course, [...(byCourse.get(b.course) ?? []), b]);
    for (const [course, rows] of byCourse) {
      db.run('DELETE FROM grading_breakdown WHERE term_id = ? AND course = ? COLLATE NOCASE', [termId, course]);
      for (const b of rows) {
        db.run('INSERT OR REPLACE INTO grading_breakdown(term_id, course, category, percent) VALUES(?,?,?,?)', [termId, course, b.category, b.percent]);
      }
    }
    return { termId, termCreated, inserted, updated, skippedConflicts };
  });
}
