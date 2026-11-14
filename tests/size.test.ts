import { describe, it, expect } from 'vitest';
import { makeCtx } from './helpers';
import { addTask, editTask, getTask, listTasks } from '../src/core/tasks';
import { setSetting } from '../src/db/repo';
import {
  parseSize, loadRates, loadLearnedRates, sizeEstimate, effectiveEstimate, syncSizeEstimates, DEFAULT_RATES, MIN_RATE_SAMPLES, type RateRule,
} from '../src/core/size';
import { loadMultipliers } from '../src/core/learning';

const t = (o: Partial<{ course: string | null; title: string; size_unit: string | null; size_amount: number | null }>) => ({ course: 'MATH 214', title: 'Written Homework 8', size_unit: 'problems', size_amount: 4, ...o });
const NONE = new Map();

describe('parseSize', () => {
  it('reads "12 pages", "12pages" and split tokens', () => {
    expect(parseSize('12', 'pages')).toEqual({ amount: 12, unit: 'pages' });
    expect(parseSize('12pages')).toEqual({ amount: 12, unit: 'pages' });
    expect(parseSize('1.5', 'video')).toEqual({ amount: 1.5, unit: 'video_minutes' });
    expect(() => parseSize('12')).toThrow(/Say what/);
    expect(() => parseSize('12', 'furlongs')).toThrow(/Unknown size unit/);
    expect(() => parseSize('0', 'pages')).toThrow();
  });
});

describe('default rates', () => {
  it('uses the starting defaults: pages 3, video 1.25x, MATH 214 written problems 15, WeBWorK 6, items 30', () => {
    const r = DEFAULT_RATES;
    expect(sizeEstimate(t({ size_unit: 'pages', size_amount: 10 }), r, NONE)!.minutes).toBe(30);
    expect(sizeEstimate(t({ size_unit: 'video_minutes', size_amount: 40 }), r, NONE)!.minutes).toBe(50);
    expect(sizeEstimate(t({}), r, NONE)!.minutes).toBe(60);
    expect(sizeEstimate(t({ title: 'WeBWorK 8 (7.1-7.2)', size_amount: 10 }), r, NONE)!.minutes).toBe(60);
    expect(sizeEstimate(t({ size_unit: 'items', size_amount: 5 }), r, NONE)!.minutes).toBe(150);
  });
  it('prints the formula, saying the rate is a default', () => {
    expect(sizeEstimate(t({ size_amount: 5 }), DEFAULT_RATES, NONE)!.formula).toBe('5 problems x 15 min = 75 min (default rate)');
  });
  it('no rate for that course/unit, or no amount, gives no estimate', () => {
    expect(sizeEstimate(t({ course: 'EECS 183' }), DEFAULT_RATES, NONE)).toBeUndefined();
    expect(sizeEstimate(t({ size_amount: null }), DEFAULT_RATES, NONE)).toBeUndefined();
  });
  it('user rules are tried before the defaults', () => {
    const mine: RateRule[] = [{ unit: 'pages', course: 'MIDEAST 207', minutes_per_unit: 4 }, ...DEFAULT_RATES];
    expect(sizeEstimate(t({ course: 'MIDEAST 207', size_unit: 'pages', size_amount: 10 }), mine, NONE)!.minutes).toBe(40);
    expect(sizeEstimate(t({ course: 'HIST 101', size_unit: 'pages', size_amount: 10 }), mine, NONE)!.minutes).toBe(30);
  });
});

describe('estimate order: manual > size > none', () => {
  it('a manual estimate wins and the size-based one is still reported next to it', () => {
    const e = effectiveEstimate({ ...t({}), estimated_minutes: 120, estimate_source: 'manual' }, DEFAULT_RATES, NONE);
    expect(e).toMatchObject({ minutes: 120, source: 'manual' });
    expect(e.size!.minutes).toBe(60);
  });
  it('size-based when there is no manual estimate; none when neither', () => {
    expect(effectiveEstimate({ ...t({}), estimated_minutes: null, estimate_source: null }, DEFAULT_RATES, NONE)).toMatchObject({ minutes: 60, source: 'size' });
    expect(effectiveEstimate({ ...t({ size_unit: null, size_amount: null }), estimated_minutes: null, estimate_source: null }, DEFAULT_RATES, NONE)).toMatchObject({ minutes: null, source: null });
  });
});

describe('edit --size', () => {
  const mk = (extra = {}) => {
    const ctx = makeCtx();
    ctx.db.run("INSERT INTO terms(name,start_date,end_date,is_current) VALUES('T','2026-08-31','2026-12-21',1)");
    return { ctx, task: addTask(ctx, { title: 'HW', course: 'MATH 214', type: 'homework', ...extra }) };
  };
  it('sets a size-based estimate when there is none (estimate_source = size)', () => {
    const { ctx, task } = mk();
    const e = editTask(ctx, task.id, { size: { amount: 4, unit: 'problems' } });
    expect(e).toMatchObject({ estimated_minutes: 60, estimate_source: 'size', size_amount: 4, size_unit: 'problems' });
  });
  it('NEVER overwrites a manual estimate silently; --est-from-size switches on request', () => {
    const { ctx, task } = mk({ est: 120 });
    const e = editTask(ctx, task.id, { size: { amount: 4, unit: 'problems' } });
    expect(e).toMatchObject({ estimated_minutes: 120, estimate_source: 'manual' });
    expect(editTask(ctx, task.id, { estFromSize: true })).toMatchObject({ estimated_minutes: 60, estimate_source: 'size' });
  });
  it('a later manual --est wins over size; clearing the size drops a size-based estimate', () => {
    const { ctx, task } = mk();
    editTask(ctx, task.id, { size: { amount: 4, unit: 'problems' } });
    expect(editTask(ctx, task.id, { size: null })).toMatchObject({ estimated_minutes: null, estimate_source: null });
    editTask(ctx, task.id, { size: { amount: 4, unit: 'problems' } });
    expect(editTask(ctx, task.id, { est: 90 })).toMatchObject({ estimated_minutes: 90, estimate_source: 'manual' });
    expect(editTask(ctx, task.id, { est: null })).toMatchObject({ estimated_minutes: 60, estimate_source: 'size' }); // falls back to size
  });
  it('a size with no applicable rate leaves the estimate empty', () => {
    const { ctx, task } = mk({ course: 'EECS 183' });
    expect(editTask(ctx, task.id, { size: { amount: 4, unit: 'problems' } }).estimated_minutes).toBeNull();
    expect(() => editTask(ctx, task.id, { estFromSize: true })).toThrow(/No rate applies/);
  });
  it('stores available_from (ISO or natural) and optional', () => {
    const { ctx, task } = mk();
    expect(editTask(ctx, task.id, { availableFrom: '2026-11-07' }).available_from).toBe('2026-11-07');
    expect(editTask(ctx, task.id, { availableFrom: 'none' }).available_from).toBeNull();
    expect(editTask(ctx, task.id, { optional: true }).optional).toBe(1);
    expect(() => editTask(ctx, task.id, { availableFrom: 'whenever' })).toThrow();
  });
  it('listing tasks that have a size unit but no amount is possible', () => {
    const { ctx, task } = mk();
    ctx.db.run("UPDATE tasks SET size_unit = 'video_minutes' WHERE id = ?", [task.id]);
    const needs = listTasks(ctx, { status: 'open' }).filter((x) => x.size_unit && x.size_amount == null);
    expect(needs.map((x) => x.id)).toEqual([task.id]);
  });
});

describe('learning per (course, unit) and no double counting', () => {
  function done(ctx: ReturnType<typeof makeCtx>, title: string, amount: number, actual: number, course = 'MATH 214') {
    const t = addTask(ctx, { title, course, type: 'homework' });
    ctx.db.run("UPDATE tasks SET size_unit='problems', size_amount=?, actual_minutes=?, status='done' WHERE id=?", [amount, actual, t.id]);
  }
  const mk = () => {
    const ctx = makeCtx();
    ctx.db.run("INSERT INTO terms(name,start_date,end_date,is_current) VALUES('T','2026-08-31','2026-12-21',1)");
    return ctx;
  };
  it(`uses the default until ${MIN_RATE_SAMPLES} finished tasks with timer data, then the learned rate`, () => {
    const ctx = mk();
    done(ctx, 'Written Homework 1', 4, 80);
    done(ctx, 'Written Homework 2', 4, 100);
    const { all } = loadRates(ctx);
    expect(loadLearnedRates(ctx, all).size).toBe(0);
    expect(sizeEstimate(t({ size_amount: 4 }), all, loadLearnedRates(ctx, all))!.minutes).toBe(60); // still the 15/problem default
    done(ctx, 'Written Homework 3', 4, 120);
    const learned = loadLearnedRates(ctx, all);
    const est = sizeEstimate(t({ size_amount: 4 }), all, learned)!;
    expect(est.learned).toBe(true);
    expect(est.rate).toBe(25); // 300 min / 12 problems
    expect(est.minutes).toBe(100);
    expect(est.formula).toBe('4 problems x 25 min = 100 min (learned rate from 3 finished tasks)');
  });
  it('WeBWorK and written problems learn separately, and other courses are unaffected', () => {
    const ctx = mk();
    for (let i = 1; i <= 3; i++) done(ctx, `Written Homework ${i}`, 4, 120);
    for (let i = 1; i <= 3; i++) done(ctx, `WeBWorK ${i}`, 10, 30, 'MATH 214');
    const { all } = loadRates(ctx);
    const l = loadLearnedRates(ctx, all);
    expect(sizeEstimate(t({ size_amount: 4 }), all, l)!.rate).toBe(30);
    expect(sizeEstimate(t({ title: 'WeBWorK 9', size_amount: 10 }), all, l)!.rate).toBe(3);
  });
  it('the per-type multiplier never learns from or applies to size-based estimates', () => {
    const ctx = mk();
    for (let i = 1; i <= 4; i++) {
      const task = addTask(ctx, { title: `HW ${i}`, course: 'MATH 214', type: 'homework' });
      ctx.db.run("UPDATE tasks SET estimated_minutes=60, estimate_source='size', actual_minutes=200, status='done' WHERE id=?", [task.id]);
    }
    expect(loadMultipliers(ctx).size).toBe(0);
  });
  it('syncSizeEstimates follows a changed rate but leaves manual estimates alone', () => {
    const ctx = mk();
    const a = addTask(ctx, { title: 'A', course: 'MATH 214', type: 'homework' });
    const b = addTask(ctx, { title: 'B', course: 'MATH 214', type: 'homework', est: 200 });
    editTask(ctx, a.id, { size: { amount: 4, unit: 'problems' } });
    editTask(ctx, b.id, { size: { amount: 4, unit: 'problems' } });
    setSetting(ctx.db, 'size_rates', JSON.stringify([{ unit: 'problems', course: 'MATH 214', minutes_per_unit: 20 }]));
    expect(syncSizeEstimates(ctx)).toBe(1);
    expect(getTask(ctx, a.id)!.estimated_minutes).toBe(80);
    expect(getTask(ctx, b.id)!.estimated_minutes).toBe(200);
  });
});
