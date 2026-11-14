import { unannounced, markAnnounced } from '../phone/inbox';
import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import { getSetting, setSetting } from '../db/repo';
import { computeViews, dueText } from '../core/views';
import { eventTitle } from '../schedule/eventTitle';
import { formatLocal } from '../time';
import { openApply } from '../core/connectorJobs';
import { currentProblem, problemMessage } from '../schedule/googleHealth';

/**
 * What deserves a desktop notification right now. Pure of Electron: the main process calls `runNotifications` on a timer and
 * shows whatever it delivers. Kinds: a planner block starting soon, a task inside the Due soon window, a backup that failed, a schedule
 * Claude proposed (and one about to expire), and a Google sign-in that stopped working.
 * What was announced is stored in the database (setting `notify_sent`), so nothing is repeated, even after a restart.
 */
export type NoticeKind = 'block' | 'due' | 'backup' | 'claude' | 'google' | 'phone';
export interface Notice {
  key: string;
  kind: NoticeKind;
  title: string;
  body: string;
  taskId?: number;
  /** a screen to open when it is clicked */
  target?: 'schedule' | 'settings-google' | 'today';
  /** a one-click fix on its banner */
  action?: 'reconnect';
}

export interface NotifySettings {
  blocks: boolean;
  dueSoon: boolean;
  backupFailure: boolean;
  /** Claude proposed a schedule apply that waits for your approval */
  claudeApply: boolean;
  /** items arrived from your phone (Reminders) */
  phoneInbox: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  /** auto: desktop notification, with an in-app banner if the system does not deliver it; both: always both; app: in-app banners only */
  delivery: 'auto' | 'both' | 'app';
  /** a block is announced when it starts within this many minutes */
  blockLeadMinutes: number;
}
export const NOTIFY_DEFAULTS: NotifySettings = { blocks: true, dueSoon: true, backupFailure: true, claudeApply: true, phoneInbox: true, quietEnabled: true, quietStart: '23:00', quietEnd: '08:00', delivery: 'auto', blockLeadMinutes: 10 };
export const NOTIFY_KEYS = ['notify_blocks', 'notify_due_soon', 'notify_backup_failure', 'notify_claude_apply', 'notify_phone_inbox', 'notify_quiet_enabled', 'notify_quiet_start', 'notify_quiet_end', 'notify_delivery'];
const SENT_KEY = 'notify_sent';
const SENT_KEEP_DAYS = 30;
const DIGEST_OVER = 3;

const bool = (raw: string | undefined, d: boolean) => (raw === undefined ? d : raw === 'true');
export function loadNotifySettings(ctx: Ctx): NotifySettings {
  const g = (k: string) => getSetting(ctx.db, k);
  return {
    blocks: bool(g('notify_blocks'), NOTIFY_DEFAULTS.blocks), dueSoon: bool(g('notify_due_soon'), NOTIFY_DEFAULTS.dueSoon),
    backupFailure: bool(g('notify_backup_failure'), NOTIFY_DEFAULTS.backupFailure), claudeApply: bool(g('notify_claude_apply'), NOTIFY_DEFAULTS.claudeApply), phoneInbox: bool(g('notify_phone_inbox'), NOTIFY_DEFAULTS.phoneInbox), quietEnabled: bool(g('notify_quiet_enabled'), NOTIFY_DEFAULTS.quietEnabled),
    quietStart: g('notify_quiet_start') ?? NOTIFY_DEFAULTS.quietStart, quietEnd: g('notify_quiet_end') ?? NOTIFY_DEFAULTS.quietEnd, delivery: (['auto', 'both', 'app'].includes(g('notify_delivery') ?? '') ? g('notify_delivery') : NOTIFY_DEFAULTS.delivery) as NotifySettings['delivery'], blockLeadMinutes: NOTIFY_DEFAULTS.blockLeadMinutes,
  };
}

/** Validate a notification setting; returns the text to store. */
export function checkNotifySetting(key: string, value: string): string {
  if (key === 'notify_delivery') {
    if (!['auto', 'both', 'app'].includes(value.trim())) throw new Error('Delivery must be auto, both or app.');
    return value.trim();
  }
  if (key === 'notify_quiet_start' || key === 'notify_quiet_end') {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim())) throw new Error('Quiet hours need times like 23:00 (HH:mm).');
    const v = value.trim();
    return v.length === 4 ? `0${v}` : v;
  }
  if (NOTIFY_KEYS.includes(key)) {
    if (!/^(true|false|yes|no|on|off)$/i.test(value.trim())) throw new Error('This switch must be true or false.');
    return /^(true|yes|on)$/i.test(value.trim()) ? 'true' : 'false';
  }
  throw new Error(`"${key}" is not a notification setting.`);
}

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Is `now` inside quiet hours (local to `tz`)? Handles a window that crosses midnight, like 23:00 to 08:00. */
export function inQuietHours(now: Date, tz: string, s: Pick<NotifySettings, 'quietEnabled' | 'quietStart' | 'quietEnd'>): boolean {
  if (!s.quietEnabled) return false;
  const a = toMin(s.quietStart), b = toMin(s.quietEnd);
  if (a === b) return false;
  const local = DateTime.fromJSDate(now, { zone: tz });
  const m = local.hour * 60 + local.minute;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

function loadSent(ctx: Ctx): Record<string, string> {
  try {
    const v = JSON.parse(getSetting(ctx.db, SENT_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

interface BlockRow { id: number; task_id: number; start: string; end: string; title: string; course: string | null; type: string; due_date: string | null }

/**
 * Work out what to announce now and hand each notice to `deliver`. A notice counts as sent only if `deliver` did not throw.
 * Returns what was delivered. Quiet hours hold everything back (blocks are not held: they only matter while still ahead).
 */
export function runNotifications(ctx: Ctx, deliver: (n: Notice) => void, extra: { backupError?: string | null; /** only the time-sensitive kinds (a Claude proposal, a Google sign-in problem): the app checks these every second or two */ only?: 'urgent' } = {}): Notice[] {
  const s = loadNotifySettings(ctx);
  const now = ctx.clock.now();
  const nowMs = now.getTime();
  const sent = loadSent(ctx);
  let changed = false;

  // forget old entries so the list cannot grow forever
  const cutoff = nowMs - SENT_KEEP_DAYS * 86_400_000;
  for (const [k, at] of Object.entries(sent)) if (Date.parse(at) < cutoff) { delete sent[k]; changed = true; }

  const out: Notice[] = [];
  const send = (n: Notice, keys: string[] = [n.key]) => {
    try { deliver(n); } catch { return; } // not marked: tried again next time
    for (const k of keys) sent[k] = now.toISOString();
    changed = true;
    out.push(n);
  };

  if (!inQuietHours(now, ctx.tz, s)) {
    const local = (ms: number, f: string) => DateTime.fromMillis(ms, { zone: ctx.tz }).toFormat(f);

    // a schedule Claude proposed, waiting for your approval (and a reminder when it is about to expire)
    if (s.claudeApply) {
      const job = openApply(ctx);
      if (job && job.status === 'pending') {
        const w = Number(job.result?.summary?.willWrite ?? 0), r = Number(job.result?.summary?.willRemove ?? 0);
        const key = `claude-apply:${job.id}`;
        if (!sent[key]) send({ key, kind: 'claude', target: 'schedule', title: 'Claude proposed a schedule', body: `${w} block${w === 1 ? '' : 's'} to write, ${r} to remove. Review on the Schedule tab` });
        const left = job.expires_at ? Date.parse(job.expires_at) - nowMs : Infinity;
        const xkey = `claude-apply-expiring:${job.id}`;
        if (left > 0 && left <= 120_000 && !sent[xkey]) send({ key: xkey, kind: 'claude', target: 'schedule', title: 'Claude’s schedule proposal expires soon', body: 'About 2 minutes left. Approve or reject it on the Schedule tab' });
      }
    }

    // the saved Google sign-in stopped working: say why, once per occurrence, with a one-click Reconnect
    const problem = currentProblem(ctx.db);
    if (problem && !sent[`google:${problem.at}`]) {
      send({ key: `google:${problem.at}`, kind: 'google', target: 'settings-google', ...(problem.kind === 'reconnect' ? { action: 'reconnect' as const } : {}), title: problem.kind === 'client' ? 'Google sign-in problem' : 'Google sign-in expired', body: problemMessage(problem) });
    }

    // items that arrived from the phone: held back during quiet hours (this block only runs outside them), announced once
    const arrived = unannounced(ctx);
    if (arrived.length) {
      if (!s.phoneInbox) markAnnounced(ctx, arrived.map((a) => a.reminder_id)); // switched off: not announced now, and not saved up to appear later
      else {
        const names = arrived.slice(0, 3).map((a) => `“${a.title}”`).join(', ');
        const key = `phone-inbox:${arrived[arrived.length - 1].rowid}`;
        send({ key, kind: 'phone', target: 'today', title: arrived.length === 1 ? 'Added from your phone' : `${arrived.length} items added from your phone`, body: `${names}${arrived.length > 3 ? ` and ${arrived.length - 3} more` : ''}. See the Inbox on Today.` });
        if (out.some((o) => o.key === key)) markAnnounced(ctx, arrived.map((a) => a.reminder_id));
      }
    }

    if (extra.only === 'urgent') return finish();

    if (s.blocks) {
      const rows = ctx.db.all<BlockRow>(
        `SELECT b.id, b.task_id, b.start, b."end", t.title, t.course, t.type, t.due_date
           FROM scheduled_blocks b JOIN tasks t ON t.id = b.task_id
          WHERE t.status <> 'done' AND t.deleted_at IS NULL AND b.start > ? AND b.start <= ?
          ORDER BY b.start`,
        [new Date(nowMs).toISOString(), new Date(nowMs + s.blockLeadMinutes * 60_000).toISOString()],
      );
      for (const r of rows) {
        const key = `block:${r.id}`;
        if (sent[key]) continue;
        const startMs = Date.parse(r.start), endMs = Date.parse(r.end);
        const left = Math.max(1, Math.ceil((startMs - nowMs) / 60_000));
        send({
          key, kind: 'block', taskId: r.task_id,
          title: `Starting in ${left} min: ${eventTitle({ course: r.course, title: r.title, isExam: r.type === 'exam' })}`,
          body: `${local(startMs, 'h:mm')}–${local(endMs, 'h:mm a')}${r.due_date ? ` · due ${formatLocal(r.due_date, ctx.tz)}` : ''}`,
        });
      }
    }

    if (s.dueSoon) {
      const fresh = computeViews(ctx).dueSoon
        .filter((i) => Date.parse(i.task.due_date!) >= nowMs)
        .map((i) => ({ item: i, key: `due:${i.task.id}:${i.task.due_date}` }))
        .filter((x) => !sent[x.key]);
      const one = (x: (typeof fresh)[number]): Notice => ({
        key: x.key, kind: 'due', taskId: x.item.task.id,
        title: `Due soon: ${eventTitle({ course: x.item.task.course, title: x.item.task.title, isExam: x.item.task.type === 'exam' })}`,
        body: `${dueText(Date.parse(x.item.task.due_date!), nowMs)} · ${formatLocal(x.item.task.due_date, ctx.tz, !!x.item.task.time_assumed)}`,
      });
      if (fresh.length > DIGEST_OVER) {
        // a pile (first launch, or a busy week) becomes one summary instead of a burst of pop-ups
        const names = fresh.slice(0, 3).map((x) => x.item.task.title).join(', ');
        send({ key: `due-digest:${nowMs}`, kind: 'due', title: `${fresh.length} tasks are due soon`, body: `${names}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}. Open Today to see them.` }, fresh.map((x) => x.key));
      } else for (const x of fresh) send(one(x));
    }

    if (s.backupFailure && extra.backupError) {
      const key = `backup:${local(nowMs, 'yyyy-MM-dd')}`;
      if (!sent[key]) send({ key, kind: 'backup', title: 'Backup failed', body: `Your backup did not complete: ${extra.backupError}. Check Settings > Backups.` });
    }
  }

  return finish();

  function finish() {
    if (changed) setSetting(ctx.db, SENT_KEY, JSON.stringify(sent));
    return out;
  }
}
