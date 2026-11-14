import type { Db } from '../db/index';
import { resolveDue } from '../time';
import { makeImportKey } from './importKey';
import type { Candidate } from './diff';
import type { ImportFile } from './schema';

export interface ParentInfo {
  id?: number;
  due_date: string | null;
  time_assumed: boolean;
}

/** Find a parent task in the database by term + course + title (not deleted). */
export function findParentInDb(db: Db, termName: string, course: string, title: string): (ParentInfo & { id: number }) | undefined {
  const r = db.get<{ id: number; due_date: string | null; time_assumed: number }>(
    `SELECT t.id, t.due_date, t.time_assumed FROM tasks t JOIN terms m ON m.id = t.term_id
      WHERE m.name = ? COLLATE NOCASE AND t.course = ? COLLATE NOCASE AND t.title = ? COLLATE NOCASE AND t.deleted_at IS NULL`,
    [termName, course, title],
  );
  return r && { id: r.id, due_date: r.due_date, time_assumed: !!r.time_assumed };
}

/** Import key of a plan step: the parent's identity plus the step title, so a revised plan matches step by step. */
export const stepKey = (term: string, course: string, parentTitle: string, stepTitle: string) => makeImportKey(term, course, `${parentTitle} :: ${stepTitle}`);

/**
 * Turn the file's plans into candidates (one per step), in plan order. A step without its own due date takes the
 * parent's due date (and its time-assumed flag) as of the import. The parent must be one of the file's items or a
 * task already in the database for this term; otherwise the error says which plan.
 */
export function buildPlanCandidates(file: ImportFile, tz: string, defaultTime: string, db: Db): Candidate[] {
  const out: Candidate[] = [];
  file.plans.forEach((p, pi) => {
    const { course, title } = p.parent;
    const inFile = file.items.find((i) => i.course.toLowerCase() === course.toLowerCase() && i.title.toLowerCase() === title.toLowerCase());
    let parentDue: { due_date: string | null; time_assumed: boolean } | undefined;
    if (inFile) {
      const d = resolveDue(inFile.due_date, tz, defaultTime);
      parentDue = { due_date: d.dueUtc, time_assumed: d.timeAssumed };
    } else parentDue = findParentInDb(db, file.term.name, course, title);
    if (!parentDue) {
      throw new Error(`plans[${pi}].parent: no task "${title}" for ${course} in term "${file.term.name}" (not in this file's items, and not in the database). Import the parent task first.`);
    }
    const keys = p.steps.map((s) => stepKey(file.term.name, course, title, s.title));
    p.steps.forEach((s, si) => {
      const own = s.due_date ? resolveDue(s.due_date, tz, defaultTime) : undefined;
      out.push({
        import_key: keys[si], course, title: s.title, type: 'other',
        due_date: own ? own.dueUtc : parentDue!.due_date, time_assumed: own ? own.timeAssumed : parentDue!.time_assumed,
        grade_weight: null, notes: null, source_quote: null, estimated_minutes: s.estimated_minutes,
        size_amount: null, size_unit: null, available_from: null, optional: false,
        depends_on: s.depends_on.length ? [...s.depends_on.map((d) => keys[d])].sort().join(',') : null,
        depends_on_titles: s.depends_on.map((d) => p.steps[d].title),
        parent: { course, title }, confidence: 'medium', expanded_from_recurring: false,
      });
    });
  });
  return out;
}

/**
 * Which existing tasks a file is compared with: the steps of the parents it plans, plus ordinary tasks only when the
 * file itself has items (a plan-only file must not report every other task of the course as "missing").
 */
export function existingForImport<T extends { parent_task_id?: number | null }>(file: ImportFile, rows: T[], db: Db): T[] {
  const parentIds = new Set(file.plans.map((p) => findParentInDb(db, file.term.name, p.parent.course, p.parent.title)?.id).filter((x): x is number => x != null));
  return rows.filter((e) => (e.parent_task_id ? parentIds.has(e.parent_task_id) : file.items.length > 0));
}
