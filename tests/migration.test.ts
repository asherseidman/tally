import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, checkDatabaseFile } from '../src/db/index';
import { MIGRATIONS } from '../src/db/schema';
import { backupBeforeMigration } from '../src/cli/context';

function makeV1(dir: string) {
  const file = join(dir, 'planner.db');
  const raw = new BetterSqlite3(file);
  raw.exec(MIGRATIONS[0]);
  raw.pragma('user_version = 1');
  raw.exec(`INSERT INTO terms(name,start_date,end_date,is_current) VALUES('T','2026-01-01','2026-05-01',1);
    INSERT INTO tasks(id,title,term_id,estimate_source,estimated_minutes,created_at,updated_at) VALUES(1,'a',1,'manual',30,'x','x'),(2,'b',1,NULL,NULL,'x','x');
    INSERT INTO dependencies VALUES(2,1);
    INSERT INTO time_sessions(task_id,started_at) VALUES(1,'x');
    INSERT INTO scheduled_blocks(task_id,start,"end") VALUES(1,'a','b');`);
  raw.close();
  return file;
}

describe('schema v2 migration', () => {
  it('takes a verified backup first, keeps every row and foreign key, and adds the new columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    const file = makeV1(dir);
    const backups = join(dir, 'bk');
    const saved = await backupBeforeMigration(file, backups);
    expect(saved).toBeTruthy();
    expect(checkDatabaseFile(saved!).ok).toBe(true);
    expect(readdirSync(backups).some((n) => /^pre-migration-v1-to-v\d+-/.test(n))).toBe(true);
    // the backup is still the OLD schema
    const old = new BetterSqlite3(saved!, { readonly: true });
    expect(old.pragma('user_version', { simple: true })).toBe(1);
    old.close();

    const db = openDb(file);
    expect(db.get<any>('SELECT COUNT(*) c FROM tasks').c).toBe(2);
    expect(db.get<any>('SELECT COUNT(*) c FROM dependencies').c).toBe(1);
    expect(db.get<any>('SELECT COUNT(*) c FROM time_sessions').c).toBe(1);
    expect(db.get<any>('SELECT optional, size_amount, available_from FROM tasks WHERE id=1')).toEqual({ optional: 0, size_amount: null, available_from: null });
    db.run("UPDATE tasks SET estimate_source='size', size_unit='pages', size_amount=5 WHERE id=1");
    expect(() => db.run("UPDATE tasks SET size_unit='furlongs' WHERE id=1")).toThrow();
    expect(db.get<any>('PRAGMA foreign_keys')).toMatchObject({ foreign_keys: 1 });
    expect(() => db.run('INSERT INTO dependencies VALUES(1,99)')).toThrow(); // FKs still enforced after migrating
    expect(db.all<any>('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
  });
  it('does nothing for a fresh or current database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    expect(await backupBeforeMigration(join(dir, 'none.db'), join(dir, 'bk'))).toBeUndefined();
    const f = join(dir, 'cur.db');
    openDb(f).close();
    expect(await backupBeforeMigration(f, join(dir, 'bk'))).toBeUndefined();
  });
});
