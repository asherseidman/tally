import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { dispatch, CHANNELS, type ApiDeps } from '../src/app/api';
import { openDb } from '../src/db/index';

const sample = (n: string) => readFileSync(join(__dirname, '..', 'samples', n), 'utf8');

function deps(): ApiDeps {
  const folder = mkdtempSync(join(tmpdir(), 'imp-'));
  const ctx = makeCtx('2026-09-01T14:00:00Z');
  ctx.db = openDb(join(folder, 'p.db'));
  const cal = new FakeCalendar({ calendars: [] });
  return { ctx, dbFile: join(folder, 'p.db'), demo: true, backupFolder: join(folder, 'backups'), calendar: () => ({ calendar: cal }) };
}
const ok = async (d: ApiDeps, ch: string, args?: unknown) => {
  const r = await dispatch(d, ch, args);
  if (!r.ok) throw new Error(r.error);
  return r.value as any;
};
const fail = async (d: ApiDeps, ch: string, args?: unknown) => {
  const r = await dispatch(d, ch, args);
  if (r.ok) throw new Error('expected an error');
  return r.error;
};
const count = (d: ApiDeps) => d.ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM tasks')!.c;

describe('import api', () => {
  it('exposes the import channels', () => {
    for (const c of ['import.review', 'import.toggle', 'import.edit', 'import.close', 'import.apply']) expect(CHANNELS).toContain(c);
  });

  it('review writes nothing and lists new items; apply needs confirm', async () => {
    const d = deps();
    const r = await ok(d, 'import.review', { text: sample('math-101.json'), fileName: 'math-101.json' });
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.every((e: any) => e.kind === 'new' && e.included)).toBe(true);
    expect(r.willAdd).toBe(r.entries.length);
    expect(r.termIsNew).toBe(true);
    expect(count(d)).toBe(0);
    expect(d.ctx.db.get<any>('SELECT COUNT(*) c FROM terms').c).toBe(0);
    expect(await fail(d, 'import.apply', { id: r.id })).toMatch(/Invalid request|confirm/i);
    expect(count(d)).toBe(0);
  });

  it('invalid files give the same readable list of problems as the CLI, and write nothing', async () => {
    const d = deps();
    const e = await fail(d, 'import.review', { text: sample('invalid.json'), fileName: 'invalid.json' });
    expect(e).toMatch(/is not a valid import file \(\d+ problems?\)/);
    expect(e).toMatch(/Nothing was imported/);
    expect(await fail(d, 'import.review', { text: '{ nope', fileName: 'x.json' })).toMatch(/not valid JSON/);
    expect(count(d)).toBe(0);
  });

  it('unchecking and editing before approving change what is written; the backup is taken after', async () => {
    const d = deps();
    const r = await ok(d, 'import.review', { text: sample('math-101.json'), fileName: 'math-101.json' });
    const total = r.entries.length;
    const dropped = await ok(d, 'import.toggle', { id: r.id, num: 1, included: false });
    expect(dropped.entries[0].included).toBe(false);
    expect(dropped.willAdd).toBe(total - 1);
    const edited = await ok(d, 'import.edit', { id: r.id, num: 2, field: 'title', value: 'Renamed in review' });
    expect(edited.entries.find((x: any) => x.title === 'Renamed in review')).toBeTruthy();
    expect(await fail(d, 'import.edit', { id: r.id, num: 2, field: 'due', value: 'banana split' })).toMatch(/Couldn't understand the date/);
    const dated = await ok(d, 'import.edit', { id: r.id, num: 2, field: 'due', value: 'dec 4 5pm' });
    expect(dated.entries.some((x: any) => /Dec 4 2026 5:00 PM/.test(x.dueText ?? ''))).toBe(true);
    expect(await fail(d, 'import.edit', { id: r.id, num: 2, field: 'course', value: 'X' })).toMatch(/identity/);
    const res = await ok(d, 'import.apply', { id: r.id, confirm: true });
    expect(res.inserted).toBe(total - 1);
    expect(res.termCreated).toBe(true);
    expect(count(d)).toBe(total - 1);
    expect(d.ctx.db.get<any>("SELECT COUNT(*) c FROM tasks WHERE title = 'Renamed in review'").c).toBe(1);
    expect(res.backupError).toBeNull();
    expect(res.backup).toBeTruthy();
    expect(readdirSync(d.backupFolder).length).toBeGreaterThan(0);
    // the review is closed after applying
    expect(await fail(d, 'import.apply', { id: r.id, confirm: true })).toMatch(/no longer open/);
  });

  it('re-importing the same file adds nothing; a revised file shows changes with before/after values', async () => {
    const d = deps();
    const a = await ok(d, 'import.review', { text: sample('math-101.json'), fileName: 'a.json' });
    await ok(d, 'import.apply', { id: a.id, confirm: true });
    const again = await ok(d, 'import.review', { text: sample('math-101.json'), fileName: 'a.json' });
    expect(again.entries).toEqual([]);
    expect(again.unchanged.length).toBeGreaterThan(0);
    const rev = await ok(d, 'import.review', { text: sample('math-101-revised.json'), fileName: 'rev.json' });
    const changed = rev.entries.filter((e: any) => e.kind === 'changed');
    expect(changed.length).toBeGreaterThan(0);
    expect(changed[0].changes[0]).toMatchObject({ field: expect.any(String), from: expect.any(String), to: expect.any(String) });
    const before = count(d);
    await ok(d, 'import.close', { id: rev.id });
    expect(count(d)).toBe(before);
  });

  it('a local edit is flagged as a conflict and kept', async () => {
    const d = deps();
    const a = await ok(d, 'import.review', { text: sample('math-101.json'), fileName: 'a.json' });
    await ok(d, 'import.apply', { id: a.id, confirm: true });
    const rev = await ok(d, 'import.review', { text: sample('math-101-revised.json'), fileName: 'rev.json' });
    const target = rev.entries.find((e: any) => e.kind === 'changed' && e.changes.some((c: any) => c.field === 'due_date'));
    expect(target).toBeTruthy();
    const row = d.ctx.db.get<any>('SELECT id FROM tasks WHERE title = ?', [target.title])!;
    d.ctx.db.run("UPDATE tasks SET due_date = '2026-12-30T12:00:00.000Z' WHERE id = ?", [row.id]);
    const rev2 = await ok(d, 'import.review', { text: sample('math-101-revised.json'), fileName: 'rev.json' });
    const t2 = rev2.entries.find((e: any) => e.title === target.title);
    expect(t2.changes.find((c: any) => c.field === 'due_date').conflict).toBe(true);
    const res = await ok(d, 'import.apply', { id: rev2.id, confirm: true });
    expect(res.keptLocalEdits.some((k: any) => k.fields.includes('due_date'))).toBe(true);
  });

  it('a review survives the app building a fresh deps object for every request (as the main process does)', async () => {
    const d = deps();
    const fresh = () => ({ ...d }) as ApiDeps;
    const r = await ok(fresh(), 'import.review', { text: sample('math-101.json'), fileName: 'a.json' });
    const t = await ok(fresh(), 'import.toggle', { id: r.id, num: 1, included: false });
    expect(t.willAdd).toBe(r.entries.length - 1);
    const res = await ok(fresh(), 'import.apply', { id: r.id, confirm: true });
    expect(res.inserted).toBe(r.entries.length - 1);
  });

  it('plans import with their steps and show what each step waits on', async () => {
    const d = deps();
    const base = await ok(d, 'import.review', { text: sample('demo-phys-101.json'), fileName: 'phys.json' });
    await ok(d, 'import.apply', { id: base.id, confirm: true });
    const r = await ok(d, 'import.review', { text: sample('demo-plan.json'), fileName: 'plan.json' });
    expect(r.entries.some((e: any) => e.parentTitle)).toBe(true);
    expect(r.entries.some((e: any) => e.after.length > 0)).toBe(true);
  });
});
