import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeCtx, loc } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { openDb, checkDatabaseFile } from '../src/db/index';
import { MIGRATIONS } from '../src/db/schema';
import { backupBeforeMigration } from '../src/cli/context';
import { createTerm } from '../src/core/terms';
import { addTask, completeTask, editTask, getTask } from '../src/core/tasks';
import { setSetting } from '../src/db/repo';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { computePlan, applyPlan } from '../src/schedule/service';
import { checkPin, createPin, removePin, listPins, pinsForPlan } from '../src/schedule/pins';
import { dispatch, processConnectorJobs, type ApiDeps } from '../src/app/api';
import { buildWeek } from '../src/app/week';
import { createServer } from '../src/mcp/server';
import { ReconnectRequiredError } from '../src/schedule/googleCalendar';
import { CLAUDE_WRITES_KEY } from '../src/core/claudeAccess';

// Thursday 2026-11-12, 10:00 in Detroit
const NOW = '2026-11-12T15:00:00Z';
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const CAL_NAME = 'Secret Class Calendar';

let ctx: Ctx;
let clockMs: number;
let cal: FakeCalendar;
let busy: { start: number; end: number }[];
let app: ApiDeps;
const tick = (ms: number) => { clockMs += ms; };

function setup() {
  ctx = makeCtx(NOW);
  clockMs = Date.parse(NOW);
  ctx.clock = { now: () => new Date(clockMs) };
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  for (const [k, v] of Object.entries({ min_block_minutes: '30', max_block_minutes: '120', buffer_minutes: '10', min_lead_minutes: '30', placement_style: 'early', exam_duration_minutes: '120' })) setSetting(ctx.db, k, v);
  for (let wd = 1; wd <= 7; wd++) ctx.db.run(`INSERT INTO availability_windows(weekday, start, "end", kind) VALUES(?, '09:00', '21:00', 'free')`, [wd]);
  // Friday has its own windows: free 9-21 with 12-13 blocked
  ctx.db.run(`INSERT INTO availability_windows(date, start, "end", kind) VALUES('2026-11-13', '09:00', '21:00', 'free'), ('2026-11-13', '12:00', '13:00', 'blocked')`);
  busy = [{ start: loc('2026-11-12T11:00'), end: loc('2026-11-12T12:00') }, { start: loc('2026-11-13T10:00'), end: loc('2026-11-13T11:00') }];
  cal = new FakeCalendar({ calendars: [{ id: 'classcal', summary: CAL_NAME, busy }] });
  app = { ctx, dbFile: ':memory:', demo: true, backupFolder: '/x', calendar: () => ({ calendar: cal, simulated: true }) };
}
beforeEach(setup);

const essay = () => addTask(ctx, { title: 'Essay', course: 'ENG 100', type: 'homework', due: '2026-11-13 8pm', est: 120 });
const lab = () => addTask(ctx, { title: 'Lab report', course: 'PHYS 140', type: 'project', due: '2026-11-18 5pm', est: 120 });
const ok = async (ch: string, args?: unknown) => { const r = await dispatch(app, ch, args); if (!r.ok) throw new Error((r as { error: string }).error); return r.value as any; };

describe('schema v6 migration', () => {
  it('takes a verified backup first, keeps every row, adds pins and pin_id, and accepts the new job kinds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig6-'));
    const file = join(dir, 'planner.db');
    const raw = new BetterSqlite3(file);
    for (let v = 0; v < 5; v++) raw.exec(MIGRATIONS[v]);
    raw.pragma('user_version = 5');
    raw.exec(`INSERT INTO terms(name,start_date,end_date,is_current) VALUES('T','2026-08-31','2026-12-21',1);
      INSERT INTO tasks(id,title,term_id,created_at,updated_at) VALUES(1,'a',1,'x','x');
      INSERT INTO scheduled_blocks(task_id,start,"end",google_event_id) VALUES(1,'2026-11-12T15:00:00.000Z','2026-11-12T16:00:00.000Z','ev1');
      INSERT INTO connector_jobs(id,kind,status,created_at,updated_at,request) VALUES('j1','apply','applied','x','x','{}'), ('j2','preview','ready','x','x','{"days":7}');
      INSERT INTO connector_calls(at,tool,ok,detail) VALUES('x','tally_status',1,'ok');
      INSERT INTO change_log(at,actor,tool,summary,details) VALUES('x','claude','add_task','s','{"tasks":[],"depsAdded":[],"depsRemoved":[],"sessionsAdded":[],"sessionsRemoved":[]}');`);
    raw.close();

    const backups = join(dir, 'bk');
    const saved = await backupBeforeMigration(file, backups);
    expect(saved).toBeTruthy();
    expect(readdirSync(backups).some((n) => /^pre-migration-v5-to-v\d+-/.test(n))).toBe(true);
    expect(checkDatabaseFile(saved!).ok).toBe(true);
    const old = new BetterSqlite3(saved!, { readonly: true });
    expect(old.pragma('user_version', { simple: true })).toBe(5);
    old.close();

    const db = openDb(file);
    expect(db.get<{ v: number }>('SELECT user_version v FROM pragma_user_version')!.v).toBe(MIGRATIONS.length);
    expect(db.all('SELECT id, kind, status FROM connector_jobs ORDER BY id')).toEqual([{ id: 'j1', kind: 'apply', status: 'applied' }, { id: 'j2', kind: 'preview', status: 'ready' }]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM connector_calls')!.n).toBe(1);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM change_log')!.n).toBe(1);
    expect(db.get('SELECT task_id, google_event_id, pin_id FROM scheduled_blocks')).toEqual({ task_id: 1, google_event_id: 'ev1', pin_id: null });
    db.run("INSERT INTO connector_jobs(id,kind,status,created_at,updated_at,request) VALUES('j3','freetime','requested','x','x','{}'), ('j4','conflicts','requested','x','x','{}')");
    expect(() => db.run("INSERT INTO connector_jobs(id,kind,status,created_at,updated_at,request) VALUES('j5','approve','x','x','x','{}')")).toThrow(/CHECK/);
    db.run("INSERT INTO pins(task_id,start,\"end\",created_at,updated_at) VALUES(1,'2026-11-12T15:00:00.000Z','2026-11-12T16:00:00.000Z','x','x')");
    expect(() => db.run("INSERT INTO pins(task_id,start,\"end\",created_at,updated_at) VALUES(1,'b','a','x','x')")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO pins(task_id,start,\"end\",created_at,updated_at) VALUES(99,'a','b','x','x')")).toThrow(/FOREIGN KEY/);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('where a block may be pinned (plain-language refusals, with suggestions)', () => {
  const at = (taskId: number, a: string, b: string, pinId?: number) => checkPin(ctx, { taskId, start: loc(a), end: loc(b), pinId }, busy);

  it('accepts free time that is clear of everything', () => {
    const t = essay();
    expect(at(t.id, '2026-11-12T14:00', '2026-11-12T15:00')).toEqual({ ok: true });
  });

  it('refuses a block shorter or longer than the block limits', () => {
    const t = essay();
    const short = at(t.id, '2026-11-12T14:00', '2026-11-12T14:15');
    expect(short).toMatchObject({ ok: false, reason: 'length' });
    expect((short as any).message).toMatch(/between 30 and 120 minutes long.*this one is 15/);
    expect(at(t.id, '2026-11-12T13:00', '2026-11-12T15:30')).toMatchObject({ ok: false, reason: 'length' });
  });

  it('refuses times not on 5-minute marks, in the past, or after the due time', () => {
    const t = essay();
    expect(checkPin(ctx, { taskId: t.id, start: loc('2026-11-12T14:00') + 60_000, end: loc('2026-11-12T15:00') }, busy)).toMatchObject({ reason: 'grid' });
    expect(at(t.id, '2026-11-12T09:00', '2026-11-12T10:00')).toMatchObject({ reason: 'past' });
    const late = at(t.id, '2026-11-13T19:30', '2026-11-13T20:30');
    expect(late).toMatchObject({ reason: 'after_due' });
    expect((late as any).message).toMatch(/after “Essay” is due \(Fri Nov 13, 8:00 PM\)/);
  });

  it('refuses blocked availability and time outside your available hours, naming the free time', () => {
    const t = essay();
    const blocked = at(t.id, '2026-11-13T12:30', '2026-11-13T13:30');
    expect(blocked).toMatchObject({ reason: 'blocked' });
    expect((blocked as any).message).toMatch(/blocked in Availability \(12:00 PM–1:00 PM\)/);
    const outside = at(t.id, '2026-11-12T21:00', '2026-11-12T22:00');
    expect(outside).toMatchObject({ reason: 'outside' });
    expect((outside as any).message).toMatch(/outside your available time on Thursday \(free: 9:00 AM–9:00 PM\)/);
  });

  it('refuses busy time on your calendar (a class), without naming the event or calendar', () => {
    const t = essay();
    const r = at(t.id, '2026-11-12T11:30', '2026-11-12T12:30') as any;
    expect(r).toMatchObject({ ok: false, reason: 'busy' });
    expect(r.message).toMatch(/busy time on your calendar \(11:30 AM–12:00 PM\)/);
    expect(r.message).not.toContain(CAL_NAME);
  });

  it('refuses an exam window, another pin and another task\'s planned block', () => {
    const t = essay();
    const l = lab();
    addTask(ctx, { title: 'Exam 2', course: 'MATH 115', type: 'exam', due: '2026-11-14 6:30pm' });
    expect(at(l.id, '2026-11-14T18:00', '2026-11-14T19:00')).toMatchObject({ reason: 'exam' });
    createPin(ctx, l.id, loc('2026-11-12T16:00'), loc('2026-11-12T17:00'));
    const p = at(t.id, '2026-11-12T16:30', '2026-11-12T17:30') as any;
    expect(p).toMatchObject({ reason: 'pin' });
    expect(p.message).toMatch(/another pinned block, “PHYS 140: Lab report” \(4:00 PM–5:00 PM\)/);
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [l.id, iso(loc('2026-11-12T18:00')), iso(loc('2026-11-12T19:00'))]);
    expect(at(t.id, '2026-11-12T18:30', '2026-11-12T19:30')).toMatchObject({ reason: 'block' });
    // its own other planned blocks are not in the way (they are re-placed around the pin)
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [t.id, iso(loc('2026-11-12T19:30')), iso(loc('2026-11-12T20:30'))]);
    expect(at(t.id, '2026-11-12T19:30', '2026-11-12T20:30')).toEqual({ ok: true });
  });

  it('suggests where it can go: same length, on the same day first, closest to the drop, and every suggestion is itself valid', () => {
    const t = essay();
    const r = at(t.id, '2026-11-12T11:30', '2026-11-12T12:30') as any;
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions.length).toBeLessThanOrEqual(3);
    for (const s of r.suggestions) {
      expect(Date.parse(s.end) - Date.parse(s.start)).toBe(60 * MIN);
      expect(checkPin(ctx, { taskId: t.id, start: Date.parse(s.start), end: Date.parse(s.end) }, busy)).toEqual({ ok: true });
      expect(s.label).toMatch(/^Thu Nov 12, /);
    }
  });

  it('moving a pin ignores the pin itself', () => {
    const t = essay();
    const p = createPin(ctx, t.id, loc('2026-11-12T14:00'), loc('2026-11-12T15:00'));
    expect(at(t.id, '2026-11-12T14:30', '2026-11-12T15:30', p.id)).toEqual({ ok: true });
  });
});

describe('the planner keeps pinned blocks', () => {
  const blocksOf = (r: Awaited<ReturnType<typeof computePlan>>, taskId: number) => r.blocks.filter((b) => b.taskId === taskId);

  it('a pinned block is fixed, written exactly there, and counts toward its task', async () => {
    const t = essay(); // 120 min
    createPin(ctx, t.id, loc('2026-11-12T19:00'), loc('2026-11-12T20:00'));
    const r = await computePlan(ctx, cal, { days: 7 });
    const mine = blocksOf(r, t.id);
    expect(mine.filter((b) => b.pinned)).toEqual([expect.objectContaining({ start: loc('2026-11-12T19:00'), end: loc('2026-11-12T20:00'), pinned: true })]);
    const auto = mine.filter((b) => !b.pinned).reduce((s, b) => s + (b.end - b.start), 0) / MIN;
    expect(auto).toBe(60); // 120 minus the 60 pinned
    // parts are numbered across pinned and automatic blocks, in time order
    expect(mine.map((b) => `${b.part}/${b.parts}`)).toEqual(mine.map((_, i) => `${i + 1}/${mine.length}`));
  });

  it('a pin that covers the whole estimate leaves no automatic blocks for that task', async () => {
    const t = addTask(ctx, { title: 'Short', course: 'ENG 100', due: '2026-11-13 8pm', est: 60 });
    createPin(ctx, t.id, loc('2026-11-12T19:00'), loc('2026-11-12T20:00'));
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(blocksOf(r, t.id)).toEqual([expect.objectContaining({ pinned: true })]);
  });

  it('other tasks are planned around a pin, with the usual gap', async () => {
    const t = essay();
    const l = lab();
    const p = createPin(ctx, t.id, loc('2026-11-12T13:00'), loc('2026-11-12T15:00'));
    void p;
    const r = await computePlan(ctx, cal, { days: 7 });
    for (const b of r.blocks.filter((x) => !x.pinned)) {
      const clear = b.end + 10 * MIN <= loc('2026-11-12T13:00') || b.start >= loc('2026-11-12T15:00') + 10 * MIN;
      expect(clear, `#${b.taskId} ${new Date(b.start).toISOString()}`).toBe(true);
    }
    expect(r.blocks.some((b) => b.taskId === l.id)).toBe(true);
  });

  it('a task the planner would skip (no estimate) still gets its pinned block written', async () => {
    const t = addTask(ctx, { title: 'Read', course: 'ENG 100', due: '2026-11-13 8pm' });
    createPin(ctx, t.id, loc('2026-11-12T19:00'), loc('2026-11-12T20:00'));
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(blocksOf(r, t.id)).toEqual([expect.objectContaining({ pinned: true })]);
    const res = await applyPlan(ctx, cal, r);
    expect(res.created).toBeGreaterThan(0);
    expect(cal.writes.filter((w) => w.op === 'createEvent').some((w: any) => w.summary === 'ENG 100: Read')).toBe(true);
  });

  it('a pin beyond the horizon is still included, so an apply never takes it off the calendar', async () => {
    const t = lab();
    createPin(ctx, t.id, loc('2026-11-17T14:00'), loc('2026-11-17T15:00'));
    const r = await computePlan(ctx, cal, { days: 2 });
    expect(r.blocks.some((b) => b.pinned && b.taskId === t.id)).toBe(true);
  });

  it('Apply writes a pinned block at its pinned time, linked to its pin, and a replan days later keeps it', async () => {
    const t = lab();
    const pin = createPin(ctx, t.id, loc('2026-11-16T14:00'), loc('2026-11-16T15:30'));
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }));
    const row = () => ctx.db.get<any>('SELECT start, "end", pin_id, google_event_id FROM scheduled_blocks WHERE pin_id = ?', [pin.id]);
    expect(row()).toMatchObject({ start: iso(loc('2026-11-16T14:00')), end: iso(loc('2026-11-16T15:30')), pin_id: pin.id });
    // two days later, replan (which removes missed blocks and re-places everything else)
    tick(2 * 86_400_000);
    for (let i = 0; i < 3; i++) {
      const r = await computePlan(ctx, cal, { days: 7 });
      expect(r.blocks.filter((b) => b.pinned)).toEqual([expect.objectContaining({ start: loc('2026-11-16T14:00'), end: loc('2026-11-16T15:30'), pinId: pin.id })]);
      await applyPlan(ctx, cal, r, { replan: true });
      expect(row()).toMatchObject({ start: iso(loc('2026-11-16T14:00')), end: iso(loc('2026-11-16T15:30')) });
    }
    expect(listPins(ctx)).toHaveLength(1);
  });

  it('a pinned block in progress at apply time is rewritten whole, not trimmed', async () => {
    const t = lab();
    const pin = createPin(ctx, t.id, loc('2026-11-12T14:00'), loc('2026-11-12T15:30'));
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }));
    clockMs = loc('2026-11-12T14:45');
    const res = await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }));
    expect(res.trimmed).toEqual([]);
    expect(ctx.db.all('SELECT start, "end" FROM scheduled_blocks WHERE pin_id = ?', [pin.id])).toEqual([{ start: iso(loc('2026-11-12T14:00')), end: iso(loc('2026-11-12T15:30')) }]);
  });

  it('a past pinned block stays as history, even on replan', async () => {
    const t = lab();
    const pin = createPin(ctx, t.id, loc('2026-11-12T14:00'), loc('2026-11-12T15:00'));
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }));
    clockMs = loc('2026-11-12T17:00');
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }), { replan: true });
    expect(ctx.db.get('SELECT 1 FROM scheduled_blocks WHERE pin_id = ?', [pin.id])).toBeDefined();
  });

  it('when the task is done, the pin is left out with a warning (not silently kept)', async () => {
    const t = lab();
    createPin(ctx, t.id, loc('2026-11-16T14:00'), loc('2026-11-16T15:00'));
    completeTask(ctx, t.id);
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.some((b) => b.pinned)).toBe(false);
    expect(r.pinWarnings).toEqual([expect.objectContaining({ reason: 'done', taskId: t.id })]);
    expect(r.pinWarnings[0].message).toMatch(/is done, so its pinned block Mon Nov 16, 2:00 PM–3:00 PM is left out\. Unpin it/);
  });

  it('when the due date moves earlier than the pin, it is left out with a warning', async () => {
    const t = lab();
    createPin(ctx, t.id, loc('2026-11-16T14:00'), loc('2026-11-16T15:00'));
    editTask(ctx, t.id, { due: '2026-11-15 5pm' });
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.some((b) => b.pinned)).toBe(false);
    expect(r.pinWarnings).toEqual([expect.objectContaining({ reason: 'after_due' })]);
    expect(r.pinWarnings[0].message).toMatch(/now due Sun Nov 15, 5:00 PM, before its pinned block/);
  });

  it('a pin that now overlaps new busy time is kept where you put it, with a note', async () => {
    const t = lab();
    createPin(ctx, t.id, loc('2026-11-16T14:00'), loc('2026-11-16T15:00'));
    busy.push({ start: loc('2026-11-16T14:30'), end: loc('2026-11-16T16:00') });
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.some((b) => b.pinned)).toBe(true);
    expect(r.pinWarnings).toEqual([expect.objectContaining({ reason: 'busy' })]);
  });

  it('after Unpin, the next plan places the work automatically', async () => {
    const t = lab();
    const p = createPin(ctx, t.id, loc('2026-11-16T14:00'), loc('2026-11-16T15:00'));
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }));
    removePin(ctx, p.id);
    expect(ctx.db.get<any>('SELECT pin_id FROM scheduled_blocks WHERE start = ?', [iso(loc('2026-11-16T14:00'))]).pin_id).toBeNull();
    const r = await computePlan(ctx, cal, { days: 7 });
    expect(r.blocks.filter((b) => b.taskId === t.id).every((b) => !b.pinned)).toBe(true);
    expect(r.blocks.filter((b) => b.taskId === t.id).reduce((s, b) => s + b.end - b.start, 0) / MIN).toBe(120);
  });
});

describe('the app API for pins', () => {
  it('pins.create refuses with data (message and suggestions), then pins; the week and the preview show it', async () => {
    const t = essay();
    const no = await ok('pins.create', { taskId: t.id, start: iso(loc('2026-11-12T11:30')), end: iso(loc('2026-11-12T12:30')) });
    expect(no).toMatchObject({ ok: false, reason: 'busy' });
    expect(no.suggestions.length).toBeGreaterThan(0);
    expect(listPins(ctx)).toEqual([]);
    const yes = await ok('pins.create', { taskId: t.id, start: no.suggestions[0].start, end: no.suggestions[0].end });
    expect(yes).toMatchObject({ ok: true, pin: { taskId: t.id, start: no.suggestions[0].start } });
    const w = buildWeek(ctx, '2026-11-12');
    expect(w.days[3].blocks).toEqual([expect.objectContaining({ taskId: t.id, pinId: yes.pin.id })]);
    expect(w.days[3].blocks[0].blockId).toBeUndefined(); // not on the calendar yet
    const p = await ok('schedule.preview', { days: 7, replan: false });
    expect(p.blocks.filter((b: any) => b.pinned)).toEqual([expect.objectContaining({ taskId: t.id, pinId: yes.pin.id, start: no.suggestions[0].start })]);
  });

  it('pins.move checks the new place; pins.unpin removes it', async () => {
    const t = essay();
    const a = await ok('pins.create', { taskId: t.id, start: iso(loc('2026-11-12T14:00')), end: iso(loc('2026-11-12T15:00')) });
    expect(await ok('pins.move', { pinId: a.pin.id, start: iso(loc('2026-11-12T21:00')), end: iso(loc('2026-11-12T22:00')) })).toMatchObject({ ok: false, reason: 'outside' });
    expect(await ok('pins.move', { pinId: a.pin.id, start: iso(loc('2026-11-12T16:00')), end: iso(loc('2026-11-12T17:30')) })).toMatchObject({ ok: true }); // moved and resized
    expect(listPins(ctx)[0]).toMatchObject({ start: iso(loc('2026-11-12T16:00')), end: iso(loc('2026-11-12T17:30')) });
    expect(await ok('pins.unpin', { pinId: a.pin.id })).toMatchObject({ ok: true, taskId: t.id });
    expect(listPins(ctx)).toEqual([]);
    expect((await dispatch(app, 'pins.unpin', { pinId: a.pin.id })).ok).toBe(false);
    expect((await dispatch(app, 'pins.create', { taskId: t.id, start: 'tomorrow', end: 'later' })).ok).toBe(false);
  });

  it('adding a pin changes the plan fingerprint: an apply of the older preview is refused', async () => {
    const t = lab();
    const before = await ok('schedule.preview', { days: 7, replan: false });
    await ok('pins.create', { taskId: t.id, start: iso(loc('2026-11-16T14:00')), end: iso(loc('2026-11-16T15:00')) });
    const r = await dispatch(app, 'schedule.apply', { days: 7, replan: false, confirm: true, fingerprint: before.fingerprint });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/plan changed since you previewed/);
  });

  it('an expired Google sign-in during a pin check comes back with the Reconnect code', async () => {
    const t = essay();
    app.calendar = () => { throw new ReconnectRequiredError('invalid_grant'); };
    const r = (await dispatch(app, 'pins.create', { taskId: t.id, start: iso(loc('2026-11-12T14:00')), end: iso(loc('2026-11-12T15:00')) })) as any;
    expect(r).toMatchObject({ ok: false, code: 'google_reconnect' });
    expect(listPins(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------- the connector
describe('the connector: pinned state is visible, pins cannot be made or removed, Google busy time without titles', () => {
  let client: Client;
  let pump: ReturnType<typeof setInterval> | undefined;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content.map((c) => c.text).join('\n');
    let data: any; try { data = JSON.parse(text); } catch { /* text */ }
    return { error: !!r.isError, text, data };
  };
  beforeEach(async () => {
    process.env.TALLY_MCP_GOOGLE_WAIT_MS = '400';
    process.env.TALLY_MCP_PREVIEW_WAIT_MS = '5000';
    const server = createServer({ ctx, target: { dbFile: '/tmp/t.db', kind: 'test', label: 'TEST database' }, backupFolder: '/x' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: 't', version: '1' });
    await client.connect(a);
  });
  afterEach(async () => { if (pump) clearInterval(pump); pump = undefined; await client.close(); delete process.env.TALLY_MCP_GOOGLE_WAIT_MS; delete process.env.TALLY_MCP_PREVIEW_WAIT_MS; });
  const appOpen = () => { pump = setInterval(() => { void processConnectorJobs(app); }, 30); };

  it('has no tool that creates, moves or removes a pin (read only), even with every switch on', async () => {
    setSetting(ctx.db, CLAUDE_WRITES_KEY, 'true');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /pin/.test(n))).toEqual([]);
    for (const t of (await client.listTools()).tools) expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/"pin/i);
  });

  it('previews say which blocks are pinned, and list pinned blocks the plan left out', async () => {
    const t = lab();
    const done = addTask(ctx, { title: 'Old', course: 'X', due: '2026-11-18', est: 30 });
    createPin(ctx, t.id, loc('2026-11-16T14:00'), loc('2026-11-16T15:00'));
    createPin(ctx, done.id, loc('2026-11-16T16:00'), loc('2026-11-16T17:00'));
    completeTask(ctx, done.id);
    appOpen();
    const p = (await call('preview_schedule', { days: 7 })).data;
    expect(p.blocks.filter((b: any) => b.pinned)).toEqual([expect.objectContaining({ taskId: t.id, start: iso(loc('2026-11-16T14:00')) })]);
    expect(p.blocks.filter((b: any) => !b.pinned).length).toBeGreaterThan(0);
    expect(p.pinnedBlockWarnings).toEqual([expect.objectContaining({ taskId: done.id, reason: 'done' })]);
  });

  it('get_schedule marks pinned blocks and lists pins not on the calendar yet', async () => {
    const t = lab();
    const pin = createPin(ctx, t.id, loc('2026-11-16T14:00'), loc('2026-11-16T15:00'));
    let s = (await call('get_schedule', { days: 7 })).data;
    expect(s.pinnedNotOnCalendarYet).toEqual([expect.objectContaining({ taskId: t.id, start: iso(loc('2026-11-16T14:00')) })]);
    expect(s.conflicts).toBeNull();
    await applyPlan(ctx, cal, await computePlan(ctx, cal, { days: 7 }));
    s = (await call('get_schedule', { days: 7 })).data;
    expect(s.pinnedNotOnCalendarYet).toEqual([]);
    expect(s.blocks.filter((b: any) => b.pinned)).toEqual([expect.objectContaining({ taskId: t.id })]);
    expect(s.blocks.some((b: any) => !b.pinned)).toBe(true);
    void pin;
  });

  it('get_free_time include_google: availability minus Google busy minus Tally blocks, free intervals only, no names', async () => {
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [essay().id, iso(loc('2026-11-12T15:00')), iso(loc('2026-11-12T16:00'))]);
    appOpen();
    const r = await call('get_free_time', { start_date: '2026-11-12', days: 2, include_google: true });
    expect(r.error).toBe(false);
    expect(r.data.googleIncluded).toBe(true);
    expect(r.data.days[0]).toMatchObject({ date: '2026-11-12', free: [{ start: '09:00', end: '11:00' }, { start: '12:00', end: '15:00' }, { start: '16:00', end: '21:00' }], freeMinutes: 120 + 180 + 300 });
    // Friday: own windows (12-13 blocked) minus the 10-11 class
    expect(r.data.days[1].free).toEqual([{ start: '09:00', end: '10:00' }, { start: '11:00', end: '12:00' }, { start: '13:00', end: '21:00' }]);
    expect(r.text).not.toContain(CAL_NAME);
    expect(r.text).not.toContain('classcal');
    expect(r.text).not.toMatch(/busy"\s*:\s*\[/); // busy intervals themselves are never returned
    // and nothing secret stayed in the job row either
    expect(JSON.stringify(ctx.db.all('SELECT result FROM connector_jobs'))).not.toContain(CAL_NAME);
  });

  it('without include_google the old Tally-only answer is unchanged', async () => {
    const r = (await call('get_free_time', { start_date: '2026-11-12', days: 1 })).data;
    expect(r).toMatchObject({ googleIncluded: false, note: 'Google Calendar events are not included.' });
    expect(r.days[0].free).toEqual([{ start: '09:00', end: '21:00' }]);
  });

  it('with Tally closed it returns the Tally-only answer plus a clear warning', async () => {
    const r = (await call('get_free_time', { start_date: '2026-11-12', days: 1, include_google: true })).data;
    expect(r.googleIncluded).toBe(false);
    expect(r.days[0].free).toEqual([{ start: '09:00', end: '21:00' }]);
    expect(r.warning).toMatch(/Google Calendar events are NOT included: Tally is not open/);
  });

  it('with Google disconnected it returns the Tally-only answer plus the reconnect message', async () => {
    app.calendar = () => { throw new ReconnectRequiredError('invalid_grant'); };
    appOpen();
    const r = (await call('get_free_time', { start_date: '2026-11-12', days: 1, include_google: true })).data;
    expect(r.googleIncluded).toBe(false);
    expect(r.warning).toMatch(/Google Calendar events are NOT included: .*Reconnect/);
    expect(r.days[0].free).toEqual([{ start: '09:00', end: '21:00' }]);
  });

  it('get_schedule include_google lists planned blocks that overlap busy time, without describing the busy time', async () => {
    const t = essay();
    ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?), (?,?,?)', [t.id, iso(loc('2026-11-12T11:30')), iso(loc('2026-11-12T12:30')), t.id, iso(loc('2026-11-12T14:00')), iso(loc('2026-11-12T15:00'))]);
    appOpen();
    const r = await call('get_schedule', { days: 3, include_google: true });
    expect(r.data.googleIncluded).toBe(true);
    expect(r.data.conflicts).toEqual([expect.objectContaining({ taskId: t.id, title: 'Essay', start: iso(loc('2026-11-12T11:30')), overlapMinutes: 30, pinned: false })]);
    expect(r.text).not.toContain(CAL_NAME);
    // Tally closed: conflicts unknown, with a warning
    if (pump) clearInterval(pump);
    pump = undefined;
    const closed = (await call('get_schedule', { days: 3, include_google: true })).data;
    expect(closed.conflicts).toBeNull();
    expect(closed.warning).toMatch(/Tally is not open/);
  });

  it('input limits: include_google must be a boolean, nothing extra accepted', async () => {
    expect((await call('get_free_time', { include_google: 'yes' })).error).toBe(true);
    expect((await call('get_schedule', { include_google: 1 })).error).toBe(true);
    expect((await call('get_free_time', { include_titles: true })).error).toBe(true);
  });
});

describe('pinsForPlan', () => {
  it('ignores past pins and reports deleted tasks', () => {
    const t = essay();
    createPin(ctx, t.id, loc('2026-11-12T08:00'), loc('2026-11-12T09:00')); // past
    const l = lab();
    createPin(ctx, l.id, loc('2026-11-16T14:00'), loc('2026-11-16T15:00'));
    ctx.db.run('UPDATE tasks SET deleted_at = ? WHERE id = ?', [NOW, l.id]);
    const r = pinsForPlan(ctx, clockMs);
    expect(r.active).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ reason: 'deleted' })]);
    expect(getTask(ctx, t.id)).toBeDefined();
  });
});
