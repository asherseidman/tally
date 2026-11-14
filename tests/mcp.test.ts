import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeCtx } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { createTerm } from '../src/core/terms';
import { addTask, getTask, completeTask } from '../src/core/tasks';
import { addDependency } from '../src/core/dependencies';
import { setSetting } from '../src/db/repo';
import { openDb } from '../src/db/index';
import { createServer } from '../src/mcp/server';
import { WRITES_OFF, LIMITS } from '../src/mcp/tools';
import { resolveTarget, realDbFile, demoDbFile } from '../src/mcp/target';
import { listChanges, undoChange } from '../src/core/changeLog';
import { CLAUDE_WRITES_KEY } from '../src/core/claudeAccess';

// 2026-11-12 10:00 in Detroit
const NOW = '2026-11-12T15:00:00Z';
const TARGET = { dbFile: '/tmp/test-tally.db', kind: 'test' as const, label: 'TEST database' };

let ctx: Ctx;
let client: Client;
let backups: string;

async function connect() {
  const server = createServer({ ctx, target: TARGET, backupFolder: backups });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
}

interface Out { error: boolean; text: string; data: any }
/** Calls a tool the way a real client does; protocol-level rejections (bad input) come back as errors too. */
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
/** the task's current updatedAt, as Claude would have read it */
const ru = (taskId: number) => getTask(ctx, taskId)!.updated_at;
const allow = (on = true) => setSetting(ctx.db, CLAUDE_WRITES_KEY, on ? 'true' : 'false');
const taskCount = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM tasks')!.n;
const logCount = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM change_log')!.n;

beforeEach(async () => {
  ctx = makeCtx(NOW);
  backups = mkdtempSync(join(tmpdir(), 'tally-mcp-bk-'));
  createTerm(ctx, { name: 'Fall 2026', start_date: '2026-08-31', end_date: '2026-12-11' });
  createTerm(ctx, { name: 'Winter 2027', start_date: '2027-01-05', end_date: '2027-04-20' });
  ctx.db.run('UPDATE terms SET is_current = (name = ?)', ['Fall 2026']);
  await connect();
});
afterEach(async () => {
  await client.close();
  rmSync(backups, { recursive: true, force: true });
});

const seed = () => {
  const a = addTask(ctx, { title: 'WeBWorK 7', course: 'MATH 115', type: 'homework', due: '2026-11-13 5pm', est: 60, weight: 3 });
  const b = addTask(ctx, { title: 'Essay draft', course: 'ENGL 125', type: 'project', due: '2026-11-20', est: 120, weight: 10 });
  const c = addTask(ctx, { title: 'Quiz 4', course: 'MATH 115', type: 'quiz', due: '2026-11-30 9am', weight: 5 });
  const d = addTask(ctx, { title: 'Old reading', course: 'ENGL 125', type: 'reading', due: '2026-11-01' });
  completeTask(ctx, d.id);
  return { a, b, c, d };
};

describe('the tool surface', () => {
  it('exposes exactly the intended tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'add_dependency', 'add_step', 'add_task', 'apply_schedule', 'create_list', 'delete_task', 'edit_task', 'get_free_time', 'get_pending_apply', 'get_review', 'get_schedule', 'get_settings',
      'get_task', 'get_timer', 'get_views', 'import_confirm', 'import_dry_run', 'list_tasks', 'log_work', 'mark_done', 'move_task_to_list', 'preview_replan', 'preview_schedule',
      'remove_dependency', 'rename_list', 'reopen_task', 'start_timer', 'stop_timer', 'tally_status',
    ]);
  });

  it('has no tool for restore, config, settings, Google, availability, terms or backups; delete and apply exist only as the one guarded tool each', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name.toLowerCase());
    for (const bad of ['restore', 'config', 'setting', 'google', 'connect', 'disconnect', 'backup', 'availability', 'term', 'replan_apply', 'approve', 'reject', 'bulk', 'purge', 'wipe']) {
      expect(names.filter((n) => n.split('_').includes(bad)), bad).toEqual([]);
    }
    expect(names.filter((n) => /delete|remove|rm/.test(n.split('_')[0])).sort()).toEqual(['delete_task', 'remove_dependency']);
    expect(names.filter((n) => n.split('_').includes('apply'))).toEqual(['apply_schedule', 'get_pending_apply']);
    expect(names.filter((n) => n.includes('list') && !['list_tasks', 'create_list', 'rename_list', 'move_task_to_list'].includes(n))).toEqual([]);
  });

  it('marks reads as read-only and writes as non-destructive', async () => {
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      if (['list_tasks', 'get_task', 'get_views', 'get_schedule', 'get_free_time', 'get_settings', 'tally_status', 'import_dry_run', 'get_timer', 'preview_schedule', 'preview_replan', 'get_pending_apply', 'get_review'].includes(t.name)) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      else { expect(t.annotations?.readOnlyHint, t.name).toBe(false); expect(t.annotations?.destructiveHint, t.name).toBe(t.name === 'delete_task'); }
    }
  });

  it('refuses an unknown tool', async () => {
    const r = await call('apply_schedule', { confirm: true });
    expect(r.error).toBe(true);
  });
});

describe('read tools', () => {
  it('tally_status says which database it is and that writes are off by default', async () => {
    seed();
    const r = await call('tally_status');
    expect(r.error).toBe(false);
    expect(r.data.database).toMatchObject({ kind: 'test', label: 'TEST database', path: TARGET.dbFile });
    expect(r.data.claudeMayChangeTasks).toBe(false);
    expect(r.data.today).toBe('2026-11-12');
    expect(r.data.currentTerm.name).toBe('Fall 2026');
    expect(r.data.openTasks).toBe(3);
    expect(r.data.doneTasks).toBe(1);
  });

  it('list_tasks: defaults to open tasks, soonest first', async () => {
    seed();
    const r = await call('list_tasks');
    expect(r.data.tasks.map((t: any) => t.title)).toEqual(['WeBWorK 7', 'Essay draft', 'Quiz 4']);
    expect(r.data.count).toBe(3);
    expect(r.data.truncated).toBe(false);
  });

  it('list_tasks: filters by course, status, list, term and text', async () => {
    seed();
    expect((await call('list_tasks', { course: 'math 115' })).data.tasks.map((t: any) => t.title).sort()).toEqual(['Quiz 4', 'WeBWorK 7']);
    expect((await call('list_tasks', { status: 'done' })).data.tasks.map((t: any) => t.title)).toEqual(['Old reading']);
    expect((await call('list_tasks', { status: 'all' })).data.count).toBe(4);
    expect((await call('list_tasks', { text: 'essay' })).data.tasks.map((t: any) => t.title)).toEqual(['Essay draft']);
    expect((await call('list_tasks', { term: 'Winter 2027' })).data.count).toBe(0);
    expect((await call('list_tasks', { list: 'No such list' })).error).toBe(true);
    expect((await call('list_tasks', { term: 'No such term' })).error).toBe(true);
  });

  it('list_tasks: a due window covers whole days', async () => {
    seed();
    const r = await call('list_tasks', { due_after: '2026-11-13', due_before: '2026-11-20' });
    expect(r.data.tasks.map((t: any) => t.title)).toEqual(['WeBWorK 7', 'Essay draft']);
  });

  it('list_tasks: limit truncates and says so', async () => {
    seed();
    const r = await call('list_tasks', { limit: 2 });
    expect(r.data.returned).toBe(2);
    expect(r.data.count).toBe(3);
    expect(r.data.truncated).toBe(true);
  });

  it('get_task: dependencies, steps, parent and time entries', async () => {
    const { a, b } = seed();
    addDependency(ctx, b.id, a.id);
    ctx.db.run("INSERT INTO tasks(title, status, source, parent_task_id, created_at, updated_at, type) VALUES('Step one','todo','manual',?,?,?, 'other')", [b.id, NOW, NOW]);
    ctx.db.run('INSERT INTO time_sessions(task_id, started_at, ended_at) VALUES(?,?,?)', [b.id, '2026-11-11T15:00:00Z', '2026-11-11T16:00:00Z']);
    const r = await call('get_task', { id: b.id });
    expect(r.data.task.title).toBe('Essay draft');
    expect(r.data.blockedBy.map((x: any) => x.id)).toEqual([a.id]);
    expect(r.data.steps.map((x: any) => x.title)).toEqual(['Step one']);
    expect(r.data.recentTimeEntries).toHaveLength(1);
    expect((await call('get_task', { id: a.id })).data.blocks.map((x: any) => x.id)).toEqual([b.id]);
    expect((await call('get_task', { id: 9999 })).error).toBe(true);
  });

  it('get_views: the four views, with reasons', async () => {
    const { a, b } = seed();
    addDependency(ctx, b.id, a.id);
    const r = await call('get_views');
    expect(r.error).toBe(false);
    expect(Object.keys(r.data)).toEqual(expect.arrayContaining(['dueSoon', 'highGradeImpact', 'quickWins', 'blocked']));
    expect(r.data.dueSoon.map((t: any) => t.title)).toContain('WeBWorK 7');
    expect(r.data.dueSoon[0].reason).toBeTruthy();
    expect(r.data.blocked.map((t: any) => t.title)).toContain('Essay draft');
  });

  it('get_schedule: planned blocks, no Google ids', async () => {
    const { a } = seed();
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end", google_event_id) VALUES(?,?,?,?)', [a.id, '2026-11-12T19:00:00Z', '2026-11-12T20:00:00Z', 'secret-event-id']);
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end", google_event_id) VALUES(?,?,?,?)', [a.id, '2026-10-01T19:00:00Z', '2026-10-01T20:00:00Z', 'old-event']);
    const r = await call('get_schedule', { days: 7 });
    expect(r.data.count).toBe(1);
    expect(r.data.blocks[0]).toMatchObject({ taskId: a.id, title: 'WeBWorK 7', minutes: 60, local: 'Thu Nov 12, 2:00 PM to 3:00 PM' });
    expect(r.text).not.toContain('secret-event-id');
    expect(r.text).not.toContain('google_event_id');
  });

  it('get_free_time: windows, planned blocks and the minutes left', async () => {
    const { a } = seed();
    // Thursdays (weekday 4) 09:00-12:00 free
    ctx.db.run("INSERT INTO availability_windows(weekday, start, \"end\", kind) VALUES(4, '09:00', '12:00', 'free')");
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [a.id, '2026-11-12T15:00:00Z', '2026-11-12T16:00:00Z']); // 10:00-11:00 Detroit
    const r = await call('get_free_time', { start_date: '2026-11-12', days: 2 });
    expect(r.error).toBe(false);
    expect(r.data.days).toHaveLength(2);
    const thu = r.data.days[0];
    expect(thu).toMatchObject({ date: '2026-11-12', free: [{ start: '09:00', end: '12:00' }], freeMinutes: 180, freeMinutesAfterBlocks: 120 });
    expect(thu.plannedBlocks[0]).toMatchObject({ start: '10:00', end: '11:00' });
    expect(r.data.days[1].free).toEqual([]);
    expect(r.data.note).toMatch(/Google/);
    expect((await call('get_free_time', { start_date: '2026-02-30' })).error).toBe(true);
  });

  it('get_settings: scheduling and priority values, and never secrets, ids or paths', async () => {
    setSetting(ctx.db, 'class_calendars', '["abc@group.calendar.google.com"]');
    setSetting(ctx.db, 'busy_calendars', '["me@gmail.com"]');
    setSetting(ctx.db, 'backup_folder', '/Users/me/Library/Mobile Documents/planner-backups');
    setSetting(ctx.db, 'google_refresh_token', 'REFRESH-TOKEN-SECRET');
    setSetting(ctx.db, 'quick_add_shortcut', 'CommandOrControl+Shift+Space');
    const r = await call('get_settings');
    expect(r.error).toBe(false);
    expect(r.data.timezone).toBe('America/Detroit');
    expect(r.data.scheduling.map((s: any) => s.key)).toContain('max_block_minutes');
    expect(r.data.priority.map((s: any) => s.key)).toContain('views_due_soon_hours');
    for (const leak of ['REFRESH-TOKEN-SECRET', 'abc@group.calendar', 'me@gmail.com', 'Mobile Documents', 'CommandOrControl', 'google_refresh_token', 'client']) expect(r.text, leak).not.toContain(leak);
  });
});

describe('writes are OFF by default', () => {
  const writeCalls: [string, Record<string, unknown>][] = [
    ['add_task', { title: 'New thing' }], ['mark_done', { id: 1 }], ['reopen_task', { id: 1 }], ['log_work', { id: 1, minutes: 30 }],
    ['edit_task', { id: 1, read_updated_at: 'x', estimate_minutes: 90 }], ['add_dependency', { task: 1, blocked_by: 2 }],
    ['remove_dependency', { task: 1, blocked_by: 2 }], ['create_list', { name: 'L' }], ['rename_list', { name: 'L', new_name: 'M' }], ['move_task_to_list', { id: 1, list: 'L', read_updated_at: 'x' }],
    ['add_step', { parent: 1, title: 's' }], ['start_timer', { id: 1 }], ['stop_timer', {}], ['import_confirm', { diff_id: '3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b11' }],
  ];

  it.each(writeCalls)('%s is refused and changes nothing', async (name, args) => {
    seed();
    const before = JSON.stringify(ctx.db.all('SELECT * FROM tasks'));
    const r = await call(name, args);
    expect(r.error).toBe(true);
    expect(r.text).toBe(WRITES_OFF);
    expect(JSON.stringify(ctx.db.all('SELECT * FROM tasks'))).toBe(before);
    expect(logCount()).toBe(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM time_sessions')!.n).toBe(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM dependencies')!.n).toBe(0);
  });

  it('an explicit "false" is also off, and reading still works', async () => {
    allow(false);
    expect((await call('add_task', { title: 'x' })).error).toBe(true);
    expect((await call('list_tasks')).error).toBe(false);
  });

  it('the switch is read fresh on every call (turned on and off while connected)', async () => {
    expect((await call('add_task', { title: 'one' })).error).toBe(true);
    allow(true);
    expect((await call('add_task', { title: 'two' })).error).toBe(false);
    allow(false);
    expect((await call('add_task', { title: 'three' })).error).toBe(true);
    expect(ctx.db.all<{ title: string }>('SELECT title FROM tasks').map((t) => t.title)).toEqual(['two']);
  });

  it('there is no tool that can turn the switch on', async () => {
    const r = await call('tally_status');
    expect(r.data.claudeMayChangeTasks).toBe(false);
    for (const t of (await client.listTools()).tools) expect(JSON.stringify(t.inputSchema)).not.toContain(CLAUDE_WRITES_KEY);
  });
});

describe('write tools (switch on)', () => {
  beforeEach(() => allow(true));

  it('add_task: understands a date at the end of the title, and reports what changed', async () => {
    const r = await call('add_task', { title: 'read ch 3 fri 5pm', course: 'ENGL 125', estimate_minutes: 45 });
    expect(r.error).toBe(false);
    expect(r.data.changed).toBe(true);
    expect(r.data.created).toHaveLength(1);
    expect(r.data.task).toMatchObject({ title: 'read ch 3', course: 'ENGL 125', estimateMinutes: 45 });
    expect(r.data.task.dueText).toMatch(/Fri Nov 13 .*5:00 PM/);
    expect(r.data.changeId).toBeGreaterThan(0);
    expect(getTask(ctx, r.data.task.id)!.title).toBe('read ch 3');
  });

  it('add_task: an explicit due wins and parse_title_date:false keeps the title as typed', async () => {
    const r = await call('add_task', { title: 'call mom tonight', parse_title_date: false });
    expect(r.data.task.title).toBe('call mom tonight');
    expect(r.data.task.due).toBeNull();
    const s = await call('add_task', { title: 'Lab report', due: '2026-11-25 3pm' });
    expect(s.data.task.dueText).toMatch(/Nov 25 .*3:00 PM/);
  });

  it('add_task: bad values are refused by the core and nothing is written', async () => {
    const n = taskCount();
    expect((await call('add_task', { title: 'x', list: 'Nope' })).error).toBe(true);
    expect((await call('add_task', { title: 'x', due: 'when the cows come home' })).error).toBe(true);
    expect(taskCount()).toBe(n);
    expect(logCount()).toBe(0);
  });

  it('mark_done and reopen_task', async () => {
    const { a } = seed();
    const done = await call('mark_done', { id: a.id });
    expect(done.data.changed).toBe(true);
    expect(done.data.updated[0].changes.status).toEqual({ from: 'todo', to: 'done' });
    expect(getTask(ctx, a.id)!.status).toBe('done');
    const again = await call('mark_done', { id: a.id });
    expect(again.data.changed).toBe(false);
    const re = await call('reopen_task', { id: a.id });
    expect(re.data.updated[0].changes.status).toEqual({ from: 'done', to: 'todo' });
    expect((await call('reopen_task', { id: a.id })).error).toBe(true); // not done any more
    expect((await call('mark_done', { id: 99999 })).error).toBe(true);
  });

  it('mark_done on a repeating task reports the next occurrence', async () => {
    const t = addTask(ctx, { title: 'Weekly quiz', due: '2026-11-13 9am', repeat: 'weekly', course: 'MATH 115' });
    const r = await call('mark_done', { id: t.id });
    expect(r.data.nextOccurrence.id).toBeGreaterThan(t.id);
    expect(r.data.created).toHaveLength(1);
  });

  it('log_work adds a finished time entry and reports the total', async () => {
    const { a } = seed();
    const r = await call('log_work', { id: a.id, minutes: 45 });
    expect(r.data.totalLoggedMinutes).toBe(45);
    expect(r.data.workLogged).toEqual([{ task: a.id, minutes: 45 }]);
    expect((await call('log_work', { id: a.id, minutes: 0 })).error).toBe(true);
    expect((await call('log_work', { id: a.id, minutes: 1441 })).error).toBe(true);
  });

  it('edit_task changes the estimate and the due date', async () => {
    const { a } = seed();
    const r = await call('edit_task', { id: a.id, read_updated_at: ru(a.id), estimate_minutes: 90, due: '2026-11-14 noon' });
    expect(r.data.updated[0].changes.estimated_minutes).toEqual({ from: 60, to: 90 });
    expect(r.data.updated[0].changes.due_date.to).toBe('2026-11-14T17:00:00.000Z');
    expect(Object.keys(r.data.updated[0].changes)).not.toContain('title');
    const clear = await call('edit_task', { id: a.id, read_updated_at: ru(a.id), estimate_minutes: null, due: 'none' });
    expect(getTask(ctx, a.id)!.estimated_minutes).toBeNull();
    expect(getTask(ctx, a.id)!.due_date).toBeNull();
    expect(clear.data.changed).toBe(true);
    expect((await call('edit_task', { id: a.id, read_updated_at: ru(a.id) })).error).toBe(true); // nothing to change
    for (const field of ['term', 'status', 'import_key', 'deleted', 'repeat', 'source', 'created_at', 'updated_at']) expect((await call('edit_task', { id: a.id, read_updated_at: ru(a.id), [field]: 'x' })).error, field).toBe(true);
  });

  it('add_dependency, and a cycle is refused', async () => {
    const { a, b } = seed();
    const r = await call('add_dependency', { task: b.id, blocked_by: a.id });
    expect(r.data.dependenciesAdded).toEqual([{ task: b.id, blockedBy: a.id }]);
    expect((await call('add_dependency', { task: a.id, blocked_by: b.id })).text).toMatch(/cycle/);
    expect((await call('add_dependency', { task: a.id, blocked_by: a.id })).error).toBe(true);
    expect((await call('add_dependency', { task: b.id, blocked_by: a.id })).data.changed).toBe(false);
  });

  it('every write is in the change history, as the connector, and can be undone', async () => {
    const { a, b } = seed();
    await call('add_task', { title: 'New thing', course: 'X 1' });
    await call('mark_done', { id: a.id });
    await call('log_work', { id: b.id, minutes: 20 });
    await call('edit_task', { id: b.id, read_updated_at: ru(b.id), estimate_minutes: 30 });
    await call('add_dependency', { task: b.id, blocked_by: a.id });
    const h = listChanges(ctx);
    expect(h.map((x) => x.tool)).toEqual(['add_dependency', 'edit_task', 'log_work', 'mark_done', 'add_task']);
    expect(h.every((x) => x.actor === 'claude' && !x.undone)).toBe(true);
    expect(h[3].summary).toContain('WeBWorK 7');
  });
});

describe('undo history', () => {
  beforeEach(() => allow(true));

  it('undoes each kind of change, newest first', async () => {
    const { a, b } = seed();
    const added = (await call('add_task', { title: 'New thing', course: 'X 1' })).data;
    const done = (await call('mark_done', { id: a.id })).data;
    const logged = (await call('log_work', { id: b.id, minutes: 20 })).data;
    const edited = (await call('edit_task', { id: b.id, read_updated_at: ru(b.id), estimate_minutes: 30, due: '2026-12-01' })).data;
    const dep = (await call('add_dependency', { task: b.id, blocked_by: a.id })).data;
    const snapshot = () => JSON.stringify(ctx.db.all('SELECT * FROM tasks WHERE id IN (?,?)', [a.id, b.id]));

    undoChange(ctx, dep.changeId);
    expect(ctx.db.get('SELECT 1 FROM dependencies')).toBeUndefined();
    undoChange(ctx, edited.changeId);
    expect(getTask(ctx, b.id)!.estimated_minutes).toBe(120);
    expect(getTask(ctx, b.id)!.due_date).toBe(b.due_date);
    undoChange(ctx, logged.changeId);
    expect(ctx.db.get('SELECT 1 FROM time_sessions')).toBeUndefined();
    expect(getTask(ctx, b.id)!.actual_minutes ?? 0).toBe(0);
    undoChange(ctx, done.changeId);
    expect(getTask(ctx, a.id)!.status).toBe('todo');
    expect(getTask(ctx, a.id)!.completed_at).toBeNull();
    undoChange(ctx, added.changeId);
    expect(getTask(ctx, added.task.id)).toBeUndefined(); // soft-deleted
    expect(ctx.db.get('SELECT deleted_at FROM tasks WHERE id = ?', [added.task.id])).toMatchObject({ deleted_at: expect.any(String) });
    void snapshot;
    expect(listChanges(ctx).every((x) => x.undone)).toBe(true);
  });

  it('undoing a repeating-task completion also removes the next occurrence', async () => {
    const t = addTask(ctx, { title: 'Weekly quiz', due: '2026-11-13 9am', repeat: 'weekly' });
    const r = (await call('mark_done', { id: t.id })).data;
    undoChange(ctx, r.changeId);
    expect(getTask(ctx, t.id)!.status).toBe('todo');
    expect(getTask(ctx, r.nextOccurrence.id)).toBeUndefined();
  });

  it('refuses to undo when the task was changed again afterwards, and touches nothing', async () => {
    const { a } = seed();
    const first = (await call('edit_task', { id: a.id, read_updated_at: ru(a.id), estimate_minutes: 90 })).data;
    await call('edit_task', { id: a.id, read_updated_at: ru(a.id), estimate_minutes: 120 });
    expect(() => undoChange(ctx, first.changeId)).toThrow(/changed again since/);
    expect(getTask(ctx, a.id)!.estimated_minutes).toBe(120);
    expect(listChanges(ctx).find((x) => x.id === first.changeId)!.undone).toBe(false);
  });

  it('refuses to undo twice, or an unknown change', async () => {
    const { a } = seed();
    const r = (await call('mark_done', { id: a.id })).data;
    undoChange(ctx, r.changeId);
    expect(() => undoChange(ctx, r.changeId)).toThrow(/already undone/);
    expect(() => undoChange(ctx, 999)).toThrow(/No change #999/);
  });

  it('a no-op write records nothing', async () => {
    const { d } = seed();
    expect((await call('mark_done', { id: d.id })).data.changed).toBe(false);
    expect(logCount()).toBe(0);
  });
});

describe('refusing unknown or oversized input', () => {
  beforeEach(() => allow(true));

  it('unknown fields are rejected (no silent extras), reads and writes alike', async () => {
    expect((await call('add_task', { title: 'x', status: 'done' })).error).toBe(true);
    expect((await call('add_task', { title: 'x', deleted_at: '2026-01-01' })).error).toBe(true);
    expect((await call('list_tasks', { sql: 'DROP TABLE tasks' })).error).toBe(true);
    expect((await call('mark_done', { id: 1, force: true })).error).toBe(true);
    expect((await call('tally_status', { verbose: true })).error).toBe(true);
    expect((await call('import_confirm', { diff_id: '3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b11', apply_to_google: true })).error).toBe(true);
    expect(taskCount()).toBe(0);
  });

  it('wrong types, bad ids and out-of-range numbers are rejected', async () => {
    seed();
    for (const [name, args] of [
      ['get_task', { id: -1 }], ['get_task', { id: 1.5 }], ['get_task', { id: '1' }], ['get_task', { id: 3_000_000_000 }], ['get_task', {}],
      ['mark_done', { id: 0 }], ['log_work', { id: 1, minutes: -5 }], ['log_work', { id: 1, minutes: 2.5 }], ['add_task', { title: '' }], ['add_task', { title: '   ' }],
      ['add_task', { title: 'x', type: 'chore' }], ['add_task', { title: 'x', grade_weight: 101 }], ['add_task', { title: 'x', estimate_minutes: 100000 }],
      ['list_tasks', { limit: 0 }], ['list_tasks', { limit: LIMITS.listMax + 1 }], ['list_tasks', { status: 'everything' }],
      ['get_free_time', { days: 15 }], ['get_free_time', { start_date: 'tomorrow' }], ['get_schedule', { days: 61 }],
    ] as [string, Record<string, unknown>][]) {
      expect((await call(name, args)).error, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });

  it('oversized text is refused, not truncated', async () => {
    const n = taskCount();
    expect((await call('add_task', { title: 'x'.repeat(LIMITS.title + 1) })).error).toBe(true);
    expect((await call('add_task', { title: 'ok', notes: 'n'.repeat(LIMITS.notes + 1) })).error).toBe(true);
    expect((await call('add_task', { title: 'ok', course: 'c'.repeat(LIMITS.short + 1) })).error).toBe(true);
    expect((await call('list_tasks', { text: 't'.repeat(LIMITS.text + 1) })).error).toBe(true);
    expect((await call('edit_task', { id: 1, read_updated_at: 'x', due: 'd'.repeat(LIMITS.short + 1) })).error).toBe(true);
    expect(taskCount()).toBe(n);
  });

  it('a title at exactly the limit is accepted', async () => {
    expect((await call('add_task', { title: 'x'.repeat(LIMITS.title) })).error).toBe(false);
  });

  it('an oversized import file is refused before anything is parsed', async () => {
    const huge = { term: { name: 'T', start_date: '2026-08-31', end_date: '2026-12-11' }, items: [], padding: 'p'.repeat(LIMITS.import) };
    const r = await call('import_dry_run', { import_file: huge });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/too large/);
  });

  it('import_dry_run rejects a non-object, a bad file, and extra top-level arguments', async () => {
    expect((await call('import_dry_run', { import_file: 'not an object' })).error).toBe(true);
    const bad = await call('import_dry_run', { import_file: JSON.parse(readFileSync('samples/invalid.json', 'utf8')) });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/not a valid import file/);
    expect((await call('import_dry_run', { import_file: {}, write: true })).error).toBe(true);
  });
});

describe('import: a dry run, then a separate confirmation with the same diff id', () => {
  const file = () => JSON.parse(readFileSync('samples/demo-phys-101.json', 'utf8'));

  it('the dry run returns the diff and writes nothing, even with writes allowed', async () => {
    allow(true);
    const before = taskCount();
    const r = await call('import_dry_run', { import_file: file() });
    expect(r.error).toBe(false);
    expect(r.data.diff_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.data).toMatchObject({ term: 'DEMO Term', termWillBeCreated: true, willAdd: 3, willUpdate: 0, unchangedCount: 0 });
    expect(r.data.entries.map((e: any) => e.title).sort()).toEqual(['Exam 1', 'Lab Report 1', 'Reading: Chapter 2']);
    expect(r.data.next).toMatch(/import_confirm/);
    expect(taskCount()).toBe(before);
    expect(logCount()).toBe(0);
    expect(ctx.db.get('SELECT 1 FROM terms WHERE name = ?', ['DEMO Term'])).toBeUndefined();
  });

  it('the dry run works with writes off (it is a read)', async () => {
    expect((await call('import_dry_run', { import_file: file() })).error).toBe(false);
  });

  it('confirm with writes off is refused and writes nothing', async () => {
    const dry = (await call('import_dry_run', { import_file: file() })).data;
    const r = await call('import_confirm', { diff_id: dry.diff_id });
    expect(r.error).toBe(true);
    expect(r.text).toBe(WRITES_OFF);
    expect(taskCount()).toBe(0);
  });

  it('confirm writes exactly the previewed diff, logs it, and the id cannot be reused', async () => {
    allow(true);
    const dry = (await call('import_dry_run', { import_file: file() })).data;
    const r = await call('import_confirm', { diff_id: dry.diff_id });
    expect(r.error).toBe(false);
    expect(r.data).toMatchObject({ changed: true, inserted: 3, updated: 0, termCreated: true });
    expect(r.data.created).toHaveLength(3);
    expect(taskCount()).toBe(3);
    expect(listChanges(ctx)[0]).toMatchObject({ tool: 'import_confirm', actor: 'claude' });
    expect((await call('import_confirm', { diff_id: dry.diff_id })).text).toMatch(/Unknown diff_id/);
    expect(taskCount()).toBe(3);
  });

  it('an unknown or malformed diff id is refused', async () => {
    allow(true);
    expect((await call('import_confirm', { diff_id: '3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b11' })).text).toMatch(/Unknown diff_id/);
    expect((await call('import_confirm', { diff_id: 'latest' })).error).toBe(true);
    expect((await call('import_confirm', { diff_id: '' })).error).toBe(true);
    expect(taskCount()).toBe(0);
  });

  it('confirm refuses when the data changed since the dry run (the diff is stale)', async () => {
    allow(true);
    const first = (await call('import_dry_run', { import_file: file() })).data;
    const second = (await call('import_dry_run', { import_file: file() })).data;
    expect((await call('import_confirm', { diff_id: second.diff_id })).error).toBe(false); // now the same file is already in
    const r = await call('import_confirm', { diff_id: first.diff_id });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/changed since that dry run/);
    expect(taskCount()).toBe(3);
  });

  it('a confirmed import can be undone (tasks come out; the term stays)', async () => {
    allow(true);
    const dry = (await call('import_dry_run', { import_file: file() })).data;
    const r = (await call('import_confirm', { diff_id: dry.diff_id })).data;
    expect(r.undoNote).toMatch(/term/);
    undoChange(ctx, r.changeId);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM tasks WHERE deleted_at IS NULL')!.n).toBe(0);
  });

  it('a revised file shows changed fields, and the dry-run state does not leak between diffs', async () => {
    allow(true);
    const base = (await call('import_dry_run', { import_file: file() })).data;
    await call('import_confirm', { diff_id: base.diff_id });
    const revised = file();
    revised.items[0].due_date = '2026-09-17';
    const d2 = (await call('import_dry_run', { import_file: revised })).data;
    expect(d2).toMatchObject({ willAdd: 0, willUpdate: 1, unchangedCount: 2 });
    expect(d2.entries[0].changes[0].field).toBe('due_date');
  });
});

describe('the change log and the connector never reach Google', () => {
  it('the tools source has no network or Google code', () => {
    for (const f of ['src/mcp/tools.ts', 'src/mcp/server.ts', 'src/mcp/main.ts', 'src/mcp/target.ts']) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/googleapis|google-auth-library|fetch\(|node:https?|node:net|node:dgram|\.listen\(|keyring|secretStore|schedule\/service|applyPlan|backups\.restore|restoreFrom/);
    }
  });
});

describe('which database (the real/demo mix-up guard)', () => {
  const ok = mkdtempSync(join(tmpdir(), 'tally-mcp-target-'));
  const file = join(ok, 'x.db');
  openDb(file).close();

  it('requires the path, and an absolute one', () => {
    expect(() => resolveTarget({ TALLY_MCP_EXPECT: 'test' })).toThrow(/TALLY_MCP_DB is not set/);
    expect(() => resolveTarget({ TALLY_MCP_DB: 'planner.db', TALLY_MCP_EXPECT: 'real' })).toThrow(/absolute/);
  });

  it('requires you to say what you expect, and only real, demo or test', () => {
    expect(() => resolveTarget({ TALLY_MCP_DB: file })).toThrow(/TALLY_MCP_EXPECT/);
    expect(() => resolveTarget({ TALLY_MCP_DB: file, TALLY_MCP_EXPECT: 'prod' })).toThrow(/TALLY_MCP_EXPECT/);
  });

  it('refuses the real database when "demo" is expected, and the demo one when "real" is expected', () => {
    expect(() => resolveTarget({ TALLY_MCP_DB: realDbFile(), TALLY_MCP_EXPECT: 'demo' })).toThrow(/Refusing to start.*REAL database/);
    expect(() => resolveTarget({ TALLY_MCP_DB: demoDbFile(), TALLY_MCP_EXPECT: 'real' })).toThrow(/Refusing to start.*DEMO database/);
    expect(() => resolveTarget({ TALLY_MCP_DB: realDbFile(), TALLY_MCP_EXPECT: 'test' })).toThrow(/Refusing to start/);
    expect(() => resolveTarget({ TALLY_MCP_DB: demoDbFile(), TALLY_MCP_EXPECT: 'test' })).toThrow(/Refusing to start/);
    expect(() => resolveTarget({ TALLY_MCP_DB: file, TALLY_MCP_EXPECT: 'real' })).toThrow(/neither your real nor your demo/);
    expect(() => resolveTarget({ TALLY_MCP_DB: file, TALLY_MCP_EXPECT: 'demo' })).toThrow(/neither your real nor your demo/);
  });

  it('never creates a database that is not there', () => {
    expect(() => resolveTarget({ TALLY_MCP_DB: join(ok, 'missing.db'), TALLY_MCP_EXPECT: 'test' })).toThrow(/No database at/);
  });

  it('accepts a matching pair and says which it is', () => {
    expect(resolveTarget({ TALLY_MCP_DB: file, TALLY_MCP_EXPECT: 'test' })).toMatchObject({ kind: 'test', label: 'TEST database', dbFile: file });
  });
});

describe('over stdio, as a client starts it (a real child process)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-mcp-stdio-'));
  const dbFile = join(dir, 'tally-test.db');
  const env = { ...process.env, TALLY_MCP_DB: dbFile, TALLY_MCP_EXPECT: 'test' } as Record<string, string>;
  const entry = ['--import', 'tsx', join(process.cwd(), 'src/mcp/main.ts')];

  it('refuses to start with no database named, with a readable message and a non-zero exit', () => {
    const r = spawnSync(process.execPath, entry, { env: { ...process.env, TALLY_MCP_DB: '', TALLY_MCP_EXPECT: '' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/TALLY_MCP_DB is not set/);
    expect(r.stdout).toBe(''); // stdout is the protocol: nothing else may be written to it
  });

  it('refuses a real/demo mix-up before opening anything', () => {
    const r = spawnSync(process.execPath, entry, { env: { ...process.env, TALLY_MCP_DB: realDbFile(), TALLY_MCP_EXPECT: 'demo' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to start/);
  });

  it('refuses a database that needs an upgrade (it never migrates one the app may be using)', () => {
    const old = join(dir, 'old.db');
    writeFileSync(old, '');
    const r = spawnSync(process.execPath, entry, { env: { ...process.env, TALLY_MCP_DB: old, TALLY_MCP_EXPECT: 'test' }, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/needs a database upgrade/);
  });

  it('serves the tools over stdio, prints which database it is, and is read-only until the switch is on', async () => {
    const db = openDb(dbFile);
    createTerm({ db, clock: makeCtx(NOW).clock, tz: 'America/Detroit', defaultTime: '23:59' }, { name: 'Fall 2026', start_date: '2026-08-31', end_date: '2026-12-11' });
    db.close();
    const transport = new StdioClientTransport({ command: process.execPath, args: entry, env, stderr: 'pipe' });
    let stderr = '';
    const c = new Client({ name: 'stdio-test', version: '1' });
    await c.connect(transport);
    transport.stderr?.on('data', (b) => { stderr += String(b); });
    try {
      const tools = (await c.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('add_task');
      const status = JSON.parse(((await c.callTool({ name: 'tally_status', arguments: {} })) as any).content[0].text);
      expect(status.database).toMatchObject({ kind: 'test', path: dbFile });
      expect(status.claudeMayChangeTasks).toBe(false);
      const refused = (await c.callTool({ name: 'add_task', arguments: { title: 'nope' } })) as any;
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toBe(WRITES_OFF);
      // the user turns the switch on in the app (another process, same file, WAL): the running connector sees it at once
      const app = openDb(dbFile);
      app.run("INSERT INTO settings(key, value) VALUES('mcp_allow_writes','true')");
      const added = JSON.parse(((await c.callTool({ name: 'add_task', arguments: { title: 'from claude' } })) as any).content[0].text);
      expect(added.changed).toBe(true);
      expect(app.get<{ title: string }>('SELECT title FROM tasks')!.title).toBe('from claude'); // visible to the "app" connection immediately
      expect(app.get<{ n: number }>('SELECT COUNT(*) n FROM change_log')!.n).toBe(1);
      app.close();
    } finally {
      await c.close();
    }
    expect(stderr).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
