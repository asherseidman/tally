import { describe, it, expect } from 'vitest';
import { makeCtx } from './helpers';
import { fixedClock } from '../src/clock';
import { createTerm } from '../src/core/terms';
import { addTask, completeTask, deleteTask, editTask } from '../src/core/tasks';
import { setSetting } from '../src/db/repo';
import { runNotifications, inQuietHours, loadNotifySettings, checkNotifySetting, NOTIFY_DEFAULTS, type Notice } from '../src/app/notifier';
import type { Ctx } from '../src/core/ctx';

// Tue Nov 10 2026, 12:00 PM Detroit (EST) = 17:00Z
const T0 = '2026-11-10T17:00:00Z';
const at = (ctx: Ctx, iso: string) => { ctx.clock = fixedClock(iso); };
function setup(now = T0) {
  const ctx = makeCtx(now);
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  const sent: Notice[] = [];
  const run = (extra?: { backupError?: string | null }) => runNotifications(ctx, (n) => sent.push(n), extra);
  const block = (taskId: number, startIso: string, minutes = 45) => {
    const end = new Date(new Date(startIso).getTime() + minutes * 60_000).toISOString();
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [taskId, new Date(startIso).toISOString(), end]);
  };
  return { ctx, sent, run, block };
}

describe('quiet hours', () => {
  const s = { ...NOTIFY_DEFAULTS, quietEnabled: true, quietStart: '23:00', quietEnd: '08:00' };
  const q = (iso: string, over = {}) => inQuietHours(new Date(iso), 'America/Detroit', { ...s, ...over });
  it('a window that crosses midnight (default 11 PM to 8 AM), in the configured time zone', () => {
    expect(q('2026-11-11T04:30:00Z')).toBe(true);   // 11:30 PM EST
    expect(q('2026-11-11T07:00:00Z')).toBe(true);   // 2:00 AM
    expect(q('2026-11-11T12:59:00Z')).toBe(true);   // 7:59 AM
    expect(q('2026-11-11T13:00:00Z')).toBe(false);  // 8:00 AM: over
    expect(q('2026-11-10T17:00:00Z')).toBe(false);  // noon
    expect(q('2026-11-11T03:59:00Z')).toBe(false);  // 10:59 PM
    expect(q('2026-11-11T04:00:00Z')).toBe(true);   // 11:00 PM exactly
  });
  it('a same-day window, and switched off', () => {
    expect(q('2026-11-10T19:00:00Z', { quietStart: '13:00', quietEnd: '15:00' })).toBe(true);  // 2 PM
    expect(q('2026-11-10T21:00:00Z', { quietStart: '13:00', quietEnd: '15:00' })).toBe(false); // 4 PM
    expect(q('2026-11-11T07:00:00Z', { quietEnabled: false })).toBe(false);
  });
  it('uses the time zone: the same instant is quiet in one zone and not in another', () => {
    const inst = new Date('2026-11-11T05:00:00Z'); // midnight Detroit, 9 PM Los Angeles
    expect(inQuietHours(inst, 'America/Detroit', s)).toBe(true);
    expect(inQuietHours(inst, 'America/Los_Angeles', s)).toBe(false);
  });
});

describe('settings', () => {
  it('defaults: all four on, quiet hours on, 11 PM to 8 AM', () => {
    const { ctx } = setup();
    expect(loadNotifySettings(ctx)).toEqual({ blocks: true, dueSoon: true, backupFailure: true, claudeApply: true, phoneInbox: true, quietEnabled: true, quietStart: '23:00', quietEnd: '08:00', delivery: 'auto', blockLeadMinutes: 10 });
  });
  it('values are validated and normalized', () => {
    expect(checkNotifySetting('notify_blocks', 'off')).toBe('false');
    expect(checkNotifySetting('notify_quiet_start', '7:05')).toBe('07:05');
    expect(() => checkNotifySetting('notify_quiet_start', '25:00')).toThrow(/HH:mm/);
    expect(() => checkNotifySetting('notify_blocks', 'maybe')).toThrow(/true or false/);
    expect(() => checkNotifySetting('nope', '1')).toThrow();
  });
});

describe('block notifications', () => {
  it('fires once when a block is 10 minutes (or less) away, not before, not after it started', () => {
    const { ctx, sent, run, block } = setup();
    const t = addTask(ctx, { title: 'WeBWorK 7', course: 'MATH 214', type: 'homework', due: '2026-11-15T23:59' });
    block(t.id, '2026-11-10T17:20:00Z'); // 12:20 PM: 20 minutes away
    run();
    expect(sent).toEqual([]);
    at(ctx, '2026-11-10T17:09:00Z'); // 11 minutes before
    run();
    expect(sent).toEqual([]);
    at(ctx, '2026-11-10T17:10:00Z'); // 10 minutes before
    run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'block', taskId: t.id });
    expect(sent[0].title).toMatch(/Starting in 10 min/);
    expect(sent[0].title).toContain('MATH 214: WeBWorK 7');
    expect(sent[0].body).toMatch(/12:20.*PM/);
    at(ctx, '2026-11-10T17:15:00Z');
    run();
    expect(sent).toHaveLength(1); // never twice for the same block
    at(ctx, '2026-11-10T17:25:00Z'); // started
    run();
    expect(sent).toHaveLength(1);
  });
  it('says how many minutes are left when the app only notices late', () => {
    const { ctx, sent, run, block } = setup();
    const t = addTask(ctx, { title: 'X', type: 'homework' });
    block(t.id, '2026-11-10T17:20:00Z');
    at(ctx, '2026-11-10T17:16:00Z');
    run();
    expect(sent[0].title).toMatch(/Starting in 4 min/);
  });
  it('none for a done or deleted task, and none when the type is switched off', () => {
    const { ctx, sent, run, block } = setup();
    const a = addTask(ctx, { title: 'Done one', type: 'homework' });
    const b = addTask(ctx, { title: 'Deleted one', type: 'homework' });
    const c = addTask(ctx, { title: 'Live one', type: 'homework' });
    for (const t of [a, b, c]) block(t.id, '2026-11-10T17:08:00Z');
    completeTask(ctx, a.id);
    deleteTask(ctx, b.id);
    setSetting(ctx.db, 'notify_blocks', 'false');
    run();
    expect(sent).toEqual([]);
    setSetting(ctx.db, 'notify_blocks', 'true');
    run();
    expect(sent.map((n) => n.taskId)).toEqual([c.id]);
  });
  it('quiet hours hold it back; it is delivered once quiet hours end if the block is still ahead', () => {
    const { ctx, sent, run, block } = setup('2026-11-11T12:55:00Z'); // 7:55 AM Detroit: quiet
    const t = addTask(ctx, { title: 'Early', type: 'homework' });
    block(t.id, '2026-11-11T13:05:00Z'); // 8:05 AM
    run();
    expect(sent).toEqual([]);
    at(ctx, '2026-11-11T13:00:00Z'); // 8:00 AM: quiet is over, block starts in 5 minutes
    run();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toMatch(/Starting in 5 min/);
  });
  it('a block that started during quiet hours is simply never notified', () => {
    const { ctx, sent, run, block } = setup('2026-11-11T12:50:00Z'); // 7:50 AM
    const t = addTask(ctx, { title: 'Early', type: 'homework' });
    block(t.id, '2026-11-11T12:58:00Z'); // 7:58 AM
    run();
    at(ctx, '2026-11-11T13:05:00Z');
    run();
    expect(sent).toEqual([]);
  });
});

describe('due-soon notifications', () => {
  it('a task inside the Due soon window is announced once, with its due time', () => {
    const { ctx, sent, run } = setup();
    const t = addTask(ctx, { title: 'Essay', course: 'ENG 100', type: 'homework', due: '2026-11-11T17:00' }); // 29h away
    run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'due', taskId: t.id });
    expect(sent[0].title).toContain('Essay');
    expect(sent[0].body).toMatch(/due in/);
    run();
    run();
    expect(sent).toHaveLength(1);
  });
  it('does not repeat after a restart (what was sent is stored in the database)', () => {
    const { ctx, sent, run } = setup();
    addTask(ctx, { title: 'Essay', type: 'homework', due: '2026-11-11T17:00' });
    run();
    const again: Notice[] = [];
    runNotifications(ctx, (n) => again.push(n)); // a new "session" on the same database
    expect(sent).toHaveLength(1);
    expect(again).toEqual([]);
  });
  it('uses the Due soon window setting; outside it, overdue, and undated tasks are not announced', () => {
    const { ctx, sent, run } = setup();
    addTask(ctx, { title: 'Far', type: 'homework', due: '2026-11-15T17:00' });      // 5 days
    addTask(ctx, { title: 'Overdue', type: 'homework', due: '2026-11-09T17:00' });  // yesterday
    addTask(ctx, { title: 'Undated', type: 'homework' });
    run();
    expect(sent).toEqual([]);
    setSetting(ctx.db, 'views_due_soon_hours', '168'); // a week
    run();
    expect(sent.map((n) => n.title.includes('Far'))).toEqual([true]);
  });
  it('none for done tasks, even if done after it became due soon', () => {
    const { ctx, sent, run } = setup();
    const a = addTask(ctx, { title: 'Done early', type: 'homework', due: '2026-11-11T17:00' });
    completeTask(ctx, a.id);
    run();
    expect(sent).toEqual([]);
  });
  it('a changed due date is a new thing to announce; the same date is not', () => {
    const { ctx, sent, run } = setup();
    const t = addTask(ctx, { title: 'Essay', type: 'homework', due: '2026-11-11T17:00' });
    run();
    editTask(ctx, t.id, { due: '2026-11-12T17:00' });
    run();
    expect(sent).toHaveLength(2);
    run();
    expect(sent).toHaveLength(2);
  });
  it('a pile of tasks becomes ONE summary, and none of them is announced again', () => {
    const { ctx, sent, run } = setup();
    for (let i = 1; i <= 6; i++) addTask(ctx, { title: `Task ${i}`, type: 'homework', due: `2026-11-1${1 + (i % 2)}T1${i}:00` });
    run();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('6 tasks are due soon');
    expect(sent[0].body).toMatch(/and 3 more/);
    run();
    expect(sent).toHaveLength(1);
    addTask(ctx, { title: 'Late addition', type: 'homework', due: '2026-11-12T10:00' });
    run();
    expect(sent).toHaveLength(2);
    expect(sent[1].title).toContain('Late addition');
  });
  it('is switched off by its own setting, and held during quiet hours, then delivered', () => {
    const { ctx, sent, run } = setup('2026-11-11T05:00:00Z'); // midnight Detroit: quiet
    addTask(ctx, { title: 'Essay', type: 'homework', due: '2026-11-11T17:00' });
    run();
    expect(sent).toEqual([]);
    at(ctx, '2026-11-11T13:00:00Z'); // 8 AM
    setSetting(ctx.db, 'notify_due_soon', 'false');
    run();
    expect(sent).toEqual([]);
    setSetting(ctx.db, 'notify_due_soon', 'true');
    run();
    expect(sent).toHaveLength(1); // not lost while it was held back
  });
});

describe('backup failure notifications', () => {
  it('announces a failure once per day, and not when switched off', () => {
    const { ctx, sent, run } = setup();
    run({ backupError: 'disk full' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'backup', title: 'Backup failed' });
    expect(sent[0].body).toContain('disk full');
    run({ backupError: 'disk full' });
    expect(sent).toHaveLength(1);
    at(ctx, '2026-11-11T17:00:00Z'); // the next day: still failing, tell them again
    run({ backupError: 'disk full' });
    expect(sent).toHaveLength(2);
    setSetting(ctx.db, 'notify_backup_failure', 'false');
    at(ctx, '2026-11-12T17:00:00Z');
    run({ backupError: 'disk full' });
    expect(sent).toHaveLength(2);
  });
  it('no failure, no notification; and quiet hours defer it', () => {
    const { ctx, sent, run } = setup('2026-11-11T05:00:00Z');
    run({ backupError: null });
    expect(sent).toEqual([]);
    run({ backupError: 'folder missing' });
    expect(sent).toEqual([]);
    at(ctx, '2026-11-11T13:30:00Z');
    run({ backupError: 'folder missing' });
    expect(sent).toHaveLength(1);
  });
});

describe('delivery problems', () => {
  it('if showing a notification fails it is not marked as sent, so it is tried again', () => {
    const { ctx } = setup();
    addTask(ctx, { title: 'Essay', type: 'homework', due: '2026-11-11T17:00' });
    let fail = true;
    const shown: Notice[] = [];
    const deliver = (n: Notice) => { if (fail) throw new Error('no permission'); shown.push(n); };
    expect(() => runNotifications(ctx, deliver)).not.toThrow();
    expect(shown).toEqual([]);
    fail = false;
    runNotifications(ctx, deliver);
    expect(shown).toHaveLength(1);
  });
  it('the sent list is pruned so it cannot grow forever', () => {
    const { ctx, run } = setup();
    ctx.db.run("INSERT INTO settings(key, value) VALUES('notify_sent', ?)", [JSON.stringify({ old: '2026-09-01T00:00:00.000Z', recent: '2026-11-09T00:00:00.000Z' })]);
    run();
    const kept = JSON.parse(ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'notify_sent'")!.value);
    expect(Object.keys(kept)).toEqual(['recent']);
  });
});
