import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import { nowIso } from '../core/ctx';
import { getSetting, setSetting } from '../db/repo';
import { addTask } from '../core/tasks';
import { parseQuickAdd } from '../core/quickAdd';
import { recordChange, undoChange } from '../core/changeLog';
import type { ReminderItem, RemindersSource } from './reminders';

/**
 * Phone capture through Apple Reminders. While Tally is open (and at launch) it reads the open reminders of ONE list, makes a
 * task from each, and only AFTER the task exists marks the reminder completed (never deletes it). Each reminder's own id is
 * recorded in the same transaction as its task, so nothing is imported twice, even if completing fails or sync is slow.
 */
export const INBOX_ENABLED_KEY = 'phone_inbox_enabled';
export const INBOX_LIST_KEY = 'phone_inbox_list';
export const DEFAULT_INBOX_LIST = 'Tally Inbox';
const STATUS_KEY = 'phone_inbox_status';
const LAST_CHECK_KEY = 'phone_inbox_last_check';

/** per pass; more waits for the next pass (a minute later) */
export const MAX_PER_PASS = 50;
/** how many open reminders are read from the list at most */
export const MAX_FETCH = 500;
export const MAX_TITLE = 300;
const MAX_NOTE = 2000;
const MAX_ID = 300;

export type InboxState = 'ok' | 'denied' | 'missing_list' | 'error';
export interface InboxStatus { state: InboxState; message: string; at: string }
export interface InboxPass {
  ran: boolean;
  /** why nothing ran: off, or waiting for permission to be retried */
  skipped?: 'off' | 'blocked';
  imported: number;
  completeFailed: number;
  retriedComplete: number;
  /** reminders still waiting (over the per-pass limit) */
  waiting: number;
  status: InboxStatus | null;
}

export const inboxEnabled = (ctx: Ctx) => getSetting(ctx.db, INBOX_ENABLED_KEY) === 'true';
export const inboxList = (ctx: Ctx) => getSetting(ctx.db, INBOX_LIST_KEY) || DEFAULT_INBOX_LIST;

/** Validate the list name the user typed. */
export function checkListName(v: string): string {
  const t = v.trim();
  if (!t) throw new Error('The list name cannot be empty.');
  if (t.length > 100) throw new Error('The list name is too long (100 characters at most).');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(t)) throw new Error('The list name cannot contain control characters.');
  return t;
}

export function inboxStatus(ctx: Ctx): InboxStatus | null {
  const raw = getSetting(ctx.db, STATUS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as InboxStatus; } catch { return null; }
}
const setStatus = (ctx: Ctx, state: InboxState, message: string) => setSetting(ctx.db, STATUS_KEY, JSON.stringify({ state, message, at: nowIso(ctx) } satisfies InboxStatus));
export const lastCheck = (ctx: Ctx) => getSetting(ctx.db, LAST_CHECK_KEY) ?? null;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

interface Made { title: string; notes: string; dueUtc: string | null; timeAssumed: boolean }

/** Title and date from one reminder. Never throws and never returns an empty title. */
export function reminderToTask(ctx: Ctx, r: ReminderItem): Made {
  const notes: string[] = [];
  let text = (r.title ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  let title = text;
  let dueUtc: string | null = null;
  let timeAssumed = false;
  if (!text) {
    title = '(untitled reminder)';
    notes.push('The reminder on your phone had no title.');
  } else {
    try {
      const q = parseQuickAdd(text, ctx.tz, ctx.clock, ctx.defaultTime);
      title = q.title || text;
      dueUtc = q.dueUtc;
      timeAssumed = q.timeAssumed;
    } catch (e) {
      title = text;
      notes.push(`Tally could not read a date from this reminder (${(e as Error).message}). It has no due date; set one by hand.`);
    }
  }
  if (title.length > MAX_TITLE) {
    notes.push(`The full text from your phone was: ${text.slice(0, MAX_NOTE)}`);
    title = `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
  }
  // the reminder's own due date wins over a date typed in the title
  if (r.dueUtc && !Number.isNaN(Date.parse(r.dueUtc))) { dueUtc = new Date(r.dueUtc).toISOString(); timeAssumed = false; }
  else if (r.dueDay && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDay)) {
    const dt = DateTime.fromISO(`${r.dueDay}T${ctx.defaultTime}`, { zone: ctx.tz });
    if (dt.isValid) { dueUtc = dt.toUTC().toISO(); timeAssumed = true; }
  }
  if (r.notes?.trim()) notes.push(r.notes.replace(CONTROL, ' ').trim().slice(0, MAX_NOTE));
  notes.push(`Added from your phone (Reminders list “${'{LIST}'}”).`);
  return { title, notes: notes.join('\n\n'), dueUtc, timeAssumed };
}

const running = new WeakSet<Ctx>();

/**
 * One pass. `force` runs even when the switch is off or permission was denied (the Check now / Retry buttons).
 * Reads the list; for each reminder not seen before (oldest first, at most MAX_PER_PASS) creates the task and records its id in one
 * transaction, then marks the reminder completed. A reminder whose task exists but whose completion failed is retried next pass.
 */
export async function runInbox(ctx: Ctx, source: RemindersSource, opts: { force?: boolean } = {}): Promise<InboxPass> {
  const none: InboxPass = { ran: false, imported: 0, completeFailed: 0, retriedComplete: 0, waiting: 0, status: inboxStatus(ctx) };
  if (!opts.force && !inboxEnabled(ctx)) return { ...none, skipped: 'off' };
  const cur = inboxStatus(ctx);
  if (!opts.force && cur && (cur.state === 'denied' || cur.state === 'missing_list')) return { ...none, skipped: 'blocked' };
  if (running.has(ctx)) return { ...none, skipped: 'blocked' };
  running.add(ctx);
  try {
    const list = inboxList(ctx);
    const res = await source.fetch(list, MAX_FETCH);
    setSetting(ctx.db, LAST_CHECK_KEY, nowIso(ctx));
    if (res.status !== 'ok') {
      setStatus(ctx, res.status, res.message);
      return { ...none, ran: true, status: inboxStatus(ctx) };
    }
    const out: InboxPass = { ran: true, imported: 0, completeFailed: 0, retriedComplete: 0, waiting: 0, status: null };
    const known = new Map(ctx.db.all<{ reminder_id: string; completed_at: string | null }>('SELECT reminder_id, completed_at FROM reminder_imports').map((r) => [r.reminder_id, r.completed_at]));
    const seen = new Set<string>(); // the same id listed twice in one read is still one reminder
    const fresh = res.items.filter((i) => { if (!i.id || i.id.length > MAX_ID || known.has(i.id) || seen.has(i.id)) return false; seen.add(i.id); return true; });
    const todo = fresh.slice(0, MAX_PER_PASS);
    out.waiting = Math.max(0, fresh.length - todo.length) + Math.max(0, res.total - res.items.length);

    let blocked = false; // permission lost midway: stop touching Reminders
    const complete = async (id: string): Promise<boolean> => {
      const c = await source.complete(list, id);
      if (c.status === 'ok' || c.status === 'gone') {
        ctx.db.run('UPDATE reminder_imports SET completed_at = ?, complete_error = NULL WHERE reminder_id = ?', [nowIso(ctx), id]);
        return true;
      }
      if (c.status === 'denied') blocked = true;
      ctx.db.run('UPDATE reminder_imports SET complete_error = ? WHERE reminder_id = ?', [c.message.slice(0, 300), id]);
      return false;
    };

    // reminders already turned into tasks whose completion failed earlier: retry that, never the import
    for (const it of res.items) {
      if (blocked) break;
      if (known.has(it.id) && known.get(it.id) === null) { if (await complete(it.id)) out.retriedComplete++; else out.completeFailed++; }
    }

    for (const r of todo) {
      if (blocked) break;
      const made = reminderToTask(ctx, r);
      const { change } = recordChange(ctx, { actor: 'phone', tool: 'reminders_import', summary: (t: { id: number }) => `Added task #${t.id} “${made.title}” from your phone` }, () => {
        const t = addTask(ctx, { title: made.title, notes: made.notes.replace('{LIST}', list) });
        if (made.dueUtc) ctx.db.run('UPDATE tasks SET due_date = ?, time_assumed = ? WHERE id = ?', [made.dueUtc, made.timeAssumed ? 1 : 0, t.id]);
        ctx.db.run('INSERT INTO reminder_imports(reminder_id, list_name, task_id, title, imported_at) VALUES(?,?,?,?,?)', [r.id, list, t.id, made.title, nowIso(ctx)]);
        return t;
      });
      ctx.db.run('UPDATE reminder_imports SET change_id = ? WHERE reminder_id = ?', [change?.changeId ?? null, r.id]);
      out.imported++;
      // only now, with the task safely recorded, mark the reminder completed
      if (!(await complete(r.id))) out.completeFailed++;
    }

    if (blocked) setStatus(ctx, 'denied', 'macOS stopped allowing Tally to control Reminders. Switch it back on in System Settings > Privacy & Security > Automation, then press Retry.');
    else setStatus(ctx, 'ok', out.completeFailed ? `Imported, but ${out.completeFailed} reminder${out.completeFailed === 1 ? '' : 's'} could not be marked completed on this Mac (they will not be imported again; Tally retries).` : 'Working');
    out.status = inboxStatus(ctx);
    return out;
  } finally { running.delete(ctx); }
}

export interface InboxItem {
  reminderId: string;
  taskId: number;
  title: string;
  /** the task's current title (it may have been edited since) */
  taskTitle: string | null;
  due: string | null;
  importedAt: string;
  undone: boolean;
  taskDone: boolean;
  /** the reminder is still open in Reminders (completing it failed) */
  stillOpenOnPhone: boolean;
  /** an Undo is possible (not undone, and a recorded change exists) */
  canUndo: boolean;
  noDate: boolean;
}

export function recentImports(ctx: Ctx, limit = 8): InboxItem[] {
  const rows = ctx.db.all<{ reminder_id: string; task_id: number; change_id: number | null; title: string; imported_at: string; completed_at: string | null; t_title: string | null; due_date: string | null; status: string | null; deleted_at: string | null; undone_at: string | null }>(
    `SELECT ri.reminder_id, ri.task_id, ri.change_id, ri.title, ri.imported_at, ri.completed_at, t.title t_title, t.due_date, t.status, t.deleted_at, c.undone_at
       FROM reminder_imports ri LEFT JOIN tasks t ON t.id = ri.task_id LEFT JOIN change_log c ON c.id = ri.change_id
      ORDER BY ri.imported_at DESC, ri.rowid DESC LIMIT ?`, [limit]);
  return rows.map((r) => {
    const undone = !!r.undone_at || !!r.deleted_at;
    return { reminderId: r.reminder_id, taskId: r.task_id, title: r.title, taskTitle: r.t_title, due: r.due_date, importedAt: r.imported_at, undone, taskDone: r.status === 'done', stillOpenOnPhone: r.completed_at === null, canUndo: !undone && r.change_id !== null, noDate: !r.due_date };
  });
}

export const importedCount = (ctx: Ctx): number => ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM reminder_imports')!.n;

/** Undo one import (the same undo as every other change: refused if the task was edited since). The reminder stays completed and is never imported again. */
export function undoImport(ctx: Ctx, reminderId: string): { summary: string } {
  const r = ctx.db.get<{ change_id: number | null }>('SELECT change_id FROM reminder_imports WHERE reminder_id = ?', [reminderId]);
  if (!r) throw new Error('That item is not in the inbox history.');
  if (r.change_id === null) throw new Error('This item has no recorded change to undo. Delete the task from its detail panel instead.');
  return undoChange(ctx, r.change_id);
}

/** Items imported but not yet announced (for the notification). */
export function unannounced(ctx: Ctx): { reminder_id: string; title: string; rowid: number }[] {
  return ctx.db.all('SELECT reminder_id, title, rowid FROM reminder_imports WHERE announced_at IS NULL ORDER BY rowid');
}
export function markAnnounced(ctx: Ctx, ids: string[]): void {
  for (const id of ids) ctx.db.run('UPDATE reminder_imports SET announced_at = ? WHERE reminder_id = ?', [nowIso(ctx), id]);
}
