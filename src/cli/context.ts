import { dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { openDb, hasPendingMigration, schemaVersionOf, backupDatabaseFile, makeSelfContained, checkDatabaseFile } from '../db/index';
import { MIGRATIONS } from '../db/schema';
import { dbPath } from '../paths';
import { getSetting } from '../db/repo';
import { systemClock } from '../clock';
import { autoBackupIfDue } from '../core/backup';
import type { Ctx } from '../core/ctx';
import { syncSizeEstimates } from '../core/size';

export interface CliContext {
  ctx: Ctx;
  dbFile: string;
  backupFolder: string;
  demo: boolean;
  /** set when today's automatic backup failed (the app announces it as a notification) */
  backupError?: string;
  close(): void;
}

/** Configured folder, else a default NEXT TO the database file (so a PLANNER_DB override stays self-contained). */
export function backupFolderFor(setting: string | undefined, dbFile: string, demo: boolean): string {
  return setting || join(dirname(dbFile), demo ? 'backups-demo' : 'backups');
}

/**
 * A schema migration rewrites tables, so an existing database gets a verified backup first. If the user configured
 * a backup folder it is used (read from the file itself, before migrating); the backup is checked before the
 * migration is allowed to run.
 */
export async function backupBeforeMigration(dbFile: string, fallbackFolder: string): Promise<string | undefined> {
  if (!hasPendingMigration(dbFile)) return undefined;
  const from = schemaVersionOf(dbFile)!;
  const configured = configuredBackupFolder(dbFile);
  const folder = configured ?? fallbackFolder;
  mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, '').replace('T', '-');
  const final = join(folder, `pre-migration-v${from}-to-v${MIGRATIONS.length}-${stamp}.db`);
  const tmp = `${final}.tmp`;
  rmSync(tmp, { force: true });
  await backupDatabaseFile(dbFile, tmp);
  makeSelfContained(tmp);
  const check = checkDatabaseFile(tmp);
  if (!check.ok) {
    rmSync(tmp, { force: true });
    throw new Error(`Pre-migration backup failed its integrity check (${check.detail}); the database was NOT migrated.`);
  }
  renameSync(tmp, final);
  console.error(`(pre-migration backup saved and verified: ${final})`);
  return final;
}

function configuredBackupFolder(dbFile: string): string | undefined {
  const raw = new BetterSqlite3(dbFile, { readonly: true, fileMustExist: true });
  try {
    const row = raw.prepare("SELECT value FROM settings WHERE key = 'backup_folder'").get() as { value: string } | undefined;
    return row?.value || undefined;
  } catch {
    return undefined;
  } finally {
    raw.close();
  }
}

/** Opens the database and runs the once-a-day automatic backup. Backup failures are loud but never block the command. */
export async function openContext(demo: boolean): Promise<CliContext> {
  const dbFile = dbPath(demo);
  await backupBeforeMigration(dbFile, backupFolderFor(undefined, dbFile, demo));
  const db = openDb(dbFile);
  const ctx: Ctx = {
    db,
    clock: systemClock,
    tz: getSetting(db, 'timezone') ?? 'America/Detroit',
    defaultTime: getSetting(db, 'default_due_time') ?? '23:59',
  };
  const backupFolder = backupFolderFor(getSetting(db, 'backup_folder'), dbFile, demo);
  let backupError: string | undefined;
  try {
    const r = await autoBackupIfDue(ctx, backupFolder);
    if (r.ran) console.error(`(daily backup saved: ${r.backup!.path})`);
  } catch (e) {
    backupError = (e as Error).message;
    const bar = '!'.repeat(70);
    console.error(`\n${bar}\n!! DAILY BACKUP FAILED: ${(e as Error).message}\n!! Folder: ${backupFolder}\n!! Your data is NOT backed up today. Fix this or run: npm run backup\n${bar}\n`);
  }
  syncSizeEstimates(ctx);
  return { ctx, dbFile, backupFolder, demo, backupError, close: () => db.close() };
}
