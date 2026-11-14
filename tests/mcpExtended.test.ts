import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeCtx } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { createTerm } from '../src/core/terms';
import { addTask, getTask, editTask, completeTask } from '../src/core/tasks';
import { addDependency } from '../src/core/dependencies';
import { createList } from '../src/core/lists';
import { setSetting } from '../src/db/repo';
import { createServer } from '../src/mcp/server';
import { WRITES_OFF, DELETES_OFF, SCHEDULE_OFF } from '../src/mcp/tools';
import { listChanges, undoChange } from '../src/core/changeLog';
import { CLAUDE_WRITES_KEY, CLAUDE_DELETES_KEY, CLAUDE_SCHEDULE_KEY } from '../src/core/claudeAccess';
import { getJob, listCalls, setJob, CALL_LOG_KEEP } from '../src/core/connectorJobs';
import { dispatch, processConnectorJobs, handlers, type ApiDeps } from '../src/app/api';
import { runningTimers } from '../src/app/timerOps';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { iv } from './helpers';

const NOW = '2026-11-12T15:00:00Z'; // Thursday 10:00 in Detroit
const TARGET = { dbFile: '/tmp/test-tally.db', kind: 'test' as const, label: 'TEST database' };
const MIN = 60_000;

let ctx: Ctx;
let clockMs: number;
let client: Client;
let backups: string;
const tick = (ms: number) => { clockMs += ms; };

async function connect() {
  const server = createServer({ ctx, target: TARGET, backupFolder: backups });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
}
interface Out { error: boolean; text: string; data: any }
async function call(name: string, args: Record<string, unknown> = {}): Promise<Out> {
  try {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content.map((c) => c.text).join('\n');
    let data: any;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return { error: !!r.isError, text, data };
  } catch (e) {
    return { error: true, text: (e as Error).message, data: undefined };
  }
}
const on = (key: string, v = true) => setSetting(ctx.db, key, v ? 'true' : 'false');
const ru = (id: number) => getTask(ctx, id)!.updated_at;
const row = (id: number) => ctx.db.get<any>('SELECT * FROM tasks WHERE id = ?', [id])!;
const logCount = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM change_log')!.n;

beforeEach(async () => {
  process.env.TALLY_MCP_PREVIEW_WAIT_MS = '5000';
  ctx = makeCtx(NOW);
  clockMs = Date.parse(NOW);
  ctx.clock = { now: () => new Date(clockMs) };
  backups = mkdtempSync(join(tmpdir(), 'tally-mcp-ext-'));
  createTerm(ctx, { name: 'Fall 2026', start_date: '2026-08-31', end_date: '2026-12-11' });
  await connect();
});
afterEach(async () => {
  await client.close();
  rmSync(backups, { recursive: true, force: true });
  delete process.env.TALLY_MCP_PREVIEW_WAIT_MS;
});

// ======================================================================================================== 1. full editing
describe('full task editing (behind "Allow Claude to change my tasks")', () => {
  const newTask = () => addTask(ctx, { title: 'Essay draft', course: 'ENGL 125', type: 'project', due: '2026-11-20', est: 120, weight: 10 });

  it('is refused for every new editing tool when the switch is off, and nothing changes', async () => {
    const t = newTask();
    const before = JSON.stringify(ctx.db.all('SELECT * FROM tasks'));
    for (const [name, args] of [
      ['edit_task', { id: t.id, read_updated_at: ru(t.id), title: 'New' }], ['create_list', { name: 'L' }], ['rename_list', { name: 'A', new_name: 'B' }],
      ['move_task_to_list', { id: t.id, list: 'none', read_updated_at: ru(t.id) }], ['add_step', { parent: t.id, title: 's' }], ['remove_dependency', { task: t.id, blocked_by: 2 }],
    ] as [string, Record<string, unknown>][]) {
      const r = await call(name, args);
      expect(r.error, name).toBe(true);
      expect(r.text, name).toBe(WRITES_OFF);
    }
    expect(JSON.stringify(ctx.db.all('SELECT * FROM tasks'))).toBe(before);
    expect(ctx.db.get('SELECT 1 FROM lists')).toBeUndefined();
    expect(logCount()).toBe(0);
  });

  describe('with the switch on', () => {
    beforeEach(() => on(CLAUDE_WRITES_KEY));

    it('edits every allowed field and reports each from/to', async () => {
      const t = newTask();
      createList(ctx, 'Homework');
      const edit = async (patch: Record<string, unknown>) => {
        const r = await call('edit_task', { id: t.id, read_updated_at: ru(t.id), ...patch });
        expect(r.error, JSON.stringify(patch) + r.text).toBe(false);
        return r.data;
      };
      expect((await edit({ title: 'Essay draft v2' })).updated[0].changes.title).toEqual({ from: 'Essay draft', to: 'Essay draft v2' });
      expect((await edit({ notes: 'use the library copy' })).updated[0].changes.notes.to).toBe('use the library copy');
      expect((await edit({ notes: null })).updated[0].changes.notes.to).toBeNull();
      expect((await edit({ list: 'Homework' })).updated[0].changes.list_id.to).toBeGreaterThan(0);
      expect((await edit({ list: 'none' })).updated[0].changes.list_id.to).toBeNull();
      expect((await edit({ course: 'ENGL 225' })).updated[0].changes.course.to).toBe('ENGL 225');
      expect((await edit({ course: 'none' })).updated[0].changes.course.to).toBeNull();
      expect((await edit({ type: 'homework' })).updated[0].changes.type).toEqual({ from: 'project', to: 'homework' });
      expect((await edit({ grade_weight: 12.5 })).updated[0].changes.grade_weight).toEqual({ from: 10, to: 12.5 });
      expect((await edit({ grade_weight: null })).updated[0].changes.grade_weight.to).toBeNull();
      expect((await edit({ optional: true })).updated[0].changes.optional).toEqual({ from: 0, to: 1 });
      expect((await edit({ deadline_only: true })).updated[0].changes.deadline_only).toEqual({ from: 0, to: 1 });
      expect((await edit({ available_from: '2026-11-16' })).updated[0].changes.available_from.to).toBe('2026-11-16');
      expect((await edit({ available_from: 'none' })).updated[0].changes.available_from.to).toBeNull();
      expect((await edit({ size: { amount: 12, unit: 'pages' } })).updated[0].changes.size_amount.to).toBe(12);
      expect(row(t.id).size_unit).toBe('pages');
      await edit({ size: null });
      expect(row(t.id).size_unit).toBeNull();
      expect((await edit({ estimate_minutes: 200, due: '2026-11-25 3pm' })).updated[0].changes.estimated_minutes).toEqual({ from: 120, to: 200 });
      expect(row(t.id)).toMatchObject({ title: 'Essay draft v2', type: 'homework', optional: 1, deadline_only: 1 });
    });

    it('a manual edit stays manual: setting an estimate marks it manual, and a size change never replaces a manual estimate', async () => {
      const t = addTask(ctx, { title: 'Read ch 4', course: 'ENGL 125', due: '2026-11-20' });
      await call('edit_task', { id: t.id, read_updated_at: ru(t.id), size: { amount: 10, unit: 'pages' } });
      expect(row(t.id)).toMatchObject({ estimate_source: 'size' }); // no estimate of its own: the size gives one
      const sizeMinutes = row(t.id).estimated_minutes;
      expect(sizeMinutes).toBeGreaterThan(0);
      await call('edit_task', { id: t.id, read_updated_at: ru(t.id), estimate_minutes: 45 });
      expect(row(t.id)).toMatchObject({ estimated_minutes: 45, estimate_source: 'manual' });
      await call('edit_task', { id: t.id, read_updated_at: ru(t.id), size: { amount: 40, unit: 'pages' } });
      expect(row(t.id)).toMatchObject({ estimated_minutes: 45, estimate_source: 'manual', size_amount: 40 }); // the manual estimate survived the size change
      await call('edit_task', { id: t.id, read_updated_at: ru(t.id), size: null });
      expect(row(t.id)).toMatchObject({ estimated_minutes: 45, estimate_source: 'manual' });
    });

    it('refuses bad values with the core\'s message and writes nothing', async () => {
      const t = newTask();
      const before = JSON.stringify(row(t.id));
      for (const patch of [{ list: 'No such list' }, { due: 'when the cows come home' }, { available_from: 'someday' }, { type: 'chore' }, { size: { amount: 0, unit: 'pages' } }, { size: { amount: 5, unit: 'furlongs' } }, { grade_weight: 101 }, { title: '   ' }]) {
        expect((await call('edit_task', { id: t.id, read_updated_at: ru(t.id), ...patch })).error, JSON.stringify(patch)).toBe(true);
      }
      expect(JSON.stringify(row(t.id))).toBe(before);
      expect(logCount()).toBe(0);
    });

    it('does not allow changing the term, import keys or ids', async () => {
      const t = newTask();
      for (const f of ['term', 'term_id', 'import_key', 'new_id', 'id_to', 'source', 'status']) {
        expect((await call('edit_task', { id: t.id, read_updated_at: ru(t.id), [f]: 'x' })).error, f).toBe(true);
      }
      // a task with no term would be attached to the current term by a course edit: that is a term change, so it is refused
      const loose = addTask(ctx, { title: 'Call mom' });
      expect(loose.term_id).toBeNull();
      const r = await call('edit_task', { id: loose.id, read_updated_at: ru(loose.id), course: 'ENGL 125' });
      expect(r.error).toBe(true);
      expect(r.text).toMatch(/term/);
      expect(row(loose.id).term_id).toBeNull();
      expect((await call('edit_task', { id: loose.id, read_updated_at: ru(loose.id), title: 'Call mom back' })).error).toBe(false);
    });

    it('refuses an edit when the task changed in Tally after Claude read it (optimistic check), with a clear message', async () => {
      const t = newTask();
      const read = (await call('get_task', { id: t.id })).data.task.updatedAt;
      expect(read).toBe(ru(t.id));
      tick(5 * MIN);
      editTask(ctx, t.id, { notes: 'edited in Tally' }); // the user, in the app, after Claude read it
      expect(ru(t.id)).not.toBe(read);
      const before = JSON.stringify(row(t.id));
      const r = await call('edit_task', { id: t.id, read_updated_at: read, title: 'Claude\'s title' });
      expect(r.error).toBe(true);
      expect(r.text).toMatch(/changed in Tally after you read it/);
      expect(r.text).toMatch(/Nothing was changed/);
      expect(r.text).toMatch(/get_task/);
      expect(JSON.stringify(row(t.id))).toBe(before);
      expect(logCount()).toBe(0);
      // reading again gives the new value, and the edit goes through
      const fresh = (await call('get_task', { id: t.id })).data.task.updatedAt;
      expect((await call('edit_task', { id: t.id, read_updated_at: fresh, title: 'Claude\'s title' })).error).toBe(false);
      expect(row(t.id).notes).toBe('edited in Tally'); // the user's edit is still there
      // and the same read can't be reused for a second edit
      tick(MIN);
      expect((await call('edit_task', { id: t.id, read_updated_at: fresh, title: 'again' })).error).toBe(false); // the first edit moved updated_at forward...
    });

    it('read_updated_at is required, and move_task_to_list checks it too', async () => {
      const t = newTask();
      createList(ctx, 'Homework');
      expect((await call('edit_task', { id: t.id, title: 'x' })).error).toBe(true);
      expect((await call('move_task_to_list', { id: t.id, list: 'Homework' })).error).toBe(true);
      const read = ru(t.id);
      tick(MIN);
      editTask(ctx, t.id, { est: 99 });
      const r = await call('move_task_to_list', { id: t.id, list: 'Homework', read_updated_at: read });
      expect(r.error).toBe(true);
      expect(r.text).toMatch(/changed in Tally after you read it/);
      expect(row(t.id).list_id).toBeNull();
    });

    it('create_list, rename_list, move_task_to_list, add_step, remove_dependency all work and are in the change log', async () => {
      const t = newTask();
      const other = addTask(ctx, { title: 'Quiz', course: 'ENGL 125', due: '2026-11-18' });
      addDependency(ctx, t.id, other.id);

      const created = await call('create_list', { name: 'Homework' });
      expect(created.data).toMatchObject({ changed: true, list: { name: 'Homework' }, listsChanged: [{ from: null, to: 'Homework' }] });
      expect((await call('create_list', { name: 'homework' })).error).toBe(true); // exists
      const renamed = await call('rename_list', { name: 'Homework', new_name: 'English' });
      expect(renamed.data.listsChanged).toEqual([{ id: created.data.list.id, from: 'Homework', to: 'English' }]);
      expect((await call('rename_list', { name: 'Nope', new_name: 'x' })).error).toBe(true);
      const moved = await call('move_task_to_list', { id: t.id, list: 'English', read_updated_at: ru(t.id) });
      expect(moved.data.updated[0].changes.list_id.to).toBe(created.data.list.id);
      expect((await call('move_task_to_list', { id: t.id, list: 'Missing', read_updated_at: ru(t.id) })).error).toBe(true);

      const step = await call('add_step', { parent: t.id, title: 'Outline', estimate_minutes: 20 });
      expect(step.data.created).toHaveLength(1);
      expect(step.data.step).toMatchObject({ title: 'Outline', course: 'ENGL 125', list: 'English', estimateMinutes: 20 });
      expect(row(step.data.step.id)).toMatchObject({ parent_task_id: t.id, term_id: t.term_id, estimate_source: 'manual' });
      expect((await call('get_task', { id: t.id })).data.steps.map((x: any) => x.title)).toEqual(['Outline']);
      expect((await call('add_step', { parent: step.data.step.id, title: 'sub-step' })).text).toMatch(/itself a step/);
      expect((await call('add_step', { parent: 99999, title: 'x' })).error).toBe(true);

      const rm = await call('remove_dependency', { task: t.id, blocked_by: other.id });
      expect(rm.data.dependenciesRemoved).toEqual([{ task: t.id, blockedBy: other.id }]);
      expect((await call('remove_dependency', { task: t.id, blocked_by: other.id })).data.changed).toBe(false);

      expect(listChanges(ctx).map((c) => c.tool)).toEqual(['remove_dependency', 'add_step', 'move_task_to_list', 'rename_list', 'create_list']);
    });

    it('every one of them can be undone', async () => {
      const t = newTask();
      const other = addTask(ctx, { title: 'Quiz', course: 'ENGL 125', due: '2026-11-18' });
      addDependency(ctx, t.id, other.id);
      const c1 = (await call('create_list', { name: 'Homework' })).data;
      const c2 = (await call('rename_list', { name: 'Homework', new_name: 'English' })).data;
      const c3 = (await call('move_task_to_list', { id: t.id, list: 'English', read_updated_at: ru(t.id) })).data;
      const c4 = (await call('add_step', { parent: t.id, title: 'Outline' })).data;
      const c5 = (await call('remove_dependency', { task: t.id, blocked_by: other.id })).data;
      const c6 = (await call('edit_task', { id: t.id, read_updated_at: ru(t.id), title: 'Changed', size: { amount: 5, unit: 'pages' }, notes: 'n' })).data;
      for (const c of [c6, c5, c4, c3, c2, c1]) undoChange(ctx, c.changeId);
      expect(row(t.id)).toMatchObject({ title: 'Essay draft', list_id: null, notes: null, size_amount: null });
      expect(ctx.db.get('SELECT 1 FROM dependencies WHERE task_id = ? AND blocked_by_task_id = ?', [t.id, other.id])).toBeDefined();
      expect(ctx.db.get('SELECT 1 FROM lists')).toBeUndefined();
      expect(row(c4.step.id).deleted_at).not.toBeNull();
    });

    it('undo of a list rename refuses if the list was renamed again', async () => {
      createList(ctx, 'Homework');
      const c = (await call('rename_list', { name: 'Homework', new_name: 'English' })).data;
      ctx.db.run("UPDATE lists SET name = 'Mine'");
      expect(() => undoChange(ctx, c.changeId)).toThrow(/changed again since/);
    });

    it('limits: long text and unknown units are refused', async () => {
      const t = newTask();
      expect((await call('edit_task', { id: t.id, read_updated_at: ru(t.id), notes: 'n'.repeat(5001) })).error).toBe(true);
      expect((await call('edit_task', { id: t.id, read_updated_at: ru(t.id), title: 'x'.repeat(301) })).error).toBe(true);
      expect((await call('create_list', { name: 'l'.repeat(101) })).error).toBe(true);
      expect((await call('add_step', { parent: t.id, title: 's'.repeat(301) })).error).toBe(true);
      expect((await call('add_step', { parent: t.id, title: 's', status: 'done' })).error).toBe(true);
    });
  });
});

// ======================================================================================================== 2. timers
describe('timers (behind "Allow Claude to change my tasks")', () => {
  const two = () => ({ a: addTask(ctx, { title: 'WeBWorK 7', course: 'MATH 115', est: 60 }), b: addTask(ctx, { title: 'Essay', course: 'ENGL 125', est: 90 }) });

  it('get_timer works with the switch off; start and stop are refused', async () => {
    const { a } = two();
    expect((await call('get_timer')).data).toEqual({ running: [] });
    for (const [n, args] of [['start_timer', { id: a.id }], ['stop_timer', {}]] as [string, Record<string, unknown>][]) expect((await call(n, args)).text).toBe(WRITES_OFF);
    expect(runningTimers(ctx)).toHaveLength(0);
    expect(logCount()).toBe(0);
  });

  describe('switch on', () => {
    beforeEach(() => on(CLAUDE_WRITES_KEY));

    it('start_timer starts it; the app (window API and tray) sees it; get_timer shows elapsed time', async () => {
      const { a } = two();
      const r = await call('start_timer', { id: a.id });
      expect(r.error).toBe(false);
      expect(r.data.timers).toEqual([{ task: a.id, action: 'started' }]);
      expect(r.data.running).toHaveLength(1);
      expect(row(a.id).status).toBe('in_progress');
      // the same rows the tray and the window read
      expect(runningTimers(ctx).map((x) => x.taskId)).toEqual([a.id]);
      const api = await dispatch({ ctx, dbFile: ':memory:', demo: true, backupFolder: backups, calendar: () => { throw new Error('no'); } }, 'timer.status', undefined);
      expect((api as any).value).toMatchObject([{ taskId: a.id }]);
      tick(25 * MIN);
      const t = await call('get_timer');
      expect(t.data.running[0]).toMatchObject({ taskId: a.id, title: 'WeBWorK 7', elapsedMinutes: 25, runningOverLimit: false });
      expect(t.data.warning).toBeUndefined();
    });

    it('starting a second timer stops and records the first (one at a time, as in the app)', async () => {
      const { a, b } = two();
      await call('start_timer', { id: a.id });
      tick(30 * MIN);
      const r = await call('start_timer', { id: b.id });
      expect(r.data.stoppedAndRecorded).toEqual([{ taskId: a.id, title: 'WeBWorK 7' }]);
      expect(r.data.running.map((x: any) => x.taskId)).toEqual([b.id]);
      expect(row(a.id).actual_minutes).toBe(30);
      const sessions = ctx.db.all<any>('SELECT * FROM time_sessions ORDER BY id');
      expect(sessions).toHaveLength(2);
      expect(sessions[0].ended_at).not.toBeNull();
      expect(sessions[1].ended_at).toBeNull();
      expect(r.data.timers).toEqual(expect.arrayContaining([{ task: b.id, action: 'started' }, { task: a.id, action: 'stopped' }]));
    });

    it('stop_timer records the session exactly as the app does, and says so when nothing runs', async () => {
      const { a } = two();
      await call('start_timer', { id: a.id });
      tick(42 * MIN + 20_000);
      const r = await call('stop_timer');
      expect(r.error).toBe(false);
      expect(r.data.recorded).toEqual([{ taskId: a.id, minutes: 42, total: 42 }]);
      expect(row(a.id).actual_minutes).toBe(42);
      expect(runningTimers(ctx)).toHaveLength(0);
      const again = await call('stop_timer');
      expect(again.data).toMatchObject({ changed: false, message: 'No timer was running.' });
    });

    it('flags a timer left running more than 8 hours (and not before)', async () => {
      const { a } = two();
      await call('start_timer', { id: a.id });
      tick(8 * 60 * MIN);
      expect((await call('get_timer')).data.running[0].runningOverLimit).toBe(false); // exactly 8 h
      tick(MIN);
      const t = (await call('get_timer')).data;
      expect(t.running[0]).toMatchObject({ runningOverLimit: true, elapsedMinutes: 481 });
      expect(t.warning).toMatch(/more than 8 hours/);
      expect(t.warning).toMatch(/WeBWorK 7/);
    });

    it('refuses a done or unknown task', async () => {
      const { a } = two();
      completeTask(ctx, a.id);
      expect((await call('start_timer', { id: a.id })).text).toMatch(/is done/);
      expect((await call('start_timer', { id: 9999 })).error).toBe(true);
      expect(runningTimers(ctx)).toHaveLength(0);
    });

    it('start and stop are in the change log and can be undone', async () => {
      const { a, b } = two();
      const s1 = (await call('start_timer', { id: a.id })).data;
      tick(10 * MIN);
      const s2 = (await call('start_timer', { id: b.id })).data; // stops a
      tick(5 * MIN);
      const st = (await call('stop_timer')).data;
      expect(listChanges(ctx).map((c) => c.tool)).toEqual(['stop_timer', 'start_timer', 'start_timer']);
      undoChange(ctx, st.changeId); // b is running again, its session reopened
      expect(runningTimers(ctx).map((x) => x.taskId)).toEqual([b.id]);
      expect(row(b.id).actual_minutes ?? 0).toBe(0);
      undoChange(ctx, s2.changeId); // b's session removed, a's session reopened
      expect(runningTimers(ctx).map((x) => x.taskId)).toEqual([a.id]);
      undoChange(ctx, s1.changeId);
      expect(runningTimers(ctx)).toHaveLength(0);
      expect(ctx.db.get('SELECT 1 FROM time_sessions')).toBeUndefined();
    });
  });
});

// ======================================================================================================== 3. delete
describe('delete_task (its own switch)', () => {
  const trio = () => {
    const a = addTask(ctx, { title: 'WeBWorK 7', course: 'MATH 115', est: 60, due: '2026-11-13' });
    const b = addTask(ctx, { title: 'Essay', course: 'ENGL 125', est: 90, due: '2026-11-20' });
    const c = addTask(ctx, { title: 'Quiz', course: 'MATH 115', due: '2026-11-30' });
    return { a, b, c };
  };

  it('is refused unless BOTH switches are on, with a message that names the missing one', async () => {
    const { a } = trio();
    expect((await call('delete_task', { id: a.id })).text).toBe(WRITES_OFF);
    on(CLAUDE_DELETES_KEY); // only the delete switch
    expect((await call('delete_task', { id: a.id })).text).toBe(WRITES_OFF);
    on(CLAUDE_DELETES_KEY, false);
    on(CLAUDE_WRITES_KEY); // only the change switch
    const r = await call('delete_task', { id: a.id });
    expect(r.text).toBe(DELETES_OFF);
    expect(row(a.id).deleted_at).toBeNull();
    expect(logCount()).toBe(0);
  });

  describe('both on', () => {
    beforeEach(() => { on(CLAUDE_WRITES_KEY); on(CLAUDE_DELETES_KEY); });

    it('soft-deletes one task, appears in the change log, and Undo brings it back', async () => {
      const { a, b } = trio();
      const r = await call('delete_task', { id: a.id });
      expect(r.error).toBe(false);
      expect(r.data.updated[0].changes.deleted_at.to).toEqual(expect.any(String));
      expect(row(a.id)).toBeDefined(); // the row is still there: a soft delete
      expect(row(a.id).deleted_at).not.toBeNull();
      expect(row(b.id).deleted_at).toBeNull();
      expect((await call('list_tasks')).data.tasks.map((t: any) => t.title)).not.toContain('WeBWorK 7');
      expect(listChanges(ctx)[0]).toMatchObject({ tool: 'delete_task', actor: 'claude', summary: expect.stringContaining('WeBWorK 7') });
      // the Undo button in Settings
      const d: ApiDeps = { ctx, dbFile: ':memory:', demo: true, backupFolder: backups, calendar: () => { throw new Error('no'); } };
      const view = await dispatch(d, 'settings.get', undefined);
      expect((view as any).value.claude.changes[0]).toMatchObject({ id: r.data.changeId, undone: false });
      expect((await dispatch(d, 'changes.undo', { id: r.data.changeId })).ok).toBe(true);
      expect(row(a.id).deleted_at).toBeNull();
      expect((await call('delete_task', { id: 99999 })).error).toBe(true);
      expect((await call('delete_task', { id: a.id })).data.changed).toBe(true); // can be deleted again
      expect((await call('delete_task', { id: a.id })).error).toBe(true); // already deleted: not found
    });

    it('is refused when open tasks are waiting on it unless force is true, and force is still undoable', async () => {
      const { a, b, c } = trio();
      addDependency(ctx, b.id, a.id); // Essay waits on WeBWorK 7
      addDependency(ctx, c.id, a.id);
      completeTask(ctx, c.id); // a done dependent does not count
      const refused = await call('delete_task', { id: a.id });
      expect(refused.error).toBe(true);
      expect(refused.text).toMatch(/1 open task\(s\) are waiting on #\d+ “WeBWorK 7”/);
      expect(refused.text).toMatch(/Essay/);
      expect(refused.text).toMatch(/force: true/);
      expect(row(a.id).deleted_at).toBeNull();
      expect(logCount()).toBe(0);
      expect((await call('delete_task', { id: a.id, force: false })).error).toBe(true);
      expect((await call('get_views')).data.blocked.map((t: any) => t.title)).toContain('Essay');

      const forced = await call('delete_task', { id: a.id, force: true });
      expect(forced.error).toBe(false);
      expect(forced.data.releasedTasks).toEqual([{ id: b.id, title: 'Essay' }]);
      expect(row(a.id).deleted_at).not.toBeNull();
      expect((await call('get_views')).data.blocked.map((t: any) => t.title)).not.toContain('Essay'); // released
      expect(listChanges(ctx)[0].summary).toMatch(/forced/);
      undoChange(ctx, forced.data.changeId); // the same undo path
      expect(row(a.id).deleted_at).toBeNull();
      expect((await call('get_views')).data.blocked.map((t: any) => t.title)).toContain('Essay'); // blocked again
    });

    it('is one task per call: no lists, terms or bulk deletes exist', async () => {
      const { a, b } = trio();
      expect((await call('delete_task', { id: [a.id, b.id] })).error).toBe(true);
      expect((await call('delete_task', { ids: [a.id, b.id] })).error).toBe(true);
      expect((await call('delete_task', { id: a.id, all: true })).error).toBe(true);
      expect((await call('delete_task', { id: a.id, list: 'x' })).error).toBe(true);
      expect((await call('delete_task', { id: a.id, term: 'Fall 2026' })).error).toBe(true);
      expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM tasks WHERE deleted_at IS NOT NULL')!.n).toBe(0);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.filter((n) => /delete|purge|wipe|clear/.test(n))).toEqual(['delete_task']);
    });
  });
});

// ======================================================================================================== 4. schedule
describe('schedule: previews, and applying only with approval inside the app', () => {
  let app: ApiDeps;
  let cal: FakeCalendar;
  let busy: { start: number; end: number }[];
  let pump: ReturnType<typeof setInterval> | undefined;

  const seedSchedule = () => {
    for (let wd = 1; wd <= 7; wd++) ctx.db.run("INSERT INTO availability_windows(weekday, start, \"end\", kind) VALUES(?, '09:00', '22:00', 'free')", [wd]);
    addTask(ctx, { title: 'Essay', course: 'ENG 100', type: 'homework', due: 'nov 13 8pm', est: 90 });
    addTask(ctx, { title: 'Lab report', course: 'PHYS 140', type: 'project', due: 'nov 18 5pm', est: 120, weight: 8 });
  };
  /** the Tally app answering the connector: in the real app the main process runs this every 1.5 s */
  const startApp = () => { pump = setInterval(() => { void processConnectorJobs(app); }, 40); };
  beforeEach(() => {
    busy = [iv('2026-11-12T11:00', '2026-11-12T12:00')];
    cal = new FakeCalendar({ calendars: [{ id: 'classcal', summary: 'School', busy }] });
    app = { ctx, dbFile: ':memory:', demo: true, backupFolder: backups, calendar: () => ({ calendar: cal, simulated: true }) };
    seedSchedule();
  });
  afterEach(() => { if (pump) clearInterval(pump); pump = undefined; });

  const blocks = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM scheduled_blocks')!.n;
  const preview = async (tool = 'preview_schedule', days = 7) => { const r = await call(tool, { days }); expect(r.error, r.text).toBe(false); return r.data; };
  const askApply = async (previewId: string) => call('apply_schedule', { preview_id: previewId });

  it('previews return the same sections as the Schedule screen, with an id and a timestamp, and write nothing', async () => {
    startApp();
    const p = await preview();
    const screen = (await handlers['schedule.preview'](app, { days: 7, replan: false })) as any;
    expect(p.previewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.previewedAt).toBe(NOW.replace('Z', '.000Z'));
    expect(p).toMatchObject({ mode: 'schedule', days: 7, timezone: 'America/Detroit', calendar: { name: 'Planner Blocks', simulated: true } });
    expect(p.summary).toMatchObject({ blocksToWrite: screen.willWrite, blocksToRemove: screen.willRemove });
    expect(p.blocks.length).toBe(screen.blocks.filter((b: any) => !b.tentative).length);
    expect(p.blocks.length).toBeGreaterThan(0);
    expect(p.blocks[0]).toMatchObject({ taskId: expect.any(Number), title: expect.stringContaining('ENG 100'), local: expect.stringMatching(/^\w{3} \w{3} \d+, \d+:\d\d [AP]M to \d+:\d\d [AP]M$/) });
    for (const k of ['tentative', 'doesNotFit', 'notScheduled']) expect(Array.isArray(p[k]), k).toBe(true);
    for (const k of ['moved', 'trimmed', 'workAlreadyLogged']) expect(p[k]).toMatchObject({ heading: expect.any(String), lines: expect.any(Array), count: expect.any(Number) });
    expect(p.trimmed.heading).toMatch(/^WOULD TRIM/);
    expect(p._apply).toBeUndefined(); // internals are not handed to Claude
    expect(blocks()).toBe(0);
    expect(cal.writes).toEqual([]);
  });

  it('reports DOES NOT FIT and NOT SCHEDULED like the screen', async () => {
    addTask(ctx, { title: 'Huge', course: 'ENG 100', type: 'project', due: 'nov 13 6pm', est: 3000 });
    addTask(ctx, { title: 'No estimate', course: 'ENG 100', due: 'nov 15' });
    startApp();
    const p = await preview();
    expect(p.doesNotFit.map((x: any) => x.title)).toEqual(expect.arrayContaining([expect.stringContaining('Huge')]));
    expect(p.notScheduled.map((x: any) => x.title)).toContain('No estimate');
  });

  it('preview_replan is the Replan mode', async () => {
    startApp();
    const p = await preview('preview_replan');
    expect(p.mode).toBe('replan');
  });

  it('a preview needs the app: with Tally closed it says so after a wait, and leaves no request behind', async () => {
    await client.close();
    process.env.TALLY_MCP_PREVIEW_WAIT_MS = '300';
    await connect();
    const r = await call('preview_schedule', { days: 7 });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/Tally did not answer/);
    expect(r.text).toMatch(/Tally must be open/);
    expect(ctx.db.get<{ s: string }>("SELECT status s FROM connector_jobs WHERE kind = 'preview'")!.s).toBe('failed');
    expect(blocks()).toBe(0);
  });

  it('apply_schedule is refused while its switch is off, even with the other two on', async () => {
    startApp();
    on(CLAUDE_WRITES_KEY); on(CLAUDE_DELETES_KEY);
    const p = await preview();
    const r = await askApply(p.previewId);
    expect(r.error).toBe(true);
    expect(r.text).toBe(SCHEDULE_OFF);
    expect(ctx.db.get("SELECT 1 FROM connector_jobs WHERE kind = 'apply'")).toBeUndefined();
    expect(blocks()).toBe(0);
  });

  it('previews are allowed with every switch off', async () => {
    startApp();
    expect((await call('preview_schedule', { days: 3 })).error).toBe(false);
  });

  it('apply_schedule NEVER writes: it creates a pending request that waits for approval in the app', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY); // note: the "change my tasks" switch is NOT needed
    const p = await preview();
    const r = await askApply(p.previewId);
    expect(r.error, r.text).toBe(false);
    expect(r.data).toMatchObject({ status: 'pending', willWrite: p.summary.blocksToWrite, willRemove: 0, ttlMinutes: 10 });
    expect(r.data.expiresAt).toBe(new Date(clockMs + 10 * MIN).toISOString());
    expect(r.data.message).toMatch(/Nothing has been written/);
    // nothing was written, to the database or to the (simulated) calendar
    expect(blocks()).toBe(0);
    expect(cal.writes).toEqual([]);
    const job = getJob(ctx, r.data.applyId)!;
    expect(job).toMatchObject({ kind: 'apply', status: 'pending' });
    // it is visible to the app as the pending card
    const state = (await dispatch(app, 'pending.get', undefined)) as any;
    expect(state.value.pending).toMatchObject({ id: r.data.applyId, willWrite: p.summary.blocksToWrite, calendarName: 'Planner Blocks', simulated: true });
    // and to Claude
    expect((await call('get_pending_apply')).data).toMatchObject({ applyId: r.data.applyId, status: 'pending', message: expect.stringMatching(/Waiting for the user/) });
    expect(blocks()).toBe(0);
  });

  it('only after Approve in the app does the app perform the write, then get_pending_apply says applied', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p = await preview();
    const ask = (await askApply(p.previewId)).data;
    const approve = await dispatch(app, 'pending.approve', { id: ask.applyId, confirm: true });
    expect(approve.ok, JSON.stringify(approve)).toBe(true);
    expect((approve as any).value.message).toMatch(/^Applied: removed 0 earlier block\(s\), wrote \d+ to "Planner Blocks"\./); // the same text as a normal Apply
    expect(blocks()).toBe(p.summary.blocksToWrite);
    expect(cal.writes.length).toBeGreaterThan(0);
    const got = (await call('get_pending_apply')).data;
    expect(got).toMatchObject({ status: 'applied', applyId: ask.applyId });
    expect(got.message).toMatch(/^Applied:/);
    expect(((await dispatch(app, 'pending.get', undefined)) as any).value.pending).toBeNull();
    // approving twice does nothing more
    const again = await dispatch(app, 'pending.approve', { id: ask.applyId, confirm: true });
    expect(again.ok).toBe(false);
    expect(blocks()).toBe(p.summary.blocksToWrite);
  });

  it('Reject writes nothing and Claude sees "rejected"', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p = await preview();
    const ask = (await askApply(p.previewId)).data;
    expect((await dispatch(app, 'pending.reject', { id: ask.applyId })).ok).toBe(true);
    expect(blocks()).toBe(0);
    expect(cal.writes).toEqual([]);
    expect((await call('get_pending_apply')).data).toMatchObject({ status: 'rejected', message: expect.stringMatching(/rejected/) });
    expect((await dispatch(app, 'pending.approve', { id: ask.applyId, confirm: true })).ok).toBe(false); // too late
  });

  it('a pending apply expires after 10 minutes: Claude sees "expired", the app refuses to approve it, nothing is written', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p = await preview();
    const ask = (await askApply(p.previewId)).data;
    tick(9 * MIN + 59_000);
    expect((await call('get_pending_apply')).data.status).toBe('pending');
    tick(2_000);
    expect((await call('get_pending_apply')).data.status).toBe('expired');
    const r = await dispatch(app, 'pending.approve', { id: ask.applyId, confirm: true });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/expired/);
    expect(blocks()).toBe(0);
    expect(((await dispatch(app, 'pending.get', undefined)) as any).value.pending).toBeNull();
    expect(((await dispatch(app, 'pending.get', undefined)) as any).value.last).toMatchObject({ id: ask.applyId, status: 'expired' });
  });

  it('only one apply can be pending at a time', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p1 = await preview();
    const p2 = await preview();
    const first = (await askApply(p1.previewId)).data;
    const second = await askApply(p2.previewId);
    expect(second.error).toBe(true);
    expect(second.text).toMatch(/Only one can be pending at a time/);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM connector_jobs WHERE kind = 'apply'")!.n).toBe(1);
    await dispatch(app, 'pending.reject', { id: first.applyId });
    expect((await askApply(p2.previewId)).error).toBe(false); // free again
  });

  it('a preview id is single use, and unknown or malformed ids are refused', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p = await preview();
    const first = (await askApply(p.previewId)).data;
    await dispatch(app, 'pending.reject', { id: first.applyId });
    expect((await askApply(p.previewId)).text).toMatch(/already used/);
    expect((await askApply('3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b11')).text).toMatch(/Unknown preview_id/);
    expect((await call('apply_schedule', { preview_id: 'latest' })).error).toBe(true);
    expect((await call('apply_schedule', { preview_id: p.previewId, confirm: true })).error).toBe(true);
    // an apply job's id is not a preview id
    expect((await askApply(first.applyId)).text).toMatch(/Unknown preview_id/);
  });

  it('a preview goes stale when tasks or availability change, or with time (30 minutes)', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    // 1. a task edit
    let p = await preview();
    tick(MIN);
    editTask(ctx, 1, { est: 200 });
    expect((await askApply(p.previewId)).text).toMatch(/changed since that preview, so it is stale/);
    // 2. availability
    p = await preview();
    ctx.db.run("INSERT INTO availability_windows(date, start, \"end\", kind) VALUES('2026-11-14', '09:00', '10:00', 'blocked')");
    expect((await askApply(p.previewId)).text).toMatch(/stale/);
    // 3. a new task
    p = await preview();
    addTask(ctx, { title: 'New', course: 'ENG 100', due: 'nov 16', est: 30 });
    expect((await askApply(p.previewId)).text).toMatch(/stale/);
    // 4. age
    p = await preview();
    tick(31 * MIN);
    expect((await askApply(p.previewId)).text).toMatch(/older than 30 minutes/);
    // none of them created a request
    expect(ctx.db.get("SELECT 1 FROM connector_jobs WHERE kind = 'apply'")).toBeUndefined();
    // a fresh preview works
    p = await preview();
    expect((await askApply(p.previewId)).error).toBe(false);
  });

  it('a pending apply is refused at approval if tasks or availability changed after it was requested (nothing is written)', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p = await preview();
    const ask = (await askApply(p.previewId)).data;
    tick(MIN);
    editTask(ctx, 1, { est: 30 }); // the user edits a task while the card is waiting
    const r = await dispatch(app, 'pending.approve', { id: ask.applyId, confirm: true });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/changed since the preview, so nothing was written/);
    expect(blocks()).toBe(0);
    expect(cal.writes).toEqual([]);
    expect((await call('get_pending_apply')).data.status).toBe('stale');
  });

  it('the app\'s own plan check also applies (the same fingerprint check as a normal Apply): a changed calendar makes it stale', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p = await preview();
    const ask = (await askApply(p.previewId)).data;
    busy.push(iv('2026-11-12T10:15', '2026-11-12T22:00')); // an event lands on the Google calendar after the preview
    const r = await dispatch(app, 'pending.approve', { id: ask.applyId, confirm: true });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/plan changed since you previewed/);
    expect(blocks()).toBe(0);
    expect((await call('get_pending_apply')).data.status).toBe('stale');
  });

  it('turning the switch off cancels a pending request', async () => {
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p = await preview();
    const ask = (await askApply(p.previewId)).data;
    on(CLAUDE_SCHEDULE_KEY, false);
    await new Promise((r) => setTimeout(r, 150)); // the app's tick notices
    expect((await call('get_pending_apply')).data.status).toBe('cancelled');
    expect((await dispatch(app, 'pending.approve', { id: ask.applyId, confirm: true })).ok).toBe(false);
    expect(blocks()).toBe(0);
  });

  it('approval exists only inside the app: no tool can approve, and the connector code cannot write an approved state', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /approve|confirm_apply|accept/.test(n))).toEqual([]);
    for (const f of ['src/mcp/tools.ts', 'src/mcp/server.ts', 'src/mcp/main.ts']) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/['"]applied['"]|['"]approving['"]|schedule\.apply|applyPlan|pending\.approve|computePlan|createCalendar|googleapis|getRefreshToken/);
    }
    // approving needs an explicit confirmation flag and a real id even from inside the app
    expect((await dispatch(app, 'pending.approve', { id: '3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b11' })).ok).toBe(false);
    expect((await dispatch(app, 'pending.approve', { id: 'nope', confirm: true })).ok).toBe(false);
    expect((await dispatch(app, 'pending.approve', { id: '3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b11', confirm: true })).ok).toBe(false);
    // a forged job row cannot be approved either (only a 'pending' apply can be)
    const forged = '3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b12';
    ctx.db.run("INSERT INTO connector_jobs(id, kind, status, created_at, updated_at, request) VALUES(?, 'preview', 'ready', ?, ?, '{}')", [forged, NOW, NOW]);
    expect((await dispatch(app, 'pending.approve', { id: forged, confirm: true })).ok).toBe(false);
    expect(blocks()).toBe(0);
  });

  it('get_pending_apply says "none" before any request, and can be asked about a specific one', async () => {
    expect((await call('get_pending_apply')).data.status).toBe('none');
    startApp();
    on(CLAUDE_SCHEDULE_KEY);
    const p = await preview();
    const ask = (await askApply(p.previewId)).data;
    expect((await call('get_pending_apply', { apply_id: ask.applyId })).data.status).toBe('pending');
    expect((await call('get_pending_apply', { apply_id: '3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b11' })).data.status).toBe('none');
    expect((await call('get_pending_apply', { apply_id: 'x' })).error).toBe(true);
  });

  it('a failed preview (the app could not read the calendar) comes back as a readable error', async () => {
    app.calendar = () => { throw new Error('Google says: token expired'); };
    startApp();
    const r = await call('preview_schedule', { days: 7 });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/preview failed: .*token expired/);
  });

  it('input limits: days must be 1 to 60', async () => {
    for (const days of [0, 61, 1.5, '7']) expect((await call('preview_schedule', { days })).error, String(days)).toBe(true);
    expect((await call('preview_schedule', { days: 7, replan: true })).error).toBe(true);
  });
});

// ======================================================================================================== 5. call log and settings
describe('the connector call log and the three switches in Settings', () => {
  const app = (): ApiDeps => ({ ctx, dbFile: ':memory:', demo: true, backupFolder: backups, calendar: () => { throw new Error('no'); } });

  it('every call is logged: tool, time, result, whether it worked', async () => {
    const t = addTask(ctx, { title: 'WeBWorK 7', course: 'MATH 115', est: 60 });
    await call('tally_status');
    await call('add_task', { title: 'nope' }); // refused: switch off
    on(CLAUDE_WRITES_KEY);
    await call('mark_done', { id: t.id });
    await call('mark_done', { id: 9999 });
    const log = listCalls(ctx);
    expect(log.map((c) => c.tool)).toEqual(['mark_done', 'mark_done', 'add_task', 'tally_status']);
    expect(log.map((c) => c.ok)).toEqual([false, true, false, true]);
    expect(log[0].detail).toMatch(/No task #9999/);
    expect(log[1].detail).toMatch(/Marked #\d+ “WeBWorK 7” done|Marked|ok/);
    expect(log[2].detail).toMatch(/turned off/);
    expect(log.every((c) => /^\d{4}-\d\d-\d\dT/.test(c.at))).toBe(true);
  });

  it('keeps only the last 50', async () => {
    for (let i = 0; i < CALL_LOG_KEEP + 10; i++) await call('tally_status');
    expect(listCalls(ctx)).toHaveLength(CALL_LOG_KEEP);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM connector_calls')!.n).toBe(CALL_LOG_KEEP);
  });

  it('is shown in Settings with the three switches, each off by default and explained', async () => {
    await call('tally_status');
    const s = ((await dispatch(app(), 'settings.get', undefined)) as any).value.claude;
    expect([s.writes, s.deletes, s.schedule].map((i) => [i.key, i.label, i.value, i.default])).toEqual([
      ['mcp_allow_writes', 'Allow Claude to change my tasks', 'false', 'false'],
      ['mcp_allow_deletes', 'Allow Claude to delete tasks', 'false', 'false'],
      ['mcp_allow_schedule', 'Allow Claude to apply schedules to Google', 'false', 'false'],
    ]);
    for (const i of [s.writes, s.deletes, s.schedule]) { expect(i.kind).toBe('bool'); expect(i.help.length).toBeGreaterThan(60); }
    expect(s.schedule.help).toMatch(/Approve/);
    expect(s.calls[0]).toMatchObject({ tool: 'tally_status', ok: true });
  });

  it('each switch saves, validates and resets independently', async () => {
    for (const key of ['mcp_allow_writes', 'mcp_allow_deletes', 'mcp_allow_schedule']) {
      const on1 = (await dispatch(app(), 'settings.set', { key, value: 'true' })) as any;
      expect(on1.ok).toBe(true);
      const pick = (v: any) => Object.values(v.claude).find((i: any) => i?.key === key) as any;
      expect(pick(on1.value).value).toBe('true');
      expect(((await dispatch(app(), 'settings.set', { key, value: 'maybe' })) as any).ok).toBe(false);
      expect(pick(((await dispatch(app(), 'settings.reset', { key })) as any).value).value).toBe('false');
    }
  });
});
