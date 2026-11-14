import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeCtx } from './helpers';
import { openDb } from '../src/db/index';
import { MIGRATIONS } from '../src/db/schema';
import { backupBeforeMigration } from '../src/cli/context';
import { addTask, editTask, getTask, completeTask } from '../src/core/tasks';
import { logWork } from '../src/core/timer';
import { setSetting } from '../src/db/repo';
import { parseSize, parseUnit, loadRates, loadLearnedRates, sizeEstimate, effectiveEstimate, syncSizeEstimates, setRate, removeRate, DEFAULT_RATES, SIZE_UNITS, MIN_POINTS_MINUTES } from '../src/core/size';
import { parseImportFile } from '../src/import/schema';
import { dispatch, type ApiDeps } from '../src/app/api';
import { createServer } from '../src/mcp/server';
import { CLAUDE_WRITES_KEY } from '../src/core/claudeAccess';
import { applyStep, getReview } from '../src/core/review';
import { createTerm } from '../src/core/terms';

const NONE = new Map();
const z = (o: Partial<{ course: string | null; title: string; size_amount: number | null }> = {}) => ({ course: 'EECS 183', title: 'Lecture 22 zyBooks', size_unit: 'points', size_amount: 100, ...o });

describe('the points unit', () => {
  it('is one of the units and is understood in several spellings, with decimals', () => {
    expect(SIZE_UNITS).toContain('points');
    expect(parseSize('100', 'points')).toEqual({ amount: 100, unit: 'points' });
    expect(parseSize('100pts')).toEqual({ amount: 100, unit: 'points' });
    expect(parseSize('87.5', 'point')).toEqual({ amount: 87.5, unit: 'points' });
    expect(parseUnit('Pt')).toBe('points');
    expect(() => parseSize('100')).toThrow(/points/);
  });
});

describe('the default points rate and the examples', () => {
  it('0.3 minutes per point: 100 points = 30 minutes, 40 points = 12 minutes', () => {
    expect(DEFAULT_RATES.find((r) => r.unit === 'points')!.minutes_per_unit).toBe(0.3);
    const a = sizeEstimate(z(), DEFAULT_RATES, NONE)!;
    expect(a.minutes).toBe(30);
    expect(a.formula).toBe('100 points x 0.3 min = 30 min (default rate)');
    expect(sizeEstimate(z({ size_amount: 40 }), DEFAULT_RATES, NONE)!.minutes).toBe(12);
  });
  it('rounds to whole minutes and never goes below 5', () => {
    expect(sizeEstimate(z({ size_amount: 55 }), DEFAULT_RATES, NONE)!.minutes).toBe(17); // 16.5
    expect(sizeEstimate(z({ size_amount: 61 }), DEFAULT_RATES, NONE)!.minutes).toBe(18); // 18.3
    expect(sizeEstimate(z({ size_amount: 10 }), DEFAULT_RATES, NONE)!.minutes).toBe(MIN_POINTS_MINUTES); // 3 -> 5
    expect(sizeEstimate(z({ size_amount: 1 }), DEFAULT_RATES, NONE)!.minutes).toBe(5);
    expect(Number.isInteger(sizeEstimate(z({ size_amount: 33.3 }), DEFAULT_RATES, NONE)!.minutes)).toBe(true);
  });
  it('the minimum of 5 is only for points: other units keep their old behaviour', () => {
    expect(sizeEstimate({ course: null, title: 'x', size_unit: 'video_minutes', size_amount: 2 }, DEFAULT_RATES, NONE)!.minutes).toBe(3);
  });
});

describe('a per-course, per-title rate with decimals', () => {
  it('"EECS 183, titles containing zyBooks, 0.45 minutes per point" is tried before the default and matches case-insensitively', () => {
    const ctx = makeCtx();
    setRate(ctx, { unit: 'points', minutes_per_unit: 0.45, course: 'EECS 183', title_match: 'zybooks' });
    const { all, user } = loadRates(ctx);
    expect(user).toEqual([{ unit: 'points', minutes_per_unit: 0.45, course: 'EECS 183', title_match: 'zybooks' }]);
    expect(sizeEstimate(z(), all, NONE)!.minutes).toBe(45);
    expect(sizeEstimate(z({ title: 'LECTURE 23 ZYBOOKS' }), all, NONE)!.minutes).toBe(45);
    expect(sizeEstimate(z({ title: 'Lab 9' }), all, NONE)!.minutes).toBe(30); // another title: the default
    expect(sizeEstimate(z({ course: 'MATH 214' }), all, NONE)!.minutes).toBe(30); // another course: the default
  });
  it('accepts any decimal, replaces the same rule instead of duplicating it, and removes by number', () => {
    const ctx = makeCtx();
    setRate(ctx, { unit: 'points', minutes_per_unit: 0.333, course: 'EECS 183', title_match: 'zyBooks' });
    expect(sizeEstimate(z(), loadRates(ctx).all, NONE)!.minutes).toBe(33);
    setRate(ctx, { unit: 'pts', minutes_per_unit: 0.25, course: 'eecs 183', title_match: 'ZYBOOKS' });
    expect(loadRates(ctx).user).toHaveLength(1);
    expect(sizeEstimate(z(), loadRates(ctx).all, NONE)!.minutes).toBe(25);
    expect(() => setRate(ctx, { unit: 'points', minutes_per_unit: 0 })).toThrow(/above 0/);
    expect(() => setRate(ctx, { unit: 'furlongs', minutes_per_unit: 1 })).toThrow(/Unknown size unit/);
    expect(removeRate(ctx, 1).minutes_per_unit).toBe(0.25);
    expect(() => removeRate(ctx, 1)).toThrow(/no rule/);
    expect(sizeEstimate(z(), loadRates(ctx).all, NONE)!.minutes).toBe(30);
  });
  it('a hand-written size_rates setting with a fractional points rate is accepted', () => {
    const ctx = makeCtx();
    setSetting(ctx.db, 'size_rates', JSON.stringify([{ unit: 'points', minutes_per_unit: 0.28, course: 'EECS 183', title_match: 'zyBooks' }]));
    expect(sizeEstimate(z(), loadRates(ctx).all, NONE)!.minutes).toBe(28);
  });
});

describe('task estimates from points', () => {
  const ctxWithTerm = () => { const ctx = makeCtx(); createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' }); return ctx; };
  it('setting points gives a size-based estimate; the multiplier is never applied; a manual estimate wins and is never overwritten', () => {
    const ctx = ctxWithTerm();
    const t = addTask(ctx, { title: 'Lecture 22 zyBooks', course: 'EECS 183', due: '2026-11-20 5pm' });
    editTask(ctx, t.id, { size: { amount: 100, unit: 'points' } });
    expect(getTask(ctx, t.id)).toMatchObject({ estimated_minutes: 30, estimate_source: 'size', size_unit: 'points', size_amount: 100 });
    const { all } = loadRates(ctx);
    const row = getTask(ctx, t.id)!;
    expect(effectiveEstimate(row, all, NONE)).toMatchObject({ minutes: 30, source: 'size' });
    // a manual estimate wins, and changing the points or the rate never replaces it
    editTask(ctx, t.id, { est: 20 });
    editTask(ctx, t.id, { size: { amount: 200, unit: 'points' } });
    setRate(ctx, { unit: 'points', minutes_per_unit: 1, course: 'EECS 183' });
    syncSizeEstimates(ctx);
    expect(getTask(ctx, t.id)).toMatchObject({ estimated_minutes: 20, estimate_source: 'manual' });
    expect(effectiveEstimate(getTask(ctx, t.id)!, loadRates(ctx).all, NONE).size!.minutes).toBe(200); // still shown beside it
  });
  it('a rate change updates size-based estimates but not manual ones', () => {
    const ctx = ctxWithTerm();
    const a = addTask(ctx, { title: 'Lecture 23 zyBooks', course: 'EECS 183', due: '2026-11-20 5pm' });
    editTask(ctx, a.id, { size: { amount: 100, unit: 'points' } });
    const b = addTask(ctx, { title: 'Lecture 24 zyBooks', course: 'EECS 183', due: '2026-11-20 5pm', est: 99 });
    editTask(ctx, b.id, { size: { amount: 100, unit: 'points' } });
    setRate(ctx, { unit: 'points', minutes_per_unit: 0.5, course: 'EECS 183', title_match: 'zyBooks' });
    syncSizeEstimates(ctx);
    expect(getTask(ctx, a.id)!.estimated_minutes).toBe(50);
    expect(getTask(ctx, b.id)!.estimated_minutes).toBe(99);
  });
});

describe('learning the points rate from logged time', () => {
  it('calibrates from DONE zyBooks tasks with points and tracked time (fractional), once there are 3', () => {
    const ctx = makeCtx();
    createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
    const done = (title: string, points: number, minutes: number) => {
      const t = addTask(ctx, { title, course: 'EECS 183', due: '2026-11-01 5pm' });
      editTask(ctx, t.id, { size: { amount: points, unit: 'points' } });
      ctx.db.run("UPDATE tasks SET status='done', completed_at='2026-11-01T10:00:00Z' WHERE id=?", [t.id]);
      logWork(ctx, t.id, minutes);
    };
    done('Lecture 1 zyBooks', 100, 45); done('Lecture 2 zyBooks', 100, 40);
    expect(loadLearnedRates(ctx, loadRates(ctx).all).size).toBe(0); // two samples: not applied
    done('Lecture 3 zyBooks', 80, 35);
    const learned = [...loadLearnedRates(ctx, loadRates(ctx).all).values()];
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ samples: 3, minutesPerUnit: 0.429 }); // 120 min over 280 points
    // the next zyBooks task uses it
    const next = addTask(ctx, { title: 'Lecture 26 zyBooks', course: 'EECS 183', due: '2026-12-01 5pm' });
    editTask(ctx, next.id, { size: { amount: 100, unit: 'points' } });
    expect(getTask(ctx, next.id)!.estimated_minutes).toBe(43);
    expect(effectiveEstimate(getTask(ctx, next.id)!, loadRates(ctx).all, loadLearnedRates(ctx, loadRates(ctx).all)).formula).toContain('learned rate from 3 finished tasks');
  });
  it('learns separately for a title-specific rule', () => {
    const ctx = makeCtx();
    createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
    setRate(ctx, { unit: 'points', minutes_per_unit: 0.3, course: 'EECS 183', title_match: 'zyBooks' });
    for (let i = 0; i < 3; i++) {
      const t = addTask(ctx, { title: `L${i} zyBooks`, course: 'EECS 183' });
      editTask(ctx, t.id, { size: { amount: 100, unit: 'points' } });
      ctx.db.run("UPDATE tasks SET status='done' WHERE id=?", [t.id]);
      logWork(ctx, t.id, 36);
    }
    const other = addTask(ctx, { title: 'Lab zy-less', course: 'EECS 183' });
    editTask(ctx, other.id, { size: { amount: 100, unit: 'points' } });
    const learned = loadLearnedRates(ctx, loadRates(ctx).all);
    expect([...learned.keys()]).toEqual(['EECS 183|points|zyBooks']);
    expect(learned.get('EECS 183|points|zyBooks')!.minutesPerUnit).toBe(0.36);
  });
  void completeTask;
});

describe('the import format', () => {
  const file = (size: unknown) => ({ term: { name: 'T1', start_date: '2026-08-31', end_date: '2026-12-15' }, items: [{ course: 'EECS 183', title: 'Lecture 22 zyBooks', type: 'homework', due_date: '2026-11-16', size }] });
  it('accepts points (with decimals) and still rejects unknown units, naming the valid ones', () => {
    const ok = parseImportFile(file({ amount: 100, unit: 'points' }));
    expect(ok.ok).toBe(true);
    expect(parseImportFile(file({ amount: 87.5, unit: 'points' })).ok).toBe(true);
    expect(parseImportFile(file({ unit: 'points' })).ok).toBe(true); // amount unknown yet
    const bad = parseImportFile(file({ amount: 5, unit: 'furlongs' }));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toMatch(/points/);
  });
  it('writes size_unit points to the database (the table accepts it)', () => {
    const db = openDb(':memory:');
    db.run("INSERT INTO terms(name,start_date,end_date,is_current) VALUES('T','2026-08-31','2026-12-21',1)");
    db.run("INSERT INTO tasks(title,size_unit,size_amount,created_at,updated_at) VALUES('x','points',100,'x','x')");
    expect(db.get<any>('SELECT size_unit FROM tasks').size_unit).toBe('points');
    expect(() => db.run("INSERT INTO tasks(title,size_unit,created_at,updated_at) VALUES('y','furlongs','x','x')")).toThrow(/CHECK/);
  });
});

describe('the app, the connector and the weekly review', () => {
  const setup = () => {
    const ctx = makeCtx('2026-11-12T15:00:00Z');
    createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
    const app: ApiDeps = { ctx, dbFile: ':memory:', demo: true, backupFolder: '/x', calendar: () => { throw new Error('no calendar'); } };
    return { ctx, app };
  };
  it('tasks.add with a size (the quick-add "More" fields) and tasks.edit', async () => {
    const { ctx, app } = setup();
    const r = await dispatch(app, 'tasks.add', { title: 'Lecture 22 zyBooks', course: 'EECS 183', size: { amount: 100, unit: 'points' } });
    expect(r.ok).toBe(true);
    const t = (r as any).value;
    expect(t).toMatchObject({ sizeAmount: 100, sizeUnit: 'points', estimate: 30, estimateSource: 'size' });
    expect(t.estimateNote).toContain('100 points x 0.3 min = 30 min');
    const bad = await dispatch(app, 'tasks.add', { title: 'x', size: { amount: 5, unit: 'furlongs' } });
    expect(bad.ok).toBe(false);
    const e = await dispatch(app, 'tasks.edit', { id: t.id, patch: { size: { amount: 40, unit: 'points' } } });
    expect((e as any).value.task).toMatchObject({ estimate: 12, sizeAmount: 40 });
    void ctx;
  });
  it('the weekly review "missing details" step can set points (with a unit when the task has none)', () => {
    const { ctx } = setup();
    const t = addTask(ctx, { title: 'Lecture 25 zyBooks', course: 'EECS 183', due: '2026-11-18 5pm' });
    expect(getReview(ctx).needsInfo.find((n) => n.taskId === t.id)!.problems).toContain('no_estimate');
    expect(() => applyStep(ctx, 'c', [{ taskId: t.id, sizeAmount: 100 }])).toThrow(/measured in/);
    applyStep(ctx, 'c', [{ taskId: t.id, sizeAmount: 100, sizeUnit: 'points' }]);
    expect(getTask(ctx, t.id)).toMatchObject({ size_unit: 'points', size_amount: 100, estimated_minutes: 30 });
    expect(getReview(ctx).needsInfo.some((n) => n.taskId === t.id)).toBe(false);
  });
  it('connector add_task and edit_task take points; unknown units are refused', async () => {
    const { ctx } = setup();
    setSetting(ctx.db, CLAUDE_WRITES_KEY, 'true');
    const server = createServer({ ctx, target: { dbFile: '/tmp/t.db', kind: 'test', label: 'TEST database' }, backupFolder: '/x' });
    const client = new Client({ name: 't', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      const text = r.content.map((c) => c.text).join('\n'); let data: any; try { data = JSON.parse(text); } catch { /* text */ }
      return { error: !!r.isError, text, data };
    };
    const tools = (await client.listTools()).tools;
    expect(JSON.stringify(tools.find((t) => t.name === 'add_task')!.inputSchema)).toContain('points');
    expect(JSON.stringify(tools.find((t) => t.name === 'edit_task')!.inputSchema)).toContain('points');
    const add = await call('add_task', { title: 'Lecture 22 zyBooks', course: 'EECS 183', size: { amount: 100, unit: 'points' } });
    expect(add.error).toBe(false);
    const id = add.data.task.id;
    expect(getTask(ctx, id)).toMatchObject({ size_unit: 'points', size_amount: 100, estimated_minutes: 30 });
    const got = (await call('get_task', { id })).data;
    const ed = await call('edit_task', { id, read_updated_at: got.task?.updatedAt ?? got.updatedAt, size: { amount: 40, unit: 'points' } });
    expect(ed.error, ed.text).toBe(false);
    expect(getTask(ctx, id)).toMatchObject({ size_amount: 40, estimated_minutes: 12 });
    expect((await call('add_task', { title: 'x', size: { amount: 5, unit: 'furlongs' } })).error).toBe(true);
    await client.close(); await server.close();
  });
});

describe('the command line', () => {
  it('edit <id> --size N points, rates set/ls/rm, and show prints the formula (a temp database, never the real one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pts-cli-'));
    const env = { ...process.env, PLANNER_DB: join(dir, 'planner.db'), PLANNER_BACKUP_FOLDER: join(dir, 'bk') };
    const plan = (...args: string[]) => execFileSync('npx', ['tsx', 'src/cli/main.ts', ...args], { env, encoding: 'utf8', timeout: 60_000 });
    plan('term', 'new', 'Fall', '--start', '2026-08-31', '--end', '2026-12-21', '--current');
    plan('config', 'set', 'backup_folder', join(dir, 'bk'));
    const added = plan('add', 'Lecture 22 zyBooks', '--course', 'EECS 183', '--due', 'dec 1 5pm');
    const id = /#(\d+)/.exec(added)![1];
    const edited = plan('edit', id, '--size', '100', 'points');
    expect(edited).toMatch(/points/);
    expect(plan('show', id)).toContain('100 points x 0.3 min = 30 min (default rate)');
    expect(plan('rates', 'set', '0.45', '--unit', 'points', '--course', 'EECS 183', '--match', 'zyBooks')).toMatch(/0\.45 min per point/);
    expect(plan('rates')).toContain('titles containing “zyBooks”');
    expect(plan('estimates')).toMatch(/No differences/); // size-based estimates follow the rate by themselves
    expect(plan('edit', id, '--size', '40', 'points')).toBeTruthy();
    expect(plan('show', id)).toContain('40 points x 0.45 min = 18 min');
    expect(() => execFileSync('npx', ['tsx', 'src/cli/main.ts', 'edit', id, '--size', '5', 'furlongs'], { env, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 })).toThrow();
    expect(plan('rates', 'rm', '1')).toMatch(/Removed/);
    rmSync(dir, { recursive: true, force: true });
  }, 90_000);
});

describe('schema v8 migration', () => {
  it('takes a verified backup first, keeps every task and link, and then accepts points', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig8-'));
    const file = join(dir, 'planner.db');
    const raw = new BetterSqlite3(file);
    for (let v = 0; v < 7; v++) raw.exec(MIGRATIONS[v]);
    raw.pragma('user_version = 7');
    raw.exec(`INSERT INTO terms(name,start_date,end_date,is_current) VALUES('T','2026-08-31','2026-12-21',1);
      INSERT INTO tasks(id,title,term_id,size_unit,size_amount,created_at,updated_at,deadline_only) VALUES(1,'a',1,'pages',4,'x','x',1),(2,'b',1,NULL,NULL,'x','x',0);
      INSERT INTO dependencies(task_id,blocked_by_task_id) VALUES(2,1);
      INSERT INTO time_sessions(task_id,started_at,ended_at) VALUES(1,'2026-11-01T10:00:00Z','2026-11-01T11:00:00Z');
      INSERT INTO scheduled_blocks(task_id,start,"end") VALUES(1,'2026-11-12T15:00:00.000Z','2026-11-12T16:00:00.000Z');
      INSERT INTO pins(task_id,start,"end",created_at,updated_at) VALUES(1,'2026-11-12T15:00:00.000Z','2026-11-12T16:00:00.000Z','x','x');`);
    raw.close();
    const backups = join(dir, 'bk');
    const saved = await backupBeforeMigration(file, backups);
    expect(saved).toBeTruthy();
    expect(readdirSync(backups).some((n) => /^pre-migration-v7-to-v8-/.test(n))).toBe(true);
    const old = new BetterSqlite3(saved!, { readonly: true });
    expect(old.pragma('user_version', { simple: true })).toBe(7);
    expect(() => old.prepare("SELECT 1 FROM tasks WHERE size_unit = 'points'").get()).not.toThrow();
    old.close();
    const db = openDb(file);
    expect(db.get<{ v: number }>('SELECT user_version v FROM pragma_user_version')!.v).toBe(MIGRATIONS.length);
    expect(db.all('SELECT id, title, size_unit, size_amount, deadline_only FROM tasks ORDER BY id')).toEqual([{ id: 1, title: 'a', size_unit: 'pages', size_amount: 4, deadline_only: 1 }, { id: 2, title: 'b', size_unit: null, size_amount: null, deadline_only: 0 }]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM dependencies')!.n).toBe(1);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM time_sessions')!.n).toBe(1);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM scheduled_blocks')!.n).toBe(1);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM pins')!.n).toBe(1);
    expect(db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND name LIKE 'idx_%' ORDER BY name")).toEqual([{ name: 'idx_tasks_due' }, { name: 'idx_tasks_import_key' }, { name: 'idx_tasks_term' }]);
    db.run("UPDATE tasks SET size_unit = 'points', size_amount = 100 WHERE id = 1");
    expect(() => db.run("UPDATE tasks SET size_unit = 'furlongs' WHERE id = 1")).toThrow(/CHECK/);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
