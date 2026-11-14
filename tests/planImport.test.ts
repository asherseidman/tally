import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/index';
import { parseImportFile } from '../src/import/schema';
import { buildCandidates, applyImport } from '../src/import/apply';
import { buildPlanCandidates, existingForImport } from '../src/import/plan';
import { diffImport } from '../src/import/diff';
import { findTermByName, listTasksForImport } from '../src/db/repo';
import { fixedClock } from '../src/clock';
import { openBlockers } from '../src/core/dependencies';
import { makeCtx } from './helpers';

const clock = fixedClock('2026-11-01T12:00:00Z');
const TERM = { name: 'Fall 2026', start_date: '2026-08-31', end_date: '2026-12-21' };
const exam = { course: 'EECS 183', title: 'Exam 2', type: 'exam', due_date: '2026-11-11T20:00:00' };
const steps = (extra: any[] = []) => [
  { title: 'Review lectures', estimated_minutes: 90 },
  { title: 'Practice problems', estimated_minutes: 120, depends_on: [0] },
  { title: 'Mock exam', estimated_minutes: 60, due_date: '2026-11-10', depends_on: [0, 1] },
  ...extra,
];
const file = (o: any = {}) => {
  const r = parseImportFile({ term: TERM, items: [exam], plans: [{ parent: { course: 'EECS 183', title: 'Exam 2' }, steps: steps() }], ...o });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.data;
};
function run(db: ReturnType<typeof openDb>, f: ReturnType<typeof file>) {
  const cands = [...buildCandidates(f, 'America/Detroit', '23:59'), ...buildPlanCandidates(f, 'America/Detroit', '23:59', db)];
  const term = findTermByName(db, f.term.name);
  const diff = diffImport(cands, existingForImport(f, term ? listTasksForImport(db, term.id) : [], db));
  const res = applyImport(db, f, { new: diff.new, changed: diff.changed }, clock);
  return { diff, res };
}
const row = (db: any, title: string) => db.get('SELECT * FROM tasks WHERE title = ?', [title]);

describe('plan validation', () => {
  const bad = (plans: any) => parseImportFile({ term: TERM, items: [exam], plans });
  const errs = (plans: any) => { const r = bad(plans); return r.ok ? [] : r.errors; };
  it('rejects out-of-range, self and looping depends_on, and duplicate titles, with readable paths', () => {
    const P = { course: 'EECS 183', title: 'Exam 2' };
    expect(errs([{ parent: P, steps: [{ title: 'a', estimated_minutes: 10, depends_on: [5] }] }]).join()).toMatch(/plans\[0\]\.steps\[0\]\.depends_on\[0\].*index 5/);
    expect(errs([{ parent: P, steps: [{ title: 'a', estimated_minutes: 10, depends_on: [0] }] }]).join()).toMatch(/cannot depend on itself/);
    expect(errs([{ parent: P, steps: [{ title: 'a', estimated_minutes: 10, depends_on: [1] }, { title: 'b', estimated_minutes: 10, depends_on: [0] }] }]).join()).toMatch(/loop: \[0\] a -> \[1\] b -> \[0\] a/);
    expect(errs([{ parent: P, steps: [{ title: 'a', estimated_minutes: 10 }, { title: 'A', estimated_minutes: 10 }] }]).join()).toMatch(/duplicate step title/);
    expect(errs([{ parent: P, steps: [{ title: 'a', estimated_minutes: 0 }] }]).length).toBeGreaterThan(0);
    expect(errs([{ parent: P, steps: [] }]).length).toBeGreaterThan(0);
  });
  it('a plan whose parent is nowhere is an error naming the plan', () => {
    const db = openDb(':memory:');
    const f = file({ items: [] });
    expect(() => buildPlanCandidates(f, 'America/Detroit', '23:59', db)).toThrow(/plans\[0\]\.parent: no task "Exam 2" for EECS 183.*Import the parent task first/);
  });
});

describe('importing a plan', () => {
  it('saves steps as tasks in the parent\'s term, links the parent, wires dependencies, marks estimates imported', () => {
    const db = openDb(':memory:');
    const { res } = run(db, file());
    expect(res.inserted).toBe(4);
    const parent = row(db, 'Exam 2');
    const [a, b, c] = ['Review lectures', 'Practice problems', 'Mock exam'].map((t) => row(db, t));
    for (const s of [a, b, c]) expect(s).toMatchObject({ parent_task_id: parent.id, term_id: parent.term_id, course: 'EECS 183', estimate_source: 'imported', source: 'import' });
    expect([a.estimated_minutes, b.estimated_minutes, c.estimated_minutes]).toEqual([90, 120, 60]);
    expect(a.due_date).toBe(parent.due_date); // no own due date: inherits the parent's
    expect(a.time_assumed).toBe(parent.time_assumed);
    expect(c.due_date).toBe('2026-11-11T04:59:00.000Z'); // its own date (default time 23:59)
    const ctx = { ...makeCtx(), db };
    expect(openBlockers(ctx, a.id)).toEqual([]);
    expect(openBlockers(ctx, b.id).map((t) => t.id)).toEqual([a.id]);
    expect(openBlockers(ctx, c.id).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(a.import_key).toBeTruthy();
  });
  it('a plan can target a parent already in the database (plan-only file) and does not call other tasks missing', () => {
    const db = openDb(':memory:');
    run(db, file({ plans: [] })); // exam + nothing
    run(db, { ...file({ items: [{ course: 'EECS 183', title: 'Lab 1', type: 'homework', due_date: '2026-11-05' }], plans: [] }) });
    const planOnly = file({ items: [] });
    const { diff, res } = run(db, planOnly);
    expect(diff.missing).toEqual([]);
    expect(res.inserted).toBe(3);
  });
  it('re-importing the same plan is a no-op (no duplicates, nothing changed)', () => {
    const db = openDb(':memory:');
    run(db, file());
    const { diff, res } = run(db, file());
    expect([diff.new.length, diff.changed.length, res.inserted, res.updated]).toEqual([0, 0, 0, 0]);
    expect(db.get<any>('SELECT COUNT(*) c FROM tasks').c).toBe(4);
    expect(db.get<any>('SELECT COUNT(*) c FROM dependencies').c).toBe(3);
  });
  it('a revised plan diffs cleanly: new step added, changed due date updated, dependencies rewired, removed step reported missing and kept', () => {
    const db = openDb(':memory:');
    run(db, file());
    const revised = file({
      plans: [{ parent: { course: 'EECS 183', title: 'Exam 2' }, steps: [
        { title: 'Review lectures', estimated_minutes: 90 },
        { title: 'Practice problems', estimated_minutes: 120 }, // no longer depends on step 0
        { title: 'Mock exam', estimated_minutes: 60, due_date: '2026-11-09', depends_on: [1] }, // new date; only needs practice
        { title: 'Flashcards', estimated_minutes: 30 }, // new
      ] }],
    });
    const { diff, res } = run(db, revised);
    expect(diff.new.map((c) => c.title)).toEqual(['Flashcards']);
    expect(diff.changed.map((c) => c.candidate.title).sort()).toEqual(['Mock exam', 'Practice problems']);
    expect(res.inserted).toBe(1);
    const ctx = { ...makeCtx(), db };
    expect(openBlockers(ctx, row(db, 'Practice problems').id)).toEqual([]);
    expect(openBlockers(ctx, row(db, 'Mock exam').id).map((t) => t.title)).toEqual(['Practice problems']);
    expect(row(db, 'Mock exam').due_date).toBe('2026-11-10T04:59:00.000Z');
    // drop a step from the file: reported missing, task stays
    const dropped = file({ plans: [{ parent: { course: 'EECS 183', title: 'Exam 2' }, steps: [{ title: 'Review lectures', estimated_minutes: 90 }] }] });
    const r2 = run(db, dropped);
    expect(r2.diff.missing.map((m) => m.title).sort()).toEqual(['Flashcards', 'Mock exam', 'Practice problems']);
    expect(db.get<any>('SELECT COUNT(*) c FROM tasks').c).toBe(5);
  });
  it('local edits to a step are protected, and estimates are never changed by a re-import', () => {
    const db = openDb(':memory:');
    run(db, file());
    db.run("UPDATE tasks SET estimated_minutes = 200 WHERE title = 'Review lectures'");
    db.run("UPDATE tasks SET due_date = '2026-11-08T04:59:00.000Z' WHERE title = 'Mock exam'");
    const r = file({ plans: [{ parent: { course: 'EECS 183', title: 'Exam 2' }, steps: [
      { title: 'Review lectures', estimated_minutes: 45 }, { title: 'Practice problems', estimated_minutes: 120, depends_on: [0] }, { title: 'Mock exam', estimated_minutes: 60, due_date: '2026-11-12', depends_on: [0, 1] }] }] });
    const { diff } = run(db, r);
    expect(row(db, 'Review lectures').estimated_minutes).toBe(200);
    const mock = diff.changed.find((c) => c.candidate.title === 'Mock exam')!;
    expect(mock.conflicts).toContain('due_date');
    expect(row(db, 'Mock exam').due_date).toBe('2026-11-08T04:59:00.000Z');
  });
  it('refuses a plan that would loop with dependencies already in the database, and imports nothing', () => {
    const db = openDb(':memory:');
    run(db, file());
    const a = row(db, 'Review lectures'), c = row(db, 'Mock exam');
    db.run('INSERT INTO dependencies VALUES(?,?)', [a.id, c.id]); // manual: Review waits on Mock exam (a loop with the plan's Mock <- Review)
    const bumped = file({ plans: [{ parent: { course: 'EECS 183', title: 'Exam 2' }, steps: [
      { title: 'Review lectures', estimated_minutes: 90 }, { title: 'Practice problems', estimated_minutes: 120, depends_on: [0] }, { title: 'Mock exam', estimated_minutes: 60, due_date: '2026-11-10', depends_on: [0] }] }] });
    expect(() => run(db, bumped)).toThrow(/dependency loop/);
  });
});
