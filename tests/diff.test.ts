import { describe, it, expect } from 'vitest';
import { diffImport, type Candidate, type ExistingTask } from '../src/import/diff';

const cand = (o: Partial<Candidate> = {}): Candidate => ({
  import_key: 'k1', course: 'MATH 101', title: 'HW 1', type: 'homework',
  due_date: '2026-09-07T03:59:00.000Z', time_assumed: true, grade_weight: 1.4,
  notes: null, source_quote: null, estimated_minutes: null, size_amount: null, size_unit: null, available_from: null, optional: false,
  confidence: 'high', expanded_from_recurring: false, ...o,
});
const snapOf = (c: Candidate) => ({
  type: c.type, due_date: c.due_date, time_assumed: c.time_assumed, grade_weight: c.grade_weight,
  notes: c.notes, source_quote: c.source_quote, estimated_minutes: c.estimated_minutes,
  size_amount: c.size_amount, size_unit: c.size_unit, available_from: c.available_from, optional: c.optional, deadline_only: false, depends_on: null,
});
const existing = (c: Candidate, o: Partial<ExistingTask> = {}): ExistingTask => ({
  id: 1, import_key: c.import_key, course: c.course, title: c.title, ...snapOf(c),
  status: 'todo', deleted_at: null, import_snapshot: snapOf(c), ...o,
});

describe('diffImport', () => {
  it('new when key not in db', () => {
    const r = diffImport([cand()], []);
    expect(r.new).toHaveLength(1);
  });
  it('unchanged when identical', () => {
    const c = cand();
    const r = diffImport([c], [existing(c)]);
    expect(r.unchanged).toHaveLength(1);
    expect(r.new).toHaveLength(0);
  });
  it('moved date is changed, not new', () => {
    const c = cand();
    const moved = cand({ due_date: '2026-09-14T03:59:00.000Z' });
    const r = diffImport([moved], [existing(c)]);
    expect(r.new).toHaveLength(0);
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].fields.map((f) => f.field)).toEqual(['due_date']);
    expect(r.changed[0].conflicts).toEqual([]);
  });
  it('local rename does not affect matching or count as change', () => {
    const c = cand();
    const r = diffImport([c], [existing(c, { title: 'My renamed homework' })]);
    expect(r.unchanged).toHaveLength(1);
  });
  it('field edited locally and changed in file is a conflict, not applied', () => {
    const c = cand();
    const moved = cand({ due_date: '2026-09-14T03:59:00.000Z' });
    const r = diffImport([moved], [existing(c, { due_date: '2026-09-08T03:59:00.000Z' })]);
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].conflicts).toEqual(['due_date']);
  });
  it('local edit with unchanged file is unchanged', () => {
    const c = cand();
    const r = diffImport([c], [existing(c, { due_date: '2026-09-08T03:59:00.000Z' })]);
    expect(r.unchanged).toHaveLength(1);
  });
  it('missing: same course, import-sourced, active, not in file', () => {
    const a = cand(); const b = cand({ import_key: 'k2', title: 'HW 2' });
    const other = cand({ import_key: 'k3', course: 'PHYS 101' });
    const r = diffImport([a], [existing(a), existing(b, { id: 2 }), existing(other, { id: 3 })]);
    expect(r.missing.map((m) => m.id)).toEqual([2]);
  });
  it('soft-deleted tasks are not resurrected or reported missing', () => {
    const c = cand();
    const r = diffImport([c], [existing(c, { deleted_at: '2026-09-01T00:00:00Z' })]);
    expect(r.new).toHaveLength(0);
    expect(r.unchanged).toHaveLength(1);
    const r2 = diffImport([], [existing(c, { deleted_at: 'x' })]);
    expect(r2.missing).toHaveLength(0);
  });
  it('null snapshot (legacy) compares against current values', () => {
    const c = cand();
    const r = diffImport([cand({ grade_weight: 2 })], [existing(c, { import_snapshot: null })]);
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].conflicts).toEqual([]);
  });
});

describe('estimates are never changed by a re-import', () => {
  it('a file that now carries an estimate does not touch a task whose estimate was cleared in the app', () => {
    const c = cand({ estimated_minutes: null });
    const withEstimate = cand({ estimated_minutes: 60 });
    const r = diffImport([withEstimate], [existing(c)]);
    expect(r.changed).toHaveLength(0);
    expect(r.unchanged).toHaveLength(1);
  });
  it('nor does it overwrite an estimate set in the app, and it is not reported as a conflict', () => {
    const c = cand({ estimated_minutes: null });
    const r = diffImport([cand({ estimated_minutes: 90 })], [existing(c, { estimated_minutes: 45 })]);
    expect(r.changed).toHaveLength(0);
  });
  it('other fields in the same task still update normally', () => {
    const c = cand();
    const r = diffImport([cand({ estimated_minutes: 60, due_date: '2026-09-14T03:59:00.000Z' })], [existing(c)]);
    expect(r.changed).toHaveLength(1);
    expect(r.changed[0].fields.map((f) => f.field)).toEqual(['due_date']);
  });
  it('brand-new tasks still take the estimate from the file as their starting value', () => {
    const r = diffImport([cand({ estimated_minutes: 60 })], []);
    expect(r.new[0].estimated_minutes).toBe(60);
  });
});
