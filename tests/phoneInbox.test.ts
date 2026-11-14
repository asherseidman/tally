import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { openDb } from '../src/db/index';
import { MIGRATIONS } from '../src/db/schema';
import { backupBeforeMigration } from '../src/cli/context';
import { setSetting, getSetting } from '../src/db/repo';
import { FakeReminders } from '../src/phone/fakeReminders';
import { runInbox, reminderToTask, recentImports, undoImport, importedCount, MAX_PER_PASS, MAX_TITLE, INBOX_ENABLED_KEY } from '../src/phone/inbox';
import { runNotifications, loadNotifySettings, checkNotifySetting, type Notice } from '../src/app/notifier';
import { dispatch, inboxTick, type ApiDeps } from '../src/app/api';
import { syntaxCheck, classifyFailure } from '../src/phone/jxaReminders';
import { DENIED_MESSAGE } from '../src/phone/reminders';
import { getTask } from '../src/core/tasks';

// Thursday 2026-11-12 10:00 in Detroit (outside quiet hours)
const NOW = '2026-11-12T15:00:00Z';
const LIST = 'Tally Inbox';
let ctx: Ctx;
let rem: FakeReminders;
let clockMs: number;
const tasks = () => ctx.db.all<{ id: number; title: string; notes: string | null; due_date: string | null; time_assumed: number; deleted_at: string | null }>('SELECT id, title, notes, due_date, time_assumed, deleted_at FROM tasks ORDER BY id');
const on = () => setSetting(ctx.db, INBOX_ENABLED_KEY, 'true');

beforeEach(() => {
  ctx = makeCtx(NOW);
  clockMs = Date.parse(NOW);
  ctx.clock = { now: () => new Date(clockMs) };
  rem = new FakeReminders();
  rem.add(LIST);
  on();
});

describe('importing reminders', () => {
  it('is OFF until switched on (nothing is read, so no permission prompt)', async () => {
    ctx.db.run("DELETE FROM settings WHERE key = ?", [INBOX_ENABLED_KEY]);
    rem.add(LIST, { id: 'a', title: 'x' });
    const r = await runInbox(ctx, rem);
    expect(r).toMatchObject({ ran: false, skipped: 'off' });
    expect(rem.fetchCalls).toBe(0);
    expect(tasks()).toHaveLength(0);
  });

  it('turns each reminder into a task, then (only then) marks the reminder completed', async () => {
    rem.add(LIST, { id: 'r1', title: 'Read chapter 5' }, { id: 'r2', title: 'Buy a stapler' });
    const seenAtComplete: number[] = [];
    const orig = rem.complete.bind(rem);
    rem.complete = async (l, id) => { seenAtComplete.push(tasks().length + (importedRow(id) ? 1000 : 0)); return orig(l, id); };
    const r = await runInbox(ctx, rem);
    expect(r.imported).toBe(2);
    expect(tasks().map((t) => t.title)).toEqual(['Read chapter 5', 'Buy a stapler']);
    // when each completion was asked for, the task AND its id row already existed
    expect(seenAtComplete).toEqual([1001, 1002]);
    expect(rem.completed).toEqual(['r1', 'r2']);
    expect(importedCount(ctx)).toBe(2);
    expect(getSetting(ctx.db, 'phone_inbox_last_check')).toBeTruthy();
    expect(tasks()[0].notes).toContain('Added from your phone');
  });
  const importedRow = (id: string) => ctx.db.get('SELECT 1 FROM reminder_imports WHERE reminder_id = ?', [id]);

  it('parses a trailing date like quick-add, and the reminder\'s own due date wins', async () => {
    rem.add(LIST,
      { id: 'a', title: 'Written homework due friday 5pm' },
      { id: 'b', title: 'Essay draft due friday', dueUtc: '2026-11-20T20:00:00.000Z' },
      { id: 'c', title: 'Call advisor', dueDay: '2026-11-17' });
    await runInbox(ctx, rem);
    const [a, b, c] = tasks();
    expect(a.title).toBe('Written homework');
    expect(a.due_date).toBe('2026-11-13T22:00:00.000Z'); // Fri 5 PM EST
    expect(b.title).toBe('Essay draft'); // the date phrase is still taken out of the title
    expect(b.due_date).toBe('2026-11-20T20:00:00.000Z');
    expect(b.time_assumed).toBe(0);
    expect(c.title).toBe('Call advisor');
    expect(c.due_date).toBe('2026-11-18T04:59:00.000Z'); // 23:59 on Nov 17 in Detroit
    expect(c.time_assumed).toBe(1);
  });

  it('never imports a reminder twice: after a restart (fresh connection to the same database), and when the same id is listed twice', async () => {
    rem.add(LIST, { id: 'r1', title: 'One' }, { id: 'r1', title: 'One again' }, { id: 'r2', title: 'Two' });
    expect((await runInbox(ctx, rem)).imported).toBe(2);
    // the app restarts: new context over the same database, and Reminders still shows both (sync was slow)
    rem.completed = [];
    const restarted: Ctx = { ...ctx, clock: ctx.clock };
    expect((await runInbox(restarted, rem)).imported).toBe(0);
    expect((await runInbox(restarted, rem)).imported).toBe(0);
    expect(tasks()).toHaveLength(2);
  });

  it('keeps the task and the record when marking the reminder completed fails, never imports it again, and retries the completion', async () => {
    rem.add(LIST, { id: 'r1', title: 'Flaky' });
    rem.failComplete = true;
    const r1 = await runInbox(ctx, rem);
    expect(r1).toMatchObject({ imported: 1, completeFailed: 1 });
    expect(r1.status?.message).toMatch(/could not be marked completed/);
    expect(recentImports(ctx)[0].stillOpenOnPhone).toBe(true);
    const r2 = await runInbox(ctx, rem); // still failing: no duplicate
    expect(r2).toMatchObject({ imported: 0, completeFailed: 1 });
    expect(tasks()).toHaveLength(1);
    rem.failComplete = false;
    const r3 = await runInbox(ctx, rem);
    expect(r3).toMatchObject({ imported: 0, retriedComplete: 1 });
    expect(rem.completed).toEqual(['r1']);
    expect(recentImports(ctx)[0].stillOpenOnPhone).toBe(false);
    expect(tasks()).toHaveLength(1);
  });

  it('a reminder that is gone by completion time counts as done (no error, no duplicate)', async () => {
    rem.add(LIST, { id: 'r1', title: 'Vanishes' });
    rem.complete = async () => ({ status: 'gone' });
    expect((await runInbox(ctx, rem)).completeFailed).toBe(0);
    expect(recentImports(ctx)[0].stillOpenOnPhone).toBe(false);
  });
});

describe('bad titles become tasks, never dropped', () => {
  it('empty, control characters, whitespace and a huge title', async () => {
    const huge = 'word '.repeat(2000);
    rem.add(LIST, { id: 'e', title: '' }, { id: 's', title: '   \n  ' }, { id: 'c', title: 'Pay\u0000 rent\u0007 soon' }, { id: 'h', title: huge });
    const r = await runInbox(ctx, rem);
    expect(r.imported).toBe(4);
    const t = tasks();
    expect(t[0]).toMatchObject({ title: '(untitled reminder)', due_date: null });
    expect(t[0].notes).toContain('no title');
    expect(t[1].title).toBe('(untitled reminder)');
    expect(t[2].title).toBe('Pay rent soon');
    expect(t[3].title.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(t[3].notes).toContain('The full text from your phone was');
    expect(t[3].notes!.length).toBeLessThan(5000);
  });

  it('a title the date parser rejects still becomes a dateless task with a note', () => {
    const bad: Ctx = { ...ctx, tz: 'Not/AZone' };
    const made = reminderToTask(bad, { id: 'x', title: 'Do the thing friday', notes: null, dueUtc: null, dueDay: null, createdUtc: null });
    expect(made.title).toBe('Do the thing friday');
    expect(made.dueUtc).toBeNull();
    expect(made.notes).toContain('could not read a date');
  });

  it('keeps the reminder\'s own notes', async () => {
    rem.add(LIST, { id: 'n', title: 'With notes', notes: 'bring the blue folder' });
    await runInbox(ctx, rem);
    expect(tasks()[0].notes).toContain('bring the blue folder');
  });
});

describe('permission and list problems', () => {
  it('denied: a clear message, nothing imported, background passes wait for Retry, Retry works once allowed', async () => {
    rem.add(LIST, { id: 'r1', title: 'Waiting' });
    rem.deny = true;
    const r = await runInbox(ctx, rem);
    expect(r.imported).toBe(0);
    expect(r.status).toMatchObject({ state: 'denied' });
    expect(r.status!.message).toBe(DENIED_MESSAGE);
    expect(r.status!.message).toMatch(/System Settings/);
    const calls = rem.fetchCalls;
    expect((await runInbox(ctx, rem)).skipped).toBe('blocked'); // the minute timer does not keep poking macOS
    expect(rem.fetchCalls).toBe(calls);
    rem.deny = false;
    const retry = await runInbox(ctx, rem, { force: true }); // the Retry button
    expect(retry.imported).toBe(1);
    expect(retry.status?.state).toBe('ok');
  });

  it('missing list: says so; never creates or reads another list', async () => {
    const other = new FakeReminders();
    other.add('Groceries', { id: 'g', title: 'milk' });
    setSetting(ctx.db, 'phone_inbox_list', 'Nope');
    const r = await runInbox(ctx, other);
    expect(r.status).toMatchObject({ state: 'missing_list' });
    expect(tasks()).toHaveLength(0);
    expect(other.completed).toEqual([]);
  });

  it('only ever touches the named list', async () => {
    rem.add('Groceries', { id: 'g1', title: 'milk' });
    rem.add(LIST, { id: 'r1', title: 'Mine' });
    await runInbox(ctx, rem);
    expect(tasks().map((t) => t.title)).toEqual(['Mine']);
    expect(rem.completeCalls.every((c) => c.startsWith(`${LIST}:`))).toBe(true);
    expect(rem.completed).toEqual(['r1']);
  });

  it('a custom list name is used', async () => {
    rem.add('School stuff', { id: 'x', title: 'Hello' });
    setSetting(ctx.db, 'phone_inbox_list', 'School stuff');
    expect((await runInbox(ctx, rem)).imported).toBe(1);
  });

  it('osascript failures are classified (not authorized = denied)', () => {
    expect(classifyFailure('execution error: Not authorized to send Apple events to Reminders. (-1743)').status).toBe('denied');
    expect(classifyFailure('execution error: Reminders got an error: Application isn\'t running. (-600)').status).toBe('error');
    expect(classifyFailure('x\n-1712').message).toMatch(/did not answer/);
  });
});

describe('huge lists', () => {
  it('imports at most 50 per pass, the rest on the next passes, in the order they were created, with nothing lost or doubled', async () => {
    for (let i = 0; i < 130; i++) rem.add(LIST, { id: `id${i}`, title: `Item ${i}` });
    const r1 = await runInbox(ctx, rem);
    expect(r1.imported).toBe(MAX_PER_PASS);
    expect(r1.waiting).toBe(80);
    expect((await runInbox(ctx, rem)).imported).toBe(50);
    const r3 = await runInbox(ctx, rem);
    expect(r3).toMatchObject({ imported: 30, waiting: 0 });
    expect(tasks()).toHaveLength(130);
    expect(new Set(tasks().map((t) => t.title)).size).toBe(130);
    expect((await runInbox(ctx, rem)).imported).toBe(0);
  });

  it('reads at most 500 reminders from a list of thousands', async () => {
    for (let i = 0; i < 1200; i++) rem.add(LIST, { id: `b${i}`, title: `T${i}` });
    const r = await runInbox(ctx, rem);
    expect(r.imported).toBe(50);
    expect(r.waiting).toBe(1150);
  });
});

describe('Undo and the Inbox panel', () => {
  it('lists recent additions; Undo removes the task and the reminder is NOT imported again', async () => {
    rem.add(LIST, { id: 'r1', title: 'Oops' });
    await runInbox(ctx, rem);
    const [item] = recentImports(ctx);
    expect(item).toMatchObject({ reminderId: 'r1', canUndo: true, undone: false, noDate: true });
    undoImport(ctx, 'r1');
    expect(getTask(ctx, item.taskId)).toBeUndefined(); // soft-deleted
    expect(recentImports(ctx)[0]).toMatchObject({ undone: true, canUndo: false });
    rem.completed = [];
    expect((await runInbox(ctx, rem)).imported).toBe(0);
    expect(() => undoImport(ctx, 'r1')).toThrow(/already undone/);
    expect(() => undoImport(ctx, 'zzz')).toThrow(/not in the inbox/);
    // it is in the shared change history
    expect(ctx.db.get<{ actor: string }>("SELECT actor FROM change_log WHERE actor = 'phone'")).toBeTruthy();
  });

  it('refuses to undo if the task was edited since (nothing overwritten)', async () => {
    rem.add(LIST, { id: 'r1', title: 'Edited later' });
    await runInbox(ctx, rem);
    ctx.db.run("UPDATE tasks SET title = 'changed by hand'");
    expect(() => undoImport(ctx, 'r1')).toThrow(/changed again/);
  });
});

describe('the app layer', () => {
  const app = (): ApiDeps => ({ ctx, dbFile: ':memory:', demo: true, backupFolder: '/nonexistent', hooks: { reminders: rem, openPrivacyPane: () => { opened++; } }, calendar: () => { throw new Error('no calendar'); } });
  let opened = 0;
  beforeEach(() => { opened = 0; });
  const ok = async (ch: string, args?: unknown) => { const r = await dispatch(app(), ch, args); if (!r.ok) throw new Error((r as { error: string }).error); return r.value as any; };

  it('inbox.get / inbox.check / inbox.undo / inbox.openPrivacy', async () => {
    rem.add(LIST, { id: 'r1', title: 'From phone due friday' });
    const before = await ok('inbox.get');
    expect(before).toMatchObject({ enabled: true, list: LIST, defaultList: 'Tally Inbox', state: null, imported: 0, canOpenPane: true });
    const c = await ok('inbox.check');
    expect(c.pass.imported).toBe(1);
    expect(c).toMatchObject({ state: 'ok', imported: 1 });
    expect(c.recent[0]).toMatchObject({ title: 'From phone', canUndo: true });
    expect(c.recent[0].dueText).toMatch(/Fri Nov 13/);
    const u = await ok('inbox.undo', { reminderId: 'r1' });
    expect(u.recent[0].undone).toBe(true);
    await ok('inbox.openPrivacy');
    expect(opened).toBe(1);
  });

  it('Check now works even with the switch off (and Retry after a denial)', async () => {
    ctx.db.run("DELETE FROM settings WHERE key = ?", [INBOX_ENABLED_KEY]);
    rem.add(LIST, { id: 'r1', title: 'Manual check' });
    expect((await ok('inbox.check')).pass.imported).toBe(1);
  });

  it('the settings channel validates the switch and the list name, and clears the old status', async () => {
    rem.deny = true;
    await ok('inbox.check');
    expect((await ok('inbox.get')).state).toBe('denied');
    await ok('settings.set', { key: 'phone_inbox_enabled', value: 'true' });
    expect((await ok('inbox.get')).state).toBeNull();
    await expect(ok('settings.set', { key: 'phone_inbox_enabled', value: 'maybe' })).rejects.toThrow(/on or off/);
    await expect(ok('settings.set', { key: 'phone_inbox_list', value: '   ' })).rejects.toThrow(/empty/);
    await expect(ok('settings.set', { key: 'phone_inbox_list', value: 'x'.repeat(101) })).rejects.toThrow(/too long/);
    await ok('settings.set', { key: 'phone_inbox_list', value: ' Home ' });
    expect((await ok('inbox.get')).list).toBe('Home');
    await ok('settings.reset', { key: 'phone_inbox_list' });
    expect((await ok('inbox.get')).list).toBe('Tally Inbox');
  });

  it('no Reminders source (not the Mac app) gives a readable error', async () => {
    const d = { ...app(), hooks: {} };
    const r = await dispatch(d, 'inbox.check', undefined);
    expect(r.ok).toBe(false);
    await inboxTick(d); // does nothing, no throw
  });

  it('inboxTick runs only while switched on', async () => {
    rem.add(LIST, { id: 'r1', title: 'Timer pass' });
    await inboxTick(app());
    expect(tasks()).toHaveLength(1);
  });
});

describe('notification when items arrive', () => {
  const run = (): Notice[] => { const got: Notice[] = []; runNotifications(ctx, (n) => got.push(n)); return got; };
  it('is on by default, validated, announced once with titles and opens Today', async () => {
    expect(loadNotifySettings(ctx).phoneInbox).toBe(true);
    expect(checkNotifySetting('notify_phone_inbox', 'off')).toBe('false');
    rem.add(LIST, { id: 'a', title: 'One' }, { id: 'b', title: 'Two' });
    await runInbox(ctx, rem);
    const got = run().filter((n) => n.kind === 'phone');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ target: 'today', title: '2 items added from your phone' });
    expect(got[0].body).toContain('“One”');
    expect(run().filter((n) => n.kind === 'phone')).toHaveLength(0); // not repeated
    rem.add(LIST, { id: 'c', title: 'Three' });
    await runInbox(ctx, rem);
    expect(run().filter((n) => n.kind === 'phone')[0].title).toBe('Added from your phone');
  });

  it('is held back during quiet hours and delivered afterwards', async () => {
    rem.add(LIST, { id: 'a', title: 'Late night' });
    clockMs = Date.parse('2026-11-13T05:00:00Z'); // midnight in Detroit
    await runInbox(ctx, rem);
    expect(run().filter((n) => n.kind === 'phone')).toHaveLength(0);
    clockMs = Date.parse('2026-11-13T14:00:00Z'); // 9 AM
    expect(run().filter((n) => n.kind === 'phone')).toHaveLength(1);
  });

  it('switched off: nothing is shown now and nothing is saved up for later', async () => {
    setSetting(ctx.db, 'notify_phone_inbox', 'false');
    rem.add(LIST, { id: 'a', title: 'Quiet' });
    await runInbox(ctx, rem);
    expect(run().filter((n) => n.kind === 'phone')).toHaveLength(0);
    setSetting(ctx.db, 'notify_phone_inbox', 'true');
    expect(run().filter((n) => n.kind === 'phone')).toHaveLength(0);
  });

  it('a failing delivery is retried', async () => {
    rem.add(LIST, { id: 'a', title: 'Retry me' });
    await runInbox(ctx, rem);
    expect(() => runNotifications(ctx, () => { throw new Error('boom'); })).not.toThrow();
    expect(run().filter((n) => n.kind === 'phone')).toHaveLength(1);
  });
});

describe('schema v7 migration', () => {
  it('takes a verified backup first, keeps every row and adds reminder_imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig7-'));
    const file = join(dir, 'planner.db');
    const raw = new BetterSqlite3(file);
    for (let v = 0; v < 6; v++) raw.exec(MIGRATIONS[v]);
    raw.pragma('user_version = 6');
    raw.exec("INSERT INTO tasks(id,title,created_at,updated_at) VALUES(1,'a','x','x')");
    raw.close();
    const backups = join(dir, 'bk');
    const saved = await backupBeforeMigration(file, backups);
    expect(saved).toBeTruthy();
    expect(readdirSync(backups).some((n) => /^pre-migration-v6-to-v\d+-/.test(n))).toBe(true);
    const db = openDb(file);
    expect(db.get<{ v: number }>('SELECT user_version v FROM pragma_user_version')!.v).toBe(MIGRATIONS.length);
    expect(db.get('SELECT title FROM tasks')).toEqual({ title: 'a' });
    db.run("INSERT INTO reminder_imports(reminder_id,list_name,task_id,title,imported_at) VALUES('r','L',1,'a','x')");
    expect(() => db.run("INSERT INTO reminder_imports(reminder_id,list_name,task_id,title,imported_at) VALUES('r','L',1,'a','x')")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.run("INSERT INTO reminder_imports(reminder_id,list_name,task_id,title,imported_at) VALUES('q','L',99,'a','x')")).toThrow(/FOREIGN KEY/);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the real Reminders script', () => {
  it.runIf(process.platform === 'darwin')('compiles and receives its argument under the real osascript WITHOUT opening Reminders', async () => {
    expect(await syntaxCheck()).toContain('syntax-ok');
  });
  it('the test files never construct the real source', () => {
    // this file imports JxaReminders only for syntaxCheck/classifyFailure; no test builds a JxaReminders instance
    expect(typeof syntaxCheck).toBe('function');
  });
});
