import { describe, it, expect, beforeEach } from 'vitest';
import { makeCtx, fmt, iv } from './helpers';
import { createTerm } from '../src/core/terms';
import { addTask, editTask } from '../src/core/tasks';
import { computePlan } from '../src/schedule/service';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { setSetting } from '../src/db/repo';
import { setWindow } from '../src/schedule/availabilityWindows';
import type { Ctx } from '../src/core/ctx';

// now = Sat Nov 7 2026, 10:00 AM Detroit
let ctx: Ctx;
let cal: FakeCalendar;
beforeEach(() => {
  ctx = makeCtx('2026-11-07T15:00:00Z');
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  for (let wd = 1; wd <= 7; wd++) setWindow(ctx, { weekday: wd }, { start: '09:00', end: '22:00' }, 'free');
  cal = new FakeCalendar({ calendars: [{ id: 'c', summary: 'C', busy: [iv('2026-11-09T09:00', '2026-11-09T10:00')] }] });
});
const add = (title: string, due: string, o: any = {}) => addTask(ctx, { title, course: 'MIDEAST 207', due, ...o });

describe('early placement through computePlan (the default)', () => {
  it('a weekly assignment due Thursday 11 PM starts Monday, around busy calendar time', async () => {
    add('Weekly Assignment', '2026-11-12T23:00', { est: 60 });
    const r = await computePlan(ctx, cal, { days: 14 });
    expect(r.problems).toEqual([]);
    expect(r.blocks.map((b) => fmt(b.start))).toEqual(['2026-11-09T10:00']); // Mon 9-10 is busy, so the first free slot is right after it
  });
  it('available_from holds a task back; late style still available as a setting', async () => {
    const t = add('Weekly Assignment', '2026-11-12T23:00', { est: 60 });
    editTask(ctx, t.id, { availableFrom: '2026-11-11' });
    expect((await computePlan(ctx, cal, { days: 14 })).blocks.map((b) => fmt(b.start))).toEqual(['2026-11-11T09:00']);
    setSetting(ctx.db, 'placement_style', 'late');
    expect((await computePlan(ctx, cal, { days: 14 })).blocks.map((b) => fmt(b.start))).toEqual(['2026-11-12T20:00']);
  });
  it('plain settings change the behaviour: a 1-day lead starts Wednesday', async () => {
    add('Weekly Assignment', '2026-11-12T23:00', { est: 60 });
    setSetting(ctx.db, 'early_lead_days', '1');
    expect((await computePlan(ctx, cal, { days: 14 })).blocks.map((b) => fmt(b.start))).toEqual(['2026-11-11T09:00']);
  });
});

describe('optional tasks and size-based estimates', () => {
  it('optional tasks are skipped by default, and scheduled when include_optional_tasks is true', async () => {
    const t = add('AY 209-234', '2026-11-12T11:30', { type: 'reading' });
    editTask(ctx, t.id, { size: { amount: 26, unit: 'pages' }, optional: true });
    const r = await computePlan(ctx, cal, { days: 14 });
    expect(r.skipped.find((s) => s.task.id === t.id)!.reason).toMatch(/optional/);
    setSetting(ctx.db, 'include_optional_tasks', 'true');
    const r2 = await computePlan(ctx, cal, { days: 14 });
    expect(r2.tasks.get(t.id)).toMatchObject({ baseMinutes: 78, estimateSource: 'size', minutes: 78 });
  });
  it('a size-based estimate is not multiplied by the per-type multiplier', async () => {
    for (let i = 0; i < 4; i++) {
      const d = addTask(ctx, { title: `old ${i}`, course: 'X', type: 'reading', est: 30 });
      ctx.db.run("UPDATE tasks SET status='done', actual_minutes=90 WHERE id=?", [d.id]); // reading tasks run 3x
    }
    const sized = add('Read', '2026-11-12T23:00', { type: 'reading' });
    editTask(ctx, sized.id, { size: { amount: 10, unit: 'pages' } });
    const manual = add('Read manual', '2026-11-12T23:00', { type: 'reading', est: 30 });
    const r = await computePlan(ctx, cal, { days: 14 });
    expect(r.tasks.get(sized.id)).toMatchObject({ minutes: 30, multiplierApplied: false });
    expect(r.tasks.get(manual.id)).toMatchObject({ minutes: 90, multiplierApplied: true });
  });
  it('a video with no length yet is listed as not scheduled, with how to fix it', async () => {
    const v = add('Video #4', '2026-11-12T11:30', { type: 'reading' });
    ctx.db.run("UPDATE tasks SET size_unit = 'video_minutes' WHERE id = ?", [v.id]);
    const r = await computePlan(ctx, cal, { days: 14 });
    expect(r.skipped.find((s) => s.task.id === v.id)!.reason).toMatch(/size unknown.*edit \d+ --size/);
  });
});
