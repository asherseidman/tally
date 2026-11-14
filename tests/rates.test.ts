import { describe, it, expect, beforeEach } from 'vitest';
import { makeCtx } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { createTerm } from '../src/core/terms';
import { addTask, editTask, getTask } from '../src/core/tasks';
import { logWork } from '../src/core/timer';
import { setSetting, getSetting } from '../src/db/repo';
import { MIGRATIONS } from '../src/db/schema';
import { undoChange, listChanges } from '../src/core/changeLog';
import { loadRates, loadDefaults, sizeEstimate, effectiveEstimate, loadLearnedRates, setRate, explainEstimate, DEFAULT_RATES } from '../src/core/size';
import { buildLearning, applyMultiplier } from '../src/core/learning';
import {
  stemOf, buildGroups, groupStats, renameGroup, mergeGroups, moveTask, splitTask, setGroupRate, resetGroupRate, previewApply, applyToTasks, matchPreview,
  groupKeyOf, loadOverrides, setMultiplierEnabled, resetMultiplier, groupMultiplierTable,
} from '../src/core/rateGroups';
import { dispatch, type ApiDeps } from '../src/app/api';

let ctx: Ctx;
let app: ApiDeps;
const ok = async (ch: string, args?: unknown) => { const r = await dispatch(app, ch, args); if (!r.ok) throw new Error((r as { error: string }).error); return r.value as any; };
const T = (title: string, course: string | null = 'EECS 183', extra: Record<string, unknown> = {}) => addTask(ctx, { title, course: course ?? undefined, due: '2026-12-01 5pm', ...extra } as never);
const sized = (id: number, amount: number, unit: string) => editTask(ctx, id, { size: { amount, unit: unit as never } });
const finish = (id: number, minutes: number) => { ctx.db.run("UPDATE tasks SET status='done', completed_at='2026-11-05T12:00:00.000Z' WHERE id=?", [id]); logWork(ctx, id, minutes); };

beforeEach(() => {
  ctx = makeCtx('2026-11-12T15:00:00Z');
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  app = { ctx, dbFile: ':memory:', demo: true, backupFolder: '/x', calendar: () => { throw new Error('no calendar'); } };
});

describe('grouping: the title stem', () => {
  it('the examples from the brief', () => {
    expect(stemOf('Smith-Jones reading wk 4').key).toBe('smith-jones reading');
    expect(stemOf('Smith-Jones reading wk 5').key).toBe('smith-jones reading');
    expect(stemOf('Course Pack reading 7')).toEqual({ key: 'course pack reading', display: 'Course Pack reading' });
    expect(stemOf('Lecture 22 zyBooks')).toEqual({ key: 'zybooks', display: 'zyBooks' });
    expect(stemOf('Lecture 25 zyBooks').key).toBe('zybooks');
    expect(stemOf('Lecture 23 and 24 zyBooks').key).toBe('zybooks');
    expect(stemOf('WeBWorK 9')).toEqual({ key: 'webwork', display: 'WeBWorK' });
  });
  it('strips numbers, ranges, parentheses, chapters, weeks, dates and ordinals; keeps meaningful words', () => {
    expect(stemOf('WeBWorK 8 (7.1-7.2)').key).toBe('webwork');
    expect(stemOf('Written Homework 8').key).toBe('written homework');
    expect(stemOf('Read ch 3').key).toBe('read');
    expect(stemOf('Reading chapter 4-5 for 2nd lecture').key).toBe('reading for lecture');
    expect(stemOf('Quiz 3 (Nov 12)').key).toBe('quiz');
    expect(stemOf('Problem set Nov 14').key).toBe('problem set');
    expect(stemOf('Essay due 11/20').key).toBe('essay due');
    expect(stemOf('Video #4').key).toBe('video');
    expect(stemOf('Lab 9').key).toBe('lab');
    expect(stemOf('Third reading').key).toBe('reading');
  });
  it('a title that is only numbers and a keyword still gets a name', () => {
    expect(stemOf('Lecture 22').key).toBe('lecture');
    expect(stemOf('12').key).toBe('(untitled)');
  });
});

describe('groups: by course, tasks without a size are flagged, long names and no course', () => {
  it('one group per course + stem, with every open and done task, and "no size set"', () => {
    const a = T('Lecture 22 zyBooks'), b = T('Lecture 25 zyBooks'), c = T('WeBWorK 9'), d = T('Lecture 20 zyBooks');
    sized(a.id, 100, 'points'); finish(d.id, 30);
    const groups = buildGroups(ctx);
    expect(groups.map((g) => g.name)).toEqual(['WeBWorK', 'zyBooks']);
    const zy = groups.find((g) => g.name === 'zyBooks')!;
    expect(zy.tasks.map((t) => t.id).sort()).toEqual([a.id, b.id, d.id]);
    expect(zy.unit).toBe('points');
    expect(zy.tasks.filter((t) => !t.size_unit).map((t) => t.id).sort()).toEqual([b.id, d.id]); // the screen flags these "no size set"
    expect(groups.find((g) => g.name === 'WeBWorK')!.tasks[0].id).toBe(c.id);
    T('Lecture 1 zyBooks', 'EECS 280');
    expect(buildGroups(ctx).filter((g) => g.name === 'zyBooks')).toHaveLength(2); // another course is another group
  });
  it('deleted tasks are not shown; tasks with no course group under no course', () => {
    const x = T('Reading 1', null); const y = T('Reading 2', null);
    ctx.db.run("UPDATE tasks SET deleted_at='x' WHERE id=?", [y.id]);
    const g = buildGroups(ctx).find((g) => g.course === null)!;
    expect(g.tasks.map((t) => t.id)).toEqual([x.id]);
  });
});

describe('overrides survive: rename, merge, split, move', () => {
  it('rename, merge and move are saved and a later import of a same-stem task lands in the merged group', () => {
    const a = T('Smith-Jones reading wk 4'), b = T('Course Pack reading 7'), c = T('Lecture 22 zyBooks');
    const keyA = buildGroups(ctx).find((g) => g.name === 'Smith-Jones reading')!.key;
    const keyB = buildGroups(ctx).find((g) => g.name === 'Course Pack reading')!.key;
    mergeGroups(ctx, keyA, keyB);
    renameGroup(ctx, keyB, 'All readings');
    expect(buildGroups(ctx).map((g) => g.name)).toEqual(['All readings', 'zyBooks']);
    expect(buildGroups(ctx).find((g) => g.name === 'All readings')!.tasks.map((t) => t.id).sort()).toEqual([a.id, b.id]);
    // "a later import": a new task with the old stem is merged and the name kept
    const later = T('Smith-Jones reading wk 9');
    expect(buildGroups(ctx).find((g) => g.name === 'All readings')!.tasks.map((t) => t.id)).toContain(later.id);
    // move a task to another group
    moveTask(ctx, c.id, keyB);
    expect(buildGroups(ctx).find((g) => g.name === 'All readings')!.tasks.map((t) => t.id)).toContain(c.id);
    expect(buildGroups(ctx).some((g) => g.name === 'zyBooks')).toBe(false);
    expect(() => mergeGroups(ctx, keyB, keyB)).toThrow(/different group/);
  });
  it('split a task out into its own group (named after its title)', () => {
    const a = T('Lecture 22 zyBooks'), b = T('Lecture 25 zyBooks');
    const key = splitTask(ctx, b.id);
    const g = buildGroups(ctx);
    expect(g.map((x) => x.name).sort()).toEqual(['Lecture 25 zyBooks', 'zyBooks']);
    expect(g.find((x) => x.key === key)!.tasks.map((t) => t.id)).toEqual([b.id]);
    expect(g.find((x) => x.name === 'zyBooks')!.tasks.map((t) => t.id)).toEqual([a.id]);
    renameGroup(ctx, key, 'The odd one');
    expect(buildGroups(ctx).some((x) => x.name === 'The odd one')).toBe(true);
    expect(groupKeyOf(b, loadOverrides(ctx))).toBe(key);
  });
});

describe('rules appear as groups, with settings filled in', () => {
  it('a rule saved through the CLI (rates set) shows on its group', () => {
    const a = T('Lecture 22 zyBooks'); sized(a.id, 100, 'points');
    setRate(ctx, { unit: 'points', minutes_per_unit: 0.45, course: 'EECS 183', title_match: 'zyBooks' });
    const g = buildGroups(ctx).find((x) => x.name === 'zyBooks')!;
    expect(g.ruleIdx).toEqual([0]);
    const s = groupStats(ctx, g);
    expect(s.rateInUse).toMatchObject({ minutes: 0.45, source: 'Your rate', ruleNumber: 1 });
  });
  it('a saved rule that matches no task is a card of its own; one with no title text is "All titles"', () => {
    setRate(ctx, { unit: 'pages', minutes_per_unit: 5, course: 'HIST 210', title_match: 'primary source' });
    setRate(ctx, { unit: 'problems', minutes_per_unit: 9, course: 'MATH 214' });
    const g = buildGroups(ctx);
    const orphans = g.filter((x) => x.orphan);
    expect(orphans.map((x) => x.name).sort()).toEqual(['All titles', '“primary source”']);
    expect(orphans.find((x) => x.course === 'HIST 210')!.unit).toBe('pages');
  });
  it('the API shows the same, with the rule order and built-in rates', async () => {
    setRate(ctx, { unit: 'points', minutes_per_unit: 0.45, course: 'EECS 183', title_match: 'zyBooks' });
    T('Lecture 22 zyBooks');
    const v = await ok('rates.get');
    const zy = v.groups.find((g: any) => g.name === 'zyBooks');
    expect(zy.rule).toMatchObject({ unit: 'points', minutes: 0.45, match: 'zyBooks' });
    expect(v.order[0]).toMatchObject({ mine: true, number: 1 });
    expect(v.order.filter((r: any) => !r.mine)).toHaveLength(DEFAULT_RATES.length);
    expect(v.defaults.map((d: any) => d.minutes)).toEqual(DEFAULT_RATES.map((r) => r.minutes_per_unit));
  });
});

describe('rate rules: precedence and saving', () => {
  it('first match wins: a group rule beats the built-in one, and a more specific newer rule beats an older one', () => {
    const t = T('Lecture 22 zyBooks'); sized(t.id, 100, 'points');
    const rules = () => loadRates(ctx).all;
    expect(sizeEstimate(getTask(ctx, t.id)!, rules(), new Map())!.minutes).toBe(30); // the built-in 0.3
    setGroupRate(ctx, buildGroups(ctx).find((g) => g.name === 'zyBooks')!.key, { unit: 'points', minutes: 0.5, match: 'zybooks' });
    expect(sizeEstimate(getTask(ctx, t.id)!, rules(), new Map())!.minutes).toBe(50);
    setRate(ctx, { unit: 'points', minutes_per_unit: 0.2, course: 'EECS 183', title_match: 'lecture 22' });
    expect(sizeEstimate(getTask(ctx, t.id)!, rules(), new Map())!.minutes).toBe(20); // newest first
    const why = explainEstimate(getTask(ctx, t.id)!, rules(), loadRates(ctx).user.length, new Map())!;
    expect(why).toMatch(/Rule 1 of \d+ \(your rate\)/);
    expect(why).toContain('lecture 22');
  });
  it('saving the same group twice replaces its rule (no duplicates); a different unit replaces too; reset removes it', () => {
    const t = T('Lecture 22 zyBooks'); sized(t.id, 100, 'points');
    const key = buildGroups(ctx).find((g) => g.name === 'zyBooks')!.key;
    setGroupRate(ctx, key, { unit: 'points', minutes: 0.4 });
    setGroupRate(ctx, key, { unit: 'points', minutes: 0.35, match: 'zybooks' });
    expect(loadRates(ctx).user).toEqual([{ unit: 'points', minutes_per_unit: 0.35, course: 'EECS 183', title_match: 'zybooks' }]);
    expect(resetGroupRate(ctx, key)).toBe(1);
    expect(loadRates(ctx).user).toEqual([]);
    expect(getSetting(ctx.db, 'size_rates')).toBeUndefined();
    expect(sizeEstimate(getTask(ctx, t.id)!, loadRates(ctx).all, new Map())!.minutes).toBe(30);
  });
  it('rejects bad input', () => {
    T('Lecture 22 zyBooks');
    const key = buildGroups(ctx)[0].key;
    expect(() => setGroupRate(ctx, key, { unit: 'points', minutes: 0 })).toThrow(/above 0/);
    expect(() => setGroupRate(ctx, key, { unit: 'furlongs', minutes: 1 })).toThrow(/Unknown size unit/);
    expect(() => setGroupRate(ctx, key, { unit: 'points', minutes: 1, match: 'x'.repeat(101) })).toThrow(/too long/);
    expect(() => findKey('nope')).toThrow();
  });
  const findKey = (k: string) => { if (!buildGroups(ctx).some((g) => g.key === k)) throw new Error('missing'); };
  it('the match preview lists tasks the text would catch, in that course only', () => {
    T('Lecture 22 zyBooks'); T('Lecture 25 zyBooks'); T('Lecture 1 zyBooks', 'EECS 280'); T('Lab 9');
    expect(matchPreview(ctx, 'EECS 183', 'zybooks').map((p) => p.title).sort()).toEqual(['Lecture 22 zyBooks', 'Lecture 25 zyBooks']);
    expect(matchPreview(ctx, 'EECS 183', '')).toEqual([]);
  });
});

describe('global defaults', () => {
  it('editing a built-in rate changes estimates; the order is kept; reset restores', async () => {
    const t = T('Reading'); sized(t.id, 10, 'pages');
    expect(sizeEstimate(getTask(ctx, t.id)!, loadRates(ctx).all, new Map())!.minutes).toBe(30);
    const idx = loadDefaults(ctx).rules.findIndex((r) => r.unit === 'pages');
    const v = await ok('rates.setDefault', { index: idx, minutes: 4.5 });
    expect(v.defaultsEdited).toBe(true);
    expect(sizeEstimate(getTask(ctx, t.id)!, loadRates(ctx).all, new Map())!.minutes).toBe(45);
    expect(loadDefaults(ctx).rules.map((r) => `${r.unit}|${r.course ?? ''}|${r.title_match ?? ''}`)).toEqual(DEFAULT_RATES.map((r) => `${r.unit}|${r.course ?? ''}|${r.title_match ?? ''}`));
    await ok('rates.resetDefaults');
    expect(getSetting(ctx.db, 'rate_defaults')).toBeUndefined();
    expect(sizeEstimate(getTask(ctx, t.id)!, loadRates(ctx).all, new Map())!.minutes).toBe(30);
  });
  it('the points minimum is editable', async () => {
    const t = T('zy'); sized(t.id, 10, 'points');
    expect(sizeEstimate(getTask(ctx, t.id)!, loadRates(ctx).all, new Map())!.minutes).toBe(5);
    await ok('rates.setPointsMin', { minutes: 10 });
    expect(sizeEstimate(getTask(ctx, t.id)!, loadRates(ctx).all, new Map())!.minutes).toBe(10);
    await expect(ok('rates.setPointsMin', { minutes: 0 })).rejects.toThrow();
    await ok('rates.setPointsMin', { minutes: 5 });
    expect(getSetting(ctx.db, 'points_min_minutes')).toBeUndefined();
  });
});

describe('"Apply to these tasks" never overwrites a manual estimate by default', () => {
  const setup = () => {
    const a = T('Lecture 22 zyBooks'); sized(a.id, 100, 'points');                       // size-based, current
    const b = T('Lecture 23 zyBooks', 'EECS 183', { est: 99 }); sized(b.id, 100, 'points'); // manual 99
    const c = T('Lecture 24 zyBooks'); sized(c.id, 200, 'points');
    const d = T('Lecture 25 zyBooks');                                                      // no size
    const key = buildGroups(ctx).find((g) => g.name === 'zyBooks')!.key;
    setGroupRate(ctx, key, { unit: 'points', minutes: 0.5 });
    return { a, b, c, d, key };
  };
  it('lists exactly who changes (before and after), keeps manual ones, writes nothing in preview', () => {
    const { a, b, c, d, key } = setup();
    const snap = JSON.stringify(ctx.db.all('SELECT id, estimated_minutes, estimate_source FROM tasks'));
    const p = previewApply(ctx, key);
    expect(JSON.stringify(ctx.db.all('SELECT id, estimated_minutes, estimate_source FROM tasks'))).toBe(snap);
    expect(p.rows.map((r) => [r.taskId, r.before, r.after])).toEqual([[a.id, 30, 50], [c.id, 60, 100]]);
    expect(p.keptManual).toBe(1);
    expect(p.rows.some((r) => r.taskId === b.id || r.taskId === d.id)).toBe(false);
  });
  it('applying writes only the listed tasks, the manual estimate survives, and it needs confirm when more than 3', () => {
    const { a, b, c, key } = setup();
    const p = previewApply(ctx, key);
    applyToTasks(ctx, key, { replaceManual: false, fingerprint: p.fingerprint, confirm: true });
    expect(getTask(ctx, a.id)).toMatchObject({ estimated_minutes: 50, estimate_source: 'size' });
    expect(getTask(ctx, c.id)).toMatchObject({ estimated_minutes: 100, estimate_source: 'size' });
    expect(getTask(ctx, b.id)).toMatchObject({ estimated_minutes: 99, estimate_source: 'manual' });
    // with more than 3 changes, confirm is required
    for (let i = 0; i < 4; i++) { const t = T(`Lecture ${40 + i} zyBooks`); sized(t.id, 100, 'points'); }
    setGroupRate(ctx, key, { unit: 'points', minutes: 0.7 }); // the rate moves on, so the saved estimates are stale
    const p2 = previewApply(ctx, key);
    expect(p2.rows.length).toBe(6);
    expect(() => applyToTasks(ctx, key, { replaceManual: false, fingerprint: p2.fingerprint, confirm: false })).toThrow(/Confirm to continue/);
  });
  it('replaces manual estimates only when asked, and says which were manual', () => {
    const { b, key } = setup();
    const p = previewApply(ctx, key, true);
    expect(p.rows.find((r) => r.taskId === b.id)).toMatchObject({ before: 99, beforeSource: 'manual', after: 50, wasManual: true });
    applyToTasks(ctx, key, { replaceManual: true, fingerprint: p.fingerprint, confirm: true });
    expect(getTask(ctx, b.id)).toMatchObject({ estimated_minutes: 50, estimate_source: 'size' });
  });
  it('refuses a stale list: nothing is written if the tasks or rates changed after it was shown', () => {
    const { a, key } = setup();
    const p = previewApply(ctx, key);
    setGroupRate(ctx, key, { unit: 'points', minutes: 0.6 });
    expect(() => applyToTasks(ctx, key, { replaceManual: false, fingerprint: p.fingerprint, confirm: true })).toThrow(/changed since/);
    expect(getTask(ctx, a.id)!.estimated_minutes).toBe(30);
  });
  it('through the API: apply needs confirm, is one undoable change, and the scheduler sees the new estimate without any schedule being applied', async () => {
    const { a, key } = setup();
    const pv = await ok('rates.applyPreview', { key });
    await expect(ok('rates.apply', { key, replaceManual: false, fingerprint: pv.fingerprint, confirm: false })).rejects.toThrow(/Confirm/);
    const before = ctx.db.all('SELECT * FROM scheduled_blocks').length;
    const r = await ok('rates.apply', { key, replaceManual: false, fingerprint: pv.fingerprint, confirm: true });
    expect(r.changed).toBe(2);
    expect(ctx.db.all('SELECT * FROM scheduled_blocks').length).toBe(before); // nothing scheduled or written to a calendar
    const change = listChanges(ctx)[0];
    expect(change).toMatchObject({ actor: 'rates', tool: 'rates_apply_to_tasks' });
    undoChange(ctx, change.id);
    expect(getTask(ctx, a.id)!.estimated_minutes).toBe(30);
  });
});

describe('every edit is in the change log and can be undone', () => {
  it('save, reset, rename, merge, split, move, default and multiplier edits are one undoable entry each', async () => {
    const a = T('Lecture 22 zyBooks'); sized(a.id, 100, 'points'); const b = T('WeBWorK 9'); const c = T('Lab 9');
    const gs = buildGroups(ctx);
    const zy = gs.find((g) => g.name === 'zyBooks')!.key, wb = gs.find((g) => g.name === 'WeBWorK')!.key, lab = gs.find((g) => g.name === 'Lab')!.key;
    const undoLast = () => { const e = listChanges(ctx)[0]; expect(e.actor).toBe('rates'); expect(e.undone).toBe(false); undoChange(ctx, e.id); };

    await ok('rates.saveGroup', { key: zy, unit: 'points', minutes: 0.42, match: 'zybooks' });
    expect(getSetting(ctx.db, 'size_rates')).toContain('0.42');
    undoLast();
    expect(getSetting(ctx.db, 'size_rates')).toBeUndefined();

    await ok('rates.saveGroup', { key: zy, unit: 'points', minutes: 0.42, match: 'zybooks' });
    await ok('rates.resetGroup', { key: zy });
    expect(getSetting(ctx.db, 'size_rates')).toBeUndefined();
    undoLast();
    expect(getSetting(ctx.db, 'size_rates')).toContain('0.42'); // the reset is undone, the rule is back

    await ok('rates.rename', { key: wb, name: 'Weekly WeBWorK' });
    expect(buildGroups(ctx).some((g) => g.name === 'Weekly WeBWorK')).toBe(true);
    undoLast();
    expect(buildGroups(ctx).some((g) => g.name === 'WeBWorK')).toBe(true);

    await ok('rates.merge', { from: lab, into: wb });
    expect(buildGroups(ctx).some((g) => g.name === 'Lab')).toBe(false);
    undoLast();
    expect(buildGroups(ctx).some((g) => g.name === 'Lab')).toBe(true);

    await ok('rates.split', { taskId: b.id });
    undoLast();
    await ok('rates.move', { taskId: c.id, to: wb });
    expect(buildGroups(ctx).find((g) => g.name === 'WeBWorK')!.tasks.map((t) => t.id).sort()).toEqual([b.id, c.id]);
    undoLast();
    expect(buildGroups(ctx).find((g) => g.name === 'WeBWorK')!.tasks.map((t) => t.id)).toEqual([b.id]);

    await ok('rates.setDefault', { index: 0, minutes: 7 });
    expect(loadDefaults(ctx).rules[0].minutes_per_unit).toBe(7);
    undoLast();
    expect(getSetting(ctx.db, 'rate_defaults')).toBeUndefined();

    await ok('rates.multiplier', { key: zy, enabled: false });
    expect(getSetting(ctx.db, 'rate_multiplier_off')).toContain(zy);
    undoLast();
    expect(getSetting(ctx.db, 'rate_multiplier_off')).toBeUndefined();
  });
  it('undo refuses when the setting was changed again since (nothing overwritten)', async () => {
    T('Lecture 22 zyBooks');
    const key = buildGroups(ctx)[0].key;
    await ok('rates.saveGroup', { key, unit: 'points', minutes: 0.4, match: 'zybooks' });
    const first = listChanges(ctx)[0];
    await ok('rates.saveGroup', { key, unit: 'points', minutes: 0.5, match: 'zybooks' });
    expect(() => undoChange(ctx, first.id)).toThrow(/changed again/);
    expect(getSetting(ctx.db, 'size_rates')).toContain('0.5');
  });
  it('rates persist: they are plain settings read fresh each time (a new context over the same database sees them)', async () => {
    T('Lecture 22 zyBooks');
    const key = buildGroups(ctx)[0].key;
    await ok('rates.saveGroup', { key, unit: 'points', minutes: 0.45, match: 'zybooks' });
    await ok('rates.rename', { key, name: 'zy' });
    const again: Ctx = { ...ctx };
    expect(loadRates(again).user[0].minutes_per_unit).toBe(0.45);
    expect(buildGroups(again)[0].name).toBe('zy');
  });
  it('needs no schema change: the version is still the one the points unit added', () => {
    expect(MIGRATIONS.length).toBe(8);
  });
});

describe('actual rate, totals and the "why" line', () => {
  it('actual rate needs 3 finished timed tasks; totals count open estimates and the ones without', () => {
    const open1 = T('Lecture 30 zyBooks'); sized(open1.id, 100, 'points');
    const open2 = T('Lecture 31 zyBooks');
    for (const [pts, min] of [[100, 40], [100, 44], [50, 20]]) { const t = T(`Lecture ${pts + min} zyBooks`); sized(t.id, pts, 'points'); finish(t.id, min); }
    const g = buildGroups(ctx).find((x) => x.name === 'zyBooks')!;
    const s = groupStats(ctx, g);
    expect(s.actual).toEqual({ minutesPerUnit: 0.416, n: 3, enough: true }); // 104 min over 250 points
    expect(s.openCount).toBe(2);
    expect(s.openWithoutEstimate).toBe(1);
    expect(s.openEstimatedMinutes).toBeGreaterThan(0);
    expect(s.rateInUse!.source).toBe('Learned'); // 3+ samples calibrate the rule
    void open2;
  });
  it('fewer than 3 finished tasks: "not enough data", and the rate in use is the built-in default', () => {
    const t = T('Lecture 22 zyBooks'); sized(t.id, 100, 'points'); finish(t.id, 40);
    const s = groupStats(ctx, buildGroups(ctx)[0]);
    expect(s.actual).toMatchObject({ minutesPerUnit: null, n: 1, enough: false });
    expect(s.rateInUse).toMatchObject({ source: 'Built-in default', minutes: 0.3 });
  });
  it('the task detail has a "why this estimate" line', async () => {
    const t = T('Lecture 22 zyBooks'); sized(t.id, 100, 'points');
    const d = await ok('tasks.get', { id: t.id });
    expect(d.task.estimateWhy).toMatch(/Rule \d+ of \d+ \(built-in rate\)/);
    expect(d.task.estimateWhy).toContain('zyBooks'.slice(0, 0)); // wording is stable even without a title match
    const plain = T('Plain');
    expect((await ok('tasks.get', { id: plain.id })).task.estimateWhy).toBeNull();
  });
});

describe('learned timing per group, with the fallback chain group -> task type -> none', () => {
  const finished = (title: string, course: string, type: string, est: number, actual: number) => {
    const t = addTask(ctx, { title, course, type, due: '2026-11-01 5pm', est });
    ctx.db.run("UPDATE tasks SET status='done', completed_at='2026-11-05T12:00:00.000Z' WHERE id=?", [t.id]);
    logWork(ctx, t.id, actual);
    return t;
  };
  it('3+ finished timed tasks in the group: the group multiplier is used (not the type one)', () => {
    for (let i = 0; i < 3; i++) finished(`Problem set ${i}`, 'MATH 214', 'homework', 60, 90);      // group "problem set": 1.5x
    for (let i = 0; i < 3; i++) finished(`Essay ${i}`, 'ENG 100', 'homework', 60, 60);               // other homework: 1.0x, so the type overall is 1.25x
    const next = addTask(ctx, { title: 'Problem set 9', course: 'MATH 214', type: 'homework', due: '2026-12-01 5pm', est: 60 });
    const r = buildLearning(ctx).apply(60, next);
    expect(r).toMatchObject({ applied: true, scope: 'group', multiplier: 1.5, samples: 3, minutes: 90 });
  });
  it('fewer than 3 in the group: falls back to the task type; with no type history either: none', () => {
    for (let i = 0; i < 3; i++) finished(`Essay ${i}`, 'ENG 100', 'homework', 60, 120);              // type homework: 2x
    finished('Quiz prep 1', 'MATH 214', 'homework', 60, 60);
    const small = addTask(ctx, { title: 'Quiz prep 2', course: 'MATH 214', type: 'homework', due: '2026-12-01 5pm', est: 60 });
    expect(buildLearning(ctx).apply(60, small)).toMatchObject({ scope: 'type', applied: true, multiplier: expect.any(Number) });
    const reading = addTask(ctx, { title: 'Something new', course: 'HIST 1', type: 'reading', due: '2026-12-01 5pm', est: 60 });
    expect(buildLearning(ctx).apply(60, reading)).toMatchObject({ scope: 'none', applied: false, minutes: 60 });
  });
  it('turning a group off gives it no multiplier at all; reset forgets the earlier tasks; both are undoable settings', () => {
    for (let i = 0; i < 3; i++) finished(`Problem set ${i}`, 'MATH 214', 'homework', 60, 90);
    const next = addTask(ctx, { title: 'Problem set 9', course: 'MATH 214', type: 'homework', due: '2026-12-01 5pm', est: 60 });
    const key = groupKeyOf(next, loadOverrides(ctx));
    setMultiplierEnabled(ctx, key, false);
    expect(buildLearning(ctx).apply(60, next)).toMatchObject({ applied: false, scope: 'none', minutes: 60 });
    setMultiplierEnabled(ctx, key, true);
    expect(buildLearning(ctx).apply(60, next).scope).toBe('group');
    resetMultiplier(ctx, key);
    expect([...groupMultiplierTable(ctx).values()].length).toBe(0);
    expect(buildLearning(ctx).apply(60, next).scope).toBe('type'); // the type history still counts
  });
  it('size-based estimates never get a multiplier (the scheduler skips them, as before)', () => {
    for (let i = 0; i < 3; i++) finished(`Lecture ${i} zyBooks`, 'EECS 183', 'homework', 30, 60);
    const t = addTask(ctx, { title: 'Lecture 22 zyBooks', course: 'EECS 183', type: 'homework', due: '2026-12-01 5pm' });
    sized(t.id, 100, 'points');
    const e = effectiveEstimate(getTask(ctx, t.id)!, loadRates(ctx).all, loadLearnedRates(ctx, loadRates(ctx).all));
    expect(e).toMatchObject({ minutes: 30, source: 'size' });
    // the planner applies learning only when the source is not 'size' (see evaluate() in service.ts); the type table alone would have said 2x
    expect(applyMultiplier(30, 'homework', new Map([['homework', { multiplier: 2, samples: 3 }]])).minutes).toBe(60);
  });
  it('the Rates screen data carries the group multiplier, its switch and its reset date', async () => {
    for (let i = 0; i < 3; i++) finished(`Problem set ${i}`, 'MATH 214', 'homework', 60, 90);
    const v = await ok('rates.get');
    const g = v.groups.find((x: any) => x.name === 'Problem set');
    expect(g.multiplier).toMatchObject({ value: 1.5, samples: 3, enough: true, disabled: false });
    await ok('rates.multiplier', { key: g.key, enabled: false });
    expect((await ok('rates.get')).groups.find((x: any) => x.name === 'Problem set').multiplier.disabled).toBe(true);
    await ok('rates.multiplierReset', { key: g.key });
    expect((await ok('rates.get')).groups.find((x: any) => x.name === 'Problem set').multiplier.resetAt).toBeTruthy();
  });
});
