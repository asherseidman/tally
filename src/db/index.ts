import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { MIGRATIONS } from './schema';

/** The only database surface the rest of the app sees. better-sqlite3 stays behind it. */
export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: unknown[] | Record<string, unknown>): { changes: number; lastInsertRowid: number };
  get<T = any>(sql: string, params?: unknown[] | Record<string, unknown>): T | undefined;
  all<T = any>(sql: string, params?: unknown[] | Record<string, unknown>): T[];
  transaction<T>(fn: () => T): T;
  /** Online backup (never a raw file copy). */
  backup(destPath: string): Promise<void>;
  close(): void;
}

class SqliteDb implements Db {
  constructor(private db: BetterSqlite3.Database) {}
  exec(sql: string) {
    this.db.exec(sql);
  }
  run(sql: string, params: unknown[] | Record<string, unknown> = []) {
    const r = this.db.prepare(sql).run(params as any);
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }
  get<T>(sql: string, params: unknown[] | Record<string, unknown> = []) {
    return this.db.prepare(sql).get(params as any) as T | undefined;
  }
  all<T>(sql: string, params: unknown[] | Record<string, unknown> = []) {
    return this.db.prepare(sql).all(params as any) as T[];
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  async backup(destPath: string) {
    await this.db.backup(destPath);
  }
  close() {
    this.db.close();
  }
}

/** Open (and migrate) a database. Use ':memory:' for tests. */
export function openDb(path: string): Db {
  const raw = new BetterSqlite3(path);
  if (path !== ':memory:') raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000'); // another process (the app, the CLI, the Claude connector) may hold the write lock for a moment
  const db = new SqliteDb(raw);
  migrate(raw);
  raw.pragma('foreign_keys = ON');
  return db;
}

/** Schema version of an existing database file, without opening it for writing or migrating it. undefined = no such file. */
export function schemaVersionOf(path: string): number | undefined {
  if (path === ':memory:' || !existsSync(path)) return undefined;
  const raw = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    return raw.pragma('user_version', { simple: true }) as number;
  } finally {
    raw.close();
  }
}

/** True when the file exists, is not brand new, and has migrations still to run. */
export const hasPendingMigration = (path: string): boolean => {
  const v = schemaVersionOf(path);
  return v !== undefined && v > 0 && v < MIGRATIONS.length;
};

/** Foreign keys are off while migrating (table rebuilds need that) and checked before committing each step. */
function migrate(raw: BetterSqlite3.Database) {
  const current = raw.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) throw new Error(`Database schema v${current} is newer than this app (v${MIGRATIONS.length}).`);
  raw.pragma('foreign_keys = OFF');
  for (let v = current; v < MIGRATIONS.length; v++) {
    raw.transaction(() => {
      raw.exec(MIGRATIONS[v]);
      const bad = raw.pragma('foreign_key_check') as unknown[];
      if (bad.length) throw new Error(`Migration to v${v + 1} would break ${bad.length} foreign key(s); nothing was changed.`);
      raw.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export interface FileCheck {
  ok: boolean;
  detail: string;
}

/** Open a database file read-only and run SQLite's integrity check. Never throws. */
export function checkDatabaseFile(path: string): FileCheck {
  let raw: BetterSqlite3.Database | undefined;
  try {
    raw = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    const rows = raw.pragma('integrity_check') as { integrity_check: string }[];
    if (!(rows.length === 1 && rows[0].integrity_check === 'ok')) {
      return { ok: false, detail: rows.map((r) => r.integrity_check).slice(0, 5).join('; ') };
    }
    const hasTasks = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
    if (!hasTasks) return { ok: false, detail: 'not a planner database (no tasks table)' };
    return { ok: true, detail: 'ok' };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  } finally {
    raw?.close();
  }
}

/** Online backup of a database FILE (uses SQLite's backup API, never a raw copy). */
export async function backupDatabaseFile(srcPath: string, destPath: string): Promise<void> {
  const raw = new BetterSqlite3(srcPath, { readonly: true, fileMustExist: true });
  try {
    await raw.backup(destPath);
  } finally {
    raw.close();
  }
}

/**
 * Backups inherit the live database's WAL mode, which makes every later open create -wal/-shm
 * files beside them. Switch the copy to a rollback journal so a backup is one self-contained file.
 */
export function makeSelfContained(path: string): void {
  const raw = new BetterSqlite3(path);
  try {
    raw.pragma('journal_mode = DELETE');
  } finally {
    raw.close();
  }
}
