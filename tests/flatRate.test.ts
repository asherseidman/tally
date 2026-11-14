import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeCtx } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { createTerm } from '../src/core/terms';
import { addTask, editTask, getTask } from '../src/core/tasks';
import { logWork } from '../src/core/timer';
import { setSetting, getSetting } from '../src/db/repo';
import { undoChange, listChanges } from '../src/core/changeLog';
import { loadRates, setRate, effectiveEstimate, loadLearnedRates, explainEstimate, syncSizeEstimates } from '../src/core/size';
import { buildGroups, groupStats, setGroupMode, setGroupRate, renameGroup, setMultiplierEnabled, previewApply, applyToTasks, baseGroupKey, groupMultiplierTable } from '../src/core/rateGroups';
import { buildLearning } from '../src/core/learning';
import { dispatch, type ApiDeps } from '../src/app/api';
import { CLAUDE_WRITES_KEY } from '../src/core/claudeAccess';
import { createServer } from '../src/mcp/server';
import { applyImport, buildCandidates } from '../src/import/apply';
import { diffImport } from '../src/import/diff';
import { findTermByName, listTasksForImport } from '../src/db/repo';
import { parseImportFile } from '../src/import/schema';

let ctx: Ctx;
let app: ApiDeps;
const ok = async (ch: string, args?: unknown) => { const r = await dispatch(app, ch, args); if (!r.ok) throw new Error((r as { error: string }).error); return r.value as any; };
const T = (title: string, extra: Record<string, unknown> = {}) => addTask(ctx, { title, course: 'EECS 183', due: '2026-12-01 5pm', ...extra } as never);
const est = (id: number) => { const t = getTask(ctx, id)!; return effectiveEstimate(t, loadRates(ctx).all, loadLearnedRates(ctx, loadRates(ctx).all)); };
const gOf = (id: number) => buildGroups(ctx).find((g) => g.tasks.some((t) => t.id === id))!;
const finish = (id: number, minutes: number) => { ctx.db.run("UPDATE tasks SET status='done', completed_at='2026-11-05T12:00:00.000Z' WHERE id=?", [id]); logWork(ctx, id, minutes); };

beforeEach(() => {
  ctx = makeCtx('2026-11-14T15:00:00Z');
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  app = { ctx, dbFile: ':memory:', demo: true, backupFolder: '/x', calendar: () => { throw new Error('no calendar'); } };
});

describe('a flat per-assignment rate', () => {
  it('applies with no size and no unit, and reads "Flat 60 min per EECS 183 Lab"', () => {
    const t = T('Lab 4');
    expect(est(t.id).minutes).toBeNull();
    setRate(ctx, { unit: '', minutes_per_unit: 60, course: 'EECS 183', title_match: 'Lab', per_assignment: true });
    const e = est(t.id);
    expect(e).toMatchObject({ minutes: 60, source: 'size' });
    expect(e.formula).toContain('Flat 60 min per EECS 183 Lab');
    const t2 = getTask(ctx, T('Lab 5').id)!; // created after the rule: picked up at once
    expect(t2).toMatchObject({ estimated_minutes: 60, estimate_source: 'size', size_unit: null });
    expect(explainEstimate(t2, loadRates(ctx).all, 1, new Map())).toMatch(/^Flat 60 min per EECS 183 Lab\. Rule 1 of/);
  });

  it('precedence: manual beats flat beats size beats none', () => {
    const sized = T('Lab 1', { size: undefined });
    editTask(ctx, sized.id, { size: { amount: 10, unit: 'pages' } });
    expect(est(sized.id)).toMatchObject({ minutes: 30, source: 'size' }); // built-in 3 min per page
    setRate(ctx, { unit: '', minutes_per_unit: 60, course: 'EECS 183', title_match: 'Lab', per_assignment: true });
    expect(est(sized.id)).toMatchObject({ minutes: 60, source: 'size' }); // flat beats size
    expect(est(sized.id).size?.flat).toBe(true);
    const manual = T('Lab 2', { est: 45 });
    editTask(ctx, manual.id, { size: { amount: 10, unit: 'pages' } });
    expect(est(manual.id)).toMatchObject({ minutes: 45, source: 'manual' }); // manual beats both
    expect(getTask(ctx, manual.id)!.estimated_minutes).toBe(45);
    const none = T('Reading blurb');
    expect(est(none.id).minutes).toBeNull(); // no rate matches: none
  });

  it('is rule-ordered like the others: the newest of two flat rules wins, and flat/none by order', () => {
    setRate(ctx, { unit: '', minutes_per_unit: 90, course: 'EECS 183', per_assignment: true });
    setRate(ctx, { unit: '', minutes_per_unit: 60, course: 'EECS 183', title_match: 'Lab', per_assignment: true });
    expect(loadRates(ctx).user.map((r) => r.minutes_per_unit)).toEqual([60, 90]);
    expect(est(T('Lab 3').id).minutes).toBe(60); // more recent / specific first
    expect(est(T('Project 1').id).minutes).toBe(90);
  });

  it('does not take the learned multiplier, and flat tasks do not feed it', () => {
    setRate(ctx, { unit: '', minutes_per_unit: 60, course: 'EECS 183', title_match: 'Lab', per_assignment: true });
    for (let i = 0; i < 3; i++) finish(T(`Lab ${i + 10}`).id, 120);
    const t = T('Lab 20');
    const l = buildLearning(ctx);
    expect(est(t.id).source).toBe('size'); // source size: the planner never multiplies it
    void l;
    expect([...groupMultiplierTable(ctx).keys()].some((k) => k.includes('lab'))).toBe(false);
  });
});

describe('modes on a group', () => {
  it('"no rate" stops flat and size estimates; manual still counts', () => {
    const a = T('Lab 1'); editTask(ctx, a.id, { size: { amount: 4, unit: 'pages' } });
    expect(est(a.id).minutes).toBe(12);
    setGroupMode(ctx, gOf(a.id).key, { mode: 'none' });
    expect(est(a.id).minutes).toBeNull();
    syncSizeEstimates(ctx); // what the app does at start and after an import
    expect(getTask(ctx, a.id)!.estimate_source).toBeNull(); // the stale size estimate is dropped
    const m = T('Lab 2', { est: 20 });
    expect(est(m.id)).toMatchObject({ minutes: 20, source: 'manual' });
    expect(gOf(a.id).mode).toBe('none');
  });

  it('switching modes keeps the group\'s other settings', () => {
    const a = T('Lab 1'); editTask(ctx, a.id, { size: { amount: 4, unit: 'pages' } });
    T('Lab 2');
    const key = gOf(a.id).key;
    setGroupRate(ctx, key, { unit: 'pages', minutes: 5, match: 'Lab' });
    renameGroup(ctx, key, 'EECS Labs');
    setMultiplierEnabled(ctx, key, false);
    setGroupMode(ctx, key, { mode: 'flat', minutes: 60 });
    let g = gOf(a.id);
    expect(g).toMatchObject({ mode: 'flat', name: 'EECS Labs' });
    expect(est(a.id).minutes).toBe(60);
    setGroupMode(ctx, key, { mode: 'none' });
    expect(gOf(a.id).mode).toBe('none');
    setGroupMode(ctx, key, { mode: 'unit' });
    g = gOf(a.id);
    expect(g).toMatchObject({ mode: 'unit', name: 'EECS Labs' });
    expect(est(a.id).minutes).toBe(20); // the 5-min-per-page rate is still there
    expect(loadRates(ctx).user.filter((r) => r.unit === 'pages')).toHaveLength(1);
    expect(loadRates(ctx).user).toHaveLength(1); // the flat and no-rate rules are gone
    expect(groupStats(ctx, g).multiplier.disabled).toBe(true); // the multiplier switch survived
  });

  it('flat needs minutes, and they must be positive', () => {
    const a = T('Lab 1');
    expect(() => setGroupMode(ctx, gOf(a.id).key, { mode: 'flat' })).toThrow(/how many minutes/);
    expect(() => setGroupMode(ctx, gOf(a.id).key, { mode: 'flat', minutes: 0 })).toThrow(/above 0/);
    expect(() => setGroupMode(ctx, gOf(a.id).key, { mode: 'flat', minutes: -5 })).toThrow();
  });

  it('measured average with the count; "not enough data" under 3', () => {
    const key = gOf(T('Lab 1').id).key;
    setGroupMode(ctx, key, { mode: 'flat', minutes: 60 });
    finish(T('Lab 2').id, 50); finish(T('Lab 3').id, 70);
    let g = buildGroups(ctx).find((x) => x.key === key)!;
    expect(groupStats(ctx, g).average).toEqual({ minutesPerTask: null, n: 2, enough: false });
    finish(T('Lab 4').id, 90);
    g = buildGroups(ctx).find((x) => x.key === key)!;
    expect(groupStats(ctx, g).average).toEqual({ minutesPerTask: 70, n: 3, enough: true });
  });
});

describe('Apply to these tasks, flat', () => {
  it('lists before/after, never overwrites manual by default, confirms above 3, refuses a stale list', () => {
    const ids = [1, 2, 3, 4].map((i) => T(`Lab ${i}`).id);
    const manual = T('Lab 9', { est: 45 });
    const key = gOf(ids[0]).key;
    ctx.db.run("UPDATE tasks SET estimated_minutes = NULL, estimate_source = NULL WHERE estimate_source = 'size'"); // as if created before the rule
    setGroupMode(ctx, key, { mode: 'flat', minutes: 60 });
    ctx.db.run("UPDATE tasks SET estimated_minutes = NULL, estimate_source = NULL WHERE estimate_source = 'size'");
    const p = previewApply(ctx, key, false);
    expect(p.rows.map((r) => r.taskId).sort()).toEqual(ids.sort());
    expect(p.rows.every((r) => r.before === null && r.after === 60 && /Flat 60 min/.test(r.formula))).toBe(true);
    expect(p.keptManual).toBe(1);
    expect(() => applyToTasks(ctx, key, { replaceManual: false, fingerprint: p.fingerprint, confirm: false })).toThrow(/Confirm/);
    expect(() => applyToTasks(ctx, key, { replaceManual: false, fingerprint: 'stale', confirm: true })).toThrow(/changed since/);
    applyToTasks(ctx, key, { replaceManual: false, fingerprint: p.fingerprint, confirm: true });
    expect(ids.every((id) => getTask(ctx, id)!.estimated_minutes === 60)).toBe(true);
    expect(getTask(ctx, manual.id)!.estimated_minutes).toBe(45); // kept
    const p2 = previewApply(ctx, key, true);
    expect(p2.rows.map((r) => r.taskId)).toEqual([manual.id]);
    expect(p2.rows[0]).toMatchObject({ before: 45, after: 60, wasManual: true });
  });
});

describe('through the app, undo, and other doors', () => {
  it('rates.setMode is one change-log entry and Undo puts the old state back', async () => {
    const a = T('Lab 1');
    const raw = getSetting(ctx.db, 'size_rates');
    const v = await ok('rates.get');
    const g = v.groups.find((x: any) => x.tasks.some((t: any) => t.id === a.id));
    const r = await ok('rates.setMode', { key: g.key, mode: 'flat', minutes: 60 });
    const g2 = r.groups.find((x: any) => x.tasks.some((t: any) => t.id === a.id));
    expect(g2).toMatchObject({ mode: 'flat', flat: { minutes: 60 } });
    const row = listChanges(ctx).find((c) => c.tool === 'rates_set_mode')!;
    expect(row.summary).toContain('flat 60 min per assignment');
    undoChange(ctx, row.id);
    expect(getSetting(ctx.db, 'size_rates')).toBe(raw);
    expect(est(a.id).minutes).toBeNull();
  });

  it('a task added through the app API picks the flat estimate up', async () => {
    setRate(ctx, { unit: '', minutes_per_unit: 60, course: 'EECS 183', title_match: 'Lab', per_assignment: true });
    const t = await ok('tasks.add', { title: 'Lab 7', course: 'EECS 183', due: 'dec 1 5pm' });
    expect(t).toMatchObject({ estimate: 60, estimateSource: 'size' });
    expect(t.estimateWhy).toMatch(/^Flat 60 min per EECS 183 Lab/);
  });

  it('an imported task gets it too', () => {
    setRate(ctx, { unit: '', minutes_per_unit: 60, course: 'EECS 183', title_match: 'Lab', per_assignment: true });
    const parsed = parseImportFile({ term: { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-15' }, items: [{ course: 'EECS 183', title: 'Lab 8', type: 'homework', due_date: '2026-12-02' }, { course: 'EECS 183', title: 'Exam 1', type: 'exam', due_date: '2026-12-03' }], grading_breakdown: [{ category: 'Homework', percent: 15 }] });
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
    const cands = buildCandidates(parsed.data, 'America/Detroit', '23:59');
    const term = findTermByName(ctx.db, 'Fall')!;
    const diff = diffImport(cands, listTasksForImport(ctx.db, term.id));
    applyImport(ctx.db, parsed.data, { new: diff.new, changed: diff.changed }, ctx.clock);
    syncSizeEstimates(ctx); // what the app and the CLI do after an import
    const rows = ctx.db.all<{ title: string; estimated_minutes: number | null }>("SELECT title, estimated_minutes FROM tasks WHERE source = 'import' ORDER BY title");
    expect(rows).toEqual([{ title: 'Exam 1', estimated_minutes: null }, { title: 'Lab 8', estimated_minutes: 60 }]);
  });

  it('the connector shows per-assignment and no-rate rules in get_settings, and add_task picks the flat estimate up', async () => {
    setRate(ctx, { unit: '', minutes_per_unit: 60, course: 'EECS 183', title_match: 'Lab', per_assignment: true });
    setGroupMode(ctx, gOf(T('Reading 1').id).key, { mode: 'none' });
    setSetting(ctx.db, CLAUDE_WRITES_KEY, 'true');
    const server = createServer({ ctx, target: { dbFile: '/tmp/t.db', kind: 'test', label: 'TEST database' }, backupFolder: '/x' });
    const client = new Client({ name: 't', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => { const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] }; return JSON.parse(r.content.map((c) => c.text).join('\n')); };
    const s = await call('get_settings');
    expect(s.rates.yours.map((r: any) => r.kind).sort()).toEqual(['no_rate', 'per_assignment']);
    expect(s.rates.yours.find((r: any) => r.kind === 'per_assignment')).toMatchObject({ minutesPerAssignment: 60, course: 'EECS 183', titleContains: 'Lab', unit: null });
    expect(s.rates.builtIn.length).toBeGreaterThan(0);
    const added = await call('add_task', { title: 'Lab 11', course: 'EECS 183', due: 'dec 2 5pm' });
    expect(getTask(ctx, added.task.id)).toMatchObject({ estimated_minutes: 60, estimate_source: 'size' });
    await client.close(); await server.close();
  });

  it('CLI: rates set 60 --per-assignment --course "EECS 183" --match Lab (a temp database)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flat-cli-'));
    const env = { ...process.env, PLANNER_DB: join(dir, 'planner.db'), PLANNER_BACKUP_FOLDER: join(dir, 'bk') };
    const plan = (...args: string[]) => execFileSync('npx', ['tsx', 'src/cli/main.ts', ...args], { env, encoding: 'utf8', timeout: 60_000 });
    plan('term', 'new', 'Fall', '--start', '2026-08-31', '--end', '2026-12-21', '--current');
    plan('config', 'set', 'backup_folder', join(dir, 'bk'));
    const out = plan('rates', 'set', '60', '--per-assignment', '--course', 'EECS 183', '--match', 'Lab');
    expect(out).toMatch(/flat: 60 min per assignment/);
    const added = plan('add', 'Lab 4', '--course', 'EECS 183', '--due', 'dec 1 5pm');
    const id = /#(\d+)/.exec(added)![1];
    expect(plan('show', id)).toContain('Flat 60 min per EECS 183 Lab');
    expect(plan('rates')).toContain('flat: 60 min per assignment');
    rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it('needs no schema change', () => {
    expect(ctx.db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(8);
  });
});
void baseGroupKey;
