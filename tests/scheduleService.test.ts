import { describe, it, expect, beforeEach } from 'vitest';
import { makeCtx, loc, fmt, iv, routineJson } from './helpers';
import { fixedClock } from '../src/clock';
import { createTerm, archiveTerm, useTerm } from '../src/core/terms';
import { addTask, completeTask, deleteTask, editTask } from '../src/core/tasks';
import { computePlan, applyPlan, describeMoves, previewTrims } from '../src/schedule/service';
import { formatPlan } from '../src/schedule/format';
import { logWork } from '../src/core/timer';
import { addDependency } from '../src/core/dependencies';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { saveWorkingHoursJson, saveClassCalendars, addAwayWindow } from '../src/schedule/settings';
import { ReconnectRequiredError } from '../src/schedule/googleCalendar';
import { PLANNER_CALENDAR_NAME } from '../src/schedule/googleCalendar';
import type { Ctx } from '../src/core/ctx';
import { seedAvailability } from '../src/schedule/seedAvailability';
import { setWindow } from '../src/schedule/availabilityWindows';
import { setSetting } from '../src/db/repo';

// "now" = Sun Nov 8 2026, 9:30 PM Detroit
const NOW = '2026-11-09T02:30:00Z';
let ctx: Ctx;
let cal: FakeCalendar;

const classes = [iv('2026-11-09T10:00', '2026-11-09T11:00'), iv('2026-11-09T13:00', '2026-11-09T14:30')];
async function fresh(now = NOW) {
  ctx = makeCtx(now);
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  saveWorkingHoursJson(ctx, routineJson());
  saveClassCalendars(ctx, ['classes']);
  cal = new FakeCalendar({ calendars: [{ id: 'classes', summary: 'Classes', busy: classes }, { id: 'personal', summary: 'Personal', busy: [] }] });
  // Free time now comes from availability windows. Seed them from the routine, and use late placement so these
  // tests keep pinning the original "as late as possible" behaviour (early placement has its own tests).
  await seedAvailability(ctx, cal, { weeks: 4 });
  setSetting(ctx.db, 'placement_style', 'late');
}
const add = (title: string, due: string | undefined, est: number | undefined, extra: any = {}) =>
  addTask(ctx, { title, course: 'X', due, est, ...extra });
const mins = (bs: { start: number; end: number }[]) => bs.reduce((s, b) => s + (b.end - b.start) / 60000, 0);

beforeEach(async () => { await fresh(); });

describe('computePlan (dry run)', () => {
  it('writes nothing and does not create the Planner Blocks calendar', async () => {
    add('HW', '2026-11-11T23:59', 120);
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.length).toBeGreaterThan(0);
    expect(cal.writes).toEqual([]);
    expect(await cal.findPlannerCalendarId()).toBeUndefined();
    expect(ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks').c).toBe(0);
  });
  it('honors the first-class rule: nothing before the first class ends, but the gap between classes is usable', async () => {
    add('Big task', '2026-11-09T19:00', 200); // deadline 5 PM Monday (under 240 min, so not spread over days)
    const r = await computePlan(ctx, cal, { days: 7 });
    const monday = r.blocks.filter((b) => fmt(b.start).startsWith('2026-11-09'));
    expect(monday.length).toBeGreaterThan(0);
    expect(monday.every((b) => b.start >= loc('2026-11-09T11:00'))).toBe(true); // first class 10-11
    expect(r.windows.some((w) => fmt(w.start) === '2026-11-09T11:00' && fmt(w.end) === '2026-11-09T13:00')).toBe(true); // the gap
    expect(monday.some((b) => b.end <= loc('2026-11-09T13:00'))).toBe(true); // the 11-1 gap between classes was used
    expect(r.blocks.every((b) => b.end <= loc('2026-11-09T17:00'))).toBe(true);
  });
  it('never schedules within the 30-minute lead time of now', async () => {
    add('Soon', '2026-11-09T01:00', 20); // due 1 AM Monday: deadline 11 PM Sunday
    const r = await computePlan(ctx, cal, { days: 7 });
    const nowMs = ctx.clock.now().getTime();
    expect(r.blocks.every((b) => b.start >= nowMs + 30 * 60000)).toBe(true);
  });
  it('respects fixed unavailable windows (Wednesday gym 4-5 PM) and Thursday 8:30 PM end', async () => {
    add('Wed thing', '2026-11-11T23:59', 600);
    add('Thu thing', '2026-11-12T23:59', 600);
    const r = await computePlan(ctx, cal, { days: 7 });
    for (const b of r.blocks) {
      if (fmt(b.start).startsWith('2026-11-11')) expect(b.end <= loc('2026-11-11T16:00') || b.start >= loc('2026-11-11T17:00')).toBe(true);
      if (fmt(b.start).startsWith('2026-11-12')) expect(b.end).toBeLessThanOrEqual(loc('2026-11-12T20:30'));
    }
  });
  it('a per-date override removes that day from the plan', async () => {
    setWindow(ctx, { date: '2026-11-10' }, { start: '00:00', end: '24:00' }, 'blocked');
    add('Tue deadline', '2026-11-10T23:59', 120);
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.every((b) => !fmt(b.start).startsWith('2026-11-10'))).toBe(true);
  });
  it('a blocked time window on one date keeps work out of it (before a midterm), without blanking the day', async () => {
    setWindow(ctx, { date: '2026-11-10' }, { start: '16:00', end: '18:00' }, 'blocked');
    add('Tue deadline', '2026-11-10T20:00', 60); // deadline 6 PM Tuesday: would normally land 5-6 PM
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.length).toBeGreaterThan(0);
    for (const b of r.blocks) expect(b.end <= loc('2026-11-10T16:00') || b.start >= loc('2026-11-10T18:00')).toBe(true);
    expect(r.blocks.some((b) => fmt(b.start).startsWith('2026-11-10'))).toBe(true); // the rest of the day is still usable
  });
  it('Planner Blocks events are not counted as busy time (they are replaced)', async () => {
    add('HW', '2026-11-11T23:59', 60);
    const first = await computePlan(ctx, cal, { days: 7 });
    await applyPlan(ctx, cal, first, {});
    const second = await computePlan(ctx, cal, { days: 7 });
    expect(second.blocks.map((b) => [b.start, b.end])).toEqual(first.blocks.map((b) => [b.start, b.end]));
  });
  it('limits the shown/applied blocks to the horizon', async () => {
    add('Soon', '2026-11-10T23:59', 60);
    add('Later', '2026-12-04T23:59', 60);
    const r = await computePlan(ctx, cal, { days: 3 });
    expect(r.blocks.every((b) => b.start < loc('2026-11-12T00:00'))).toBe(true);
    expect(r.blocks.some((b) => r.tasks.get(b.taskId)!.title === 'Later')).toBe(false);
  });
});

describe('what gets scheduled, and why not', () => {
  it('skips with a reason: done, deleted, no estimate, no due date, overdue, attendance, estimate used up', async () => {
    const done = add('done one', '2026-11-12T23:59', 30); completeTask(ctx, done.id);
    const del = add('deleted one', '2026-11-12T23:59', 30); deleteTask(ctx, del.id);
    add('no estimate', '2026-11-12T23:59', undefined);
    add('no due', undefined, 30);
    add('overdue', '2026-11-01T23:59', 30);
    add('lecture', '2026-11-12T23:59', 30, { type: 'attendance' });
    const used = add('used up', '2026-11-12T23:59', 60); ctx.db.run('UPDATE tasks SET actual_minutes = 70 WHERE id = ?', [used.id]);
    add('ok', '2026-11-12T23:59', 30);
    const r = await computePlan(ctx, cal, { days: 7 });
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.task.title, s.reason]));
    expect(Object.keys(reasons).sort()).toEqual(['lecture', 'no due', 'no estimate', 'overdue', 'used up']);
    expect(reasons['no estimate']).toMatch(/estimate/i);
    expect(reasons['no due']).toMatch(/due/i);
    expect(reasons['overdue']).toMatch(/passed|overdue/i);
    expect(reasons['lecture']).toMatch(/attendance/i);
    expect(reasons['used up']).toMatch(/used up|already/i);
    expect([...r.tasks.values()].map((t) => t.title)).toEqual(['ok']);
  });
  it('scopes to the current term plus term-less tasks; archived/other terms are excluded', async () => {
    createTerm(ctx, { name: 'Old', start_date: '2026-01-01', end_date: '2026-05-01' });
    add('current term', '2026-11-12T23:59', 30);
    addTask(ctx, { title: 'personal', due: '2026-11-12T23:59', est: 30 });
    addTask(ctx, { title: 'old term', course: 'Z', term: 'Old', due: '2026-11-12T23:59', est: 30 });
    const r = await computePlan(ctx, cal, { days: 7 });
    expect([...r.tasks.values()].map((t) => t.title).sort()).toEqual(['current term', 'personal']);
    useTerm(ctx, 'Old'); archiveTerm(ctx, 'Fall');
    const r2 = await computePlan(ctx, cal, { days: 7 });
    expect([...r2.tasks.values()].map((t) => t.title).sort()).toEqual(['old term', 'personal']);
  });
  it('applies the learned multiplier at plan time without changing the stored estimate', async () => {
    for (let i = 0; i < 3; i++) {
      const h = add(`past hw ${i}`, undefined, 60, { type: 'homework' });
      completeTask(ctx, h.id);
      ctx.db.run('UPDATE tasks SET actual_minutes = 90 WHERE id = ?', [h.id]);
    }
    const t = add('new hw', '2026-11-12T23:59', 60, { type: 'homework' });
    const r = await computePlan(ctx, cal, { days: 7 });
    const st = r.tasks.get(t.id)!;
    expect(st.minutes).toBe(90);
    expect(st.multiplier).toBe(1.5);
    expect(ctx.db.get<any>('SELECT estimated_minutes e, estimate_source s FROM tasks WHERE id = ?', [t.id])).toEqual({ e: 60, s: 'manual' });
  });
  it('schedules only the remaining time when some has been tracked', async () => {
    const t = add('partly done', '2026-11-12T23:59', 120);
    ctx.db.run('UPDATE tasks SET actual_minutes = 45 WHERE id = ?', [t.id]);
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.tasks.get(t.id)!.minutes).toBe(75);
  });
  it('reports tasks that cannot fit instead of dropping them', async () => {
    add('impossible', '2026-11-09T09:00', 600); // due Monday 9 AM: almost no time before it
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.problems.some((p) => p.taskId > 0 && /impossible/.test(r.tasks.get(p.taskId)!.title))).toBe(true);
  });
});

describe('all-day busy events', () => {
  const allDayMon = iv('2026-11-09T00:00', '2026-11-10T00:00');
  const withAllDay = () =>
    new FakeCalendar({ calendars: [{ id: 'classes', summary: 'Classes', busy: [] }, { id: 'family', summary: 'Family', busy: [allDayMon] }] });

  it('by default an all-day busy block (20h+) is ignored, so it does not blank the day, and the plan says so', async () => {
    add('Mon task', '2026-11-09T22:00', 60); // deadline 8 PM Monday
    const r = await computePlan(ctx, withAllDay(), { days: 7 });
    expect(r.blocks.some((b) => fmt(b.start).startsWith('2026-11-09'))).toBe(true);
    expect(r.ignoredBusy).toHaveLength(1);
    expect(r.ignoredBusy[0]).toMatchObject({ calendar: 'Family', hours: 24 });
  });
  it('with the option off (0) the all-day block makes the whole day busy', async () => {
    saveWorkingHoursJson(ctx, { ...routineJson(), ignore_busy_at_least_hours: 0 });
    add('Mon task', '2026-11-09T22:00', 60);
    const r = await computePlan(ctx, withAllDay(), { days: 7 });
    expect(r.blocks.every((b) => !fmt(b.start).startsWith('2026-11-09'))).toBe(true);
    expect(r.ignoredBusy).toEqual([]);
  });
  it('shorter busy blocks on the same calendar still count', async () => {
    const c = new FakeCalendar({ calendars: [{ id: 'classes', summary: 'Classes', busy: [] }, { id: 'family', summary: 'Family', busy: [allDayMon, iv('2026-11-09T14:30', '2026-11-09T21:00')] }] });
    add('Mon task', '2026-11-09T22:00', 60);
    const r = await computePlan(ctx, c, { days: 7 });
    for (const b of r.blocks) expect(b.end <= loc('2026-11-09T14:30') || b.start >= loc('2026-11-09T21:00')).toBe(true);
  });
  it('an excluded calendar (busy_calendars) contributes nothing', async () => {
    saveWorkingHoursJson(ctx, { ...routineJson(), ignore_busy_at_least_hours: 0 });
    ctx.db.run("INSERT INTO settings(key,value) VALUES('busy_calendars', ?)", [JSON.stringify(['classes'])]); // Family is left out
    add('Mon task', '2026-11-09T22:00', 60);
    const r = await computePlan(ctx, withAllDay(), { days: 7 });
    expect(r.blocks.some((b) => fmt(b.start).startsWith('2026-11-09'))).toBe(true);
  });
});

describe('exam windows', () => {
  it('never places work during an exam with a real time, or right after it', async () => {
    // Tuesday 6:00 PM exam (time stated) -> busy 6:00-8:00 PM plus the 10-minute buffer
    addTask(ctx, { title: 'Midterm', course: 'X', type: 'exam', due: '2026-11-10T18:00' });
    // wants to land right where the exam is: deadline = 10 PM - 2h = 8 PM
    add('Big pset', '2026-11-10T22:00', 180);
    add('After-exam thing', '2026-11-10T23:59', 60); // deadline 9:59 PM
    const r = await computePlan(ctx, cal, { days: 7 });
    const examStart = loc('2026-11-10T18:00'), examEndPlusBuffer = loc('2026-11-10T20:10');
    expect(r.blocks.length).toBeGreaterThan(0);
    for (const b of r.blocks) expect(b.end <= examStart || b.start >= examEndPlusBuffer).toBe(true);
    expect(r.examWindows.map((w) => [fmt(w.start), fmt(w.end)])).toEqual([['2026-11-10T18:00', '2026-11-10T20:00']]);
  });
  it('an exam with only an assumed time (date, no time) does not block anything', async () => {
    addTask(ctx, { title: 'Final', course: 'X', type: 'exam', due: '2026-11-10' }); // 11:59 PM assumed
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.examWindows).toEqual([]);
  });
  it('an exam with no estimate still blocks its window (it is skipped as work, not as time)', async () => {
    const e = addTask(ctx, { title: 'Midterm', course: 'X', type: 'exam', due: '2026-11-10T18:00' });
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.skipped.some((s) => s.task.id === e.id)).toBe(true);
    expect(r.examWindows).toHaveLength(1);
  });
});

describe('exam prep (through the saved settings)', () => {
  it('360 minutes of exam prep for a Wed 8 PM exam fits: up to 3h a day, ending 2h before the start', async () => {
    const e = addTask(ctx, { title: 'Exam 2', course: 'X', type: 'exam', due: '2026-11-11T20:00', est: 360 });
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.problems.filter((p) => p.taskId === e.id)).toEqual([]);
    const mine = r.blocks.filter((b) => b.taskId === e.id);
    expect(mine.reduce((s, b) => s + (b.end - b.start) / 60000, 0)).toBeGreaterThanOrEqual(360);
    expect(Math.max(...mine.map((b) => b.end))).toBeLessThanOrEqual(loc('2026-11-11T18:00'));
    const perDay = new Map<string, number>();
    for (const b of mine) perDay.set(fmt(b.start).slice(0, 10), (perDay.get(fmt(b.start).slice(0, 10)) ?? 0) + (b.end - b.start) / 60000);
    for (const v of perDay.values()) expect(v).toBeLessThanOrEqual(180);
  });
  it('a lab with its estimate cleared is listed as not scheduled with the reason "no estimate"', async () => {
    const lab = add('Lab 8', '2026-11-10T04:59', 60);
    ctx.db.run('UPDATE tasks SET estimated_minutes = NULL, estimate_source = NULL WHERE id = ?', [lab.id]);
    const r = await computePlan(ctx, cal, { days: 7 });
    const s = r.skipped.find((x) => x.task.id === lab.id)!;
    expect(s.reason).toMatch(/^no estimate/);
    expect(r.blocks.some((b) => b.taskId === lab.id)).toBe(false);
  });
});

describe('configuration errors', () => {
  it('with no availability windows at all it says how to create them', async () => {
    ctx.db.run('DELETE FROM availability_windows');
    add('x', '2026-11-12T23:59', 30);
    await expect(computePlan(ctx, cal, { days: 7 })).rejects.toThrow(/availability seed/);
  });
  it('plain settings override the old working_hours JSON for the numeric knobs', async () => {
    setSetting(ctx.db, 'min_block_minutes', '40');
    setSetting(ctx.db, 'max_block_minutes', '60');
    add('x', '2026-11-12T23:59', 200);
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.hours.min_block_minutes).toBe(40);
    expect(r.blocks.every((b) => (b.end - b.start) / 60000 <= 60)).toBe(true);
  });
  it('an unknown class calendar id is an error that lists the real ones', async () => {
    saveClassCalendars(ctx, ['nope']);
    add('x', '2026-11-12T23:59', 30);
    await expect(computePlan(ctx, cal, { days: 7 })).rejects.toThrow(/nope[\s\S]*classes/);
  });
  it('an expired Google connection surfaces as a reconnect error', async () => {
    add('x', '2026-11-12T23:59', 30);
    const broken = { ...cal, listCalendars: async () => { throw new ReconnectRequiredError('invalid_grant'); } } as any;
    await expect(computePlan(ctx, broken, { days: 7 })).rejects.toThrow(/calendar connect/);
  });
});

describe('applyPlan', () => {
  it('writes only to the Planner Blocks calendar, one event per block, and records them', async () => {
    add('HW', '2026-11-11T23:59', 240);
    add('Quiz prep', '2026-11-10T20:00', 90);
    const r = await computePlan(ctx, cal, { days: 7 });
    const res = await applyPlan(ctx, cal, r, {});
    const plannerId = (await cal.findPlannerCalendarId())!;
    expect(plannerId).toBeTruthy();
    expect(cal.writes.every((w) => w.calendarId === plannerId || w.op === 'createCalendar')).toBe(true);
    expect(cal.writes.filter((w) => w.op === 'createCalendar')).toHaveLength(1);
    expect(cal.writes.filter((w) => w.op === 'createCalendar')[0].summary).toBe(PLANNER_CALENDAR_NAME);
    expect(res.created).toBe(r.blocks.length);
    expect(cal.plannerEvents()).toHaveLength(r.blocks.length);
    const rows = ctx.db.all<any>('SELECT * FROM scheduled_blocks ORDER BY start');
    expect(rows).toHaveLength(r.blocks.length);
    expect(rows.every((x) => cal.plannerEvents().some((e) => e.id === x.google_event_id))).toBe(true);
  });
  it('re-running replaces earlier future blocks instead of duplicating them', async () => {
    add('HW', '2026-11-11T23:59', 240);
    const a = await computePlan(ctx, cal, { days: 7 });
    await applyPlan(ctx, cal, a, {});
    const n = cal.plannerEvents().length;
    add('Another', '2026-11-12T23:59', 60);
    const b = await computePlan(ctx, cal, { days: 7 });
    const res = await applyPlan(ctx, cal, b, {});
    expect(res.deleted).toBe(n);
    expect(cal.plannerEvents()).toHaveLength(b.blocks.length);
    expect(ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks').c).toBe(b.blocks.length);
  });
  it('a schedule run leaves past blocks alone; replan removes missed ones for open tasks and reports the move', async () => {
    const t = add('HW', '2026-11-12T23:59', 60);
    const a = await computePlan(ctx, cal, { days: 7 });
    await applyPlan(ctx, cal, a, {});
    // pretend a block earlier today was missed
    const pid = await cal.ensurePlannerCalendar();
    const evId = await cal.createPlannerEvent({ summary: 'HW', description: '', startMs: loc('2026-11-08T10:00'), endMs: loc('2026-11-08T11:00'), timeZone: 'America/Detroit' });
    ctx.db.run('INSERT INTO scheduled_blocks(task_id,start,"end",google_event_id) VALUES(?,?,?,?)', [t.id, new Date(loc('2026-11-08T10:00')).toISOString(), new Date(loc('2026-11-08T11:00')).toISOString(), evId]);
    void pid;
    const b = await computePlan(ctx, cal, { days: 7 });
    await applyPlan(ctx, cal, b, {});
    expect(ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks WHERE google_event_id = ?', [evId]).c).toBe(1); // untouched
    const c = await computePlan(ctx, cal, { days: 7 });
    const res = await applyPlan(ctx, cal, c, { replan: true });
    expect(res.missedRemoved).toBe(1);
    expect(ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks WHERE google_event_id = ?', [evId]).c).toBe(0);
    expect(cal.plannerEvents().some((e) => e.id === evId)).toBe(false);
    expect(res.moved.some((m) => m.taskId === t.id && m.reason === 'missed')).toBe(true);
  });
  it('completed tasks keep no future blocks after a re-run', async () => {
    const t = add('HW', '2026-11-11T23:59', 60);
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }), {});
    expect(cal.plannerEvents().length).toBeGreaterThan(0);
    completeTask(ctx, t.id);
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }), {});
    expect(cal.plannerEvents()).toHaveLength(0);
  });
  it('tolerates an event that was already deleted by hand', async () => {
    add('HW', '2026-11-11T23:59', 60);
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }), {});
    for (const e of cal.plannerEvents()) cal.removeBehindBack(e.id);
    await expect(applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }), {})).resolves.toBeDefined();
  });
});

describe('describeMoves', () => {
  const d = (s: string) => new Date(loc(s)).toISOString();
  it('missed -> new time; shifted; removed; unchanged is omitted', () => {
    const old = [
      { taskId: 1, start: d('2026-11-08T10:00'), end: d('2026-11-08T11:00'), missed: true },
      { taskId: 2, start: d('2026-11-10T10:00'), end: d('2026-11-10T11:00'), missed: false },
      { taskId: 3, start: d('2026-11-10T12:00'), end: d('2026-11-10T13:00'), missed: false },
      { taskId: 4, start: d('2026-11-10T14:00'), end: d('2026-11-10T15:00'), missed: false },
    ];
    const next = [
      { taskId: 1, start: loc('2026-11-09T15:00'), end: loc('2026-11-09T16:00'), part: 1, parts: 1, padded: false },
      { taskId: 2, start: loc('2026-11-10T16:00'), end: loc('2026-11-10T17:00'), part: 1, parts: 1, padded: false },
      { taskId: 4, start: loc('2026-11-10T14:00'), end: loc('2026-11-10T15:00'), part: 1, parts: 1, padded: false },
    ];
    const m = describeMoves(old, next);
    expect(m.map((x) => [x.taskId, x.reason])).toEqual([[1, 'missed'], [2, 'shifted'], [3, 'removed']]);
    expect(m[0].to).toHaveLength(1);
  });
});

describe('in-progress blocks and logged work', () => {
  // NOW = Sun Nov 8 9:30 PM Detroit
  async function seedBlock(taskId: number, startIso: string, endIso: string) {
    const id = await cal.createPlannerEvent({ summary: 'old block', description: '', startMs: Date.parse(startIso), endMs: Date.parse(endIso), timeZone: ctx.tz });
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end", google_event_id) VALUES(?,?,?,?)', [taskId, startIso, endIso, id]);
    return id;
  }
  const nowMs = () => ctx.clock.now().getTime();

  it('an apply in the middle of a block trims it to now and says so; nothing is left running into the new plan', async () => {
    const t = add('Study', '2026-11-11T23:59', 300);
    const oldId = await seedBlock(t.id, '2026-11-09T02:00:00Z', '2026-11-09T04:00:00Z'); // 9:00-11:00 PM, 30 min elapsed
    const r = await computePlan(ctx, cal, { days: 7 });
    const res = await applyPlan(ctx, cal, r, {});
    expect(res.trimmed).toEqual([expect.objectContaining({ taskId: t.id, action: 'trimmed', keptMinutes: 30 })]);
    const row = ctx.db.all<any>('SELECT * FROM scheduled_blocks WHERE start < ?', [new Date(nowMs()).toISOString()]);
    expect(row).toHaveLength(1);
    expect(Date.parse(row[0].end)).toBe(Math.floor(nowMs() / 60000) * 60000);
    expect(row[0].google_event_id).not.toBe(oldId);
    expect(cal.plannerEvents().find((e) => e.id === oldId)).toBeUndefined(); // the long event is gone
    expect(cal.plannerEvents().filter((e) => e.startMs < nowMs() && e.endMs > nowMs())).toEqual([]); // nothing spans "now"
    expect(cal.plannerEvents().find((e) => e.id === row[0].google_event_id)!.endMs).toBe(Date.parse(row[0].end));
  });
  it('removes the block when hardly any has elapsed, and leaves blocks of done tasks alone', async () => {
    const t = add('Study', '2026-11-11T23:59', 60);
    const done = add('Finished', '2026-11-11T23:59', 60);
    await seedBlock(t.id, '2026-11-09T02:25:00Z', '2026-11-09T03:25:00Z'); // 5 min elapsed
    const keep = await seedBlock(done.id, '2026-11-09T02:00:00Z', '2026-11-09T04:00:00Z');
    completeTask(ctx, done.id);
    const res = await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }), {});
    expect(res.trimmed).toEqual([expect.objectContaining({ taskId: t.id, action: 'removed' })]);
    expect(cal.plannerEvents().some((e) => e.id === keep)).toBe(true);
  });
  it('the dry run lists what apply would trim, and changes nothing', async () => {
    const t = add('Study', '2026-11-11T23:59', 60);
    await seedBlock(t.id, '2026-11-09T02:00:00Z', '2026-11-09T04:00:00Z');
    const r = await computePlan(ctx, cal, { days: 7 });
    const before = cal.writes.length;
    const text = formatPlan(r, { dryRun: true, calendarNote: 'x', trims: previewTrims(ctx, r) });
    expect(text).toMatch(/WOULD TRIM[\s\S]*Study[\s\S]*30m that elapsed stays as history/);
    expect(cal.writes.length).toBe(before);
  });
  it('plans only the remaining estimate (estimate minus logged work) and says so', async () => {
    const t = add('Exam prep', '2026-11-11T23:59', 300, { type: 'exam' });
    logWork(ctx, t.id, 60, '2026-11-09T00:00:00Z');
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.tasks.get(t.id)).toMatchObject({ baseMinutes: 300, trackedMinutes: 60, minutes: 240 });
    expect(mins(r.blocks.filter((b) => b.taskId === t.id))).toBe(240);
    expect(formatPlan(r, { dryRun: true, calendarNote: 'x' })).toMatch(/estimate 300 min - 60 min logged = 240 min still to plan/);
  });
  it('when logged work covers the need, the extra block is dropped instead of keeping the old plan', async () => {
    const t = add('Exam prep', '2026-11-11T23:59', 120, { type: 'exam' });
    const a = await computePlan(ctx, cal, { days: 7 });
    await applyPlan(ctx, cal, a, {});
    expect(cal.plannerEvents().length).toBeGreaterThan(0);
    logWork(ctx, t.id, 120, '2026-11-08T23:00:00Z');
    const b = await computePlan(ctx, cal, { days: 7 });
    expect(b.blocks).toEqual([]);
    await applyPlan(ctx, cal, b, {});
    expect(cal.plannerEvents()).toEqual([]);
  });
});

describe('event titles written to Google', () => {
  it('uses COURSE: title, Prep for exams, and leaves the stored titles alone', async () => {
    const e = add('Exam 2', '2026-11-11T20:00', 120, { type: 'exam' });
    add('HW', '2026-11-11T23:59', 60);
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }), {});
    const titles = cal.plannerEvents().map((x) => x.summary).sort();
    expect(titles).toContain('X: HW');
    expect(titles.some((x) => /^X: Exam 2 Prep( \(\d\/\d\))?$/.test(x))).toBe(true);
    expect(ctx.db.get<any>('SELECT title FROM tasks WHERE id = ?', [e.id]).title).toBe('Exam 2');
  });
});

describe('deadline-only tasks', () => {
  it('are neither scheduled nor listed under not scheduled, even with no estimate', async () => {
    const e = add('Showcase Event', '2026-12-15T10:00', undefined);
    const other = add('No estimate', '2026-12-15T10:00', undefined);
    editTask(ctx, e.id, { deadlineOnly: true });
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.skipped.some((s) => s.task.id === e.id)).toBe(false);
    expect(r.skipped.some((s) => s.task.id === other.id)).toBe(true); // ordinary tasks still report why
    expect(r.blocks.some((b) => b.taskId === e.id)).toBe(false);
    editTask(ctx, e.id, { deadlineOnly: false });
    expect((await computePlan(ctx, cal, { days: 7 })).skipped.some((s) => s.task.id === e.id)).toBe(true);
  });
});

describe('dependencies and plan steps in the scheduler', () => {
  it('a blocked task is not scheduled (and says why) until its blocker is done; completing the blocker releases it', async () => {
    const a = add('Write draft', '2026-11-11T23:59', 60);
    const b = add('Outline', '2026-11-11T23:59', 30);
    addDependency(ctx, a.id, b.id);
    let r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.some((x) => x.taskId === a.id)).toBe(false);
    expect(r.skipped.some((s) => s.task.id === a.id)).toBe(false); // projected as TENTATIVE instead (see below)
    // late placement puts the blocker right at the deadline, so nothing fits after it: reported as a tentative problem
    expect(r.tentativeProblems.some((p) => p.taskId === a.id)).toBe(true);
    expect(r.blocks.some((x) => x.taskId === b.id)).toBe(true);
    completeTask(ctx, b.id);
    r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.some((x) => x.taskId === a.id)).toBe(true);
  });
  it('a parent whose work is planned as steps is not also scheduled itself', async () => {
    const parent = add('Exam 2', '2026-11-11T20:00', 300, { type: 'exam' });
    const step = add('Review lectures', '2026-11-11T12:00', 60);
    ctx.db.run('UPDATE tasks SET parent_task_id = ? WHERE id = ?', [parent.id, step.id]);
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.skipped.find((s) => s.task.id === parent.id)!.reason).toMatch(/planned as 1 step/);
    expect(r.blocks.some((x) => x.taskId === step.id)).toBe(true);
  });
});

describe('tentative projections for blocked tasks', () => {
  // NOW = Sun Nov 8 9:30 PM; late placement is set in fresh(), so these use early placement explicitly
  const early = () => setSetting(ctx.db, 'placement_style', 'early');
  it('plans a blocked task as if its blocker finishes at the end of the blocker\'s planned blocks, and never earlier', async () => {
    early();
    const a = add('Draft', '2026-11-13T23:59', 90);
    const b = add('Edits', '2026-11-13T23:59', 60);
    addDependency(ctx, b.id, a.id);
    const r = await computePlan(ctx, cal, { days: 14 });
    const draftEnd = Math.max(...r.blocks.filter((x) => x.taskId === a.id).map((x) => x.end));
    expect(r.blocks.some((x) => x.taskId === b.id)).toBe(false); // not a real block
    expect(r.tentative.length).toBeGreaterThan(0);
    expect(r.tentative.every((x) => x.taskId === b.id && x.start >= draftEnd && x.waitingOn.includes(a.id))).toBe(true);
    expect(r.skipped.some((s) => s.task.id === b.id)).toBe(false); // not listed as merely "blocked"
    expect(formatPlan(r, { dryRun: true, calendarNote: 'x' })).toMatch(/TENTATIVE \(waiting on #\d+ Draft\):[\s\S]*Edits[\s\S]*makes its deadline/);
  });
  it('resolves chains layer by layer (A -> B -> C), each after the previous one\'s tentative end', async () => {
    early();
    const a = add('A', '2026-11-14T23:59', 45);
    const b = add('B', '2026-11-14T23:59', 45);
    const c = add('C', '2026-11-14T23:59', 45);
    addDependency(ctx, b.id, a.id);
    addDependency(ctx, c.id, b.id);
    const r = await computePlan(ctx, cal, { days: 14 });
    const end = (id: number, list: { taskId: number; end: number }[]) => Math.max(...list.filter((x) => x.taskId === id).map((x) => x.end));
    const start = (id: number) => Math.min(...r.tentative.filter((x) => x.taskId === id).map((x) => x.start));
    expect(start(b.id)).toBeGreaterThanOrEqual(end(a.id, r.blocks));
    expect(start(c.id)).toBeGreaterThanOrEqual(end(b.id, r.tentative));
  });
  it('tentative blocks never reach Google on apply, and the real blocks are unaffected by them', async () => {
    early();
    const a = add('Draft', '2026-11-13T23:59', 90);
    const b = add('Edits', '2026-11-13T23:59', 60);
    addDependency(ctx, b.id, a.id);
    const r = await computePlan(ctx, cal, { days: 14 });
    const res = await applyPlan(ctx, cal, r, {});
    expect(res.created).toBe(r.blocks.length);
    expect(cal.plannerEvents().length).toBe(r.blocks.length);
    expect(cal.plannerEvents().some((e) => /Edits/.test(e.summary))).toBe(false);
    expect(ctx.db.all<any>('SELECT * FROM scheduled_blocks WHERE task_id = ?', [b.id])).toEqual([]);
  });
  it('a tentative task that would not fit is reported under DOES NOT FIT, labeled tentative', async () => {
    early();
    const a = add('Draft', '2026-11-09T23:59', 120);
    const b = add('Edits', '2026-11-09T23:59', 480); // far more than fits after the draft before it is due
    addDependency(ctx, b.id, a.id);
    const r = await computePlan(ctx, cal, { days: 14 });
    expect(r.tentativeProblems.some((p) => p.taskId === b.id)).toBe(true);
    const text = formatPlan(r, { dryRun: true, calendarNote: 'x' });
    expect(text).toMatch(/\(tentative\) #\d+ X · Edits/);
    expect(text).toMatch(/WOULD NOT FIT \(tentative\)/);
    expect(r.problems.some((p) => p.taskId === b.id)).toBe(false); // real problems stay separate
  });
  it('a task whose blocker has no planned time stays blocked (and says it cannot be projected)', async () => {
    early();
    const noEst = add('No estimate', '2026-11-13T23:59', undefined);
    const b = add('After it', '2026-11-13T23:59', 30);
    addDependency(ctx, b.id, noEst.id);
    const r = await computePlan(ctx, cal, { days: 14 });
    expect(r.tentative).toEqual([]);
    expect(r.skipped.find((s) => s.task.id === b.id)!.reason).toMatch(/blocked by #\d+ No estimate.*cannot be projected/);
  });
  it('once the blocker is done the task becomes a real block and the tentative one disappears', async () => {
    early();
    const a = add('Draft', '2026-11-13T23:59', 60);
    const b = add('Edits', '2026-11-13T23:59', 60);
    addDependency(ctx, b.id, a.id);
    completeTask(ctx, a.id);
    const r = await computePlan(ctx, cal, { days: 14 });
    expect(r.tentative).toEqual([]);
    expect(r.blocks.some((x) => x.taskId === b.id)).toBe(true);
  });
});
