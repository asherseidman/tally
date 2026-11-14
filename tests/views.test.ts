import { describe, it, expect } from 'vitest';
import { makeCtx } from './helpers';
import { createTerm } from '../src/core/terms';
import { addTask, completeTask, editTask } from '../src/core/tasks';
import { addDependency } from '../src/core/dependencies';
import { computeViews, spanText, dueText, impactScore, DEFAULT_VIEW_SETTINGS } from '../src/core/views';
import { setSetting } from '../src/db/repo';

// now = Tue Sep 1 2026 12:00 PM Detroit (16:00Z)
const mk = () => {
  const ctx = makeCtx();
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  return ctx;
};
const add = (ctx: any, title: string, due: string | undefined, est?: number, extra: any = {}) => addTask(ctx, { title, course: 'X', due, est, ...extra });
const ids = (xs: { task: { id: number } }[]) => xs.map((x) => x.task.id);

describe('text helpers', () => {
  it('say spans in plain English', () => {
    expect(spanText(35 * 60_000)).toBe('35 min');
    expect(spanText(5 * 3_600_000)).toBe('5 hours');
    expect(spanText(3_600_000)).toBe('1 hour');
    expect(spanText(50 * 3_600_000)).toBe('2 days 2 hours');
    expect(dueText(Date.now() - 3 * 3_600_000, Date.now())).toBe('overdue by 3 hours');
  });
});

describe('Due Soon', () => {
  it('lists open tasks due within 72 hours (and overdue ones), soonest first, with a reason', () => {
    const ctx = mk();
    const late = add(ctx, 'Later', 'sep 7 5pm', 60);
    const a = add(ctx, 'Tomorrow', 'tomorrow 5pm', 90);
    const o = add(ctx, 'Overdue', 'today 9am');
    const edge = add(ctx, 'Edge', 'sep 4 11am', 30); // 71 hours away
    const done = add(ctx, 'Done', 'tomorrow 9am', 10);
    completeTask(ctx, done.id);
    add(ctx, 'No due', undefined, 10);
    const v = computeViews(ctx);
    expect(ids(v.dueSoon)).toEqual([o.id, a.id, edge.id]);
    expect(ids(v.dueSoon)).not.toContain(late.id);
    expect(v.dueSoon[0].reason).toMatch(/^overdue by 3 hours/);
    expect(v.dueSoon[1].reason).toBe('due in 29 hours, ~1.5 hours of work');
  });
  it('flags assumed times and blockers', () => {
    const ctx = mk();
    const a = add(ctx, 'A', 'tomorrow', 30);
    const b = add(ctx, 'B', 'sep 10', 30);
    addDependency(ctx, a.id, b.id);
    expect(computeViews(ctx).dueSoon[0].reason).toMatch(/blocked by #2 B.*time assumed/);
  });
  it('the window is a setting', () => {
    const ctx = mk();
    add(ctx, 'Later', 'sep 7 5pm', 60);
    expect(computeViews(ctx).dueSoon).toHaveLength(0);
    setSetting(ctx.db, 'views_due_soon_hours', '200');
    expect(computeViews(ctx).dueSoon).toHaveLength(1);
  });
});

describe('Quick Wins', () => {
  it('is estimate <= 20 minutes and unblocked, shortest first; size-based estimates count; blocked and unestimated do not', () => {
    const ctx = mk();
    const q20 = add(ctx, 'Twenty', 'sep 9', 20);
    const q5 = add(ctx, 'Five', 'sep 20', 5);
    const q21 = add(ctx, 'TwentyOne', 'sep 9', 21);
    const none = add(ctx, 'NoEst', 'sep 9');
    const blocker = add(ctx, 'Blocker', 'sep 9', 60);
    const waiting = add(ctx, 'Waiting', 'sep 9', 10);
    addDependency(ctx, waiting.id, blocker.id);
    const sized = add(ctx, 'Sized', 'sep 9', undefined, { type: 'reading' });
    editTask(ctx, sized.id, { size: { amount: 5, unit: 'pages' } }); // 15 min
    const v = computeViews(ctx);
    expect(ids(v.quickWins)).toEqual([q5.id, sized.id, q20.id]);
    for (const x of [q21, none, blocker, waiting]) expect(ids(v.quickWins)).not.toContain(x.id);
    expect(v.quickWins[0].reason).toMatch(/^5 min, due in/);
  });
  it('counts only the remaining estimate (logged time subtracted) and releases tasks when their blocker is done', () => {
    const ctx = mk();
    const t = add(ctx, 'Almost done', 'sep 9', 60);
    ctx.db.run('UPDATE tasks SET actual_minutes = 45 WHERE id = ?', [t.id]);
    const blocker = add(ctx, 'B', 'sep 9', 60);
    const w = add(ctx, 'W', 'sep 9', 10);
    addDependency(ctx, w.id, blocker.id);
    expect(ids(computeViews(ctx).quickWins)).toEqual([t.id]);
    completeTask(ctx, blocker.id);
    expect(ids(computeViews(ctx).quickWins)).toEqual([w.id, t.id]);
  });
  it('leaves out deadline-only items', () => {
    const ctx = mk();
    const e = add(ctx, 'Event', 'sep 9', 10);
    editTask(ctx, e.id, { deadlineOnly: true });
    expect(computeViews(ctx).quickWins).toEqual([]);
  });
});

describe('Blocked', () => {
  it('lists each blocked task with what is blocking it; empties as blockers finish', () => {
    const ctx = mk();
    const b1 = add(ctx, 'First', 'sep 5 5pm', 30);
    const b2 = add(ctx, 'Second', 'sep 6', 30);
    const t = add(ctx, 'Final', 'sep 8', 60);
    addDependency(ctx, t.id, b1.id);
    addDependency(ctx, t.id, b2.id);
    const v = computeViews(ctx);
    expect(ids(v.blocked)).toEqual([t.id]);
    expect(v.blocked[0].reason).toMatch(/^waiting on #1 First \(due Sat Sep 5 2026 5:00 PM\), #2 Second/);
    completeTask(ctx, b1.id);
    expect(computeViews(ctx).blocked[0].reason).not.toMatch(/First/);
    completeTask(ctx, b2.id);
    expect(computeViews(ctx).blocked).toEqual([]);
  });
});

describe('scope', () => {
  it('defaults to the current term plus term-less tasks; other terms stay out', () => {
    const ctx = mk();
    createTerm(ctx, { name: 'Spring', start_date: '2027-01-10', end_date: '2027-05-01' });
    const mine = add(ctx, 'Mine', 'tomorrow 5pm', 10);
    const other = addTask(ctx, { title: 'Other', course: 'Y', due: 'tomorrow 5pm', est: 10, term: 'Spring' });
    expect(ids(computeViews(ctx).quickWins)).toEqual([mine.id]);
    expect(ids(computeViews(ctx, { scope: { term: 'Spring' } }).quickWins)).toContain(other.id);
  });
});

describe('High Grade Impact', () => {
  const S = DEFAULT_VIEW_SETTINGS;
  it('score = weight% x urgency x effort_factor with the approved constants (7 days, 4 hours)', () => {
    expect(impactScore(10, 0, 0, S)).toBe(10);
    expect(impactScore(10, 7, 0, S)).toBeCloseTo(5);
    expect(impactScore(10, 0, 4, S)).toBeCloseTo(5);
    expect(impactScore(15, 1, 5, S)).toBeCloseTo(15 * (1 / (1 + 1 / 7)) * (1 / (1 + 5 / 4)), 6);
    expect(impactScore(10, 14, 8, S)).toBeCloseTo(10 / 3 / 3);
    expect(impactScore(10, -3, 0, S)).toBe(10); // negative days count as 0
  });
  it('ranks by score, shows weight / time left / effort in the reason, and caps at impact_limit', () => {
    const ctx = mk();
    const big = add(ctx, 'Exam', 'sep 2 5pm', 300, { weight: 15, type: 'exam' }); // 1.2 days, 5h
    const far = add(ctx, 'Project', 'sep 30 5pm', 120, { weight: 20 });
    const hw = add(ctx, 'HW', 'sep 4 5pm', 60, { weight: 1.67 });
    const v = computeViews(ctx);
    expect(ids(v.highImpact)).toEqual([big.id, far.id, hw.id]);
    expect(v.highImpact[0].reason).toBe('worth 15%, due in 29 hours, ~5 hours of work');
    expect(v.highImpact[0].score).toBeCloseTo(15 * (1 / (1 + 29 / 24 / 7)) * (1 / (1 + 5 / 4)), 4);
    setSetting(ctx.db, 'impact_limit', '2');
    expect(computeViews(ctx).highImpact).toHaveLength(2);
  });
  it('leaves out overdue, ungraded, blocked and done tasks (overdue stays in Due Soon)', () => {
    const ctx = mk();
    const over = add(ctx, 'Overdue exam', 'today 9am', 60, { weight: 15 });
    const ungraded = add(ctx, 'Ungraded', 'tomorrow', 60);
    const zero = add(ctx, 'Zero', 'tomorrow', 60, { weight: 0 });
    const blocker = add(ctx, 'Blocker', 'sep 9', 60);
    const waiting = add(ctx, 'Waiting', 'tomorrow', 60, { weight: 10 });
    addDependency(ctx, waiting.id, blocker.id);
    const done = add(ctx, 'Done', 'tomorrow', 60, { weight: 10 });
    completeTask(ctx, done.id);
    const ok = add(ctx, 'Fine', 'tomorrow', 60, { weight: 5 });
    const v = computeViews(ctx);
    expect(ids(v.highImpact)).toEqual([ok.id]);
    expect(ids(v.dueSoon)).toContain(over.id);
    for (const x of [over, ungraded, zero, waiting, done]) expect(ids(v.highImpact)).not.toContain(x.id);
    completeTask(ctx, blocker.id);
    expect(ids(computeViews(ctx).highImpact)).toContain(waiting.id);
  });
  it('a task with no estimate is assumed 60 minutes (and says so); logged time reduces the effort', () => {
    const ctx = mk();
    const a = add(ctx, 'NoEst', 'sep 5', undefined, { weight: 10 });
    const b = add(ctx, 'Logged', 'sep 5', 240, { weight: 10 });
    ctx.db.run('UPDATE tasks SET actual_minutes = 180 WHERE id = ?', [b.id]);
    const v = computeViews(ctx).highImpact;
    expect(v.find((x) => x.task.id === a.id)!.reason).toMatch(/~60 min of work \(assumed: no estimate\)/);
    expect(v.find((x) => x.task.id === b.id)!.reason).toMatch(/~60 min of work$/); // 240 - 180
  });
  it('the constants are settings', () => {
    const ctx = mk();
    const t = add(ctx, 'T', 'sep 8 12pm', 60, { weight: 10 }); // 7 days
    const base = computeViews(ctx).highImpact[0].score;
    setSetting(ctx.db, 'impact_urgency_days', '14');
    expect(computeViews(ctx).highImpact[0].score).toBeGreaterThan(base);
    expect(t.id).toBeGreaterThan(0);
  });
});
