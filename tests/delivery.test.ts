import { describe, it, expect } from 'vitest';
import { Deliverer, explainFailure, type DeliveryEnv, type OsNotification, type Mode } from '../src/app/delivery';

/** A fake operating system: records what the app asked for and lets the test fire the events a real one would. */
function world(opts: { supported?: boolean; throwOnShow?: boolean; mode?: Mode } = {}) {
  const made: (OsNotification & { fire(event: string, ...a: unknown[]): void; shown: boolean })[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  let t = 1_000;
  let mode: Mode = opts.mode ?? 'auto';
  const env: DeliveryEnv = {
    supported: () => opts.supported ?? true,
    create: () => {
      const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
      const n = {
        shown: false,
        on(e: string, cb: (...a: unknown[]) => void) { handlers.set(e, [...(handlers.get(e) ?? []), cb]); },
        show() { if (opts.throwOnShow) throw new Error('boom'); n.shown = true; },
        fire(e: string, ...a: unknown[]) { for (const cb of handlers.get(e) ?? []) cb(...a); },
      };
      made.push(n);
      return n;
    },
  };
  const d = new Deliverer(env, { mode: () => mode, timeoutMs: 2000, now: () => new Date('2026-11-10T17:00:00Z'), clockMs: () => t, after: (ms, fn) => { timers.push({ ms, fn }); } });
  return { d, made, setMode: (m: Mode) => { mode = m; }, tick: (ms: number) => { t += ms; }, runTimers: () => { while (timers.length) timers.shift()!.fn(); } };
}
const n = { kind: 'due' as const, title: 'Due soon: Essay', body: 'due in 5 hours', taskId: 7 };

describe('delivery diagnostics', () => {
  it('reports exactly what happened when the system says it was shown', () => {
    const w = world();
    const r = w.d.deliver(n);
    expect(r).toMatchObject({ supported: true, showCalled: true, outcome: 'pending', banner: false });
    w.tick(12);
    w.made[0].fire('show');
    expect(r.outcome).toBe('shown');
    expect(r.events).toEqual([{ event: 'show', ms: 12 }]);
    w.tick(3000);
    w.made[0].fire('click');
    w.made[0].fire('close');
    expect(r.events.map((e) => e.event)).toEqual(['show', 'click', 'close']);
    w.runTimers();
    expect(r.outcome).toBe('shown');
    expect(w.d.banners).toEqual([]); // delivered: no fallback
  });

  it('no "show" event within the timeout means the system probably dropped it: fallback banner', () => {
    const w = world();
    const r = w.d.deliver(n);
    expect(w.d.banners).toEqual([]);
    w.runTimers(); // two seconds pass with nothing from the OS
    expect(r.outcome).toBe('no-event');
    expect(r.banner).toBe(true);
    expect(w.d.banners).toHaveLength(1);
    expect(w.d.banners[0]).toMatchObject({ title: 'Due soon: Essay', body: 'due in 5 hours', taskId: 7 });
  });

  it('clicking the desktop notification calls back with the record (to open the task)', () => {
    const clicked: number[] = [];
    const made: { fire(e: string): void }[] = [];
    const env: DeliveryEnv = { supported: () => true, create: () => { const h = new Map<string, (() => void)[]>(); const x = { on: (e: string, cb: () => void) => { h.set(e, [...(h.get(e) ?? []), cb]); }, show() {}, fire: (e: string) => (h.get(e) ?? []).forEach((c) => c()) }; made.push(x); return x as unknown as OsNotification; } };
    const d = new Deliverer(env, { mode: () => 'auto', timeoutMs: 2000, now: () => new Date(), after: () => {}, onClick: (r) => { if (r.taskId) clicked.push(r.taskId); } });
    d.deliver(n);
    made[0].fire('click');
    expect(clicked).toEqual([7]);
  });

  it('a "failed" event is reported with its message and falls back', () => {
    const w = world();
    const r = w.d.deliver(n);
    w.made[0].fire('failed', 'Notifications are not allowed for this application');
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/not allowed/);
    expect(r.events[0]).toMatchObject({ event: 'failed', detail: expect.stringMatching(/not allowed/) });
    expect(w.d.banners).toHaveLength(1);
    w.runTimers();
    expect(w.d.banners).toHaveLength(1); // not duplicated when the timer fires later
  });

  it('macOS "UNErrorDomain error 1" is explained in plain words, not just reported as a failure', () => {
    const plain = 'macOS has not allowed notifications for this app. The unpackaged dev build is never given permission; the packaged app will ask once.';
    for (const raw of ['UNErrorDomain error 1', 'Error Domain=UNErrorDomain Code=1 "Notifications are not allowed for this application"', 'The operation couldn’t be completed. (UNErrorDomain error 1.)', 'Notifications are not allowed for this application']) {
      expect(explainFailure(raw)).toBe(plain);
    }
    const w = world();
    const r = w.d.deliver(n);
    w.made[0].fire('failed', {}, 'The operation couldn’t be completed. (UNErrorDomain error 1.)');
    expect(r.outcome).toBe('failed');
    expect(r.reason).toBe(plain);
    expect(r.error).toMatch(/UNErrorDomain error 1/); // the raw text is kept too
    expect(w.d.banners).toHaveLength(1); // the fallback is unchanged
  });

  it('other errors are passed on, and no message at all is admitted', () => {
    expect(explainFailure('disk on fire')).toBe('The system reported an error: disk on fire');
    expect(explainFailure('UNErrorDomain error 12')).toMatch(/The system reported an error/); // a different code is not mislabelled
    expect(explainFailure(null)).toMatch(/without saying why/);
  });

  it('a failed event after a show event still wins (the system changed its mind)', () => {
    const w = world();
    const r = w.d.deliver(n);
    w.made[0].fire('show');
    w.made[0].fire('failed', 'late failure');
    expect(r.outcome).toBe('failed');
    expect(w.d.banners).toHaveLength(1);
  });

  it('an unsupported system: no attempt, banner at once', () => {
    const w = world({ supported: false });
    const r = w.d.deliver(n);
    expect(r).toMatchObject({ supported: false, showCalled: false, outcome: 'unsupported', banner: true });
    expect(w.made).toEqual([]);
    expect(w.d.banners).toHaveLength(1);
  });

  it('show() throwing is reported as an error with a banner', () => {
    const w = world({ throwOnShow: true });
    const r = w.d.deliver(n);
    expect(r).toMatchObject({ showCalled: false, outcome: 'error', error: 'boom', banner: true });
    expect(w.d.banners).toHaveLength(1);
  });

  it('mode "both" always adds the banner; mode "app" never touches the system', () => {
    const both = world({ mode: 'both' });
    both.d.deliver(n);
    both.made[0].fire('show');
    expect(both.d.banners).toHaveLength(1);
    const app = world({ mode: 'app' });
    const r = app.d.deliver(n);
    expect(app.made).toEqual([]);
    expect(r).toMatchObject({ outcome: 'app-only', showCalled: false, banner: true });
    expect(app.d.banners).toHaveLength(1);
  });

  it('the fallback works for all three kinds', () => {
    const w = world({ supported: false });
    for (const kind of ['block', 'due', 'backup'] as const) w.d.deliver({ kind, title: kind, body: 'b' });
    expect(w.d.banners.map((b) => b.kind)).toEqual(['block', 'due', 'backup']);
  });

  it('banners can be dismissed one at a time', () => {
    const w = world({ supported: false });
    w.d.deliver({ kind: 'due', title: 'A', body: '' });
    w.d.deliver({ kind: 'due', title: 'B', body: '' });
    const [a, b] = w.d.banners;
    w.d.dismiss(a.id);
    expect(w.d.banners.map((x) => x.title)).toEqual(['B']);
    w.d.dismiss(9999);
    expect(w.d.banners).toHaveLength(1);
    w.d.dismiss(b.id);
    expect(w.d.banners).toEqual([]);
  });

  it('test() waits until the outcome is known and returns the record', async () => {
    const w = world();
    const p = w.d.test();
    w.made[0].fire('show');
    expect((await p).outcome).toBe('shown');
    const w2 = world();
    const p2 = w2.d.test();
    w2.runTimers();
    expect((await p2)).toMatchObject({ outcome: 'no-event', banner: true, kind: 'test' });
  });

  it('keeps the newest 20 records', () => {
    const w = world({ supported: false });
    for (let i = 0; i < 25; i++) w.d.deliver({ kind: 'due', title: `n${i}`, body: '' });
    expect(w.d.records).toHaveLength(20);
    expect(w.d.records[0].title).toBe('n24');
  });
});
