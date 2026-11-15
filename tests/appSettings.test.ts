import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers';
import { createTerm } from '../src/core/terms';
import { addTask, completeTask } from '../src/core/tasks';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { dispatch, CHANNELS, type ApiDeps } from '../src/app/api';
import type { AppHooks } from '../src/app/settingsApi';
import { openDb } from '../src/db/index';
import { loadScheduleSettings } from '../src/schedule/params';
import { loadWorkingHours, saveWorkingHoursJson } from '../src/schedule/settings';
import { loadViewSettings } from '../src/core/views';

function deps(hooks?: AppHooks): ApiDeps {
  const folder = mkdtempSync(join(tmpdir(), 'set-'));
  const ctx = makeCtx('2026-11-09T14:00:00Z');
  ctx.db = openDb(join(folder, 'p.db'));
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  const cal = new FakeCalendar({ calendars: [] });
  return { ctx, dbFile: join(folder, 'p.db'), demo: true, backupFolder: join(folder, 'backups'), hooks, calendar: () => ({ calendar: cal }) };
}
const ok = async (d: ApiDeps, ch: string, args?: unknown) => {
  const r = await dispatch(d, ch, args);
  if (!r.ok) throw new Error(r.error);
  return r.value as any;
};
const fail = async (d: ApiDeps, ch: string, args?: unknown) => {
  const r = await dispatch(d, ch, args);
  if (r.ok) throw new Error('expected an error');
  return r.error;
};

describe('settings api', () => {
  it('exposes the settings channels', () => {
    for (const c of ['settings.get', 'settings.set', 'settings.reset', 'terms.list', 'terms.create', 'terms.switch', 'terms.archive', 'terms.unarchive', 'terms.archived', 'backups.list', 'backups.now', 'backups.restore', 'google.status', 'google.connect']) expect(CHANNELS).toContain(c);
  });

  it('general: timezone and default due time are validated, saved and take effect immediately', async () => {
    const d = deps();
    expect((await ok(d, 'settings.get')).general).toEqual({ timezone: 'America/Detroit', defaultDueTime: '23:59', quickAddShortcut: 'CommandOrControl+Shift+Space', quickAddShortcutDefault: 'CommandOrControl+Shift+Space', quickAddShortcutActive: null, trayText: 'full', theme: 'system', colorScheme: expect.objectContaining({ id: 'blue-maize', custom: false }) });
    expect(await fail(d, 'settings.set', { key: 'timezone', value: 'Mars/Olympus' })).toMatch(/Invalid IANA timezone/);
    expect(await fail(d, 'settings.set', { key: 'default_due_time', value: '25:00' })).toMatch(/HH:mm/);
    const v = await ok(d, 'settings.set', { key: 'timezone', value: 'America/Chicago' });
    expect(v.general.timezone).toBe('America/Chicago');
    expect(d.ctx.tz).toBe('America/Chicago');
    await ok(d, 'settings.set', { key: 'default_due_time', value: '9:00' });
    expect(d.ctx.defaultTime).toBe('09:00');
    // a new task with a date and no time now uses the new default, in the new zone
    const t = addTask(d.ctx, { title: 'x', due: '2026-12-01' });
    expect(t.due_date).toBe('2026-12-01T15:00:00.000Z');
  });

  it('scheduling: values come back with default/custom flags, are validated like config set, and reach the scheduler', async () => {
    const d = deps();
    const s = await ok(d, 'settings.get');
    const min = s.scheduling.find((x: any) => x.key === 'min_block_minutes');
    expect(min).toMatchObject({ value: '25', default: '25', custom: false });
    expect(s.scheduling.find((x: any) => x.key === 'placement_style')).toMatchObject({ value: 'early', kind: 'choice' });
    expect(await fail(d, 'settings.set', { key: 'max_block_minutes', value: 'abc' })).toMatch(/whole number/);
    expect(await fail(d, 'settings.set', { key: 'min_block_minutes', value: '3' })).toMatch(/at least 5/);
    expect(await fail(d, 'settings.set', { key: 'placement_style', value: 'sideways' })).toMatch(/early.*late/);
    expect(await fail(d, 'settings.set', { key: 'min_block_minutes', value: '150' })).toMatch(/cannot be longer/);
    expect(await fail(d, 'settings.set', { key: 'not_a_setting', value: '1' })).toMatch(/not a setting/);
    await ok(d, 'settings.set', { key: 'min_block_minutes', value: '15' });
    await ok(d, 'settings.set', { key: 'max_block_minutes', value: '90' });
    await ok(d, 'settings.set', { key: 'placement_style', value: 'late' });
    const eff = loadScheduleSettings(d.ctx, loadWorkingHours(d.ctx).hours);
    expect(eff.hours.min_block_minutes).toBe(15);
    expect(eff.hours.max_block_minutes).toBe(90);
    expect(eff.placement.placement_style).toBe('late');
    const after = (await ok(d, 'settings.get')).scheduling.find((x: any) => x.key === 'min_block_minutes');
    expect(after).toMatchObject({ value: '15', custom: true });
    const reset = await ok(d, 'settings.reset', { key: 'min_block_minutes' });
    expect(reset.scheduling.find((x: any) => x.key === 'min_block_minutes')).toMatchObject({ value: '25', custom: false });
  });

  it('"default" is what applies after a reset, including a value from the saved routine (working_hours JSON)', async () => {
    const d = deps();
    saveWorkingHoursJson(d.ctx, { ...JSON.parse(readFileSync(join(__dirname, '..', 'samples', 'working-hours.json'), 'utf8')), min_block_minutes: 15 });
    const before = (await ok(d, 'settings.get')).scheduling.find((x: any) => x.key === 'min_block_minutes');
    expect(before).toMatchObject({ value: '15', default: '15', custom: false });
    await ok(d, 'settings.set', { key: 'min_block_minutes', value: '20' });
    const reset = (await ok(d, 'settings.reset', { key: 'min_block_minutes' })).scheduling.find((x: any) => x.key === 'min_block_minutes');
    expect(reset).toMatchObject({ value: '15', custom: false });
  });

  it('priority constants are the same settings the views read, with defaults and the formula', async () => {
    const d = deps();
    const s = await ok(d, 'settings.get');
    expect(s.priority.map((x: any) => x.key)).toEqual(expect.arrayContaining(['impact_urgency_days', 'impact_effort_hours', 'impact_default_minutes', 'impact_limit']));
    expect(s.priority.find((x: any) => x.key === 'impact_urgency_days')).toMatchObject({ value: '7', default: '7' });
    expect(s.formula).toMatch(/urgency half-life/);
    expect(await fail(d, 'settings.set', { key: 'impact_urgency_days', value: '0' })).toMatch(/positive/);
    await ok(d, 'settings.set', { key: 'impact_urgency_days', value: '3' });
    expect(loadViewSettings(d.ctx).impactUrgencyDays).toBe(3);
  });

  it('backup folder: created, saved, reported to the main process; reset goes back to the default', async () => {
    const moved: string[] = [];
    const d = deps({ setBackupFolder: (f) => moved.push(f) });
    const target = join(mkdtempSync(join(tmpdir(), 'bk-')), 'nested', 'folder');
    const s = await ok(d, 'settings.set', { key: 'backup_folder', value: target });
    expect(existsSync(target)).toBe(true);
    expect(s).toMatchObject({ backupFolder: target, backupFolderIsDefault: false });
    expect(moved).toEqual([target]);
    const r = await ok(d, 'settings.reset', { key: 'backup_folder' });
    expect(r.backupFolderIsDefault).toBe(true);
    expect(moved[1]).toMatch(/backups-demo$/);
  });
});

describe('quick-add shortcut setting', () => {
  it('is validated, normalized, offered to the system, and only saved if the system accepts it', async () => {
    const registered: string[] = [];
    let refuse = false;
    const d = deps({ setShortcut: (a) => { if (refuse) throw new Error('That shortcut is already in use by another app.'); registered.push(a); } });
    expect(await fail(d, 'settings.set', { key: 'quick_add_shortcut', value: 'Space' })).toMatch(/modifier/);
    expect(await fail(d, 'settings.set', { key: 'quick_add_shortcut', value: 'Command+Banana' })).toMatch(/Unknown key/);
    expect(registered).toEqual([]);
    const v = await ok(d, 'settings.set', { key: 'quick_add_shortcut', value: 'ctrl+alt+k' });
    expect(v.general.quickAddShortcut).toBe('Control+Alt+K');
    expect(registered).toEqual(['Control+Alt+K']);
    refuse = true;
    expect(await fail(d, 'settings.set', { key: 'quick_add_shortcut', value: 'Command+Shift+J' })).toMatch(/already in use/);
    expect((await ok(d, 'settings.get')).general.quickAddShortcut).toBe('Control+Alt+K'); // unchanged
    refuse = false;
    const off = await ok(d, 'settings.set', { key: 'quick_add_shortcut', value: '' });
    expect(off.general.quickAddShortcut).toBe('');
    expect(registered.at(-1)).toBe('');
    const back = await ok(d, 'settings.reset', { key: 'quick_add_shortcut' });
    expect(back.general.quickAddShortcut).toBe('CommandOrControl+Shift+Space');
    expect(registered.at(-1)).toBe('CommandOrControl+Shift+Space');
  });
});

describe('appearance (theme) setting', () => {
  it('system by default; light and dark are accepted and applied to the windows; reset goes back to system', async () => {
    const applied: string[] = [];
    const d = deps({ setTheme: (t) => { applied.push(t); } });
    expect((await ok(d, 'settings.get')).general.theme).toBe('system');
    expect(await fail(d, 'settings.set', { key: 'theme', value: 'sepia' })).toMatch(/system, light or dark/);
    expect((await ok(d, 'settings.set', { key: 'theme', value: 'dark' })).general.theme).toBe('dark');
    expect((await ok(d, 'settings.set', { key: 'theme', value: 'light' })).general.theme).toBe('light');
    expect((await ok(d, 'settings.reset', { key: 'theme' })).general.theme).toBe('system');
    expect(applied).toEqual(['dark', 'light', 'system']);
  });
});

describe('menu bar text setting', () => {
  it('full by default; elapsed and none are accepted; anything else is explained; the main process is told', async () => {
    let refreshed = 0;
    const d = deps({ trayRefresh: () => { refreshed++; } });
    expect((await ok(d, 'settings.get')).general.trayText).toBe('full');
    expect(await fail(d, 'settings.set', { key: 'tray_text', value: 'huge' })).toMatch(/full, elapsed or none/);
    expect((await ok(d, 'settings.set', { key: 'tray_text', value: 'elapsed' })).general.trayText).toBe('elapsed');
    expect((await ok(d, 'settings.set', { key: 'tray_text', value: 'none' })).general.trayText).toBe('none');
    expect((await ok(d, 'settings.reset', { key: 'tray_text' })).general.trayText).toBe('full');
    expect(refreshed).toBe(3);
  });
});

describe('notification settings and actions', () => {
  it('eight settings with defaults (all on, quiet 23:00 to 08:00), validated and resettable', async () => {
    const d = deps();
    const n = (await ok(d, 'settings.get')).notifications;
    expect(n.map((x: any) => [x.key, x.value])).toEqual([
      ['notify_blocks', 'true'], ['notify_due_soon', 'true'], ['notify_backup_failure', 'true'], ['notify_claude_apply', 'true'], ['notify_phone_inbox', 'true'],
      ['notify_quiet_enabled', 'true'], ['notify_quiet_start', '23:00'], ['notify_quiet_end', '08:00'], ['notify_delivery', 'auto'],
    ]);
    expect(await fail(d, 'settings.set', { key: 'notify_delivery', value: 'carrier-pigeon' })).toMatch(/auto, both or app/);
    expect((await ok(d, 'settings.set', { key: 'notify_delivery', value: 'app' })).notifications.at(-1).value).toBe('app');
    expect(await fail(d, 'settings.set', { key: 'notify_quiet_start', value: '25:00' })).toMatch(/HH:mm/);
    expect(await fail(d, 'settings.set', { key: 'notify_blocks', value: 'maybe' })).toMatch(/true or false/);
    expect(await fail(d, 'settings.set', { key: 'notify_quiet_start', value: '08:00' })).toMatch(/cannot start and end at the same time/);
    let v = await ok(d, 'settings.set', { key: 'notify_due_soon', value: 'false' });
    expect(v.notifications.find((x: any) => x.key === 'notify_due_soon')).toMatchObject({ value: 'false', custom: true });
    v = await ok(d, 'settings.set', { key: 'notify_quiet_start', value: '22:30' });
    expect(v.notifications.find((x: any) => x.key === 'notify_quiet_start').value).toBe('22:30');
    v = await ok(d, 'settings.reset', { key: 'notify_due_soon' });
    expect(v.notifications.find((x: any) => x.key === 'notify_due_soon')).toMatchObject({ value: 'true', custom: false });
  });
  it('test/check/recent go through the main process hooks, and say so when there are none', async () => {
    expect(await fail(deps(), 'notifications.test')).toMatch(/only available in the app window/);
    expect(await ok(deps(), 'notifications.recent')).toEqual([]);
    const calls: string[] = [];
    const d = deps({
      notifyTest: async () => { calls.push('test'); return { id: 1, at: 'x', kind: 'test' as const, title: 'Test notification', body: '', supported: true, showCalled: true, events: [], error: null, reason: null, outcome: 'shown' as const, banner: false }; },
      notifyCheck: () => { calls.push('check'); return [{ key: 'k', kind: 'due', title: 'T', body: 'B' }]; },
      notifyRecent: () => [{ id: 1, at: '2026-11-10T17:00:00.000Z', kind: 'test' as const, title: 'Test notification', body: 'x', supported: true, showCalled: true, events: [], error: null, reason: null, outcome: 'no-event' as const, banner: true }],
      banners: () => [{ id: 1, at: 'x', kind: 'test', title: 'Test notification', body: 'x' }],
      dismissBanner: (id: number) => { calls.push(`dismiss ${id}`); },
    });
    expect((await ok(d, 'notifications.test')).outcome).toBe('shown');
    expect((await ok(d, 'notifications.check')).length).toBe(1);
    expect((await ok(d, 'notifications.recent'))[0].title).toBe('Test notification');
    expect((await ok(d, 'banners.list'))[0].title).toBe('Test notification');
    await ok(d, 'banners.dismiss', { id: 1 });
    expect(calls).toEqual(['test', 'check', 'dismiss 1']);
    expect(await ok(deps(), 'banners.list')).toEqual([]);
  });
});

describe('terms api', () => {
  it('create, switch, archive, unarchive; counts per term; invalid input is explained', async () => {
    const d = deps();
    expect(await fail(d, 'terms.create', { name: 'Bad', start: '2026-13-01', end: '2026-12-01' })).toMatch(/real dates/);
    expect(await fail(d, 'terms.create', { name: 'Bad', start: '2027-05-01', end: '2027-01-01' })).toMatch(/before its start/);
    expect(await fail(d, 'terms.create', { name: 'fall', start: '2027-01-01', end: '2027-05-01' })).toMatch(/already exists/);
    let rows = await ok(d, 'terms.create', { name: 'Winter', start: '2027-01-05', end: '2027-04-25' });
    expect(rows.map((t: any) => [t.name, t.current])).toEqual([['Fall', true], ['Winter', false]]);
    rows = await ok(d, 'terms.switch', { name: 'Winter' });
    expect(rows.find((t: any) => t.name === 'Winter').current).toBe(true);
    expect((await ok(d, 'app.info')).terms.find((t: any) => t.is_current).name).toBe('Winter');
    const t = addTask(d.ctx, { title: 'Old HW', term: 'Fall', type: 'homework' });
    const t2 = addTask(d.ctx, { title: 'Old done', term: 'Fall' });
    completeTask(d.ctx, t2.id);
    rows = await ok(d, 'terms.archive', { name: 'Fall' });
    expect(rows.find((x: any) => x.name === 'Fall')).toMatchObject({ archived: true, current: false, open: 1, done: 1 });
    expect(await fail(d, 'terms.switch', { name: 'Fall' })).toMatch(/archived/);
    rows = await ok(d, 'terms.unarchive', { name: 'Fall' });
    expect(rows.find((x: any) => x.name === 'Fall').archived).toBe(false);
    void t;
  });

  it('the archived-terms browser is read-only: it lists an archived term\'s tasks and refuses a live term', async () => {
    const d = deps();
    const a = addTask(d.ctx, { title: 'Open one', term: 'Fall' });
    const b = addTask(d.ctx, { title: 'Done one', term: 'Fall' });
    completeTask(d.ctx, b.id);
    await ok(d, 'terms.create', { name: 'Winter', start: '2027-01-05', end: '2027-04-25', makeCurrent: true });
    const fall = (await ok(d, 'terms.list')).find((t: any) => t.name === 'Fall');
    expect(await fail(d, 'terms.archived', { id: fall.id })).toMatch(/not archived/);
    await ok(d, 'terms.archive', { name: 'Fall' });
    const r = await ok(d, 'terms.archived', { id: fall.id });
    expect(r.term.archived).toBe(true);
    expect(r.tasks.map((t: any) => [t.title, t.status]).sort()).toEqual([['Done one', 'done'], ['Open one', 'todo']]);
    // not in the normal views, and viewing changed nothing
    expect((await ok(d, 'tasks.list', {})).some((t: any) => t.id === a.id)).toBe(false);
    expect(d.ctx.db.get<any>("SELECT COUNT(*) c FROM tasks WHERE status = 'done'").c).toBe(1);
  });
});

describe('backups api', () => {
  it('lists, creates a verified backup on demand', async () => {
    const d = deps();
    expect((await ok(d, 'backups.list')).backups).toEqual([]);
    const v = await ok(d, 'backups.now');
    expect(v.backups.length).toBe(1);
    expect(v.backups[0].name).toMatch(/^planner-\d{8}-\d{6}\.db$/);
    expect(v.folderExists).toBe(true);
  });

  it('restore needs the typed word, only accepts files in the backup folder, verifies, then asks the main process to swap', async () => {
    const calls: string[] = [];
    const d = deps({ restore: async (p) => { calls.push(p); return { safetyBackup: '/x/pre-restore-1.db' }; } });
    const v = await ok(d, 'backups.now');
    const name = v.backups[0].name;
    expect(await fail(d, 'backups.restore', { name, typed: 'yes' })).toMatch(/Type the word "restore"/);
    expect(await fail(d, 'backups.restore', { name: '../../etc/passwd', typed: 'restore' })).toMatch(/not a backup in your backup folder/);
    expect(await fail(d, 'backups.restore', { name: 'planner-20200101-000000.db', typed: 'restore' })).toMatch(/No backup named/);
    expect(calls).toEqual([]);
    // a corrupt file with a backup-shaped name is refused before anything is touched
    writeFileSync(join(v.folder, 'planner-20990101-000000.db'), 'not a database');
    expect(await fail(d, 'backups.restore', { name: 'planner-20990101-000000.db', typed: 'restore' })).toMatch(/integrity check/);
    expect(calls).toEqual([]);
    const r = await ok(d, 'backups.restore', { name, typed: 'restore' });
    expect(calls).toEqual([join(v.folder, name)]);
    expect(r.message).toMatch(/Restored .* saved first as pre-restore-1\.db/);
  });

  it('restoring is refused where the window cannot swap the database', async () => {
    const d = deps();
    const v = await ok(d, 'backups.now');
    expect(await fail(d, 'backups.restore', { name: v.backups[0].name, typed: 'restore' })).toMatch(/only available in the app window/);
  });
});

describe('google api', () => {
  it('without hooks it explains (demo: nothing to connect); with hooks it passes through', async () => {
    const d = deps();
    expect((await ok(d, 'google.status')).message).toMatch(/simulated/);
    const g = deps({ google: {
      status: async () => ({ demo: false, clientFile: '/c.json', clientFileFound: true, connected: false, message: 'Not connected.' }),
      check: async () => ({ demo: false, clientFile: '/c.json', clientFileFound: true, connected: true, message: 'ok' }),
      connect: async () => ({ demo: false, clientFile: '/c.json', clientFileFound: true, connected: true, message: 'Connected.' }),
      disconnect: async () => ({ demo: false, clientFile: '/c.json', clientFileFound: true, connected: false, message: 'Removed.' }),
    } });
    expect((await ok(g, 'google.status')).connected).toBe(false);
    expect((await ok(g, 'google.connect')).connected).toBe(true);
    expect((await ok(g, 'google.disconnect')).message).toBe('Removed.');
  });
});
