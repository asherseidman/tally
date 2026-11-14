import { describe, it, expect } from 'vitest';
import { makeCtx } from './helpers';
import { addTask, getTask } from '../src/core/tasks';
import { startSession, stopSession, sessionMinutes } from '../src/core/timer';
import { fixedClock } from '../src/clock';

describe('timer', () => {
  it('records a session and sets actual_minutes to the sum', () => {
    const ctx = makeCtx('2026-09-01T10:00:00Z');
    const t = addTask(ctx, { title: 'x' });
    const s1 = startSession(ctx, t.id);
    (ctx as any).clock = fixedClock('2026-09-01T10:25:00Z');
    expect(stopSession(ctx, s1).minutes).toBe(25);
    (ctx as any).clock = fixedClock('2026-09-01T12:00:00Z');
    const s2 = startSession(ctx, t.id);
    (ctx as any).clock = fixedClock('2026-09-01T12:20:00Z');
    stopSession(ctx, s2);
    expect(getTask(ctx, t.id)!.actual_minutes).toBe(45);
    expect(ctx.db.get<any>('SELECT COUNT(*) c FROM time_sessions').c).toBe(2);
  });
  it('start marks in_progress (not done tasks)', () => {
    const ctx = makeCtx();
    const t = addTask(ctx, { title: 'x' });
    startSession(ctx, t.id);
    expect(getTask(ctx, t.id)!.status).toBe('in_progress');
  });
  it('rounds seconds to minutes; very short sessions count as at least 1 minute only if >=30s', () => {
    expect(sessionMinutes('2026-09-01T10:00:00Z', '2026-09-01T10:00:20Z')).toBe(0);
    expect(sessionMinutes('2026-09-01T10:00:00Z', '2026-09-01T10:00:40Z')).toBe(1);
    expect(sessionMinutes('2026-09-01T10:00:00Z', '2026-09-01T10:02:29Z')).toBe(2);
  });
  it('unfinished sessions are not counted; unknown/deleted task errors', () => {
    const ctx = makeCtx();
    const t = addTask(ctx, { title: 'x' });
    startSession(ctx, t.id);
    expect(getTask(ctx, t.id)!.actual_minutes).toBeNull();
    expect(() => startSession(ctx, 999)).toThrow(/999/);
  });
});
