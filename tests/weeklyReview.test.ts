import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeCtx, loc } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { createTerm } from '../src/core/terms';
import { addTask, getTask, editTask } from '../src/core/tasks';
import { setSetting, getSetting } from '../src/db/repo';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { dispatch, type ApiDeps } from '../src/app/api';
import { getReview, reviewState, applyStep, finishReview, ensureReviewClock, REVIEW_LAST_KEY } from '../src/core/review';
import { undoChange, listChanges } from '../src/core/changeLog';
import { createServer } from '../src/mcp/server';
import { CLAUDE_WRITES_KEY } from '../src/core/claudeAccess';

// Thursday 2026-11-12, 10:00 in Detroit; the last review was Thursday Nov 5
const NOW = '2026-11-12T15:00:00Z';
const DAY = 86_400_000;
let ctx: Ctx;
let app: ApiDeps;
let cal: FakeCalendar;
const iso = (ms: number) => new Date(ms).toISOString();
const ok = async (ch: string, args?: unknown) => { const r = await dispatch(app, ch, args); if (!r.ok) throw new Error((r as { error: string }).error); return r.value as any; };
const block = (taskId: number, start: string, end: string) => ctx.db.run('INSERT INTO scheduled_blocks(task_id,start,"end",google_event_id) VALUES(?,?,?,?)', [taskId, iso(loc(start)), iso(loc(end)), `ev${Math.random()}`]).lastInsertRowid;
/** everything a review step could change, to prove a read or an unconfirmed step wrote nothing */
const snapshot = () => JSON.stringify({
  tasks: ctx.db.all('SELECT * FROM tasks ORDER BY id'), sessions: ctx.db.all('SELECT * FROM time_sessions'), blocks: ctx.db.all('SELECT * FROM scheduled_blocks'),
  settings: ctx.db.all('SELECT * FROM settings ORDER BY key'), log: ctx.db.all('SELECT * FROM change_log'),
});

beforeEach(() => {
  ctx = makeCtx(NOW);
  ctx.clock = { now: () => new Date(NOW) };
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  for (const [k, v] of Object.entries({ min_block_minutes: '30', max_block_minutes: '120', buffer_minutes: '10', min_lead_minutes: '30', placement_style: 'early' })) setSetting(ctx.db, k, v);
  for (let wd = 1; wd <= 7; wd++) ctx.db.run(`INSERT INTO availability_windows(weekday, start, "end", kind) VALUES(?, '09:00', '21:00', 'free')`, [wd]);
  cal = new FakeCalendar({ calendars: [{ id: 'classcal', summary: 'Classes', busy: [] }] });
  app = { ctx, dbFile: ':memory:', demo: true, backupFolder: '/x', calendar: () => ({ calendar: cal, simulated: true }) };
  setSetting(ctx.db, REVIEW_LAST_KEY, iso(Date.parse(NOW) - 7 * DAY));
});

describe('review state and the "review due" marker', () => {
  it('is due after 7 days since the last review, and finishing clears it and remembers the date', () => {
    expect(reviewState(ctx)).toMatchObject({ due: true, daysSince: 7 });
    setSetting(ctx.db, REVIEW_LAST_KEY, iso(Date.parse(NOW) - 6.9 * DAY));
    expect(reviewState(ctx).due).toBe(false);
    setSetting(ctx.db, REVIEW_LAST_KEY, iso(Date.parse(NOW) - 8 * DAY));
    expect(reviewState(ctx).due).toBe(true);
    const s = finishReview(ctx);
    expect(s).toMatchObject({ due: false, daysSince: 0 });
    expect(s.lastReviewAt).toBe(NOW.replace('Z', '.000Z'));
  });

  it('never reviewed: not due at first use, due a week after Tally was first used', () => {
    ctx.db.run('DELETE FROM settings WHERE key = ?', [REVIEW_LAST_KEY]);
    expect(reviewState(ctx)).toEqual({ lastReviewAt: null, daysSince: null, due: false }); // a pure read does not start the clock
    ensureReviewClock(ctx);
    expect(reviewState(ctx).due).toBe(false);
    let now = Date.parse(NOW);
    ctx.clock = { now: () => new Date(now) };
    now += 7 * DAY;
    expect(reviewState(ctx).due).toBe(true);
  });

  it('the app channel shows the marker state and the review channel never writes anything but the first-seen date', async () => {
    const st = await ok('review.state');
    expect(st.due).toBe(true);
    const before = snapshot();
    await ok('review.get');
    expect(snapshot()).toBe(before);
  });
});

describe('what the review shows (reading writes nothing)', () => {
  it('finished blocks and due items since the last review; overdue and slipped; missing details within 14 days', () => {
    const hw = addTask(ctx, { title: 'Problem set', course: 'MATH 214', due: '2026-11-11 5pm', est: 90 });      // overdue, block happened
    const rd = addTask(ctx, { title: 'Reading ch 4', course: 'HIST 210', due: '2026-11-20 5pm', est: 60 });    // block happened, due later
    const doneAlready = addTask(ctx, { title: 'Quiz prep', course: 'MATH 214', due: '2026-11-14 5pm', est: 30 });
    ctx.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [doneAlready.id]);
    const noEst = addTask(ctx, { title: 'Lab report', course: 'PHYS 140', due: '2026-11-18 5pm' });             // no estimate
    const assumed = addTask(ctx, { title: 'Essay', course: 'ENG 100', due: '2026-11-19', est: 120 });           // time assumed
    const sized = addTask(ctx, { title: 'Read pages', course: 'HIST 210', due: '2026-11-17 5pm' });
    editTask(ctx, sized.id, { size: { amount: 20, unit: 'pages' } });
    ctx.db.run('UPDATE tasks SET size_amount = NULL WHERE id = ?', [sized.id]);                                   // unit known, amount unknown
    const far = addTask(ctx, { title: 'Far away', course: 'ENG 100', due: '2026-12-10 5pm' });                   // beyond 14 days
    const noDate = addTask(ctx, { title: 'Someday' });
    block(hw.id, '2026-11-09T10:00', '2026-11-09T11:30');
    block(rd.id, '2026-11-10T14:00', '2026-11-10T15:00');
    block(rd.id, '2026-11-13T14:00', '2026-11-13T15:00');                                                         // future: not shown as finished
    block(doneAlready.id, '2026-11-04T10:00', '2026-11-04T11:00');                                                // before the last review
    const before = snapshot();
    const r = getReview(ctx);
    expect(snapshot()).toBe(before);

    expect(r.since).toBe(iso(Date.parse(NOW) - 7 * DAY));
    expect(r.finished.blocks.map((b) => b.title)).toEqual(['Problem set', 'Reading ch 4']);
    expect(r.finished.blocks[0].minutes).toBe(90);
    expect(r.finished.dueItems.map((t) => t.title)).toEqual(['Problem set']);
    expect(r.slipped.map((s) => [s.title, s.reason])).toEqual([['Problem set', 'overdue'], ['Reading ch 4', 'missed_block']]);
    expect(r.slipped[0].detail).toMatch(/was due Wed Nov 11/);
    const info = Object.fromEntries(r.needsInfo.map((n) => [n.title, n.problems]));
    expect(info).toEqual({ 'Read pages': ['no_size'], 'Lab report': ['no_estimate'], Essay: ['time_assumed'] });
    expect(r.needsInfo.map((n) => n.title)).not.toContain('Far away');
    expect(r.needsInfo.map((n) => n.title)).not.toContain('Someday');
    expect(far.id).toBeGreaterThan(0); expect(noDate.id).toBeGreaterThan(0); expect(noEst.id).toBeGreaterThan(0); expect(assumed.id).toBeGreaterThan(0);
  });

  it('with no earlier review it looks back 7 days; deleted tasks and attendance never appear', () => {
    ctx.db.run('DELETE FROM settings WHERE key = ?', [REVIEW_LAST_KEY]);
    const gone = addTask(ctx, { title: 'Removed', due: '2026-11-10 5pm', est: 30 });
    ctx.db.run("UPDATE tasks SET deleted_at = 'x' WHERE id = ?", [gone.id]);
    addTask(ctx, { title: 'Lecture', type: 'attendance', due: '2026-11-13 10am' });
    const r = getReview(ctx);
    expect(r.sinceIsLastReview).toBe(false);
    expect(r.slipped).toHaveLength(0);
    expect(r.needsInfo).toHaveLength(0);
  });
});

describe('step a: what you finished (nothing is written until it is applied)', () => {
  it('Done completes, Partly logs time and keeps it open, Not done changes nothing', () => {
    const a = addTask(ctx, { title: 'A', due: '2026-11-15 5pm', est: 60 });
    const b = addTask(ctx, { title: 'B', due: '2026-11-15 5pm', est: 60 });
    const c = addTask(ctx, { title: 'C', due: '2026-11-15 5pm', est: 60 });
    const bid = block(b.id, '2026-11-10T10:00', '2026-11-10T11:00');
    const before = snapshot();
    getReview(ctx);
    expect(snapshot()).toBe(before); // choosing in the UI is local; only apply writes
    const r = applyStep(ctx, 'a', [{ taskId: a.id, result: 'done' }, { taskId: b.id, blockId: bid, result: 'partly' }, { taskId: c.id, result: 'not' }]);
    expect(r.counts).toEqual({ done: 1, partly: 1, 'not done': 1 });
    expect(getTask(ctx, a.id)!.status).toBe('done');
    expect(getTask(ctx, b.id)!.status).not.toBe('done');
    expect(getTask(ctx, b.id)!.actual_minutes).toBe(30); // half of the 60-minute block
    expect(getTask(ctx, c.id)!.actual_minutes ?? 0).toBe(0);
    expect(r.changeId).toBeGreaterThan(0);
  });

  it('Partly takes the minutes you typed, and needs minutes when there is no block', () => {
    const t = addTask(ctx, { title: 'T', est: 60 });
    expect(() => applyStep(ctx, 'a', [{ taskId: t.id, result: 'partly' }])).toThrow(/how many minutes/);
    applyStep(ctx, 'a', [{ taskId: t.id, result: 'partly', minutes: 25 }]);
    expect(getTask(ctx, t.id)!.actual_minutes).toBe(25);
  });

  it('is all-or-nothing: one bad decision writes none of them', () => {
    const a = addTask(ctx, { title: 'A', est: 30 });
    const before = snapshot();
    expect(() => applyStep(ctx, 'a', [{ taskId: a.id, result: 'done' }, { taskId: 9999, result: 'done' }])).toThrow(/no longer exists/);
    expect(snapshot()).toBe(before);
    expect(() => applyStep(ctx, 'a', [{ taskId: a.id, result: 'done' }, { taskId: a.id, result: 'not' }])).toThrow(/twice/);
    expect(snapshot()).toBe(before);
    expect(() => applyStep(ctx, 'a', [])).toThrow(/Nothing was chosen/);
  });

  it('is one entry in the shared change history and can be undone', () => {
    const a = addTask(ctx, { title: 'A', est: 30 });
    const r = applyStep(ctx, 'a', [{ taskId: a.id, result: 'done' }]);
    expect(listChanges(ctx)[0]).toMatchObject({ actor: 'review', tool: 'review_step_a' });
    undoChange(ctx, r.changeId!);
    expect(getTask(ctx, a.id)!.status).toBe('todo');
  });

  it('skips a task already done instead of failing', () => {
    const a = addTask(ctx, { title: 'A', est: 30 });
    ctx.db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [a.id]);
    const r = applyStep(ctx, 'a', [{ taskId: a.id, result: 'done' }]);
    expect(r.skipped[0]).toMatch(/already done/);
  });
});

describe('step b: overdue and slipped', () => {
  it('Reschedule due, Mark done, Drop (soft delete) and Keep', () => {
    const [r1, d1, x1, k1] = ['R', 'D', 'X', 'K'].map((n) => addTask(ctx, { title: n, due: '2026-11-10 5pm', est: 30 }));
    const out = applyStep(ctx, 'b', [{ taskId: r1.id, action: 'reschedule', due: 'fri 5pm' }, { taskId: d1.id, action: 'done' }, { taskId: x1.id, action: 'drop' }, { taskId: k1.id, action: 'keep' }]);
    expect(out.counts).toEqual({ rescheduled: 1, done: 1, dropped: 1, kept: 1 });
    expect(getTask(ctx, r1.id)!.due_date).toBe('2026-11-13T22:00:00.000Z');
    expect(getTask(ctx, d1.id)!.status).toBe('done');
    expect(getTask(ctx, x1.id)).toBeUndefined();
    expect(ctx.db.get<{ deleted_at: string | null }>('SELECT deleted_at FROM tasks WHERE id = ?', [x1.id])!.deleted_at).toBeTruthy(); // soft
    expect(getTask(ctx, k1.id)!.due_date).toBe('2026-11-10T22:00:00.000Z');
    undoChange(ctx, out.changeId!);
    expect(getTask(ctx, x1.id)).toBeTruthy();
    expect(getTask(ctx, d1.id)!.status).toBe('todo');
  });

  it('refuses a reschedule without a date or with an unreadable one, writing nothing', () => {
    const a = addTask(ctx, { title: 'A', due: '2026-11-10 5pm' });
    const b = addTask(ctx, { title: 'B', due: '2026-11-10 5pm' });
    const before = snapshot();
    expect(() => applyStep(ctx, 'b', [{ taskId: b.id, action: 'drop' }, { taskId: a.id, action: 'reschedule' }])).toThrow(/new due date/);
    expect(() => applyStep(ctx, 'b', [{ taskId: b.id, action: 'drop' }, { taskId: a.id, action: 'reschedule', due: 'gibberish xyz' }])).toThrow();
    expect(snapshot()).toBe(before);
  });
});

describe('step c: missing details with an inline fix', () => {
  it('sets an estimate, a size and a real due time', () => {
    const t = addTask(ctx, { title: 'Lab', due: '2026-11-18', type: 'project' });
    const s = addTask(ctx, { title: 'Pages', due: '2026-11-17 5pm' });
    editTask(ctx, s.id, { size: { amount: 5, unit: 'pages' } });
    ctx.db.run('UPDATE tasks SET size_amount = NULL, estimated_minutes = NULL, estimate_source = NULL WHERE id = ?', [s.id]);
    const r = applyStep(ctx, 'c', [{ taskId: t.id, estimate: 90, due: 'nov 18 5pm' }, { taskId: s.id, sizeAmount: 30 }]);
    expect(r.counts).toEqual({ fixed: 2 });
    const lab = getTask(ctx, t.id)!;
    expect(lab).toMatchObject({ estimated_minutes: 90, time_assumed: 0, due_date: '2026-11-18T22:00:00.000Z' });
    expect(getTask(ctx, s.id)).toMatchObject({ size_amount: 30, size_unit: 'pages' });
    expect(getTask(ctx, s.id)!.estimated_minutes).toBeGreaterThan(0); // the size-based estimate
    expect(getReview(ctx).needsInfo).toHaveLength(0);
  });

  it('needs a unit when the task has none; empty rows are skipped; bad numbers refuse the whole step', () => {
    const t = addTask(ctx, { title: 'T', due: '2026-11-18 5pm' });
    expect(() => applyStep(ctx, 'c', [{ taskId: t.id, sizeAmount: 10 }])).toThrow(/measured in/);
    expect(applyStep(ctx, 'c', [{ taskId: t.id }]).skipped[0]).toMatch(/nothing entered/);
    const before = snapshot();
    expect(() => applyStep(ctx, 'c', [{ taskId: t.id, estimate: 0 }])).toThrow();
    expect(snapshot()).toBe(before);
  });
});

describe('step d: the replan is the Schedule screen\'s own preview and apply', () => {
  it('the 14-day replan preview writes nothing; Apply needs confirm and the matching fingerprint; then it writes', async () => {
    addTask(ctx, { title: 'Essay', course: 'ENG 100', due: '2026-11-16 8pm', est: 120, type: 'homework' });
    const before = snapshot();
    const p = await ok('schedule.preview', { days: 14, replan: true });
    expect(snapshot()).toBe(before);
    expect(p).toMatchObject({ replan: true, days: 14, simulated: true });
    expect(p.willWrite).toBeGreaterThan(0);
    const noConfirm = await dispatch(app, 'schedule.apply', { days: 14, replan: true, fingerprint: p.fingerprint });
    expect(noConfirm.ok).toBe(false);
    expect(ctx.db.all('SELECT * FROM scheduled_blocks')).toHaveLength(0);
    const a = await ok('schedule.apply', { days: 14, replan: true, fingerprint: p.fingerprint, confirm: true });
    expect(a.created).toBeGreaterThan(0);
    expect(ctx.db.all('SELECT * FROM scheduled_blocks').length).toBeGreaterThan(0);
  });
});

describe('the app channels and the connector', () => {
  it('review.apply validates, applies one step, and review.finish stores the date', async () => {
    const t = addTask(ctx, { title: 'T', due: '2026-11-10 5pm', est: 30 });
    await expect(ok('review.apply', { step: 'z', decisions: [{}] })).rejects.toThrow();
    await expect(ok('review.apply', { step: 'b', decisions: [] })).rejects.toThrow();
    const r = await ok('review.apply', { step: 'b', decisions: [{ taskId: t.id, action: 'done' }] });
    expect(r.summary).toBe('1 done');
    const f = await ok('review.finish');
    expect(f.due).toBe(false);
    expect(getSetting(ctx.db, REVIEW_LAST_KEY)).toBe(f.lastReviewAt);
    expect((await ok('review.get')).sinceIsLastReview).toBe(true);
  });

  it('get_review is read only: it shows the review and writes nothing, even with every switch on', async () => {
    setSetting(ctx.db, CLAUDE_WRITES_KEY, 'true');
    addTask(ctx, { title: 'Overdue one', due: '2026-11-10 5pm', est: 30 });
    const server = createServer({ ctx, target: { dbFile: '/tmp/t.db', kind: 'test', label: 'TEST database' }, backupFolder: '/x' });
    const client = new Client({ name: 't', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'get_review')!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect((await client.listTools()).tools.map((t) => t.name).filter((n) => n.includes('review') && !n.startsWith('preview'))).toEqual(['get_review']); // no way to answer or finish it
    const before = snapshot().replace(/"connector_calls".*/, '');
    const res = (await client.callTool({ name: 'get_review', arguments: {} })) as { content: { text: string }[] };
    const data = JSON.parse(res.content[0].text);
    expect(data.slipped.map((s: { title: string }) => s.title)).toEqual(['Overdue one']);
    expect(data.state.due).toBe(true);
    expect(snapshot().replace(/"connector_calls".*/, '')).toBe(before);
    await client.close(); await server.close();
  });
});
void afterEach;
