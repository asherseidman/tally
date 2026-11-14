import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index';
import { fixedClock } from '../src/clock';
import { createBackup } from '../src/core/backup';
import { createTerm } from '../src/core/terms';
import { runDoctor, hasFailures, looksCloudSynced, type DoctorOptions } from '../src/core/doctor';
import type { Ctx } from '../src/core/ctx';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'planner-doc-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = '2026-09-01T16:00:00Z';
function setup(over: Partial<DoctorOptions> = {}, withTerm = true) {
  const dbFile = join(dir, 'live.db');
  const ctx: Ctx = { db: openDb(dbFile), clock: fixedClock(NOW), tz: 'America/Detroit', defaultTime: '23:59' };
  if (withTerm) createTerm(ctx, { name: 'A', start_date: '2026-08-31', end_date: '2026-12-11' });
  const opts: DoctorOptions = { ctx, dbFile, backupFolder: join(dir, 'bk'), backupFolderConfigured: true, deviceOf: (p) => (p.startsWith(join(dir, 'bk')) ? 'other-disk' : 'main-disk'), ...over };
  return { ctx, opts };
}
const get = (cs: ReturnType<typeof runDoctor>, name: RegExp) => cs.find((c) => name.test(c.name))!;

describe('doctor', () => {
  it('all pass on a healthy setup', async () => {
    const { ctx, opts } = setup();
    await createBackup(ctx, opts.backupFolder);
    const cs = runDoctor(opts);
    expect(cs.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(hasFailures(cs)).toBe(false);
  });
  it('fails when the database file is corrupt', () => {
    const { opts } = setup();
    const bad = join(dir, 'junk.db');
    writeFileSync(bad, 'junk'.repeat(1000));
    expect(get(runDoctor({ ...opts, dbFile: bad }), /database/i).status).toBe('fail');
  });
  it('fails when no backup folder has been configured', () => {
    const { opts } = setup({ backupFolderConfigured: false });
    const c = get(runDoctor(opts), /backup folder/i);
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/config set backup_folder/);
  });
  it('fails when the backup folder is not writable', () => {
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, 'x');
    const { opts } = setup({ backupFolder: join(blocker, 'sub') });
    expect(get(runDoctor(opts), /backup folder/i).status).toBe('fail');
  });
  it('warns when the folder is on the same disk and not cloud-synced', () => {
    const { opts } = setup({ deviceOf: () => 'same' });
    const c = get(runDoctor(opts), /backup folder/i);
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/same disk/i);
  });
  it('same volume is fine when the folder looks cloud-synced', () => {
    const cloud = join(dir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'planner-backups');
    mkdirSync(cloud, { recursive: true });
    const { opts } = setup({ backupFolder: cloud, deviceOf: () => 'same' });
    expect(get(runDoctor(opts), /backup folder/i).status).toBe('pass');
  });
  it('recognizes common cloud-sync paths', () => {
    expect(looksCloudSynced('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/b')).toBe(true);
    expect(looksCloudSynced('/Users/x/Library/CloudStorage/GoogleDrive-a@b/My Drive/b')).toBe(true);
    expect(looksCloudSynced('/Users/x/Dropbox/b')).toBe(true);
    expect(looksCloudSynced('/Users/x/OneDrive - School/b')).toBe(true);
    expect(looksCloudSynced('/Users/x/Documents/b')).toBe(false);
  });
  it('last backup: fails when none, warns when stale, passes when recent', async () => {
    const { ctx, opts } = setup();
    expect(get(runDoctor(opts), /last backup/i).status).toBe('fail');
    (ctx as any).clock = fixedClock('2026-08-28T12:00:00Z');
    await createBackup(ctx, opts.backupFolder);
    (ctx as any).clock = fixedClock(NOW);
    expect(get(runDoctor(opts), /last backup/i).status).toBe('warn');
    await createBackup(ctx, opts.backupFolder);
    expect(get(runDoctor(opts), /last backup/i).status).toBe('pass');
  });
  it('last backup fails if the newest backup fails its integrity check', async () => {
    const { ctx, opts } = setup();
    const b = await createBackup(ctx, opts.backupFolder);
    writeFileSync(b.path, 'corrupted'.repeat(500));
    const c = get(runDoctor(opts), /last backup/i);
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/integrity/i);
  });
  it('fails with no current term', () => {
    const { opts } = setup({}, false);
    expect(get(runDoctor(opts), /term/i).status).toBe('fail');
  });
  it('fails on an invalid or missing timezone', () => {
    const { ctx, opts } = setup();
    ctx.db.run("UPDATE settings SET value = 'Mars/Base' WHERE key = 'timezone'");
    expect(get(runDoctor(opts), /timezone/i).status).toBe('fail');
    ctx.db.run("DELETE FROM settings WHERE key = 'timezone'");
    expect(get(runDoctor(opts), /timezone/i).status).toBe('fail');
  });
});

describe('hasFailures', () => {
  it('warnings alone are not failures', () => {
    expect(hasFailures([{ name: 'x', status: 'warn', detail: '' }])).toBe(false);
    expect(hasFailures([{ name: 'x', status: 'fail', detail: '' }])).toBe(true);
  });
});
