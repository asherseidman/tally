import { createHash, randomUUID } from 'node:crypto';
import type { Ctx } from './ctx';
import { nowIso } from './ctx';

/**
 * Hand-off between the Claude connector and the app. The connector never talks to Google: it asks the APP for a schedule
 * preview (the app holds the Google access) and asks the app to apply one, which waits for the user's approval in the window.
 * This module is only rows in `connector_jobs` plus the call log; no Google, no network.
 */
export const PREVIEW_MAX_AGE_MS = 30 * 60_000; // an older preview id is refused
export const APPLY_TTL_MS = 10 * 60_000; // a pending apply expires after this
export const CALL_LOG_KEEP = 50;

/** preview: a schedule preview; apply: a request waiting for approval; freetime / conflicts: questions that need Google busy time, answered by the app */
export type JobKind = 'preview' | 'apply' | 'freetime' | 'conflicts';
export type PreviewStatus = 'requested' | 'ready' | 'failed' | 'used';
export type ApplyStatus = 'pending' | 'approving' | 'applied' | 'rejected' | 'expired' | 'stale' | 'cancelled' | 'failed';

export interface Job {
  id: string;
  kind: JobKind;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  request: any;
  result: any;
  error: string | null;
}
interface Raw { id: string; kind: JobKind; status: string; created_at: string; updated_at: string; expires_at: string | null; request: string; result: string | null; error: string | null }
const parse = (r: Raw): Job => ({ ...r, request: JSON.parse(r.request), result: r.result ? JSON.parse(r.result) : null });

export const getJob = (ctx: Ctx, id: string): Job | undefined => {
  const r = ctx.db.get<Raw>('SELECT * FROM connector_jobs WHERE id = ?', [id]);
  return r && parse(r);
};

export function setJob(ctx: Ctx, id: string, patch: { status?: string; result?: unknown; error?: string | null; expires_at?: string | null }): void {
  const sets = ['updated_at = ?'];
  const vals: unknown[] = [nowIso(ctx)];
  if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
  if (patch.result !== undefined) { sets.push('result = ?'); vals.push(JSON.stringify(patch.result)); }
  if (patch.error !== undefined) { sets.push('error = ?'); vals.push(patch.error); }
  if (patch.expires_at !== undefined) { sets.push('expires_at = ?'); vals.push(patch.expires_at); }
  ctx.db.run(`UPDATE connector_jobs SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
}

function insertJob(ctx: Ctx, kind: JobKind, status: string, request: unknown, expiresAt: string | null = null): string {
  const id = randomUUID();
  const now = nowIso(ctx);
  ctx.db.run('INSERT INTO connector_jobs(id, kind, status, created_at, updated_at, expires_at, request) VALUES(?,?,?,?,?,?,?)', [id, kind, status, now, now, expiresAt, JSON.stringify(request)]);
  return id;
}

export const requestPreview = (ctx: Ctx, req: { days: number; replan: boolean }): string => insertJob(ctx, 'preview', 'requested', req);
/** A question for the app (it holds the Google access); answered by `processConnectorJobs` while Tally is open. */
export const requestJob = (ctx: Ctx, kind: 'preview' | 'freetime' | 'conflicts', req: unknown): string => insertJob(ctx, kind, 'requested', req);

/** Pending applies past their time become "expired". Safe to call from either process. */
export function expireJobs(ctx: Ctx): number {
  const now = nowIso(ctx);
  const r = ctx.db.run("UPDATE connector_jobs SET status = 'expired', updated_at = ? WHERE kind = 'apply' AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?", [now, now]);
  // a preview request nobody picked up for a minute means the app is not running: drop it so it cannot be answered much later
  ctx.db.run("UPDATE connector_jobs SET status = 'failed', error = 'Tally did not answer (is the app open?).', updated_at = ? WHERE kind <> 'apply' AND status = 'requested' AND created_at <= ?", [now, new Date(ctx.clock.now().getTime() - 60_000).toISOString()]);
  // housekeeping: keep the table small
  ctx.db.run("DELETE FROM connector_jobs WHERE created_at < ? AND status NOT IN ('pending','approving','requested')", [new Date(ctx.clock.now().getTime() - 24 * 3_600_000).toISOString()]);
  return r.changes;
}

export const requestedPreviews = (ctx: Ctx): Job[] => ctx.db.all<Raw>("SELECT * FROM connector_jobs WHERE kind = 'preview' AND status = 'requested' ORDER BY created_at").map(parse);
/** Every question waiting for the app: previews, free time, conflicts. */
export const requestedJobs = (ctx: Ctx): Job[] => ctx.db.all<Raw>("SELECT * FROM connector_jobs WHERE kind <> 'apply' AND status = 'requested' ORDER BY created_at").map(parse);

/** The apply that is waiting for approval (or being written right now), if any. */
export function openApply(ctx: Ctx): Job | undefined {
  expireJobs(ctx);
  const r = ctx.db.get<Raw>("SELECT * FROM connector_jobs WHERE kind = 'apply' AND status IN ('pending','approving') ORDER BY created_at DESC LIMIT 1");
  return r && parse(r);
}

export function latestApply(ctx: Ctx): Job | undefined {
  expireJobs(ctx);
  const r = ctx.db.get<Raw>("SELECT * FROM connector_jobs WHERE kind = 'apply' ORDER BY created_at DESC LIMIT 1");
  return r && parse(r);
}

export const createPendingApply = (ctx: Ctx, request: unknown, summary: unknown): string => {
  const id = insertJob(ctx, 'apply', 'pending', request, new Date(ctx.clock.now().getTime() + APPLY_TTL_MS).toISOString());
  setJob(ctx, id, { result: { summary } });
  return id;
};

/**
 * A fingerprint of everything a schedule depends on that lives in the database: tasks (the fields the planner reads),
 * dependencies, availability windows, the blocks already written, pinned blocks, and the current term. A preview is stale when this changed.
 * (Google busy time is not in the database; the app's own fingerprint check at approval covers that.)
 */
export function inputsHash(ctx: Ctx): string {
  const rows = {
    tasks: ctx.db.all("SELECT id, title, course, type, status, due_date, time_assumed, estimated_minutes, estimate_source, actual_minutes, deleted_at, size_amount, size_unit, available_from, optional, deadline_only, parent_task_id, term_id, recurrence_rule FROM tasks ORDER BY id"),
    deps: ctx.db.all('SELECT task_id, blocked_by_task_id FROM dependencies ORDER BY task_id, blocked_by_task_id'),
    windows: ctx.db.all('SELECT date, weekday, start, "end", kind FROM availability_windows ORDER BY id'),
    blocks: ctx.db.all('SELECT task_id, start, "end" FROM scheduled_blocks ORDER BY start, task_id'),
    pins: ctx.db.all('SELECT id, task_id, start, "end" FROM pins ORDER BY id'),
    term: ctx.db.get('SELECT id FROM terms WHERE is_current = 1 AND archived_at IS NULL'),
  };
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

// ---- the call log: what Claude did, newest first, last 50 kept
export interface CallEntry { id: number; at: string; tool: string; ok: boolean; detail: string }

export function logCall(ctx: Ctx, tool: string, ok: boolean, detail: string): void {
  ctx.db.run('INSERT INTO connector_calls(at, tool, ok, detail) VALUES(?,?,?,?)', [nowIso(ctx), tool, ok ? 1 : 0, detail.slice(0, 240)]);
  ctx.db.run('DELETE FROM connector_calls WHERE id NOT IN (SELECT id FROM connector_calls ORDER BY id DESC LIMIT ?)', [CALL_LOG_KEEP]);
}

export const listCalls = (ctx: Ctx, limit = CALL_LOG_KEEP): CallEntry[] =>
  ctx.db.all<{ id: number; at: string; tool: string; ok: number; detail: string }>('SELECT * FROM connector_calls ORDER BY id DESC LIMIT ?', [Math.min(limit, CALL_LOG_KEEP)]).map((r) => ({ ...r, ok: !!r.ok }));
