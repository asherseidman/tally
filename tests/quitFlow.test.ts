import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers';
import { openDb } from '../src/db/index';
import { fixedClock } from '../src/clock';
import { createTerm } from '../src/core/terms';
import { addTask } from '../src/core/tasks';
import { startSession, openSessions } from '../src/core/timer';
import { resolveQuit, type QuitChoice } from '../src/app/quitFlow';
import { runningTimers, stopAll } from '../src/app/timerOps';
import { formatElapsed, trayState } from '../src/app/trayModel';
import type { Ctx } from '../src/core/ctx';

const START = '2026-11-10T17:00:00Z';
/** A real database FILE, so a "relaunch" can close it and open it again, as the app does. */
function openFile() {
  const file = join(mkdtempSync(join(tmpdir(), 'quit-')), 'planner.db');
  const open = (nowIso: string): Ctx => ({ ...makeCtx(nowIso), db: openDb(file) });
  const ctx = open(START);
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  const task = addTask(ctx, { title: 'WeBWorK 7', course: 'MATH 214', type: 'homework', due: '2026-11-15T23:59' });
  startSession(ctx, task.id);
  return { file, ctx, open, task };
}
const sessionRows = (ctx: Ctx) => ctx.db.all<{ id: number; started_at: string; ended_at: string | null }>('SELECT id, started_at, ended_at FROM time_sessions ORDER BY id');
const answer = (c: QuitChoice) => { const seen: number[] = []; return { ask: async (r: { taskId: number }[]) => { seen.push(r.length); return c; }, seen }; };

describe('quitting with a running timer (real database file, then a relaunch)', () => {
  it('no timer running: quits at once and never asks', async () => {
    const ctx = makeCtx(START);
    const a = answer('cancel');
    const r = await resolveQuit(ctx, a.ask);
    expect(r).toMatchObject({ action: 'quit', choice: null });
    expect(a.seen).toEqual([]);
  });

  it('KEEP: it quits, the session stays open with no end time, and the relaunch shows it running with the FULL elapsed time', async () => {
    const { ctx, open, task } = openFile();
    const started = sessionRows(ctx)[0].started_at;
    const a = answer('keep');
    const r = await resolveQuit(ctx, a.ask);
    expect(r).toMatchObject({ action: 'quit', choice: 'keep', stopped: [] });
    expect(a.seen).toEqual([1]); // asked exactly once
    // (a) the app goes on to quit, (b) the session is open, untouched
    expect(sessionRows(ctx)).toEqual([{ id: 1, started_at: started, ended_at: null }]);
    expect(ctx.db.get<{ m: number | null }>('SELECT actual_minutes m FROM tasks WHERE id = ?', [task.id])!.m ?? 0).toBe(0); // nothing recorded until it is stopped
    ctx.db.close(); // the app exits
    // (c) relaunch two and a half hours later, against the same file
    const again = open('2026-11-10T19:30:00Z');
    expect(sessionRows(again)).toEqual([{ id: 1, started_at: started, ended_at: null }]);
    const running = runningTimers(again);
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ sessionId: 1, taskId: task.id, startedAtMs: Date.parse(started) });
    expect(formatElapsed(again.clock.now().getTime() - running[0].startedAtMs)).toBe('2:30:00'); // not restarted from zero
    expect(trayState(again).running?.taskId).toBe(task.id); // the menu-bar icon would show it too
    // and stopping it later records the whole stretch
    expect(stopAll(again)).toEqual([{ taskId: task.id, minutes: 150, total: 150 }]);
  });

  it('STOP: it quits, the session is closed and the time is recorded; the relaunch has nothing running', async () => {
    const { ctx, open, task } = openFile();
    ctx.clock = fixedClock('2026-11-10T17:45:00Z');
    const r = await resolveQuit(ctx, answer('stop').ask);
    expect(r).toMatchObject({ action: 'quit', choice: 'stop', stopped: [{ taskId: task.id, minutes: 45, total: 45 }] });
    ctx.db.close();
    const again = open('2026-11-10T20:00:00Z');
    expect(sessionRows(again)[0].ended_at).toBe('2026-11-10T17:45:00.000Z');
    expect(runningTimers(again)).toEqual([]);
    expect(again.db.get<{ m: number }>('SELECT actual_minutes m FROM tasks WHERE id = ?', [task.id])!.m).toBe(45);
  });

  it('CANCEL: it does not quit and the timer keeps running, untouched', async () => {
    const { ctx, open } = openFile();
    const before = sessionRows(ctx);
    const r = await resolveQuit(ctx, answer('cancel').ask);
    expect(r).toMatchObject({ action: 'cancel', choice: 'cancel' });
    expect(sessionRows(ctx)).toEqual(before);
    ctx.db.close();
    expect(runningTimers(open('2026-11-10T18:00:00Z'))).toHaveLength(1);
  });

  it('if the dialog itself fails, it does not quit and loses nothing', async () => {
    const { ctx } = openFile();
    const lines: string[] = [];
    const r = await resolveQuit(ctx, async () => { throw new Error('dialog exploded'); }, (m) => lines.push(m));
    expect(r.action).toBe('cancel');
    expect(runningTimers(ctx)).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/dialog exploded/);
  });

  it('leftover open sessions (e.g. after a crash) are all handled', async () => {
    const { ctx, task } = openFile();
    startSession(ctx, task.id); // a second open session
    expect(openSessions(ctx)).toHaveLength(2);
    ctx.clock = fixedClock('2026-11-10T17:10:00Z');
    const r = await resolveQuit(ctx, answer('stop').ask);
    expect(r.stopped).toHaveLength(2);
    expect(openSessions(ctx)).toEqual([]);
  });

  it('it narrates each step so a real run can be checked in the log', async () => {
    const { ctx } = openFile();
    const lines: string[] = [];
    await resolveQuit(ctx, answer('keep').ask, (m) => lines.push(m));
    expect(lines.join('\n')).toMatch(/1 timer\(s\) running.*asking/);
    expect(lines.join('\n')).toMatch(/answer: keep/);
    expect(lines.join('\n')).toMatch(/leaving session.*open in the database/);
  });
});
