import { describe, it, expect, beforeEach } from 'vitest';
import { makeCtx } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { setSetting } from '../src/db/repo';
import { runNotifications, loadNotifySettings, checkNotifySetting, NOTIFY_DEFAULTS, type Notice } from '../src/app/notifier';
import { createPendingApply, setJob, getJob, APPLY_TTL_MS } from '../src/core/connectorJobs';
import { recordProblem, recordConnected } from '../src/schedule/googleHealth';
import { dispatch, type ApiDeps } from '../src/app/api';
import { Deliverer, type DeliveryEnv } from '../src/app/delivery';

// Thursday 2026-11-12 12:00 in Detroit (outside the default quiet hours, 23:00-08:00)
const T0 = '2026-11-12T17:00:00Z';
const MIN = 60_000;
let ctx: Ctx;
let clockMs: number;
const tick = (ms: number) => { clockMs += ms; };
const run = (opts: { only?: 'urgent' } = {}): Notice[] => { const got: Notice[] = []; runNotifications(ctx, (n) => got.push(n), opts); return got; };
const propose = (willWrite = 5, willRemove = 2) => createPendingApply(ctx, { days: 14 }, { willWrite, willRemove });

beforeEach(() => {
  ctx = makeCtx(T0);
  clockMs = Date.parse(T0);
  ctx.clock = { now: () => new Date(clockMs) };
});

describe('"Claude proposes a schedule" notification', () => {
  it('is on by default, can be switched off, and is a validated boolean setting', () => {
    expect(NOTIFY_DEFAULTS.claudeApply).toBe(true);
    expect(loadNotifySettings(ctx).claudeApply).toBe(true);
    setSetting(ctx.db, 'notify_claude_apply', 'false');
    expect(loadNotifySettings(ctx).claudeApply).toBe(false);
    expect(checkNotifySetting('notify_claude_apply', 'off')).toBe('false');
    expect(() => checkNotifySetting('notify_claude_apply', 'maybe')).toThrow();
  });

  it('announces a new proposal with the numbers, and opens the Schedule tab when clicked', () => {
    propose(5, 2);
    const got = run({ only: 'urgent' });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'claude', target: 'schedule', title: 'Claude proposed a schedule', body: '5 blocks to write, 2 to remove. Review on the Schedule tab' });
    expect(`${got[0].title}: ${got[0].body}`).toBe('Claude proposed a schedule: 5 blocks to write, 2 to remove. Review on the Schedule tab');
  });

  it('uses the singular for one block', () => {
    propose(1, 1);
    expect(run()[0].body).toBe('1 block to write, 1 to remove. Review on the Schedule tab');
  });

  it('never repeats for the same request, however often it is checked, even after a restart', () => {
    const id = propose();
    expect(run({ only: 'urgent' })).toHaveLength(1);
    for (let i = 0; i < 5; i++) { tick(5_000); expect(run({ only: 'urgent' }), `check ${i}`).toEqual([]); }
    expect(run()).toEqual([]); // the 30-second check sees it as already announced too
    expect(getJob(ctx, id)!.status).toBe('pending');
    // the "restart": nothing is kept in memory, the record is in the database
    expect(run({ only: 'urgent' })).toEqual([]);
  });

  it('a different request is announced again', () => {
    const a = propose(3, 0);
    expect(run()).toHaveLength(1);
    setJob(ctx, a, { status: 'rejected' });
    propose(4, 1);
    const got = run();
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe('4 blocks to write, 1 to remove. Review on the Schedule tab');
  });

  it('warns when about 2 minutes are left and it is still pending, once', () => {
    propose();
    run();
    tick(7 * MIN + 30_000); // 2.5 minutes left: not yet
    expect(run()).toEqual([]);
    tick(31_000); // 1 minute 59 left
    const got = run();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'claude', target: 'schedule', title: 'Claude’s schedule proposal expires soon', body: 'About 2 minutes left. Approve or reject it on the Schedule tab' });
    tick(20_000);
    expect(run()).toEqual([]); // once
  });

  it('does not warn about one that was approved, rejected, expired or cancelled', () => {
    for (const status of ['applied', 'rejected', 'cancelled', 'stale']) {
      const id = propose();
      run();
      setJob(ctx, id, { status });
      tick(8 * MIN + 10_000);
      expect(run(), status).toEqual([]);
    }
    const id = propose();
    run();
    tick(APPLY_TTL_MS + 1000); // simply expired
    expect(run()).toEqual([]);
    expect(getJob(ctx, id)!.status).toBe('expired');
  });

  it('says nothing when the switch is off', () => {
    setSetting(ctx.db, 'notify_claude_apply', 'false');
    propose();
    expect(run()).toEqual([]);
    tick(8 * MIN + 10_000);
    expect(run()).toEqual([]);
  });

  it('respects quiet hours: held back while quiet, delivered afterwards if still pending, never twice', () => {
    setSetting(ctx.db, 'notify_quiet_start', '12:00');
    setSetting(ctx.db, 'notify_quiet_end', '12:05');
    const id = propose(); // 12:00, quiet until 12:05
    expect(run({ only: 'urgent' })).toEqual([]);
    tick(3 * MIN);
    expect(run({ only: 'urgent' })).toEqual([]);
    tick(3 * MIN); // 12:06: quiet is over, the request (expires 12:10) is still pending
    const got = run({ only: 'urgent' });
    expect(got.map((n) => n.title)).toEqual(['Claude proposed a schedule']);
    expect(getJob(ctx, id)!.status).toBe('pending');
    expect(run({ only: 'urgent' })).toEqual([]);
  });

  it('a request that expires during quiet hours is never announced', () => {
    setSetting(ctx.db, 'notify_quiet_start', '12:00');
    setSetting(ctx.db, 'notify_quiet_end', '12:05');
    propose();
    tick(11 * MIN);
    expect(run()).toEqual([]);
  });

  it('a failed delivery is retried at the next check (not marked as sent)', () => {
    propose();
    let fail = true;
    const attempts: string[] = [];
    const deliver = (n: Notice) => { attempts.push(n.title); if (fail) throw new Error('no window'); };
    runNotifications(ctx, deliver, { only: 'urgent' });
    fail = false;
    runNotifications(ctx, deliver, { only: 'urgent' });
    runNotifications(ctx, deliver, { only: 'urgent' });
    expect(attempts).toEqual(['Claude proposed a schedule', 'Claude proposed a schedule']);
  });

  it('the urgent check does not announce blocks, due-soon tasks or backups', () => {
    ctx.db.run("INSERT INTO terms(name, start_date, end_date, is_current) VALUES('T','2026-08-31','2026-12-21',1)");
    ctx.db.run("INSERT INTO tasks(title, type, status, due_date, term_id, source, created_at, updated_at) VALUES('Soon','homework','todo',?,1,'manual',?,?)", [new Date(clockMs + 5 * 3600_000).toISOString(), T0, T0]);
    expect(run({ only: 'urgent' })).toEqual([]);
    expect(run().some((n) => n.kind === 'due')).toBe(true);
  });
});

describe('"Google sign-in expired" notification', () => {
  it('announces a rejected sign-in once, with a Reconnect action that opens Settings, Google', () => {
    recordConnected(ctx.db, new Date(clockMs - 7.2 * 86_400_000));
    recordProblem(ctx.db, ctx.clock.now(), 'invalid_grant', 'reconnect');
    const got = run({ only: 'urgent' });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: 'google', target: 'settings-google', action: 'reconnect', title: 'Google sign-in expired' });
    expect(got[0].body).toMatch(/Your Google sign-in expired/);
    tick(10_000);
    expect(run({ only: 'urgent' })).toEqual([]);
  });

  it('a new failure after reconnecting is announced again', () => {
    recordProblem(ctx.db, ctx.clock.now(), 'invalid_grant', 'reconnect');
    expect(run()).toHaveLength(1);
    tick(MIN);
    recordConnected(ctx.db, ctx.clock.now()); // reconnected: the problem is cleared
    expect(run()).toEqual([]);
    tick(MIN);
    recordProblem(ctx.db, ctx.clock.now(), 'invalid_grant', 'reconnect');
    expect(run()).toHaveLength(1);
  });

  it('a client problem is announced without a Reconnect action (it would not help)', () => {
    recordProblem(ctx.db, ctx.clock.now(), 'invalid_client', 'client');
    const [n] = run();
    expect(n).toMatchObject({ kind: 'google', title: 'Google sign-in problem', target: 'settings-google' });
    expect(n.action).toBeUndefined();
  });

  it('is held back during quiet hours and delivered afterwards', () => {
    setSetting(ctx.db, 'notify_quiet_start', '12:00');
    setSetting(ctx.db, 'notify_quiet_end', '12:05');
    recordProblem(ctx.db, ctx.clock.now(), 'invalid_grant', 'reconnect');
    expect(run()).toEqual([]);
    tick(6 * MIN);
    expect(run()).toHaveLength(1);
  });
});

describe('the banner for these notices', () => {
  const env: DeliveryEnv = { supported: () => true, create: () => ({ on() {}, show() {} }) };
  const make = (mode: 'auto' | 'both' | 'app' = 'app') => new Deliverer(env, { mode: () => mode, timeoutMs: 2000, now: () => new Date(T0), after: () => {} });

  it('carries the screen to open and the one-click action', () => {
    const d = make();
    d.deliver({ kind: 'claude', title: 'Claude proposed a schedule', body: '5 blocks to write, 2 to remove. Review on the Schedule tab', target: 'schedule' });
    d.deliver({ kind: 'google', title: 'Google sign-in expired', body: 'x', target: 'settings-google', action: 'reconnect' });
    expect(d.banners).toMatchObject([{ kind: 'claude', target: 'schedule' }, { kind: 'google', target: 'settings-google', action: 'reconnect' }]);
    expect(d.banners[0].action).toBeUndefined();
  });

  it('the desktop notification click is told which screen to open', () => {
    let clicked: unknown;
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const d = new Deliverer({ supported: () => true, create: () => ({ on: (e, cb) => { handlers.set(e, cb); }, show() {} }) }, { mode: () => 'auto', timeoutMs: 2000, now: () => new Date(T0), after: () => {}, onClick: (r) => { clicked = { target: r.target, action: r.action }; } });
    d.deliver({ kind: 'claude', title: 't', body: 'b', target: 'schedule' });
    handlers.get('click')!();
    expect(clicked).toEqual({ target: 'schedule', action: undefined });
  });

  it('banners of a kind can be dismissed together (the Google banner goes once Reconnect worked)', () => {
    const d = make();
    d.deliver({ kind: 'google', title: 'a', body: 'b' });
    d.deliver({ kind: 'claude', title: 'c', body: 'd', target: 'schedule' });
    d.dismissKind('google');
    expect(d.banners.map((b) => b.kind)).toEqual(['claude']);
  });
});

describe('Settings, Notifications', () => {
  it('lists the new switch (on by default) and saves it', async () => {
    const d: ApiDeps = { ctx, dbFile: ':memory:', demo: true, backupFolder: '/x', calendar: () => { throw new Error('no'); } };
    const view = ((await dispatch(d, 'settings.get', undefined)) as any).value;
    const item = view.notifications.find((i: any) => i.key === 'notify_claude_apply');
    expect(item).toMatchObject({ label: 'Claude proposes a schedule', kind: 'bool', value: 'true', default: 'true' });
    expect(item.help).toMatch(/2 minutes/);
    const off = ((await dispatch(d, 'settings.set', { key: 'notify_claude_apply', value: 'false' })) as any).value;
    expect(off.notifications.find((i: any) => i.key === 'notify_claude_apply').value).toBe('false');
  });
});
