/**
 * Showing a notification, and telling the truth about what happened. The operating system may drop a notification without any
 * error (an unregistered or unsigned app, notifications turned off), so every attempt keeps a record of what was asked, which
 * events came back, and whether the OS reported it shown. When it did not, an in-app banner is the fallback (for all three kinds).
 * Electron is injected (`DeliveryEnv`), so this is tested with a fake operating system.
 */
export type Mode = 'auto' | 'both' | 'app';
export type Outcome = 'pending' | 'shown' | 'failed' | 'unsupported' | 'no-event' | 'error' | 'app-only';

export interface OsNotification {
  on(event: string, cb: (...args: unknown[]) => void): void;
  show(): void;
}
export interface DeliveryEnv {
  supported(): boolean;
  create(o: { title: string; body: string }): OsNotification;
}
export interface Banner { id: number; at: string; kind: string; title: string; body: string; taskId?: number; target?: 'schedule' | 'settings-google' | 'today'; action?: 'reconnect' }
export interface DeliveryRecord {
  id: number;
  at: string;
  kind: 'block' | 'due' | 'backup' | 'test' | 'claude' | 'google' | 'phone';
  title: string;
  body: string;
  taskId?: number;
  /** a screen to open when the notification or banner is clicked */
  target?: 'schedule' | 'settings-google' | 'today';
  /** a one-click fix offered on the banner */
  action?: 'reconnect';
  supported: boolean;
  showCalled: boolean;
  events: { event: string; ms: number; detail?: string }[];
  error: string | null;
  /** the outcome in plain words (what it means and what to do), when there is something to explain */
  reason: string | null;
  outcome: Outcome;
  /** an in-app banner was queued for it */
  banner: boolean;
}
interface Config {
  mode: () => Mode;
  /** how long to wait for the system's "show" event before treating it as dropped */
  timeoutMs: number;
  now: () => Date;
  clockMs?: () => number;
  after: (ms: number, fn: () => void) => void;
  /** the user clicked the desktop notification */
  onClick?: (r: DeliveryRecord) => void;
}
const KEEP = 20;

/**
 * The system's failure in plain words. macOS reports "UNErrorDomain error 1" (UNErrorCodeNotificationsNotAllowed) when notifications have
 * not been allowed for the app, which is always the case for an unpackaged dev build ("Electron" is never asked or registered).
 */
export function explainFailure(error: string | null): string {
  const e = error ?? '';
  if (/UNErrorDomain/i.test(e) && /(code[= ]+|error[: ]+)1\b/i.test(e) || /notifications are not allowed/i.test(e)) {
    return 'macOS has not allowed notifications for this app. The unpackaged dev build is never given permission; the packaged app will ask once.';
  }
  return e ? `The system reported an error: ${e}` : 'The system reported a failure without saying why.';
}

export class Deliverer {
  records: DeliveryRecord[] = [];
  banners: Banner[] = [];
  private seq = 0;
  private waiters = new Map<number, ((r: DeliveryRecord) => void)[]>();

  constructor(private env: DeliveryEnv, private cfg: Config) {}

  private ms = () => (this.cfg.clockMs ? this.cfg.clockMs() : Date.now());

  private banner(r: DeliveryRecord) {
    if (r.banner) return;
    r.banner = true;
    this.banners.push({ id: r.id, at: r.at, kind: r.kind, title: r.title, body: r.body, taskId: r.taskId, ...(r.target ? { target: r.target } : {}), ...(r.action ? { action: r.action } : {}) });
  }
  private settle(r: DeliveryRecord) {
    if (r.outcome === 'pending') return;
    for (const w of this.waiters.get(r.id) ?? []) w(r);
    this.waiters.delete(r.id);
  }

  deliver(n: { kind: DeliveryRecord['kind']; title: string; body: string; taskId?: number; target?: DeliveryRecord['target']; action?: DeliveryRecord['action'] }): DeliveryRecord {
    const mode = this.cfg.mode();
    const r: DeliveryRecord = {
      id: ++this.seq, at: this.cfg.now().toISOString(), kind: n.kind, title: n.title, body: n.body, taskId: n.taskId, target: n.target, action: n.action,
      supported: this.env.supported(), showCalled: false, events: [], error: null, reason: null, outcome: 'pending', banner: false,
    };
    this.records.unshift(r);
    this.records.length = Math.min(this.records.length, KEEP);

    if (mode === 'app') { r.outcome = 'app-only'; this.banner(r); this.settle(r); return r; }
    if (mode === 'both') this.banner(r);
    if (!r.supported) { r.outcome = 'unsupported'; this.banner(r); this.settle(r); return r; }

    const start = this.ms();
    const note = (event: string, detail?: unknown) => r.events.push({ event, ms: this.ms() - start, ...(detail !== undefined ? { detail: String(detail) } : {}) });
    let os: OsNotification;
    try {
      os = this.env.create({ title: r.title, body: r.body });
      os.on('show', () => { note('show'); if (r.outcome === 'pending') { r.outcome = 'shown'; this.settle(r); } });
      os.on('click', () => { note('click'); this.cfg.onClick?.(r); });
      os.on('close', () => note('close'));
      os.on('failed', (...a: unknown[]) => {
        const msg = a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : '')).find(Boolean) ?? 'the system reported a failure';
        note('failed', msg);
        r.error = msg; r.reason = explainFailure(msg); r.outcome = 'failed'; this.banner(r); this.settle(r);
      });
      os.show();
      r.showCalled = true;
    } catch (e) {
      r.error = (e as Error).message; r.reason = explainFailure(r.error); r.outcome = 'error'; this.banner(r); this.settle(r);
      return r;
    }
    this.cfg.after(this.cfg.timeoutMs, () => {
      if (r.outcome === 'pending') { r.outcome = 'no-event'; this.banner(r); this.settle(r); }
    });
    return r;
  }

  /** Send a test and wait until it is known whether the system reported it shown. */
  test(): Promise<DeliveryRecord> {
    const r = this.deliver({ kind: 'test', title: 'Test notification', body: 'If you can read this, desktop notifications work.' });
    if (r.outcome !== 'pending') return Promise.resolve(r);
    return new Promise((res) => this.waiters.set(r.id, [...(this.waiters.get(r.id) ?? []), res]));
  }

  dismiss(id: number) {
    this.banners = this.banners.filter((b) => b.id !== id);
  }

  /** Remove every banner of a kind (the Google sign-in banner goes away once Reconnect worked). */
  dismissKind(kind: string) {
    this.banners = this.banners.filter((b) => b.kind !== kind);
  }
}
