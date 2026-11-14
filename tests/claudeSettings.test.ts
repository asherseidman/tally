import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers';
import { createTerm } from '../src/core/terms';
import { addTask } from '../src/core/tasks';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { dispatch, type ApiDeps } from '../src/app/api';
import { openDb, schemaVersionOf } from '../src/db/index';
import { MIGRATIONS } from '../src/db/schema';
import { recordChange, listChanges } from '../src/core/changeLog';
import { claudeWritesAllowed } from '../src/core/claudeAccess';

function deps(): ApiDeps {
  const folder = mkdtempSync(join(tmpdir(), 'claude-set-'));
  const ctx = makeCtx('2026-11-09T14:00:00Z');
  ctx.db = openDb(join(folder, 'p.db'));
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  const cal = new FakeCalendar({ calendars: [] });
  return { ctx, dbFile: join(folder, 'p.db'), demo: true, backupFolder: join(folder, 'backups'), calendar: () => ({ calendar: cal }) };
}
const ok = async (d: ApiDeps, ch: string, args?: unknown) => { const r = await dispatch(d, ch, args); if (!r.ok) throw new Error(r.error); return r.value as any; };
const bad = async (d: ApiDeps, ch: string, args?: unknown) => { const r = await dispatch(d, ch, args); if (r.ok) throw new Error('expected an error'); return r.error; };

describe('Settings > Claude connector', () => {
  it('"Allow Claude to change my tasks" is OFF by default and shows no history', async () => {
    const d = deps();
    const s = await ok(d, 'settings.get');
    expect(s.claude.writes).toMatchObject({ key: 'mcp_allow_writes', label: 'Allow Claude to change my tasks', kind: 'bool', value: 'false', default: 'false', custom: false });
    expect(s.claude.changes).toEqual([]);
    expect(claudeWritesAllowed(d.ctx.db)).toBe(false);
  });

  it('can be switched on and off and reset; only true/false are accepted', async () => {
    const d = deps();
    expect((await ok(d, 'settings.set', { key: 'mcp_allow_writes', value: 'true' })).claude.writes.value).toBe('true');
    expect(claudeWritesAllowed(d.ctx.db)).toBe(true);
    expect((await ok(d, 'settings.set', { key: 'mcp_allow_writes', value: 'false' })).claude.writes.value).toBe('false');
    expect(await bad(d, 'settings.set', { key: 'mcp_allow_writes', value: 'yes' })).toMatch(/on or off/);
    await ok(d, 'settings.set', { key: 'mcp_allow_writes', value: 'true' });
    expect((await ok(d, 'settings.reset', { key: 'mcp_allow_writes' })).claude.writes.custom).toBe(false);
    expect(claudeWritesAllowed(d.ctx.db)).toBe(false);
  });

  it('lists recorded changes and undoes one from the window', async () => {
    const d = deps();
    const { change } = recordChange(d.ctx, { actor: 'claude', tool: 'add_task', summary: (t) => `Added task #${t.id}` }, () => addTask(d.ctx, { title: 'From Claude' }));
    let s = await ok(d, 'settings.get');
    expect(s.claude.changes).toHaveLength(1);
    expect(s.claude.changes[0]).toMatchObject({ id: change!.changeId, actor: 'claude', tool: 'add_task', undone: false });
    s = await ok(d, 'changes.undo', { id: change!.changeId });
    expect(s.claude.changes[0].undone).toBe(true);
    expect(d.ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM tasks WHERE deleted_at IS NULL')!.n).toBe(0);
    expect(await bad(d, 'changes.undo', { id: change!.changeId })).toMatch(/already undone/);
    expect(await bad(d, 'changes.undo', { id: 'x' })).toMatch(/Invalid request/);
    expect(listChanges(d.ctx)).toHaveLength(1);
  });

  it('a new database is at the latest schema, with the change_log table', () => {
    const d = deps();
    expect(schemaVersionOf(d.dbFile)).toBe(MIGRATIONS.length);
    for (const t of ['change_log', 'connector_calls', 'connector_jobs']) expect(d.ctx.db.get('SELECT name FROM sqlite_master WHERE name = ?', [t]), t).toBeDefined();
  });
});
