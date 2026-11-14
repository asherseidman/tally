import { describe, it, expect } from 'vitest';
import { makeCtx } from './helpers';
import { fixedClock } from '../src/clock';
import { createTerm } from '../src/core/terms';
import { addTask, completeTask, deleteTask } from '../src/core/tasks';
import { startSession, stopSession, openSessions } from '../src/core/timer';
import { formatElapsed, IDLE_TITLE, truncate, trayTitle, trayState, trayMenuModel, type MenuItemModel } from '../src/app/trayModel';
import { startExclusive, stopAll, runningTimers } from '../src/app/timerOps';
import type { Ctx } from '../src/core/ctx';

const T0 = '2026-11-10T17:00:00Z'; // Tue 12:00 PM Detroit
const at = (ctx: Ctx, iso: string) => { ctx.clock = fixedClock(iso); };
function setup() {
  const ctx = makeCtx(T0);
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  return ctx;
}
const ids = (m: MenuItemModel[]): string[] => m.flatMap((x) => [x.id ?? '', ...(x.submenu ? ids(x.submenu) : [])]).filter(Boolean);
const labels = (m: MenuItemModel[]): string[] => m.flatMap((x) => [x.label ?? '', ...(x.submenu ? labels(x.submenu) : [])]).filter(Boolean);

describe('elapsed time and title', () => {
  it('M:SS under an hour, H:MM:SS after, never negative', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(59_999)).toBe('0:59');
    expect(formatElapsed(23 * 60_000 + 10_000)).toBe('23:10');
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(3_600_000 + 5 * 60_000 + 9_000)).toBe('1:05:09');
    expect(formatElapsed(30 * 3_600_000)).toBe('30:00:00');
    expect(formatElapsed(-5000)).toBe('0:00');
  });
  it('the title shows the task and elapsed time while running and a timer glyph when idle (so something shows even if the image does not)', () => {
    const now = Date.parse(T0);
    expect(IDLE_TITLE).toBe('⏱');
    expect(trayTitle(null, now)).toBe('⏱');
    expect(trayTitle({ title: 'WeBWorK 7', startedAtMs: now - 23 * 60_000 }, now)).toBe('WeBWorK 7 23:00');
    const long = trayTitle({ title: 'A very long task title that would fill the whole menu bar', startedAtMs: now - 5000 }, now, 20);
    expect(long.endsWith('… 0:05')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(20 + 1 + 4);
    // a crowded menu bar: just the time, or nothing at all
    const run = { title: 'WeBWorK 7', startedAtMs: now - 23 * 60_000 };
    expect(trayTitle(run, now, 22, 'elapsed')).toBe('23:00');
    expect(trayTitle(null, now, 22, 'elapsed')).toBe('⏱');
    expect(trayTitle(run, now, 22, 'none')).toBe('');
    expect(trayTitle(null, now, 22, 'none')).toBe('');
    expect(truncate('short', 22)).toBe('short');
    expect(truncate('x'.repeat(30), 10)).toHaveLength(10);
  });
});

describe('timer operations shared by the window and the menu bar', () => {
  it('start stops (and records) the running timer first: one at a time', () => {
    const ctx = setup();
    const a = addTask(ctx, { title: 'A', type: 'homework' });
    const b = addTask(ctx, { title: 'B', type: 'homework' });
    startExclusive(ctx, a.id);
    at(ctx, '2026-11-10T17:30:00Z');
    startExclusive(ctx, b.id);
    expect(runningTimers(ctx).map((r) => r.taskId)).toEqual([b.id]);
    expect(ctx.db.get<any>('SELECT actual_minutes m FROM tasks WHERE id = ?', [a.id]).m).toBe(30);
  });
  it('stopAll records every running timer and reports the minutes', () => {
    const ctx = setup();
    const a = addTask(ctx, { title: 'A', type: 'homework' });
    startSession(ctx, a.id);
    at(ctx, '2026-11-10T17:45:00Z');
    expect(stopAll(ctx)).toEqual([{ taskId: a.id, minutes: 45, total: 45 }]);
    expect(openSessions(ctx)).toEqual([]);
    expect(stopAll(ctx)).toEqual([]);
  });
});

describe('tray state', () => {
  it('idle: starts the most urgent due-soon task, offers the next ones, never a done or deleted task', () => {
    const ctx = setup();
    const soon = addTask(ctx, { title: 'Soon', course: 'ENG 100', type: 'homework', due: '2026-11-11T17:00' });
    const later = addTask(ctx, { title: 'Later', type: 'homework', due: '2026-11-12T17:00' });
    const done = addTask(ctx, { title: 'Done', type: 'homework', due: '2026-11-10T20:00' });
    const gone = addTask(ctx, { title: 'Gone', type: 'homework', due: '2026-11-10T21:00' });
    completeTask(ctx, done.id);
    deleteTask(ctx, gone.id);
    const st = trayState(ctx);
    expect(st.running).toBeNull();
    expect(st.startTarget).toEqual({ id: soon.id, title: 'ENG 100: Soon' });
    expect(st.candidates.map((c) => c.id)).toEqual([later.id]);
  });
  it('prefers the task you timed last, as long as it is still open', () => {
    const ctx = setup();
    const soon = addTask(ctx, { title: 'Soon', type: 'homework', due: '2026-11-11T17:00' });
    const mine = addTask(ctx, { title: 'Mine', type: 'homework', due: '2026-11-14T17:00' });
    const s = startSession(ctx, mine.id);
    at(ctx, '2026-11-10T17:20:00Z');
    stopSession(ctx, s);
    expect(trayState(ctx).startTarget?.id).toBe(mine.id);
    expect(trayState(ctx).candidates.map((c) => c.id)).toEqual([soon.id]);
    completeTask(ctx, mine.id);
    expect(trayState(ctx).startTarget?.id).toBe(soon.id); // the last-timed task is done: fall back
  });
  it('running: reports the timer and no start target', () => {
    const ctx = setup();
    const a = addTask(ctx, { title: 'A', type: 'homework', due: '2026-11-11T17:00' });
    startSession(ctx, a.id);
    const st = trayState(ctx);
    expect(st.running).toMatchObject({ taskId: a.id, title: 'A' });
    expect(st.startTarget).toBeNull();
  });
  it('nothing to time at all', () => {
    const st = trayState(setup());
    expect(st).toEqual({ running: null, startTarget: null, candidates: [] });
  });
});

describe('tray menu model', () => {
  const now = Date.parse(T0);
  it('idle: says so, offers Start for the current task, Quick add, Open Tally, Quit Tally', () => {
    const m = trayMenuModel({ running: null, startTarget: { id: 5, title: 'ENG 100: Soon' }, candidates: [{ id: 6, title: 'Later' }] }, now, { shortcut: 'CommandOrControl+Shift+Space' });
    expect(m[0]).toMatchObject({ label: 'No timer running', enabled: false });
    expect(labels(m)).toContain('Start timer: ENG 100: Soon');
    expect(ids(m)).toEqual(['start:5', 'start:6', 'quick', 'open', 'quit']);
    expect(labels(m).find((l) => l.startsWith('Quick add'))).toBe('Quick add…   (Cmd/Ctrl+Shift+Space)');
    expect(ids(m)).not.toContain('stop');
  });
  it('running: shows task and elapsed time, offers Stop (not Start) and a switch list', () => {
    const m = trayMenuModel({ running: { sessionId: 1, taskId: 5, title: 'Soon', startedAtMs: now - 90_000 }, startTarget: null, candidates: [{ id: 6, title: 'Later' }] }, now);
    expect(m[0]).toMatchObject({ label: 'Timer: Soon · 1:30', enabled: false });
    expect(ids(m)).toEqual(['stop', 'start:6', 'quick', 'open', 'quit']);
    expect(labels(m)).toContain('Switch to another task');
  });
  it('nothing to time: the Start entry is disabled, everything else is still there', () => {
    const m = trayMenuModel({ running: null, startTarget: null, candidates: [] }, now);
    expect(m.find((x) => x.label?.startsWith('Start timer'))).toMatchObject({ enabled: false });
    expect(ids(m)).toEqual(['quick', 'open', 'quit']);
  });
  it('long task names are shortened in the menu', () => {
    const m = trayMenuModel({ running: null, startTarget: { id: 1, title: 'x'.repeat(100) }, candidates: [] }, now);
    expect(labels(m).find((l) => l.startsWith('Start timer:'))!.length).toBeLessThan(70);
  });
});
