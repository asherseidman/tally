import { mkdirSync, readdirSync, renameSync, rmSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import type { Ctx } from './ctx';
import type { Clock } from '../clock';
import { checkDatabaseFile, backupDatabaseFile, makeSelfContained } from '../db/index';

export const KEEP_BACKUPS = 14;
const NAME_RE = /^planner-(\d{8})-(\d{6})\.db$/;

const fileStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, '').replace('T', '-');

export interface BackupInfo {
  name: string;
  path: string;
  /** When the backup was taken, parsed from its UTC file name. */
  takenAt: Date;
  bytes: number;
}

export interface BackupResult {
  path: string;
  name: string;
  verified: boolean;
  bytes: number;
}

export function verifyBackup(path: string) {
  return checkDatabaseFile(path);
}

/** Newest first. Only files named planner-YYYYMMDD-HHMMSS.db are considered ours. */
export function listBackups(folder: string): BackupInfo[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .map((name) => ({ name, m: NAME_RE.exec(name) }))
    .filter((x) => x.m)
    .map(({ name, m }) => {
      const [, d, t] = m!;
      const takenAt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`);
      const path = join(folder, name);
      return { name, path, takenAt, bytes: statSync(path).size };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

export function pruneBackups(folder: string, keep = KEEP_BACKUPS): string[] {
  const removed: string[] = [];
  for (const b of listBackups(folder).slice(keep)) {
    rmSync(b.path);
    removed.push(b.name);
  }
  return removed;
}

/**
 * Online backup via SQLite's backup API into a temp file, verified with an integrity check
 * BEFORE it is moved into place, so a bad backup never looks like a good one.
 */
export async function createBackup(ctx: Ctx, folder: string): Promise<BackupResult> {
  mkdirSync(folder, { recursive: true });
  // Names have one-second resolution. If a backup already has this name (e.g. the daily backup and a
  // post-import backup in the same second), bump the stamp so the earlier backup is never overwritten.
  let when = ctx.clock.now();
  let name = `planner-${fileStamp(when)}.db`;
  while (existsSync(join(folder, name))) {
    when = new Date(when.getTime() + 1000);
    name = `planner-${fileStamp(when)}.db`;
  }
  const final = join(folder, name);
  const tmp = join(folder, `.${name}.tmp`);
  rmSync(tmp, { force: true });
  await ctx.db.backup(tmp);
  makeSelfContained(tmp);
  const check = verifyBackup(tmp);
  if (!check.ok) {
    rmSync(tmp, { force: true });
    throw new Error(`BACKUP FAILED VERIFICATION (${final}): ${check.detail}`);
  }
  renameSync(tmp, final);
  return { path: final, name, verified: true, bytes: statSync(final).size };
}

/** Make a backup if none exists yet for today's LOCAL date, then prune to the newest 14. */
export async function autoBackupIfDue(ctx: Ctx, folder: string, keep = KEEP_BACKUPS): Promise<{ ran: boolean; backup?: BackupResult; pruned: string[] }> {
  const today = DateTime.fromJSDate(ctx.clock.now(), { zone: ctx.tz }).toISODate();
  const has = listBackups(folder).some((b) => DateTime.fromJSDate(b.takenAt, { zone: ctx.tz }).toISODate() === today);
  if (has) return { ran: false, pruned: [] };
  const backup = await createBackup(ctx, folder);
  return { ran: true, backup, pruned: pruneBackups(folder, keep) };
}

/** Nothing to protect if the import wrote nothing (e.g. re-importing an unchanged file). */
export const shouldBackupAfterImport = (r: { inserted: number; updated: number }): boolean => r.inserted + r.updated > 0;

/** Imports are the biggest data changes: always take a fresh verified backup right after one is written. */
export async function backupAfterImport(ctx: Ctx, folder: string, keep = KEEP_BACKUPS): Promise<{ backup: BackupResult; pruned: string[] }> {
  const backup = await createBackup(ctx, folder);
  return { backup, pruned: pruneBackups(folder, keep) };
}

/**
 * Replace the live database with a backup. The backup is verified first; the current
 * database is saved as pre-restore-*.db (also via the backup API) before anything changes.
 * The caller must have closed its connection to `livePath`.
 */
export async function restoreBackup(livePath: string, backupPath: string, backupFolder: string, clock: Clock): Promise<{ safetyBackup?: string }> {
  const check = verifyBackup(backupPath);
  if (!check.ok) throw new Error(`Refusing to restore: backup failed integrity check (${check.detail}). Live database untouched.`);

  let safetyBackup: string | undefined;
  if (existsSync(livePath)) {
    mkdirSync(backupFolder, { recursive: true });
    safetyBackup = join(backupFolder, `pre-restore-${fileStamp(clock.now())}.db`);
    try {
      await backupDatabaseFile(livePath, safetyBackup);
    } catch (e) {
      // Live DB unreadable: fall back to preserving the raw file so nothing is lost.
      copyFileSync(livePath, safetyBackup);
    }
  }
  const staged = `${livePath}.restoring`;
  copyFileSync(backupPath, staged);
  for (const suffix of ['-wal', '-shm']) rmSync(livePath + suffix, { force: true });
  renameSync(staged, livePath);
  const after = checkDatabaseFile(livePath);
  if (!after.ok) throw new Error(`Restore completed but the database failed its integrity check: ${after.detail}`);
  return { safetyBackup };
}
