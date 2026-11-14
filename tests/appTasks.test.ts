import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index';
import { makeCtx } from './helpers';
import { createTerm } from '../src/core/terms';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { dispatch, type ApiDeps } from '../src/app/api';
import { applyOrder, getOrder, saveOrder } from '../src/core/ordering';

function deps(): ApiDeps {
  const ctx = makeCtx('2026-11-09T14:00:00Z'); // Mon Nov 9, 9:00 AM Detroit
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  const cal = new FakeCalendar({ calendars: [] });
  return { ctx, dbFile: ':memory:', demo: true, backupFolder: '/nonexistent', calendar: () => ({ calendar: cal }) };
}
const ok = async (d: ApiDeps, ch: string, args?: unknown) => {
  const r = await dispatch(d, ch, args);
  if (!r.ok) throw new Error(r.error);
  return r.value as any;
};
const err = async (d: ApiDeps, ch: string, args?: unknown) => {
  const r = await dispatch(d, ch, args);
  if (r.ok) throw new Error('expected an error');
  return r.error;
};

describe('ordering helper', () => {
  it('puts ordered ids first, ignores unknown ids, appends new ones, rejects duplicates', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    expect(applyOrder(items, [3, 99, 1]).map((x) => x.id)).toEqual([3, 1, 2, 4]);
    expect(applyOrder(items, []).map((x) => x.id)).toEqual([1, 2, 3, 4]);
    const ctx = makeCtx();
    saveOrder(ctx, 'order.lists', [2, 1]);
    expect(getOrder(ctx, 'order.lists')).toEqual([2, 1]);
    expect(() => saveOrder(ctx, 'k', [1, 1])).toThrow(/twice/);
  });
});

describe('tasks api', () => {
  it('quick-add parses a natural due date, flags an assumed time, and returns a display-ready task', async () => {
    const d = deps();
    const t = await ok(d, 'tasks.add', { title: 'Email advisor', due: 'fri 5pm', est: 10 });
    expect(t).toMatchObject({ title: 'Email advisor', status: 'todo', timeAssumed: false, estimate: 10, estimateSource: 'manual' });
    expect(t.dueText).toBe('Fri Nov 13 2026 5:00 PM');
    const dateOnly = await ok(d, 'tasks.add', { title: 'Read', due: 'sat' });
    expect(dateOnly.timeAssumed).toBe(true);
    expect(await err(d, 'tasks.add', { title: '' })).toMatch(/Invalid request/);
    expect(await err(d, 'tasks.add', { title: 'x', due: 'whenever-ish gibberish ???' })).toMatch(/./);
  });
  it('edits through the same rules as the CLI: size-based estimate, manual estimate kept, readable errors', async () => {
    const d = deps();
    const t = await ok(d, 'tasks.add', { title: 'Reading', course: 'HIST 101', type: 'reading', due: 'fri' });
    let det = await ok(d, 'tasks.edit', { id: t.id, patch: { size: { amount: 10, unit: 'pages' } } });
    expect(det.task).toMatchObject({ estimate: 30, estimateSource: 'size', sizeAmount: 10, sizeUnit: 'pages' });
    expect(det.task.estimateNote).toBe('10 pages x 3 min = 30 min (default rate)');
    det = await ok(d, 'tasks.edit', { id: t.id, patch: { est: 90 } });
    expect(det.task).toMatchObject({ estimate: 90, estimateSource: 'manual' });
    expect(det.task.estimateNote).toMatch(/^Size-based would be 10 pages x 3 min/);
    det = await ok(d, 'tasks.edit', { id: t.id, patch: { optional: true, deadlineOnly: true, availableFrom: '2026-11-10', notes: 'hello' } });
    expect(det.task).toMatchObject({ optional: true, deadlineOnly: true, availableFrom: '2026-11-10', notes: 'hello' });
    expect(await err(d, 'tasks.edit', { id: t.id, patch: { type: 'nonsense' } })).toMatch(/Invalid request/);
    expect(await err(d, 'tasks.edit', { id: t.id, patch: { due: 'banana' } })).toMatch(/./);
    expect(await err(d, 'tasks.edit', { id: 999, patch: { title: 'x' } })).toMatch(/No task #999/);
  });
  it('complete / undo / delete / restore, and a repeating task spawns its next occurrence', async () => {
    const d = deps();
    const t = await ok(d, 'tasks.add', { title: 'Weekly review', due: 'sun 9am' });
    await ok(d, 'tasks.edit', { id: t.id, patch: { repeat: 'weekly' } });
    const done = await ok(d, 'tasks.done', { id: t.id });
    expect(done.next).toBeGreaterThan(t.id);
    await ok(d, 'tasks.undone', { id: t.id });
    expect((await ok(d, 'tasks.get', { id: t.id })).task.status).toBe('todo');
    await ok(d, 'tasks.delete', { id: t.id });
    expect((await ok(d, 'tasks.get', { id: t.id })).task.deleted).toBe(true);
    expect((await ok(d, 'tasks.list', {})).some((x: any) => x.id === t.id)).toBe(false);
    await ok(d, 'tasks.undelete', { id: t.id });
    expect((await ok(d, 'tasks.list', {})).some((x: any) => x.id === t.id)).toBe(true);
  });
  it('logs work and times tasks: one timer at a time, stopping records the session', async () => {
    const d = deps();
    const a = await ok(d, 'tasks.add', { title: 'A' });
    const b = await ok(d, 'tasks.add', { title: 'B' });
    await ok(d, 'tasks.log', { id: a.id, minutes: 25 });
    expect((await ok(d, 'tasks.get', { id: a.id })).task.actualMinutes).toBe(25);
    let timers = await ok(d, 'timer.start', { id: a.id });
    expect(timers).toHaveLength(1);
    timers = await ok(d, 'timer.start', { id: b.id }); // stops A, starts B
    expect(timers).toHaveLength(1);
    expect(timers[0].taskId).toBe(b.id);
    const r = await ok(d, 'timer.stop');
    expect(r.timers).toEqual([]);
    expect(r.stopped).toHaveLength(1);
    expect(await err(d, 'tasks.log', { id: a.id, minutes: 0 })).toMatch(/Invalid request/);
  });
  it('dependencies: add, cycle refused with names, blockers shown, completing a blocker releases', async () => {
    const d = deps();
    const a = await ok(d, 'tasks.add', { title: 'Draft' });
    const b = await ok(d, 'tasks.add', { title: 'Edit' });
    let det = await ok(d, 'deps.add', { task: b.id, blockedBy: a.id });
    expect(det.blockers).toEqual([{ id: a.id, title: 'Draft', open: true }]);
    expect(det.task.blockedBy).toEqual([{ id: a.id, title: 'Draft' }]);
    expect((await ok(d, 'tasks.get', { id: a.id })).blocks).toEqual([{ id: b.id, title: 'Edit' }]);
    expect(await err(d, 'deps.add', { task: a.id, blockedBy: b.id })).toMatch(/cycle.*Edit.*Draft/);
    await ok(d, 'tasks.done', { id: a.id });
    expect((await ok(d, 'tasks.get', { id: b.id })).task.blockedBy).toEqual([]);
    det = await ok(d, 'deps.remove', { task: b.id, blockedBy: a.id });
    expect(det.blockers).toEqual([]);
  });
});

describe('lists api', () => {
  it('creates, renames, reorders and deletes lists; tasks keep existing; counts are open/done', async () => {
    const d = deps();
    let lists = await ok(d, 'lists.create', { name: 'Personal' });
    lists = await ok(d, 'lists.create', { name: 'Clubs' });
    expect(lists.map((l: any) => l.name)).toEqual(['Clubs', 'Personal']); // alphabetical until reordered
    const [clubs, personal] = lists;
    lists = await ok(d, 'lists.reorder', { ids: [personal.id, clubs.id] });
    expect(lists.map((l: any) => l.name)).toEqual(['Personal', 'Clubs']);
    expect(await err(d, 'lists.create', { name: 'personal' })).toMatch(/already exists/);
    const t1 = await ok(d, 'tasks.add', { title: 'One', list: 'Personal' });
    const t2 = await ok(d, 'tasks.add', { title: 'Two', list: 'Personal' });
    await ok(d, 'tasks.done', { id: t1.id });
    lists = await ok(d, 'lists.rename', { name: 'Personal', newName: 'Life' });
    expect(lists[0]).toMatchObject({ name: 'Life', open: 1, done: 1 });
    const del = await ok(d, 'lists.delete', { name: 'Life' });
    expect(del.tasksUnlinked).toBe(2);
    expect((await ok(d, 'tasks.get', { id: t2.id })).task.listName).toBeNull();
  });
  it('tasks in a list follow the saved drag order; new tasks go last; moving between lists works', async () => {
    const d = deps();
    const [l] = (await ok(d, 'lists.create', { name: 'Study' })) as any[];
    const ids: number[] = [];
    for (const n of ['A', 'B', 'C']) ids.push((await ok(d, 'tasks.add', { title: n, list: 'Study' })).id);
    expect((await ok(d, 'tasks.list', { list: 'Study' })).map((t: any) => t.title)).toEqual(['A', 'B', 'C']);
    await ok(d, 'tasks.reorder', { listId: l.id, ids: [ids[2], ids[0], ids[1]] });
    expect((await ok(d, 'tasks.list', { list: 'Study' })).map((t: any) => t.title)).toEqual(['C', 'A', 'B']);
    const e = await ok(d, 'tasks.add', { title: 'D', list: 'Study' });
    expect((await ok(d, 'tasks.list', { list: 'Study' })).map((t: any) => t.title)).toEqual(['C', 'A', 'B', 'D']);
    await ok(d, 'tasks.move', { id: e.id, list: '' });
    expect((await ok(d, 'tasks.list', { list: 'none' })).map((t: any) => t.title)).toEqual(['D']);
  });
});

describe('views api', () => {
  it('returns the four views as display-ready tasks with reasons, plus running timers', async () => {
    const d = deps();
    const soon = await ok(d, 'tasks.add', { title: 'Quiz', course: 'X', due: 'tue 5pm', est: 15, weight: 10 });
    await ok(d, 'tasks.add', { title: 'Later', course: 'X', due: 'dec 1', est: 600, weight: 5 });
    const blocker = await ok(d, 'tasks.add', { title: 'Blocker', due: 'dec 3', est: 60 });
    await ok(d, 'deps.add', { task: soon.id, blockedBy: blocker.id });
    await ok(d, 'timer.start', { id: blocker.id });
    const v = await ok(d, 'views.get', {});
    expect(v.dueSoon[0].task.title).toBe('Quiz');
    expect(v.dueSoon[0].reason).toMatch(/due in .*blocked by #\d+ Blocker/);
    expect(v.blocked[0].reason).toMatch(/waiting on #\d+ Blocker/);
    expect(v.highImpact.map((x: any) => x.task.title)).toEqual(['Later']); // Quiz is blocked, so it is not ranked
    expect(v.highImpact[0].score).toBeGreaterThan(0);
    expect(v.quickWins.map((x: any) => x.task.title)).toEqual([]); // Quiz is blocked
    expect(v.timers).toHaveLength(1);
  });
});

describe('unlisted tasks: order and moving', () => {
  it('unlisted tasks follow their own saved order (key order.tasks.none), new ones go last', async () => {
    const d = deps();
    const ids: number[] = [];
    for (const n of ['A', 'B', 'C']) ids.push((await ok(d, 'tasks.add', { title: n })).id);
    expect((await ok(d, 'tasks.list', { list: 'none' })).map((t: any) => t.title)).toEqual(['A', 'B', 'C']);
    await ok(d, 'tasks.reorder', { listId: null, ids: [ids[2], ids[0], ids[1]] });
    expect((await ok(d, 'tasks.list', { list: 'none' })).map((t: any) => t.title)).toEqual(['C', 'A', 'B']);
    expect(getOrder(d.ctx, 'order.tasks.none')).toEqual([ids[2], ids[0], ids[1]]);
    await ok(d, 'tasks.add', { title: 'D' });
    expect((await ok(d, 'tasks.list', { list: 'none' })).map((t: any) => t.title)).toEqual(['C', 'A', 'B', 'D']);
  });

  it('the order survives closing and reopening the database file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'order-')), 'p.db');
    const first = deps();
    first.ctx.db = openDb(file);
    createTerm(first.ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
    const ids: number[] = [];
    for (const n of ['A', 'B', 'C']) ids.push((await ok(first, 'tasks.add', { title: n })).id);
    await ok(first, 'tasks.reorder', { listId: null, ids: [ids[1], ids[2], ids[0]] });
    first.ctx.db.close();
    const second = deps();
    second.ctx.db = openDb(file);
    expect((await ok(second, 'tasks.list', { list: 'none' })).map((t: any) => t.title)).toEqual(['B', 'C', 'A']);
  });

  it('moving a task from Unlisted to a list puts it last there, and back to Unlisted puts it last there', async () => {
    const d = deps();
    const [l] = (await ok(d, 'lists.create', { name: 'Study' })) as any[];
    const a = await ok(d, 'tasks.add', { title: 'A', list: 'Study' });
    const b = await ok(d, 'tasks.add', { title: 'B', list: 'Study' });
    await ok(d, 'tasks.reorder', { listId: l.id, ids: [b.id, a.id] });
    const x = await ok(d, 'tasks.add', { title: 'X' });
    const y = await ok(d, 'tasks.add', { title: 'Y' });
    await ok(d, 'tasks.reorder', { listId: null, ids: [y.id, x.id] });
    await ok(d, 'tasks.move', { id: y.id, list: 'Study' });
    expect((await ok(d, 'tasks.list', { list: 'Study' })).map((t: any) => t.title)).toEqual(['B', 'A', 'Y']);
    expect((await ok(d, 'tasks.list', { list: 'none' })).map((t: any) => t.title)).toEqual(['X']);
    await ok(d, 'tasks.move', { id: b.id, list: '' });
    expect((await ok(d, 'tasks.list', { list: 'none' })).map((t: any) => t.title)).toEqual(['X', 'B']);
    expect((await ok(d, 'tasks.list', { list: 'Study' })).map((t: any) => t.title)).toEqual(['A', 'Y']);
    expect(getOrder(d.ctx, 'order.tasks.none')).not.toContain(y.id);
  });
});

describe('quick-add parsing through the api', () => {
  // clock: Mon Nov 9 2026, 9:00 AM Detroit
  it('parseQuick previews title and due; an explicit due field turns parsing off', async () => {
    const d = deps();
    const p = await ok(d, 'tasks.parseQuick', { text: 'written homework due friday 5pm' });
    expect(p).toMatchObject({ title: 'written homework', dueText: 'Fri Nov 13, 5:00 PM', timeAssumed: false, explicitDue: false });
    expect((await ok(d, 'tasks.parseQuick', { text: 'due diligence notes' })).due).toBeNull();
    expect(await ok(d, 'tasks.parseQuick', { text: 'x fri', due: 'sun' })).toMatchObject({ explicitDue: true, due: null, title: 'x fri' });
  });
  it('tasks.add with parseTitle strips the date from the title and sets the due date', async () => {
    const d = deps();
    const t = await ok(d, 'tasks.add', { title: 'written homework due friday 5pm', parseTitle: true });
    expect(t).toMatchObject({ title: 'written homework', timeAssumed: false });
    expect(t.dueText).toContain('Nov 13');
    const w = await ok(d, 'tasks.add', { title: 'read chapter fri', parseTitle: true });
    expect(w).toMatchObject({ title: 'read chapter', timeAssumed: true });
  });
  it('an explicit due wins and keeps the title as typed; without parseTitle nothing is parsed; an empty title keeps the text', async () => {
    const d = deps();
    const a = await ok(d, 'tasks.add', { title: 'x due friday', due: 'sunday 3pm', parseTitle: true });
    expect(a.title).toBe('x due friday');
    expect(a.dueText).toContain('Nov 15');
    expect((await ok(d, 'tasks.add', { title: 'plain fri 5pm' })).due).toBeNull();
    const e = await ok(d, 'tasks.add', { title: 'friday 5pm', parseTitle: true });
    expect(e).toMatchObject({ title: 'friday 5pm', due: null });
  });
});
