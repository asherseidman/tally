import { describe, it, expect } from 'vitest';
import { makeCtx, loc } from './helpers';
import { addTask } from '../src/core/tasks';
import { setWindow } from '../src/schedule/availabilityWindows';
import { buildWeek, clipToDay, weekStartOf } from '../src/app/week';

describe('week view', () => {
  it('starts weeks on Monday and clips intervals to a local day in wall-clock minutes', () => {
    expect(weekStartOf('2026-11-15', 'America/Detroit')).toBe('2026-11-09'); // a Sunday belongs to the week starting Monday
    expect(clipToDay({ start: loc('2026-11-09T09:30'), end: loc('2026-11-09T11:00') }, '2026-11-09', 'America/Detroit')).toEqual({ start: 570, end: 660 });
    expect(clipToDay({ start: loc('2026-11-09T22:00'), end: loc('2026-11-10T01:00') }, '2026-11-09', 'America/Detroit')).toEqual({ start: 1320, end: 1440 });
    expect(clipToDay({ start: loc('2026-11-09T22:00'), end: loc('2026-11-10T01:00') }, '2026-11-10', 'America/Detroit')).toEqual({ start: 0, end: 60 });
    expect(clipToDay({ start: loc('2026-11-09T08:00'), end: loc('2026-11-09T09:00') }, '2026-11-10', 'America/Detroit')).toBeUndefined();
  });
  it('uses wall-clock minutes across the fall-back day (a 25-hour day still reads 09:00 as 540)', () => {
    expect(clipToDay({ start: loc('2026-11-01T09:00'), end: loc('2026-11-01T10:00') }, '2026-11-01', 'America/Detroit')).toEqual({ start: 540, end: 600 });
  });
  it('returns 7 days with source, free spans (blocked removed) and the Planner Blocks scheduled that day', () => {
    const ctx = makeCtx('2026-11-09T14:00:00Z');
    ctx.db.run("INSERT INTO terms(name,start_date,end_date,is_current) VALUES('T','2026-08-31','2026-12-21',1)");
    setWindow(ctx, { weekday: 1 }, { start: '09:00', end: '17:00' }, 'free');
    setWindow(ctx, { date: '2026-11-09' }, { start: '12:00', end: '13:00' }, 'blocked');
    const t = addTask(ctx, { title: 'Exam 2', course: 'EECS 183', type: 'exam' });
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [t.id, new Date(loc('2026-11-10T10:00')).toISOString(), new Date(loc('2026-11-10T11:30')).toISOString()]);
    const w = buildWeek(ctx, '2026-11-12');
    expect(w.start).toBe('2026-11-09');
    expect(w.days.map((d) => d.weekday)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(w.days[0]).toMatchObject({ source: 'date', free: [{ start: 540, end: 720 }, { start: 780, end: 1020 }] });
    expect(w.days[1]).toMatchObject({ source: 'none', free: [] });
    expect(w.days[1].blocks).toEqual([{ start: 600, end: 690, label: 'EECS 183: Exam 2 Prep', taskId: 1, blockId: 1, startIso: '2026-11-10T15:00:00.000Z', endIso: '2026-11-10T16:30:00.000Z' }]);
    const next = buildWeek(ctx, '2026-11-16'); // the following Monday: template only
    expect(next.days[0]).toMatchObject({ source: 'template', free: [{ start: 540, end: 1020 }] });
  });
});
