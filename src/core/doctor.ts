import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DateTime } from 'luxon';
import type { Ctx } from './ctx';
import { checkDatabaseFile } from '../db/index';
import { getSetting } from '../db/repo';
import { currentTerm } from './terms';
import { listBackups, verifyBackup } from './backup';
import { assertTimezone } from '../time';

export interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface DoctorOptions {
  ctx: Ctx;
  dbFile: string;
  backupFolder: string;
  /** true only if the user set backup_folder; the built-in default lives next to the database. */
  backupFolderConfigured: boolean;
  /** identifies the disk/volume a path is on; injectable for tests */
  deviceOf?: (path: string) => string | number;
}

/** A backup older than this is stale (the daily backup should have run). */
export const STALE_BACKUP_HOURS = 36;

const CLOUD_HINTS = ['Mobile Documents', 'CloudDocs', 'CloudStorage', 'Dropbox', 'OneDrive', 'Google Drive', 'GoogleDrive', 'iCloud', 'Box Sync', 'pCloud', 'Sync.com'];

/** Heuristic only: a path inside a well-known sync client's folder. It cannot prove syncing works. */
export function looksCloudSynced(path: string): boolean {
  return CLOUD_HINTS.some((h) => path.includes(h));
}

const defaultDeviceOf = (p: string) => statSync(p).dev;

function checkDatabase(o: DoctorOptions): Check {
  const r = checkDatabaseFile(o.dbFile);
  return r.ok
    ? { name: 'Database', status: 'pass', detail: `opens and passes integrity check (${o.dbFile})` }
    : { name: 'Database', status: 'fail', detail: `${r.detail} (${o.dbFile})` };
}

function checkFolder(o: DoctorOptions): Check {
  const name = 'Backup folder';
  if (!o.backupFolderConfigured) {
    return { name, status: 'fail', detail: `not set; using the default ${o.backupFolder}, which is on the same disk as your database. Set one: npm run plan -- config set backup_folder <path to a cloud-synced folder>` };
  }
  try {
    mkdirSync(o.backupFolder, { recursive: true });
    const probe = join(o.backupFolder, `.doctor-${process.pid}.tmp`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
  } catch (e) {
    return { name, status: 'fail', detail: `not writable: ${(e as Error).message}` };
  }
  const cloud = looksCloudSynced(o.backupFolder);
  try {
    const dev = o.deviceOf ?? defaultDeviceOf;
    if (dev(o.backupFolder) === dev(dirname(o.dbFile)) && !cloud) {
      return { name, status: 'warn', detail: `writable, but on the same disk as the database and not in a recognized cloud-sync folder, so losing this disk loses your backups too (${o.backupFolder})` };
    }
  } catch {
    // device comparison is best-effort
  }
  return { name, status: 'pass', detail: `writable${cloud ? ', in a cloud-synced folder (sync itself is not verified)' : ', on a different disk'}: ${o.backupFolder}` };
}

function checkLastBackup(o: DoctorOptions): Check {
  const name = 'Last backup';
  const latest = listBackups(o.backupFolder)[0];
  if (!latest) return { name, status: 'fail', detail: `no backups found in ${o.backupFolder}. Run: npm run backup` };
  const v = verifyBackup(latest.path);
  if (!v.ok) return { name, status: 'fail', detail: `${latest.name} FAILED its integrity check: ${v.detail}` };
  const hours = (o.ctx.clock.now().getTime() - latest.takenAt.getTime()) / 3_600_000;
  const when = DateTime.fromJSDate(latest.takenAt, { zone: o.ctx.tz }).toFormat('ccc LLL d yyyy h:mm a');
  return hours > STALE_BACKUP_HOURS
    ? { name, status: 'warn', detail: `${when} (${Math.floor(hours)}h ago): older than ${STALE_BACKUP_HOURS}h` }
    : { name, status: 'pass', detail: `${when} (${Math.max(0, Math.floor(hours))}h ago), integrity ok` };
}

function checkTerm(o: DoctorOptions): Check {
  const t = currentTerm(o.ctx);
  return t
    ? { name: 'Current term', status: 'pass', detail: `"${t.name}" (${t.start_date}..${t.end_date})` }
    : { name: 'Current term', status: 'fail', detail: 'no current term. Create one: term new <name> --start D --end D --current, or term use <name>' };
}

function checkTimezone(o: DoctorOptions): Check {
  const tz = getSetting(o.ctx.db, 'timezone');
  if (!tz) return { name: 'Timezone', status: 'fail', detail: 'not set. Run: config set timezone America/Detroit' };
  try {
    assertTimezone(tz);
    return { name: 'Timezone', status: 'pass', detail: tz };
  } catch (e) {
    return { name: 'Timezone', status: 'fail', detail: (e as Error).message };
  }
}

export function runDoctor(o: DoctorOptions): Check[] {
  return [checkDatabase(o), checkFolder(o), checkLastBackup(o), checkTerm(o), checkTimezone(o)];
}

export const hasFailures = (cs: Check[]) => cs.some((c) => c.status === 'fail');
