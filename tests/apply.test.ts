import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/index';
import { applyImport, buildCandidates } from '../src/import/apply';
import { diffImport } from '../src/import/diff';
import { findTermByName, listTasksForImport } from '../src/db/repo';
import { parseImportFile } from '../src/import/schema';
import { fixedClock } from '../src/clock';

const clock = fixedClock('2026-09-01T12:00:00Z');
const mk = (term = 'T1', items: any[] = [{ course: 'MATH 101', title: 'HW 1', type: 'homework', due_date: '2026-09-06', grade_weight: 1.4 }]) => {
  const r = parseImportFile({
    term: { name: term, start_date: '2026-08-31', end_date: '2026-12-15' },
    items,
    grading_breakdown: [{ category: 'Homework', percent: 15 }],
  });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.data;
};
function run(db: ReturnType<typeof openDb>, file: ReturnType<typeof mk>) {
  const cands = buildCandidates(file, 'America/Detroit', '23:59');
  const term = findTermByName(db, file.term.name);
  const diff = diffImport(cands, term ? listTasksForImport(db, term.id) : []);
  const res = applyImport(db, file, { new: diff.new, changed: diff.changed }, clock);
  return { diff, res };
}
const count = (db: any) => db.get('SELECT COUNT(*) c FROM tasks').c;

describe('applyImport', () => {
  it('creates term and tasks with correct term and UTC dates', () => {
    const db = openDb(':memory:');
    const { res } = run(db, mk());
    expect(res.termCreated).toBe(true);
    const t = db.get<any>('SELECT * FROM tasks');
    expect(t.term_id).toBe(res.termId);
    expect(t.due_date).toBe('2026-09-07T03:59:00.000Z');
    expect(t.time_assumed).toBe(1);
    expect(t.source).toBe('import');
    expect(db.get<any>('SELECT is_current FROM terms').is_current).toBe(1);
    expect(db.get<any>('SELECT percent FROM grading_breakdown').percent).toBe(15);
  });
  it('re-import is idempotent', () => {
    const db = openDb(':memory:');
    run(db, mk());
    const { diff } = run(db, mk());
    expect(diff.new).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
    expect(count(db)).toBe(1);
  });
  it('moved date shows as changed and updates in place', () => {
    const db = openDb(':memory:');
    run(db, mk());
    const moved = mk('T1', [{ course: 'MATH 101', title: 'HW 1', type: 'homework', due_date: '2026-09-13', grade_weight: 1.4 }]);
    const { diff } = run(db, moved);
    expect(diff.changed).toHaveLength(1);
    expect(diff.new).toHaveLength(0);
    expect(count(db)).toBe(1);
    expect(db.get<any>('SELECT due_date FROM tasks').due_date).toBe('2026-09-14T03:59:00.000Z');
  });
  it('local rename does not break matching', () => {
    const db = openDb(':memory:');
    run(db, mk());
    db.run("UPDATE tasks SET title = 'Renamed locally'");
    const { diff } = run(db, mk());
    expect(diff.unchanged).toHaveLength(1);
    expect(count(db)).toBe(1);
    expect(db.get<any>('SELECT title FROM tasks').title).toBe('Renamed locally');
  });
  it('manual edits to other fields survive an update; edited conflicting fields are kept', () => {
    const db = openDb(':memory:');
    run(db, mk());
    db.run("UPDATE tasks SET notes = 'my note', estimated_minutes = 90, grade_weight = 3");
    const { diff } = run(db, mk('T1', [{ course: 'MATH 101', title: 'HW 1', type: 'homework', due_date: '2026-09-13', grade_weight: 2 }]));
    expect(diff.changed[0].conflicts).toEqual(['grade_weight']);
    const t = db.get<any>('SELECT * FROM tasks');
    expect(t.notes).toBe('my note');
    expect(t.estimated_minutes).toBe(90);
    expect(t.grade_weight).toBe(3);
    expect(t.due_date).toBe('2026-09-14T03:59:00.000Z');
    // acknowledged: re-import of same file is now unchanged
    expect(run(db, mk('T1', [{ course: 'MATH 101', title: 'HW 1', type: 'homework', due_date: '2026-09-13', grade_weight: 2 }])).diff.unchanged).toHaveLength(1);
  });
  it('same course in a different term creates separate tasks', () => {
    const db = openDb(':memory:');
    run(db, mk('T1'));
    run(db, mk('T2'));
    expect(count(db)).toBe(2);
    expect(db.get<any>('SELECT COUNT(*) c FROM terms').c).toBe(2);
    expect(db.get<any>('SELECT COUNT(*) c FROM terms WHERE is_current = 1').c).toBe(1);
  });
  it('only approved subset is written', () => {
    const db = openDb(':memory:');
    const f = mk('T1', [
      { course: 'C', title: 'A', type: 'quiz' },
      { course: 'C', title: 'B', type: 'quiz' },
    ]);
    const cands = buildCandidates(f, 'America/Detroit', '23:59');
    applyImport(db, f, { new: [cands[0]], changed: [] }, clock);
    expect(count(db)).toBe(1);
  });
  it('rolls back on failure', () => {
    const db = openDb(':memory:');
    const f = mk();
    const c = buildCandidates(f, 'America/Detroit', '23:59');
    c[0].type = 'bogus';
    expect(() => applyImport(db, f, { new: c, changed: [] }, clock)).toThrow();
    expect(db.get<any>('SELECT COUNT(*) c FROM terms').c).toBe(0);
  });
});

describe('size, available_from, optional in import files', () => {
  const item = (o: any = {}) => ({ course: 'MIDEAST 207', title: 'Pre-class: AY 209-234 (Nov 10)', type: 'reading', due_date: '2026-11-10T11:30:00', size: { amount: 26, unit: 'pages' }, optional: true, available_from: '2026-11-03', ...o });
  it('validates and stores the new optional fields', () => {
    const bad = parseImportFile({ term: { name: 'T', start_date: '2026-08-31', end_date: '2026-12-15' }, items: [item({ size: { amount: -1, unit: 'furlongs' } })] });
    expect(bad.ok).toBe(false);
    const db = openDb(':memory:');
    run(db, mk('T1', [item()]));
    expect(db.get<any>('SELECT size_amount, size_unit, available_from, optional FROM tasks')).toEqual({ size_amount: 26, size_unit: 'pages', available_from: '2026-11-03', optional: 1 });
  });
  it('a size with no amount (video length unknown) is allowed', () => {
    const db = openDb(':memory:');
    run(db, mk('T1', [item({ title: 'Video #4', size: { unit: 'video_minutes' }, optional: false })]));
    expect(db.get<any>('SELECT size_amount, size_unit FROM tasks')).toEqual({ size_amount: null, size_unit: 'video_minutes' });
  });
  it('old files without the new keys still import (defaults)', () => {
    const db = openDb(':memory:');
    run(db, mk());
    expect(db.get<any>('SELECT size_amount, size_unit, available_from, optional FROM tasks')).toEqual({ size_amount: null, size_unit: null, available_from: null, optional: 0 });
  });
  it('re-import is a no-op, fills in a size that was missing, and never clobbers a local edit', () => {
    const db = openDb(':memory:');
    run(db, mk('T1', [item({ size: { unit: 'video_minutes' }, title: 'Video' })]));
    expect(run(db, mk('T1', [item({ size: { unit: 'video_minutes' }, title: 'Video' })])).diff.changed.length).toBe(0);
    // the file now carries an amount: applied (the local value is still the old null)
    const r = run(db, mk('T1', [item({ size: { amount: 20, unit: 'video_minutes' }, title: 'Video' })]));
    expect(r.diff.changed[0].fields.map((f) => f.field)).toContain('size_amount');
    expect(db.get<any>('SELECT size_amount FROM tasks').size_amount).toBe(20);
    // the user edits it locally; a later file change is flagged as a conflict and not applied
    db.run('UPDATE tasks SET size_amount = 33');
    const r2 = run(db, mk('T1', [item({ size: { amount: 25, unit: 'video_minutes' }, title: 'Video' })]));
    expect(r2.diff.changed[0].conflicts).toContain('size_amount');
    expect(db.get<any>('SELECT size_amount FROM tasks').size_amount).toBe(33);
  });
  it('a file can never set the estimate of an existing task (estimates come from the app)', () => {
    const db = openDb(':memory:');
    run(db, mk('T1', [item()]));
    db.run('UPDATE tasks SET estimated_minutes = 77');
    run(db, mk('T1', [item({ estimated_minutes: 5 })]));
    expect(db.get<any>('SELECT estimated_minutes FROM tasks').estimated_minutes).toBe(77);
  });
});

describe('deadline_only in import files', () => {
  const item = (o: any = {}) => ({ course: 'EECS 183', title: 'Showcase Event', type: 'other', due_date: '2026-12-15T10:00:00', deadline_only: true, ...o });
  it('is validated as a boolean, defaults to false, and is stored', () => {
    expect(parseImportFile({ term: { name: 'T', start_date: '2026-08-31', end_date: '2026-12-15' }, items: [item({ deadline_only: 'yes' })] }).ok).toBe(false);
    const db = openDb(':memory:');
    run(db, mk('T1', [item(), item({ title: 'Lab', deadline_only: undefined })]));
    const rows = db.all<any>('SELECT title, deadline_only FROM tasks ORDER BY id');
    expect(rows).toEqual([{ title: 'Showcase Event', deadline_only: 1 }, { title: 'Lab', deadline_only: 0 }]);
  });
  it('re-import is a no-op; a newly flagged item is updated, but a local choice is never overwritten', () => {
    const db = openDb(':memory:');
    run(db, mk('T1', [item({ deadline_only: false })]));
    expect(run(db, mk('T1', [item({ deadline_only: false })])).diff.changed).toHaveLength(0);
    const r = run(db, mk('T1', [item({ deadline_only: true })]));
    expect(r.diff.changed[0].fields.map((f) => f.field)).toContain('deadline_only');
    expect(db.get<any>('SELECT deadline_only d FROM tasks').d).toBe(1);
    db.run('UPDATE tasks SET deadline_only = 0'); // the user made it schedulable again
    const r2 = run(db, mk('T1', [item({ deadline_only: true, due_date: '2026-12-16T10:00:00' })]));
    expect(r2.diff.changed.length).toBe(1);
    expect(r2.diff.changed[0].conflicts).toEqual([]);
    const r3 = run(db, mk('T1', [item({ deadline_only: false })]));
    expect(db.get<any>('SELECT deadline_only d FROM tasks').d).toBe(0);
    expect(r3.diff.changed[0].conflicts).toContain('deadline_only'); // the file changed a field the user also changed
  });
});
