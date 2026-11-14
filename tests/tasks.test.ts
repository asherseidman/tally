import { describe, it, expect } from 'vitest';
import { makeCtx } from './helpers';
import { createTerm } from '../src/core/terms';
import { createList, renameList, deleteList, listLists, moveTask } from '../src/core/lists';
import {
  addTask, editTask, completeTask, uncompleteTask, deleteTask, undoDelete, listTasks, getTask,
} from '../src/core/tasks';
import { fixedClock } from '../src/clock';

function setup() {
  const ctx = makeCtx();
  createTerm(ctx, { name: 'A', start_date: '2026-08-31', end_date: '2026-12-11' });
  return ctx;
}

describe('add / edit', () => {
  it('quick-add sets fields, natural due in local tz, manual estimate', () => {
    const ctx = setup();
    createList(ctx, 'Math');
    const t = addTask(ctx, { title: 'Read ch. 3', due: 'fri 5pm', list: 'Math', est: 45 });
    expect(t.due_date).toBe('2026-09-04T21:00:00.000Z');
    expect(t.time_assumed).toBe(0);
    expect(t.estimated_minutes).toBe(45);
    expect(t.estimate_source).toBe('manual');
    expect(t.source).toBe('manual');
    expect(t.import_key).toBeNull();
    expect(t.created_at).toBe('2026-09-01T16:00:00.000Z');
  });
  it('course tasks get the current term; no-course tasks have none', () => {
    const ctx = setup();
    expect(addTask(ctx, { title: 'x', course: 'MATH 101' }).term_id).not.toBeNull();
    expect(addTask(ctx, { title: 'y' }).term_id).toBeNull();
  });
  it('rejects empty title, bad type, unknown list, repeat without due', () => {
    const ctx = setup();
    expect(() => addTask(ctx, { title: '  ' })).toThrow();
    expect(() => addTask(ctx, { title: 'x', type: 'bogus' })).toThrow(/type/);
    expect(() => addTask(ctx, { title: 'x', list: 'Nope' })).toThrow(/Nope/);
    expect(() => addTask(ctx, { title: 'x', repeat: 'daily' })).toThrow(/due/i);
  });
  it('edit changes fields, clears due, moves between lists', () => {
    const ctx = setup();
    createList(ctx, 'Math');
    createList(ctx, 'Bio');
    const t = addTask(ctx, { title: 'x', due: 'tomorrow', list: 'Math' });
    const e = editTask(ctx, t.id, { title: 'y', list: 'Bio', est: 30, due: 'none' });
    expect(e.title).toBe('y');
    expect(e.due_date).toBeNull();
    expect(e.time_assumed).toBe(0);
    expect(e.estimated_minutes).toBe(30);
    expect(moveTask(ctx, t.id, 'Math').list_id).not.toBe(e.list_id);
  });
  it('edit of a missing id errors', () => {
    expect(() => editTask(setup(), 999, { title: 'z' })).toThrow(/999/);
  });
});

describe('complete / uncomplete / recurrence', () => {
  it('complete and un-complete', () => {
    const ctx = setup();
    const t = addTask(ctx, { title: 'x' });
    const d = completeTask(ctx, t.id);
    expect(d.completed.status).toBe('done');
    expect(d.completed.completed_at).toBe('2026-09-01T16:00:00.000Z');
    expect(d.next).toBeUndefined();
    const u = uncompleteTask(ctx, t.id);
    expect(u.status).toBe('todo');
    expect(u.completed_at).toBeNull();
  });
  it('completing a recurring task creates the next occurrence; un-complete removes it', () => {
    const ctx = setup();
    const t = addTask(ctx, { title: 'Weekly review', due: '2026-10-28T09:00', repeat: 'weekly', est: 20 });
    const d = completeTask(ctx, t.id);
    expect(d.next).toBeDefined();
    expect(d.next!.due_date).toBe('2026-11-04T14:00:00.000Z'); // 9:00 AM local across DST
    expect(d.next!.recurrence_rule).toBe(t.recurrence_rule);
    expect(d.next!.estimated_minutes).toBe(20);
    expect(d.next!.status).toBe('todo');
    expect(listTasks(ctx, {}).filter((x) => x.status === 'todo')).toHaveLength(1);
    uncompleteTask(ctx, t.id);
    expect(listTasks(ctx, {}).map((x) => x.id)).toEqual([t.id]);
    expect(getTask(ctx, d.next!.id, { includeDeleted: true })!.deleted_at).not.toBeNull();
  });
  it('completing twice does not duplicate the next occurrence', () => {
    const ctx = setup();
    const t = addTask(ctx, { title: 'r', due: '2026-10-05', repeat: 'daily' });
    completeTask(ctx, t.id);
    const again = completeTask(ctx, t.id);
    expect(again.next).toBeUndefined();
    expect(listTasks(ctx, { scope: { allTerms: true } })).toHaveLength(2);
  });
  it('overdue recurring task skips past occurrences', () => {
    const ctx = makeCtx('2026-09-10T16:00:00Z');
    const t = addTask(ctx, { title: 'r', due: '2026-09-01T09:00', repeat: 'daily' });
    const n = completeTask(ctx, t.id).next!;
    expect(n.due_date! > '2026-09-10T16:00:00.000Z').toBe(true);
    expect(n.due_date).toBe('2026-09-11T13:00:00.000Z');
  });
  it('un-completing a task that is not done errors', () => {
    const ctx = setup();
    const t = addTask(ctx, { title: 'x' });
    expect(() => uncompleteTask(ctx, t.id)).toThrow(/not done/i);
  });
});

describe('soft delete & undo', () => {
  it('delete hides, undo restores, nothing is physically removed', () => {
    const ctx = setup();
    const t = addTask(ctx, { title: 'x' });
    deleteTask(ctx, t.id);
    expect(listTasks(ctx, {})).toHaveLength(0);
    expect(listTasks(ctx, { deleted: true })).toHaveLength(1);
    expect(ctx.db.get<any>('SELECT COUNT(*) c FROM tasks').c).toBe(1);
    undoDelete(ctx, t.id);
    expect(listTasks(ctx, {})).toHaveLength(1);
  });
  it('undo without id restores the most recently deleted', () => {
    const ctx = setup();
    const a = addTask(ctx, { title: 'a' });
    const b = addTask(ctx, { title: 'b' });
    deleteTask(ctx, a.id);
    (ctx as any).clock = fixedClock('2026-09-01T17:00:00Z');
    deleteTask(ctx, b.id);
    expect(undoDelete(ctx).id).toBe(b.id);
  });
  it('undo with nothing deleted errors; deleting twice errors', () => {
    const ctx = setup();
    expect(() => undoDelete(ctx)).toThrow(/nothing/i);
    const t = addTask(ctx, { title: 'x' });
    deleteTask(ctx, t.id);
    expect(() => deleteTask(ctx, t.id)).toThrow();
  });
  it('cannot edit or complete a deleted task', () => {
    const ctx = setup();
    const t = addTask(ctx, { title: 'x' });
    deleteTask(ctx, t.id);
    expect(() => editTask(ctx, t.id, { title: 'y' })).toThrow();
    expect(() => completeTask(ctx, t.id)).toThrow();
  });
});

describe('search & filter', () => {
  it('filters by list, course, status, due range, and text', () => {
    const ctx = setup();
    createList(ctx, 'Math');
    addTask(ctx, { title: 'Problem set', course: 'MATH 101', list: 'Math', due: '2026-09-05', notes: 'chapter 4' });
    addTask(ctx, { title: 'Essay', course: 'ENG 200', due: '2026-09-20' });
    const done = addTask(ctx, { title: 'Done thing', course: 'MATH 101' });
    completeTask(ctx, done.id);
    const titles = (f: any) => listTasks(ctx, f).map((t) => t.title).sort();
    expect(titles({ list: 'Math' })).toEqual(['Problem set']);
    expect(titles({ course: 'math 101' })).toEqual(['Done thing', 'Problem set']);
    expect(titles({ status: 'done' })).toEqual(['Done thing']);
    expect(titles({ from: '2026-09-10', to: '2026-09-30' })).toEqual(['Essay']);
    expect(titles({ text: 'CHAPTER' })).toEqual(['Problem set']);
    expect(titles({ text: 'eng' })).toEqual(['Essay']);
  });
  it('text search treats LIKE wildcards literally', () => {
    const ctx = setup();
    addTask(ctx, { title: '100% effort' });
    addTask(ctx, { title: 'other' });
    expect(listTasks(ctx, { text: '%' }).map((t) => t.title)).toEqual(['100% effort']);
  });
  it('sorts by due date, undated last', () => {
    const ctx = setup();
    addTask(ctx, { title: 'none' });
    addTask(ctx, { title: 'late', due: '2026-10-01' });
    addTask(ctx, { title: 'early', due: '2026-09-02' });
    expect(listTasks(ctx, {}).map((t) => t.title)).toEqual(['early', 'late', 'none']);
  });
});

describe('lists', () => {
  it('create, rename, delete (tasks are kept and unlinked)', () => {
    const ctx = setup();
    createList(ctx, 'Math');
    expect(() => createList(ctx, 'math')).toThrow(/exists/);
    renameList(ctx, 'Math', 'Calculus');
    const t = addTask(ctx, { title: 'x', list: 'Calculus' });
    deleteList(ctx, 'Calculus');
    expect(getTask(ctx, t.id)!.list_id).toBeNull();
    expect(listLists(ctx)).toHaveLength(0);
  });
});
