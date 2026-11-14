import { describe, it, expect } from 'vitest';
import { makeCtx, iv } from './helpers';
import { createTerm } from '../src/core/terms';
import { addTask } from '../src/core/tasks';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { dispatch, CHANNELS, type ApiDeps } from '../src/app/api';
import { loadWindows, resolveDay } from '../src/schedule/availabilityWindows';

function deps(): ApiDeps & { cal: FakeCalendar } {
  const ctx = makeCtx('2026-11-09T14:00:00Z');
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  const cal = new FakeCalendar({ calendars: [{ id: 'classcal', summary: 'School', busy: [iv('2026-11-09T10:00', '2026-11-09T11:00')] }] });
  return { ctx, dbFile: ':memory:', demo: false, backupFolder: '/nonexistent', calendar: () => ({ calendar: cal }), cal };
}
const ok = async (d: ApiDeps, ch: string, args?: unknown) => {
  const r = await dispatch(d, ch, args);
  if (!r.ok) throw new Error(r.error);
  return r.value as any;
};

describe('app api', () => {
  it('exposes exactly the channels the UI uses, and rejects unknown ones', async () => {
    expect(CHANNELS).toContain('availability.paint');
    expect(await dispatch(deps(), 'fs.readFile', {})).toEqual({ ok: false, error: 'Unknown request "fs.readFile".' });
  });
  it('validates arguments with readable errors (a renderer is not trusted)', async () => {
    const r = await dispatch(deps(), 'availability.paint', { target: { date: '2026-13-40' }, range: { start: '09:00', end: '10:00' } });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/Invalid request/);
    const r2 = await dispatch(deps(), 'availability.paint', { target: { weekday: 1 }, range: { start: '10:00', end: '09:00' } });
    expect((r2 as any).error).toMatch(/end must be after start/);
  });
  it('app.info reports terms, today, and no backup yet', async () => {
    const info = await ok(deps(), 'app.info');
    expect(info).toMatchObject({ tz: 'America/Detroit', today: '2026-11-09', lastBackup: null, demo: false });
    expect(info.terms).toHaveLength(1);
  });
  it('paint / erase / block return the previous rows, and restore undoes the edit exactly', async () => {
    const d = deps();
    await ok(d, 'availability.paint', { target: { weekday: 1 }, range: { start: '09:00', end: '17:00' } });
    const edit = await ok(d, 'availability.erase', { target: { date: '2026-11-09' }, range: { start: '12:00', end: '13:00' } });
    expect(edit.materialized).toBe(true);
    expect(edit.before).toEqual([]);
    let week = await ok(d, 'availability.week', { date: '2026-11-09' });
    expect(week.days[0]).toMatchObject({ source: 'date', free: [{ start: 540, end: 720 }, { start: 780, end: 1020 }] });
    await ok(d, 'availability.restore', { target: { date: '2026-11-09' }, rows: edit.before });
    week = await ok(d, 'availability.week', { date: '2026-11-09' });
    expect(week.days[0]).toMatchObject({ source: 'template', free: [{ start: 540, end: 1020 }] });
    const blk = await ok(d, 'availability.block', { target: { date: '2026-11-10' }, range: { start: '00:00', end: '24:00' } });
    expect(blk.before).toEqual([]);
    expect(resolveDay(loadWindows(d.ctx), '2026-11-10', d.ctx.tz).free).toEqual([]);
  });
  it('calendar.busy returns grey busy events per day in wall-clock minutes, or an error message instead of throwing', async () => {
    const d = deps();
    const r = await ok(d, 'calendar.busy', { date: '2026-11-11' });
    expect(r.busy['2026-11-09']).toEqual([{ start: 600, end: 660, label: 'School' }]);
    const broken = { ...d, calendar: () => { throw new Error('Google Calendar access expired. Run: npm run plan -- calendar connect'); } };
    expect((await ok(broken as ApiDeps, 'calendar.busy', { date: '2026-11-11' })).error).toMatch(/calendar connect/);
  });
  it('schedule.dryRun returns proposed blocks (real and tentative, with display titles) and what does not fit, and writes nothing', async () => {
    const d = deps();
    for (let wd = 1; wd <= 7; wd++) await ok(d, 'availability.paint', { target: { weekday: wd }, range: { start: '09:00', end: '22:00' } });
    addTask(d.ctx, { title: 'Exam 2', course: 'EECS 183', type: 'exam', due: 'nov 13 8pm', est: 120 });
    const r = await ok(d, 'schedule.dryRun', { days: 7 });
    expect(r.blocks.length).toBeGreaterThan(0);
    expect(r.blocks.every((b: any) => /^EECS 183: Exam 2 Prep/.test(b.title) && b.tentative === false)).toBe(true);
    expect(d.cal.writes).toEqual([]);
    expect(d.ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks').c).toBe(0);
  });
  it('availability.week includes the Planner Blocks already scheduled', async () => {
    const d = deps();
    const t = addTask(d.ctx, { title: 'HW', course: 'MATH 214', type: 'homework' });
    d.ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [t.id, '2026-11-10T15:00:00.000Z', '2026-11-10T16:00:00.000Z']);
    const w = await ok(d, 'availability.week', { date: '2026-11-09' });
    expect(w.days[1].blocks).toEqual([{ start: 600, end: 660, label: 'MATH 214: HW', taskId: 1, blockId: 1, startIso: '2026-11-10T15:00:00.000Z', endIso: '2026-11-10T16:00:00.000Z' }]); // the grid also needs the task and block to drag it
  });

  describe('schedule preview and apply', () => {
    const setup = async (demo = false) => {
      const d = deps();
      d.demo = demo;
      for (let wd = 1; wd <= 7; wd++) await ok(d, 'availability.paint', { target: { weekday: wd }, range: { start: '09:00', end: '22:00' } });
      addTask(d.ctx, { title: 'Essay', course: 'ENG 100', type: 'homework', due: 'nov 13 8pm', est: 90 });
      return d;
    };
    it('preview writes nothing and reports what apply would do, with the CLI wording', async () => {
      const d = await setup();
      const p = await ok(d, 'schedule.preview', { days: 7, replan: false });
      expect(p.willWrite).toBeGreaterThan(0);
      expect(p.willRemove).toBe(0);
      expect(p.calendarName).toBe('Planner Blocks');
      expect(p.fingerprint).toMatch(/^[0-9a-f]{40}$/);
      expect(p.trims.heading).toMatch(/^WOULD TRIM/);
      expect(d.cal.writes).toEqual([]);
      expect(d.ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks').c).toBe(0);
    });
    it('apply refuses without confirm, with a stale fingerprint, and writes nothing in either case', async () => {
      const d = await setup();
      const p = await ok(d, 'schedule.preview', { days: 7, replan: false });
      const noConfirm = await dispatch(d, 'schedule.apply', { days: 7, replan: false, fingerprint: p.fingerprint });
      expect(noConfirm.ok).toBe(false);
      const stale = await dispatch(d, 'schedule.apply', { days: 7, replan: false, fingerprint: 'deadbeef', confirm: true });
      expect(stale).toMatchObject({ ok: false });
      expect((stale as any).error).toMatch(/plan changed since you previewed/);
      expect(d.cal.writes).toEqual([]);
      expect(d.ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks').c).toBe(0);
    });
    it('apply writes exactly the previewed blocks, then a second preview sees them as earlier blocks to replace', async () => {
      const d = await setup();
      const p = await ok(d, 'schedule.preview', { days: 7, replan: false });
      const r = await ok(d, 'schedule.apply', { days: 7, replan: false, fingerprint: p.fingerprint, confirm: true });
      expect(r.created).toBe(p.willWrite);
      expect(r.message).toMatch(/wrote \d+ to "Planner Blocks"/);
      expect(d.ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks').c).toBe(p.willWrite);
      const again = await ok(d, 'schedule.preview', { days: 7, replan: false });
      expect(again.willRemove).toBe(p.willWrite);
      expect(again.fingerprint).toBe(p.fingerprint);
    });
    it('a plan changed by editing a task invalidates the preview', async () => {
      const d = await setup();
      const p = await ok(d, 'schedule.preview', { days: 7, replan: false });
      addTask(d.ctx, { title: 'Another', course: 'ENG 100', type: 'homework', due: 'nov 13 9pm', est: 60 });
      const r = await dispatch(d, 'schedule.apply', { days: 7, replan: false, fingerprint: p.fingerprint, confirm: true });
      expect(r.ok).toBe(false);
      expect(d.ctx.db.get<any>('SELECT COUNT(*) c FROM scheduled_blocks').c).toBe(0);
    });
    it('reports in-progress trims and logged work with the CLI messages', async () => {
      const d = await setup();
      const t = addTask(d.ctx, { title: 'Reading', course: 'ENG 100', type: 'homework', due: 'nov 12 11pm', est: 120 });
      d.ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [t.id, '2026-11-09T13:30:00.000Z', '2026-11-09T15:30:00.000Z']); // 8:30-10:30 AM, now is 9:00
      await ok(d, 'tasks.log', { id: t.id, minutes: 30 });
      const p = await ok(d, 'schedule.preview', { days: 7, replan: false });
      expect(p.trims.count).toBe(1);
      expect(p.trims.lines[0]).toMatch(/Not credited as work done: log it with  log \d+ <minutes>/);
      expect(p.logged.lines.join('\n')).toMatch(/30 min logged/);
      const r = await ok(d, 'schedule.apply', { days: 7, replan: false, fingerprint: p.fingerprint, confirm: true });
      expect(r.trimmed.count).toBe(1);
      expect(r.trimmed.heading).toMatch(/^TRIMMED/);
    });
    it('a simulated calendar can never be applied to the real database', async () => {
      const d = await setup();
      const sim = { ...d, calendar: () => ({ calendar: d.cal, simulated: true }) } as ApiDeps;
      const p = await ok(sim, 'schedule.preview', { days: 7, replan: false });
      expect(p.simulated).toBe(true);
      const r = await dispatch(sim, 'schedule.apply', { days: 7, replan: false, fingerprint: p.fingerprint, confirm: true });
      expect(r).toMatchObject({ ok: false });
      expect((r as any).error).toMatch(/simulated/);
    });
    it('replan mode previews missed blocks as MISSED moves', async () => {
      const d = await setup();
      const t = addTask(d.ctx, { title: 'Missed', course: 'ENG 100', type: 'homework', due: 'nov 13 8pm', est: 60 });
      d.ctx.db.run('INSERT INTO scheduled_blocks(task_id, start, "end") VALUES(?,?,?)', [t.id, '2026-11-08T15:00:00.000Z', '2026-11-08T16:00:00.000Z']);
      const p = await ok(d, 'schedule.preview', { days: 7, replan: true });
      expect(p.missedCount).toBe(1);
      expect(p.moved.lines.join('\n')).toMatch(/MISSED/);
    });
  });
});
