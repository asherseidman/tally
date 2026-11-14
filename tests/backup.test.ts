import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index';
import { fixedClock } from '../src/clock';
import { createBackup, pruneBackups, autoBackupIfDue, listBackups, verifyBackup, restoreBackup } from '../src/core/backup';
import { createTerm } from '../src/core/terms';
import { addTask } from '../src/core/tasks';
import type { Ctx } from '../src/core/ctx';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'planner-bk-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fileCtx(now = '2026-09-01T16:00:00Z'): Ctx & { path: string } {
  const path = join(dir, 'live.db');
  return { path, db: openDb(path), clock: fixedClock(now), tz: 'America/Detroit', defaultTime: '23:59' };
}

describe('backup', () => {
  it('creates a verified backup including archived-term data', async () => {
    const ctx = fileCtx();
    createTerm(ctx, { name: 'A', start_date: '2026-08-31', end_date: '2026-12-11' });
    addTask(ctx, { title: 'secret', course: 'X' });
    ctx.db.run("UPDATE terms SET archived_at = '2026-09-01', is_current = 0");
    const b = await createBackup(ctx, join(dir, 'bk'));
    expect(b.verified).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    const copy = openDb(b.path);
    expect(copy.get<any>('SELECT COUNT(*) c FROM tasks').c).toBe(1);
    expect(copy.get<any>('SELECT COUNT(*) c FROM terms WHERE archived_at IS NOT NULL').c).toBe(1);
    copy.close();
  });
  it('verifyBackup detects a corrupt file', () => {
    const bad = join(dir, 'planner-20260101-000000.db');
    writeFileSync(bad, 'this is not a database'.repeat(100));
    const r = verifyBackup(bad);
    expect(r.ok).toBe(false);
  });
  it('prunes to the newest N and ignores unrelated files', async () => {
    const ctx = fileCtx();
    const bk = join(dir, 'bk');
    for (let i = 1; i <= 20; i++) {
      (ctx as any).clock = fixedClock(`2026-09-${String(i).padStart(2, '0')}T12:00:00Z`);
      await createBackup(ctx, bk);
    }
    writeFileSync(join(bk, 'notes.txt'), 'keep me');
    const removed = pruneBackups(bk, 14);
    expect(removed).toHaveLength(6);
    const left = listBackups(bk);
    expect(left).toHaveLength(14);
    expect(left[0].name).toContain('20260920'); // newest first
    expect(readdirSync(bk)).toContain('notes.txt');
  });
  it('auto backup runs once per local day', async () => {
    const ctx = fileCtx('2026-09-01T16:00:00Z');
    const bk = join(dir, 'bk');
    expect((await autoBackupIfDue(ctx, bk)).ran).toBe(true);
    expect((await autoBackupIfDue(ctx, bk)).ran).toBe(false);
    (ctx as any).clock = fixedClock('2026-09-02T16:00:00Z');
    expect((await autoBackupIfDue(ctx, bk)).ran).toBe(true);
    expect(listBackups(bk)).toHaveLength(2);
  });
  it('"day" is the local day, not UTC (11 PM and 1 AM local are different days)', async () => {
    const ctx = fileCtx('2026-09-02T03:00:00Z'); // Sep 1 11 PM EDT
    const bk = join(dir, 'bk');
    await autoBackupIfDue(ctx, bk);
    (ctx as any).clock = fixedClock('2026-09-02T05:00:00Z'); // Sep 2 1 AM EDT
    expect((await autoBackupIfDue(ctx, bk)).ran).toBe(true);
  });
  it('restore replaces the live database, after taking a safety backup', async () => {
    const ctx = fileCtx();
    createTerm(ctx, { name: 'A', start_date: '2026-08-31', end_date: '2026-12-11' });
    addTask(ctx, { title: 'original' });
    const bk = join(dir, 'bk');
    const b = await createBackup(ctx, bk);
    ctx.db.run("UPDATE tasks SET title = 'changed'");
    ctx.db.run("INSERT INTO tasks(title, created_at, updated_at) VALUES('extra','x','x')");
    ctx.db.close();
    const r = await restoreBackup(ctx.path, b.path, bk, ctx.clock);
    expect(r.safetyBackup).toBeTruthy();
    const db = openDb(ctx.path);
    expect(db.all<any>('SELECT title FROM tasks').map((x) => x.title)).toEqual(['original']);
    db.close();
    const safety = openDb(r.safetyBackup!);
    expect(safety.get<any>('SELECT COUNT(*) c FROM tasks').c).toBe(2);
    safety.close();
  });
  it('restore refuses a corrupt backup and leaves the live DB untouched', async () => {
    const ctx = fileCtx();
    addTask(ctx, { title: 'keep' });
    ctx.db.close();
    const bad = join(dir, 'planner-20260101-000000.db');
    writeFileSync(bad, 'garbage'.repeat(500));
    await expect(restoreBackup(ctx.path, bad, join(dir, 'bk'), ctx.clock)).rejects.toThrow(/integrity|not a valid|corrupt/i);
    const db = openDb(ctx.path);
    expect(db.get<any>('SELECT COUNT(*) c FROM tasks').c).toBe(1);
    db.close();
  });
});

import { backupAfterImport } from '../src/core/backup';

describe('backup around imports', () => {
  it('two backups in the same second never overwrite each other', async () => {
    const ctx = fileCtx();
    const bk = join(dir, 'bk');
    const a = await createBackup(ctx, bk);
    const b = await createBackup(ctx, bk);
    expect(a.path).not.toBe(b.path);
    expect(listBackups(bk)).toHaveLength(2);
    expect(listBackups(bk)[0].path).toBe(b.path); // newest first
  });
  it('post-import backup is taken even when today already has one, and contains the imported data', async () => {
    const ctx = fileCtx();
    const bk = join(dir, 'bk');
    expect((await autoBackupIfDue(ctx, bk)).ran).toBe(true); // the day's backup, before the import
    createTerm(ctx, { name: 'A', start_date: '2026-08-31', end_date: '2026-12-11' });
    addTask(ctx, { title: 'imported', course: 'X' });
    const post = await backupAfterImport(ctx, bk);
    expect(post.backup.verified).toBe(true);
    const all = listBackups(bk);
    expect(all).toHaveLength(2);
    const count = (p: string) => { const d = openDb(p); const n = d.get<any>('SELECT COUNT(*) c FROM tasks').c; d.close(); return n; };
    expect(count(all[1].path)).toBe(0); // before import
    expect(count(all[0].path)).toBe(1); // after import
  });
  it('post-import backup also prunes to the newest 14', async () => {
    const ctx = fileCtx();
    const bk = join(dir, 'bk');
    for (let i = 1; i <= 15; i++) {
      (ctx as any).clock = fixedClock(`2026-09-${String(i).padStart(2, '0')}T12:00:00Z`);
      await createBackup(ctx, bk);
    }
    (ctx as any).clock = fixedClock('2026-09-20T12:00:00Z');
    const r = await backupAfterImport(ctx, bk);
    expect(listBackups(bk)).toHaveLength(14);
    expect(r.pruned.length).toBe(2);
  });
});

describe('backup files are self-contained', () => {
  it('leaves exactly one .db file per backup: no -wal/-shm/tmp litter, even after verifying', async () => {
    const ctx = fileCtx();
    createTerm(ctx, { name: 'A', start_date: '2026-08-31', end_date: '2026-12-11' });
    const bk = join(dir, 'bk');
    const b = await createBackup(ctx, bk);
    verifyBackup(b.path);
    expect(readdirSync(bk)).toEqual([b.name]);
  });
});

import { shouldBackupAfterImport } from '../src/core/backup';

describe('shouldBackupAfterImport', () => {
  it('only when something was actually written', () => {
    expect(shouldBackupAfterImport({ inserted: 3, updated: 0 })).toBe(true);
    expect(shouldBackupAfterImport({ inserted: 0, updated: 2 })).toBe(true);
    expect(shouldBackupAfterImport({ inserted: 0, updated: 0 })).toBe(false);
  });
});
