import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../core/ctx';
import type { ApiDeps } from '../app/api';
import { handlers } from '../app/api';
import { settingsView } from '../app/settingsApi';
import { startReview, applyReview, closeReview } from '../app/importReview';
import type { ImportReview } from '../app/types';
import type { TaskDto } from '../app/taskDto';
import { makeDtoBuilder } from '../app/taskDto';
import { buildWeek } from '../app/week';
import { listTasks, getTask, editTask, completeTask, uncompleteTask, deleteTask, addStep, type EditPatch } from '../core/tasks';
import { SIZE_UNITS, loadRates, ruleView } from '../core/size';
import { createList, renameList } from '../core/lists';
import { addDependency, removeDependency, dependents } from '../core/dependencies';
import { startExclusive, stopAll, runningTimers } from '../app/timerOps';
import { claudeDeletesAllowed, claudeScheduleAllowed } from '../core/claudeAccess';
import { requestJob, getJob, setJob, requestPreview, openApply, latestApply, createPendingApply, inputsHash, logCall, PREVIEW_MAX_AGE_MS, APPLY_TTL_MS, expireJobs } from '../core/connectorJobs';
import { logWork } from '../core/timer';
import { currentTerm } from '../core/terms';
import { claudeWritesAllowed } from '../core/claudeAccess';
import { getReview } from '../core/review';
import { trackChanges, recordChange, type ChangeReport } from '../core/changeLog';
import { getSetting } from '../db/repo';
import { schemaVersionOf } from '../db/index';
import type { Target } from './target';

export const ACTOR = 'claude';

/** Hard limits on everything Claude can send. Anything beyond them is refused, never truncated. */
export const LIMITS = { title: 300, notes: 5000, short: 100, text: 200, import: 1_000_000, listMax: 100, listDefault: 50 } as const;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });

export const DELETES_OFF = 'Claude deleting is turned off, so nothing was deleted. To allow it, open Tally: Settings, General, Claude connector, turn on “Allow Claude to delete tasks” (it also needs “Allow Claude to change my tasks”).';
export const SCHEDULE_OFF = 'Claude applying schedules is turned off, so nothing was requested. To allow it, open Tally: Settings, General, Claude connector, turn on “Allow Claude to apply schedules to Google”. Even then, nothing is written until you click Approve on the Schedule screen.';
/** a timer left running longer than this is flagged by get_timer */
export const LONG_TIMER_HOURS = 8;
export const WRITES_OFF = 'Claude changes are turned off, so nothing was changed. To allow them, open Tally: Settings, General, Claude connector, turn on “Allow Claude to change my tasks”.';

const id = z.number().int().positive().max(2_000_000_000);
const short = z.string().trim().min(1).max(LIMITS.short);

export interface McpEnv { ctx: Ctx; target: Target; backupFolder: string }

/** What the app layer needs; the connector has no calendar, so anything that would reach Google fails loudly. */
function depsFor(e: McpEnv): ApiDeps {
  return {
    ctx: e.ctx, dbFile: e.target.dbFile, demo: e.target.kind === 'demo', backupFolder: e.backupFolder,
    calendar: () => { throw new Error('The Claude connector never uses Google.'); },
  };
}

/** Another process (the app, the CLI) may have changed the time zone or default due time since the connector started. */
function refresh(ctx: Ctx) {
  ctx.tz = getSetting(ctx.db, 'timezone') ?? ctx.tz;
  ctx.defaultTime = getSetting(ctx.db, 'default_due_time') ?? ctx.defaultTime;
}

const slim = (t: TaskDto) => ({
  id: t.id, title: t.title, course: t.course, type: t.type, status: t.status, due: t.due, dueText: t.dueText || null, dueTimeAssumed: t.timeAssumed,
  gradeWeight: t.gradeWeight, estimateMinutes: t.estimate, loggedMinutes: t.actualMinutes, list: t.listName, term: t.termName,
  updatedAt: t.updatedAt, blockedBy: t.blockedBy, optional: t.optional, deadlineOnly: t.deadlineOnly, notes: t.notes ? t.notes.slice(0, 500) : null,
});

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Free minutes in `free` spans after taking away the planned `blocks` (both in minutes since local midnight). */
function freeAfter(free: { start: number; end: number }[], blocks: { start: number; end: number }[]): number {
  let total = 0;
  for (const f of free) {
    let covered = 0;
    const merged = blocks.map((b) => ({ s: Math.max(b.start, f.start), e: Math.min(b.end, f.end) })).filter((b) => b.e > b.s).sort((a, b) => a.s - b.s);
    let cursor = f.start;
    for (const b of merged) {
      const s = Math.max(b.s, cursor);
      if (b.e > s) { covered += b.e - s; cursor = b.e; }
    }
    total += f.end - f.start - covered;
  }
  return total;
}

const fingerprintOf = (r: ImportReview) => createHash('sha256').update(JSON.stringify({ t: r.term, n: r.termIsNew, e: r.entries, u: r.unchanged, m: r.missing })).digest('hex');

export function registerTools(server: McpServer, e: McpEnv): void {
  const d = depsFor(e);
  const { ctx } = e;

  /** Wrap a tool body: refresh settings, turn thrown errors into readable tool errors, and put every call in the visible call log. */
  const run = <A>(tool: string, fn: (a: A) => unknown | Promise<unknown>) => async (a: A): Promise<ToolResult> => {
    const argText = (() => { try { const j = JSON.stringify(a ?? {}); return j.length > 90 ? `${j.slice(0, 90)}…` : j; } catch { return ''; } })();
    const note = (ok: boolean, detail: string) => { try { logCall(ctx, tool, ok, `${argText} → ${detail}`); } catch { /* the log must never break a call */ } };
    try {
      refresh(ctx);
      const v = await fn(a);
      const o = v as { changed?: boolean; summary?: unknown; message?: string; status?: string } | null;
      note(true, o && o.changed === false ? 'nothing changed' : typeof o?.message === 'string' ? o.message : typeof o?.summary === 'string' ? o.summary : o?.status ? String(o.status) : 'ok');
      return ok(v);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      note(false, m.replace(/\s+/g, ' '));
      return fail(m);
    }
  };
  class Refusal extends Error {}
  const needDeletes = () => { needWrites(); if (!claudeDeletesAllowed(ctx.db)) throw new Refusal(DELETES_OFF); };
  const needSchedule = () => { if (!claudeScheduleAllowed(ctx.db)) throw new Refusal(SCHEDULE_OFF); };
  const needWrites = () => { if (!claudeWritesAllowed(ctx.db)) throw new Refusal(WRITES_OFF); };
  const taskOrThrow = (n: number) => { const t = getTask(ctx, n); if (!t) throw new Error(`No task #${n}.`); return t; };
  /** Optimistic check: the task must not have changed in Tally since Claude read it. */
  const staleCheck = (t: { id: number; updated_at: string }, readAt: string) => {
    if (t.updated_at !== readAt) throw new Error(`Task #${t.id} was changed in Tally after you read it (you read it at ${readAt}; it was last updated ${t.updated_at}). Nothing was changed. Read it again with get_task, check what changed, and redo the edit if it is still wanted.`);
  };
  const written = (change: ChangeReport | null, nothing: string) => (change ? { changed: true, ...change } : { changed: false, message: nothing });

  /** Ask the Tally app a question that needs Google busy time (the connector never contacts Google). */
  const googleWait = Number(process.env.TALLY_MCP_GOOGLE_WAIT_MS ?? 10_000);
  const askApp = async (kind: 'freetime' | 'conflicts', req: unknown): Promise<{ ok: true; result: any } | { ok: false; warning: string }> => {
    const jobId = requestJob(ctx, kind, req);
    const until = Date.now() + googleWait;
    for (;;) {
      const j = getJob(ctx, jobId)!;
      if (j.status === 'ready') return { ok: true, result: j.result };
      if (j.status === 'failed') return { ok: false, warning: `Google Calendar events are NOT included: ${j.error}` };
      if (Date.now() > until) {
        setJob(ctx, jobId, { status: 'failed', error: 'timed out' });
        return { ok: false, warning: 'Google Calendar events are NOT included: Tally is not open (the Tally app reads your calendar; this connector never does). Open Tally on this database and ask again.' };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

  // ------------------------------------------------------------------ read tools
  server.registerTool('tally_status', {
    title: 'Tally status',
    description: 'Which database this connector is using (real, demo or test), whether Claude may change tasks, delete tasks, or request a schedule apply (three separate switches), today\'s date, the time zone and the current term. Call this first.',
    inputSchema: z.object({}).strict(), annotations: READ,
  }, run('tally_status', () => {
    const cur = currentTerm(ctx);
    const n = (sql: string) => ctx.db.get<{ n: number }>(sql)!.n;
    return {
      database: { kind: e.target.kind, label: e.target.label, path: e.target.dbFile, schemaVersion: schemaVersionOf(e.target.dbFile) },
      claudeMayChangeTasks: claudeWritesAllowed(ctx.db), claudeMayDeleteTasks: claudeDeletesAllowed(ctx.db), claudeMayRequestScheduleApply: claudeScheduleAllowed(ctx.db),
      today: DateTime.fromJSDate(ctx.clock.now(), { zone: ctx.tz }).toISODate(), timezone: ctx.tz,
      currentTerm: cur ? { name: cur.name, start: cur.start_date, end: cur.end_date } : null,
      openTasks: n("SELECT COUNT(*) n FROM tasks WHERE deleted_at IS NULL AND status <> 'done'"),
      doneTasks: n("SELECT COUNT(*) n FROM tasks WHERE deleted_at IS NULL AND status = 'done'"),
    };
  }));

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'List tasks, soonest due first. Defaults to open tasks in the current term (plus tasks with no term). Filter by term, course, list, status and a due window; due_after / due_before accept dates or plain words ("friday", "2026-11-20", "next week"). A date with no time covers the whole day.',
    inputSchema: z.object({
      term: short.optional(), all_terms: z.boolean().optional(), course: short.optional(), list: short.optional(),
      status: z.enum(['open', 'todo', 'in_progress', 'done', 'all']).default('open'),
      due_after: short.optional(), due_before: short.optional(), text: z.string().trim().min(1).max(LIMITS.text).optional(),
      limit: z.number().int().min(1).max(LIMITS.listMax).default(LIMITS.listDefault),
    }).strict(), annotations: READ,
  }, run('list_tasks', (a) => {
    const all = listTasks(ctx, {
      scope: { term: a.term, allTerms: a.all_terms }, course: a.course, list: a.list, status: a.status === 'all' ? undefined : a.status,
      from: a.due_after, to: a.due_before, text: a.text,
    });
    const dto = makeDtoBuilder(ctx);
    return { count: all.length, returned: Math.min(all.length, a.limit), truncated: all.length > a.limit, tasks: all.slice(0, a.limit).map((t) => slim(dto(t))) };
  }));

  server.registerTool('get_task', {
    title: 'Get a task',
    description: 'One task in full: its fields, what blocks it and what it blocks, its steps (sub-tasks), its parent and recent time entries.',
    inputSchema: z.object({ id }).strict(), annotations: READ,
  }, run('get_task', (a) => {
    const r = handlers['tasks.get'](d, { id: a.id }) as { task: TaskDto; blockers: unknown; blocks: unknown; parent: unknown; steps: unknown; sessions: unknown };
    return { task: r.task, blockedBy: r.blockers, blocks: r.blocks, parent: r.parent, steps: r.steps, recentTimeEntries: r.sessions };
  }));

  server.registerTool('get_views', {
    title: "Today's views",
    description: 'The four computed lists: Due soon, High grade impact, Quick wins and Blocked (the same ones as the Today screen), each task with the reason it is there, plus any running timer.',
    inputSchema: z.object({ all_terms: z.boolean().optional() }).strict(), annotations: READ,
  }, run('get_views', (a) => {
    const v = handlers['views.get'](d, { allTerms: a.all_terms }) as { dueSoon: V[]; highImpact: V[]; quickWins: V[]; blocked: V[]; dueSoonHours: number; quickWinMinutes: number; timers: unknown };
    type V = { task: TaskDto; reason: string; minutes: number | null; score: number | null };
    const f = (xs: V[]) => xs.map((x) => ({ ...slim(x.task), reason: x.reason, minutes: x.minutes, score: x.score }));
    return { dueSoon: f(v.dueSoon), highGradeImpact: f(v.highImpact), quickWins: f(v.quickWins), blocked: f(v.blocked), dueSoonWindowHours: v.dueSoonHours, quickWinMinutes: v.quickWinMinutes, runningTimers: v.timers };
  }));

  server.registerTool('get_review', {
    title: 'Weekly review (read only)',
    description: 'What the weekly review screen shows, without changing anything: what was finished since the last review (planned blocks and due items), overdue and slipped tasks, tasks due in the next 14 days that have no estimate, no size or only an assumed due time, and when the last review was done. Claude cannot answer the review or mark it done: that happens only in Tally.',
    inputSchema: z.object({}).strict(), annotations: READ,
  }, run('get_review', () => {
    const r = getReview(ctx);
    return { ...r, note: 'Read only. The review itself (Done/Partly/Not done, Reschedule/Drop, fixes, the replan) is answered in the Tally app.' };
  }));

  server.registerTool('get_schedule', {
    title: 'Planned blocks',
    description: 'The work blocks currently planned (written to the "Planner Blocks" calendar and stored in Tally), soonest first, each marked pinned if you placed it by hand, plus pinned blocks not on the calendar yet. With include_google: true, Tally (if open) also lists `conflicts`: planned blocks that overlap busy time on your Google calendars, without saying what the busy time is. The connector itself never contacts Google.',
    inputSchema: z.object({ days: z.number().int().min(1).max(60).default(14), include_google: z.boolean().default(false) }).strict(), annotations: READ,
  }, run('get_schedule', async (a) => {
    const from = DateTime.fromJSDate(ctx.clock.now(), { zone: ctx.tz }).startOf('day');
    const range = [from.toUTC().toISO(), from.plus({ days: a.days }).toUTC().toISO()];
    const rows = ctx.db.all<{ task_id: number; start: string; end: string; title: string; course: string | null; type: string; pin_id: number | null }>(
      `SELECT b.task_id, b.start, b."end", t.title, t.course, t.type, p.id AS pin_id FROM scheduled_blocks b JOIN tasks t ON t.id = b.task_id
        LEFT JOIN pins p ON p.id = b.pin_id AND p.start = b.start AND p."end" = b."end"
        WHERE b."end" > ? AND b.start < ? ORDER BY b.start`, range);
    const onCal = new Set(rows.map((r) => r.pin_id).filter((x) => x != null));
    const pins = ctx.db.all<{ id: number; task_id: number; start: string; end: string; title: string }>(
      `SELECT p.id, p.task_id, p.start, p."end", t.title FROM pins p JOIN tasks t ON t.id = p.task_id WHERE p."end" > ? AND p.start < ? AND t.deleted_at IS NULL AND t.status <> 'done' ORDER BY p.start`, range).filter((p) => !onCal.has(p.id));
    const local = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(ctx.tz);
    const span = (s0: string, e0: string) => `${local(s0).toFormat('ccc LLL d, h:mm a')} to ${local(e0).toFormat('h:mm a')}`;
    const base = {
      timezone: ctx.tz, from: from.toISODate(), days: a.days, count: rows.length,
      blocks: rows.map((b) => ({
        taskId: b.task_id, title: b.title, course: b.course, type: b.type, start: b.start, end: b.end, pinned: b.pin_id != null,
        minutes: Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000), local: span(b.start, b.end),
      })),
      pinnedNotOnCalendarYet: pins.map((p) => ({ taskId: p.task_id, title: p.title, start: p.start, end: p.end, local: span(p.start, p.end), note: 'written at this time on the next Apply' })),
    };
    if (!a.include_google) return { ...base, conflicts: null, note: 'Pass include_google: true to check these blocks against your Google calendars (Tally must be open).' };
    const r = await askApp('conflicts', { days: a.days });
    if (!r.ok) return { ...base, conflicts: null, warning: r.warning };
    return { ...base, googleIncluded: true, ...(r.result.simulated ? { calendarNote: 'demo database: the simulated calendar' } : {}), conflicts: r.result.conflicts.map((c: { taskId: number; title: string; start: string; end: string; pinned: boolean; overlapMinutes: number }) => ({ ...c, local: span(c.start, c.end) })) };
  }));

  server.registerTool('get_free_time', {
    title: 'Free-time windows',
    description: 'Your free time, day by day, as local wall-clock HH:MM in the time zone given. By default: your availability windows, the Tally blocks inside them and the minutes left after those blocks (Google Calendar events NOT included). With include_google: true, Tally (if open) computes availability windows minus Google busy time (free/busy only, the calendars the scheduler uses) minus planned blocks and returns only the free intervals: never event titles, attendees or calendar names. If Tally is not open or Google is disconnected, you get the Tally-only answer with a warning.',
    inputSchema: z.object({ start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: z.number().int().min(1).max(14).default(7), include_google: z.boolean().default(false) }).strict(), annotations: READ,
  }, run('get_free_time', async (a) => {
    const startDate = a.start_date ?? DateTime.fromJSDate(ctx.clock.now(), { zone: ctx.tz }).toISODate()!;
    if (!DateTime.fromISO(startDate).isValid) throw new Error(`"${startDate}" is not a real date.`);
    const first = DateTime.fromISO(startDate, { zone: ctx.tz });
    const out: { date: string; weekday: string; windowsFrom: string; free: { start: string; end: string }[]; plannedBlocks: { start: string; end: string; label: string; pinned: boolean }[]; freeMinutes: number; freeMinutesAfterBlocks: number }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < a.days; i += 7) {
      for (const day of buildWeek(ctx, first.plus({ days: i }).toISODate()!).days) {
        if (seen.has(day.date) || day.date < startDate || day.date >= first.plus({ days: a.days }).toISODate()!) continue;
        seen.add(day.date);
        out.push({
          date: day.date, weekday: day.weekday, windowsFrom: day.source,
          free: day.free.map((f) => ({ start: hm(f.start), end: hm(f.end) })),
          plannedBlocks: day.blocks.map((b) => ({ start: hm(b.start), end: hm(b.end), label: b.label, pinned: b.pinId != null })),
          freeMinutes: day.free.reduce((s, f) => s + f.end - f.start, 0), freeMinutesAfterBlocks: freeAfter(day.free, day.blocks),
        });
      }
    }
    out.sort((x, y) => (x.date < y.date ? -1 : 1));
    const tallyOnly = { timezone: ctx.tz, googleIncluded: false, note: 'Google Calendar events are not included.', days: out };
    if (!a.include_google) return tallyOnly;
    const r = await askApp('freetime', { startDate, days: a.days });
    if (!r.ok) return { ...tallyOnly, warning: r.warning };
    const blocksOf = new Map(out.map((d) => [d.date, d.plannedBlocks]));
    return {
      timezone: ctx.tz, googleIncluded: true,
      note: 'free = your availability windows minus busy time on your Google calendars (free/busy only) minus Tally blocks. No event details are read or returned.',
      ...(r.result.simulated ? { calendarNote: 'demo database: the simulated calendar' } : {}),
      days: r.result.days.map((d: { date: string; weekday: string; free: { start: string; end: string }[]; freeMinutes: number }) => ({ date: d.date, weekday: d.weekday, free: d.free, freeMinutes: d.freeMinutes, plannedBlocks: blocksOf.get(d.date) ?? [] })),
    };
  }));

  server.registerTool('get_settings', {
    title: 'Settings',
    description: 'Scheduling and priority settings, the estimate rates (per unit, flat per assignment, or no rate; yours first, then the built-in ones, in the order they are tried), the time zone and default due time, and whether Claude may change tasks. Never includes Google credentials, calendar IDs, file paths or anything secret, and Claude cannot change settings.',
    inputSchema: z.object({}).strict(), annotations: READ,
  }, run('get_settings', () => {
    const s = settingsView(d);
    const rows = (xs: typeof s.scheduling) => xs.map((i) => ({ key: i.key, label: i.label, value: i.value, unit: i.unit ?? null, default: i.default }));
    return {
      timezone: s.general.timezone, defaultDueTime: s.general.defaultDueTime, claudeMayChangeTasks: claudeWritesAllowed(ctx.db), claudeMayDeleteTasks: claudeDeletesAllowed(ctx.db), claudeMayRequestScheduleApply: claudeScheduleAllowed(ctx.db),
      scheduling: rows(s.scheduling), priority: rows(s.priority), priorityFormula: s.formula,
      rates: ((r) => ({ yours: r.user.map((x, i) => ruleView(x, i + 1)), builtIn: r.defaults.map((x, i) => ruleView(x, r.user.length + i + 1)), pointsMinimumMinutes: r.all.pointsMin ?? null, note: 'Tried in this order, first match wins; a flat per-assignment rule beats a per-unit one, and a manual estimate beats both.' }))(loadRates(ctx)),
    };
  }));

  // ------------------------------------------------------------------ write tools (all behind the setting)
  const sizeSchema = z.object({ amount: z.number().positive().max(100000), unit: z.enum(SIZE_UNITS) }).strict();
  server.registerTool('add_task', {
    title: 'Add a task',
    description: 'Add a task. Needs "Allow Claude to change my tasks". By default a date at the end of the title is understood ("read ch 3 fri 5pm" becomes the title "read ch 3" due Friday 5 PM); pass due to set it explicitly. Goes in the current term when a course is given. Optional size {amount, unit} (units: pages, video_minutes, problems, items, points) gives a size-based estimate unless estimate_minutes is set.',
    inputSchema: z.object({
      title: z.string().trim().min(1).max(LIMITS.title), due: short.optional(), list: short.optional(), course: short.optional(),
      type: z.enum(['homework', 'project', 'exam', 'quiz', 'reading', 'attendance', 'other']).optional(),
      estimate_minutes: z.number().int().positive().max(10080).optional(), grade_weight: z.number().min(0).max(100).optional(),
      size: sizeSchema.optional(),
      notes: z.string().max(LIMITS.notes).optional(), parse_title_date: z.boolean().default(true),
    }).strict(), annotations: WRITE,
  }, run('add_task', (a) => {
    needWrites();
    const { result, change } = recordChange(ctx, { actor: ACTOR, tool: 'add_task', summary: (r: TaskDto) => `Added task #${r.id} “${r.title}”` }, () =>
      handlers['tasks.add'](d, { title: a.title, parseTitle: a.parse_title_date, due: a.due, list: a.list, course: a.course, type: a.type, est: a.estimate_minutes, weight: a.grade_weight, notes: a.notes, size: a.size }) as TaskDto);
    return { ...written(change, 'Nothing changed.'), task: slim(result) };
  }));

  server.registerTool('mark_done', {
    title: 'Mark a task done',
    description: 'Mark a task done (a repeating task also gets its next occurrence). Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ id }).strict(), annotations: WRITE,
  }, run('mark_done', (a) => {
    needWrites();
    const t = taskOrThrow(a.id);
    const { result, change } = recordChange(ctx, { actor: ACTOR, tool: 'mark_done', summary: () => `Marked #${t.id} “${t.title}” done` }, () => completeTask(ctx, a.id));
    return { ...written(change, `#${a.id} was already done. Nothing changed.`), nextOccurrence: result.next ? { id: result.next.id, due: result.next.due_date } : null };
  }));

  server.registerTool('reopen_task', {
    title: 'Reopen a task',
    description: 'Mark a done task as not done again. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ id }).strict(), annotations: WRITE,
  }, run('reopen_task', (a) => {
    needWrites();
    const t = taskOrThrow(a.id);
    const { change } = recordChange(ctx, { actor: ACTOR, tool: 'reopen_task', summary: () => `Reopened #${t.id} “${t.title}”` }, () => uncompleteTask(ctx, a.id));
    return written(change, 'Nothing changed.');
  }));

  server.registerTool('log_work', {
    title: 'Log work on a task',
    description: 'Record that you already worked `minutes` minutes on a task (it ended just now). The scheduler then plans only what is left of the estimate. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ id, minutes: z.number().int().min(1).max(1440) }).strict(), annotations: WRITE,
  }, run('log_work', (a) => {
    needWrites();
    const t = taskOrThrow(a.id);
    const { result, change } = recordChange(ctx, { actor: ACTOR, tool: 'log_work', summary: () => `Logged ${a.minutes} min on #${t.id} “${t.title}”` }, () => logWork(ctx, a.id, a.minutes));
    return { ...written(change, 'Nothing changed.'), totalLoggedMinutes: result.total };
  }));

  server.registerTool('edit_task', {
    title: 'Edit a task',
    description: 'Edit a task\'s fields: title, notes, list (a name, or "none"), course (or "none"), type, grade_weight (or null), optional, deadline_only, available_from (a date or plain words, or "none"), size ({amount, unit: pages|video_minutes|problems|items|points} or null), estimate_minutes (or null), due (dates or plain words, or "none"). Give only what changes. `read_updated_at` is REQUIRED: pass the task\'s `updatedAt` exactly as you read it (get_task / list_tasks). If the task was changed in Tally after that, the edit is refused and nothing is written: read it again. An estimate you set is a manual one and stays manual; changing the size never replaces a manual estimate. Not editable here: term, import keys, ids, repeat. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({
      id, read_updated_at: z.string().min(1).max(64),
      title: z.string().trim().min(1).max(LIMITS.title).optional(), notes: z.string().max(LIMITS.notes).nullable().optional(),
      list: short.optional(), course: short.optional(), type: z.enum(['homework', 'project', 'exam', 'quiz', 'reading', 'attendance', 'other']).optional(),
      grade_weight: z.number().min(0).max(100).nullable().optional(), optional: z.boolean().optional(), deadline_only: z.boolean().optional(),
      available_from: short.optional(), size: sizeSchema.nullable().optional(),
      estimate_minutes: z.number().int().positive().max(10080).nullable().optional(), due: short.optional(),
    }).strict().refine((v) => Object.keys(v).some((k) => k !== 'id' && k !== 'read_updated_at'), { message: 'Give at least one field to change.' }), annotations: WRITE,
  }, run('edit_task', (a) => {
    needWrites();
    const t = taskOrThrow(a.id);
    staleCheck(t, a.read_updated_at);
    if (a.course !== undefined && a.course.trim().toLowerCase() !== 'none' && t.term_id == null) throw new Error(`Task #${t.id} has no term, and giving it a course would attach it to the current term. Changing a task's term is not allowed through Claude; do it in Tally.`);
    const patch: EditPatch = {};
    if (a.title !== undefined) patch.title = a.title;
    if (a.notes !== undefined) patch.notes = a.notes;
    if (a.list !== undefined) patch.list = a.list;
    if (a.course !== undefined) patch.course = a.course;
    if (a.type !== undefined) patch.type = a.type;
    if (a.grade_weight !== undefined) patch.weight = a.grade_weight;
    if (a.optional !== undefined) patch.optional = a.optional;
    if (a.deadline_only !== undefined) patch.deadlineOnly = a.deadline_only;
    if (a.available_from !== undefined) patch.availableFrom = a.available_from;
    if (a.size !== undefined) patch.size = a.size;
    if (a.estimate_minutes !== undefined) patch.est = a.estimate_minutes;
    if (a.due !== undefined) patch.due = a.due;
    const fields = Object.keys(patch).join(', ');
    const { result, change } = recordChange(ctx, { actor: ACTOR, tool: 'edit_task', summary: () => `Edited #${t.id} “${t.title}” (${fields})` }, () => editTask(ctx, a.id, patch));
    return { ...written(change, 'Nothing changed (it already had those values).'), task: slim(makeDtoBuilder(ctx)(result)) };
  }));

  server.registerTool('create_list', {
    title: 'Create a list', description: 'Create a list (a named group of tasks). Needs "Allow Claude to change my tasks". Lists cannot be deleted through Claude.',
    inputSchema: z.object({ name: short }).strict(), annotations: WRITE,
  }, run('create_list', (a) => {
    needWrites();
    const { result, change } = recordChange(ctx, { actor: ACTOR, tool: 'create_list', summary: () => `Created list “${a.name}”` }, () => createList(ctx, a.name));
    return { ...written(change, 'Nothing changed.'), list: { id: result.id, name: result.name } };
  }));

  server.registerTool('rename_list', {
    title: 'Rename a list', description: 'Rename a list. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ name: short, new_name: short }).strict(), annotations: WRITE,
  }, run('rename_list', (a) => {
    needWrites();
    const { result, change } = recordChange(ctx, { actor: ACTOR, tool: 'rename_list', summary: () => `Renamed list “${a.name}” to “${a.new_name}”` }, () => renameList(ctx, a.name, a.new_name));
    return { ...written(change, 'Nothing changed.'), list: { id: result.id, name: result.name } };
  }));

  server.registerTool('move_task_to_list', {
    title: 'Move a task to a list', description: 'Put a task in a list (or `list: "none"` to take it out of its list). `read_updated_at` is required, as for edit_task. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ id, list: short, read_updated_at: z.string().min(1).max(64) }).strict(), annotations: WRITE,
  }, run('move_task_to_list', (a) => {
    needWrites();
    const t = taskOrThrow(a.id);
    staleCheck(t, a.read_updated_at);
    const none = a.list.toLowerCase() === 'none';
    const { change } = recordChange(ctx, { actor: ACTOR, tool: 'move_task_to_list', summary: () => `Moved #${t.id} “${t.title}” to ${none ? 'no list' : `“${a.list}”`}` }, () => handlers['tasks.move'](d, { id: a.id, list: none ? '' : a.list }));
    return written(change, 'Nothing changed (it was already there).');
  }));

  server.registerTool('add_step', {
    title: 'Add a step to a task', description: 'Add a step: a small task under a parent task (shown in the parent\'s detail). It takes the parent\'s term, course and list. One level only. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ parent: id, title: z.string().trim().min(1).max(LIMITS.title), estimate_minutes: z.number().int().positive().max(10080).optional() }).strict(), annotations: WRITE,
  }, run('add_step', (a) => {
    needWrites();
    const p = taskOrThrow(a.parent);
    const { result, change } = recordChange(ctx, { actor: ACTOR, tool: 'add_step', summary: (r: { id: number }) => `Added step #${r.id} “${a.title}” to #${p.id} “${p.title}”` }, () => addStep(ctx, a.parent, a.title, { est: a.estimate_minutes }));
    return { ...written(change, 'Nothing changed.'), step: slim(makeDtoBuilder(ctx)(result)) };
  }));

  server.registerTool('add_dependency', {
    title: 'Add a dependency',
    description: 'Make `task` wait on `blocked_by` (it shows under Blocked until that one is done). Refuses a cycle. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ task: id, blocked_by: id }).strict(), annotations: WRITE,
  }, run('add_dependency', (a) => {
    needWrites();
    const t = taskOrThrow(a.task);
    const b = taskOrThrow(a.blocked_by);
    const { change } = recordChange(ctx, { actor: ACTOR, tool: 'add_dependency', summary: () => `#${t.id} “${t.title}” now waits on #${b.id} “${b.title}”` }, () => addDependency(ctx, a.task, a.blocked_by));
    return written(change, 'Nothing changed (that dependency already exists).');
  }));

  server.registerTool('remove_dependency', {
    title: 'Remove a dependency', description: 'Stop `task` waiting on `blocked_by`. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ task: id, blocked_by: id }).strict(), annotations: WRITE,
  }, run('remove_dependency', (a) => {
    needWrites();
    const t = taskOrThrow(a.task);
    const b = taskOrThrow(a.blocked_by);
    const { change } = recordChange(ctx, { actor: ACTOR, tool: 'remove_dependency', summary: () => `#${t.id} “${t.title}” no longer waits on #${b.id} “${b.title}”` }, () => removeDependency(ctx, a.task, a.blocked_by));
    return written(change, 'Nothing changed (there was no such dependency).');
  }));

  // ------------------------------------------------------------------ timers (same rule as the app: one at a time)
  const timerView = () => {
    const now = ctx.clock.now().getTime();
    const running = runningTimers(ctx).map((r) => {
      const hours = (now - r.startedAtMs) / 3_600_000;
      return { taskId: r.taskId, title: r.title, startedAt: new Date(r.startedAtMs).toISOString(), elapsedMinutes: Math.floor((now - r.startedAtMs) / 60_000), runningOverLimit: hours > LONG_TIMER_HOURS };
    });
    return { running, ...(running.some((r) => r.runningOverLimit) ? { warning: `A timer has been running for more than ${LONG_TIMER_HOURS} hours (${running.filter((r) => r.runningOverLimit).map((r) => `#${r.taskId} “${r.title}”, ${Math.round(r.elapsedMinutes / 60 * 10) / 10} h`).join('; ')}). It may have been left on by mistake: ask the user, then stop_timer (the whole elapsed time is recorded) or fix it in Tally.` } : {}) };
  };

  server.registerTool('get_timer', {
    title: 'Running timer', description: `The running timer, if any: which task, when it started, minutes elapsed. A timer running more than ${LONG_TIMER_HOURS} hours is flagged (runningOverLimit and a warning).`,
    inputSchema: z.object({}).strict(), annotations: READ,
  }, run('get_timer', () => timerView()));

  server.registerTool('start_timer', {
    title: 'Start a timer', description: 'Start the timer on a task. Only one timer runs at a time, as in the app: a running one is stopped and recorded first. The Tally window and menu-bar icon show it within a few seconds. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({ id }).strict(), annotations: WRITE,
  }, run('start_timer', (a) => {
    needWrites();
    const t = taskOrThrow(a.id);
    if (t.status === 'done') throw new Error(`Task #${t.id} is done. Reopen it first.`);
    const before = runningTimers(ctx);
    const { change } = recordChange(ctx, { actor: ACTOR, tool: 'start_timer', summary: () => `Started the timer on #${t.id} “${t.title}”${before.length ? ` (stopped ${before.map((r) => `#${r.taskId}`).join(', ')})` : ''}` }, () => startExclusive(ctx, a.id));
    return { ...written(change, 'Nothing changed.'), stoppedAndRecorded: before.map((r) => ({ taskId: r.taskId, title: r.title })), ...timerView() };
  }));

  server.registerTool('stop_timer', {
    title: 'Stop the timer', description: 'Stop the running timer and record the session on its task, exactly as the app does. Needs "Allow Claude to change my tasks".',
    inputSchema: z.object({}).strict(), annotations: WRITE,
  }, run('stop_timer', () => {
    needWrites();
    const before = runningTimers(ctx);
    const { result, change } = recordChange(ctx, { actor: ACTOR, tool: 'stop_timer', summary: () => `Stopped the timer on ${before.map((r) => `#${r.taskId} “${r.title}”`).join(', ')}` }, () => stopAll(ctx));
    return { ...written(change, 'No timer was running.'), recorded: result };
  }));

  // ------------------------------------------------------------------ delete (its own switch, one task at a time, soft delete)
  server.registerTool('delete_task', {
    title: 'Delete a task', description: 'Delete ONE task (the same soft delete as the app: it can be undone in Tally, Settings, General, Claude connector). Needs BOTH "Allow Claude to change my tasks" and "Allow Claude to delete tasks". Refused if other open tasks are waiting on it, unless force is true. Lists and terms cannot be deleted through Claude.',
    inputSchema: z.object({ id, force: z.boolean().default(false) }).strict(), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, run('delete_task', (a) => {
    needDeletes();
    const t = taskOrThrow(a.id);
    const waiting = dependents(ctx, a.id).filter((x) => x.status !== 'done');
    if (waiting.length && !a.force) {
      throw new Error(`Not deleted: ${waiting.length} open task(s) are waiting on #${t.id} “${t.title}”: ${waiting.map((x) => `#${x.id} “${x.title}”`).join(', ')}. Deleting it would release them. If that is what the user wants, call again with force: true.`);
    }
    const { change } = recordChange(ctx, { actor: ACTOR, tool: 'delete_task', summary: () => `Deleted #${t.id} “${t.title}”${waiting.length ? ` (forced; released ${waiting.map((x) => `#${x.id}`).join(', ')})` : ''}` }, () => deleteTask(ctx, a.id));
    return { ...written(change, 'Nothing changed.'), releasedTasks: waiting.map((x) => ({ id: x.id, title: x.title })) };
  }));

  // ------------------------------------------------------------------ schedule: previews are computed by the APP; applying needs the user's approval in the app
  const waitMs = Number(process.env.TALLY_MCP_PREVIEW_WAIT_MS ?? 30_000);
  const previewVia = async (days: number, replan: boolean) => {
    const jobId = requestPreview(ctx, { days, replan });
    const until = Date.now() + waitMs;
    for (;;) {
      const j = getJob(ctx, jobId)!;
      if (j.status === 'ready') { const { _apply, ...view } = j.result; void _apply; return view; }
      if (j.status === 'failed') throw new Error(`The preview failed: ${j.error}`);
      if (Date.now() > until) {
        setJob(ctx, jobId, { status: 'failed', error: 'timed out' });
        throw new Error(`Tally did not answer within ${Math.round(waitMs / 1000)} seconds. The preview is computed by the Tally app (it holds the Google access, the connector does not), so Tally must be open on this same database. Open it and try again.`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const daysSchema = z.object({ days: z.number().int().min(1).max(60).default(14) }).strict();

  server.registerTool('preview_schedule', {
    title: 'Preview the schedule', description: 'What the Schedule screen would show: blocks to write, tentative blocks, MOVED / TRIMMED lines, DOES NOT FIT and NOT SCHEDULED, with a previewId and timestamp. Writes nothing. Computed by the Tally app (it reads your calendars; this connector never does), so Tally must be open. Always allowed.',
    inputSchema: daysSchema, annotations: READ,
  }, run('preview_schedule', (a: { days: number }) => previewVia(a.days, false)));

  server.registerTool('preview_replan', {
    title: 'Preview a replan', description: 'Like preview_schedule, but blocks you missed are re-placed (the Replan mode). Writes nothing. Tally must be open.',
    inputSchema: daysSchema, annotations: READ,
  }, run('preview_replan', (a: { days: number }) => previewVia(a.days, true)));

  server.registerTool('apply_schedule', {
    title: 'Ask to apply a schedule', description: 'Ask to write a previewed schedule to the “Planner Blocks” Google calendar. THIS NEVER WRITES BY ITSELF: it creates a pending request that the user must approve on the Schedule screen in Tally (Approve / Reject). It expires after 10 minutes, only one can be pending, and it is refused if tasks or availability changed since the preview. Needs “Allow Claude to apply schedules to Google”. Use get_pending_apply to see what happened.',
    inputSchema: z.object({ preview_id: z.string().uuid() }).strict(), annotations: WRITE,
  }, run('apply_schedule', (a) => {
    needSchedule();
    expireJobs(ctx);
    const pv = getJob(ctx, a.preview_id);
    if (!pv || pv.kind !== 'preview' || pv.status === 'requested' || pv.status === 'failed') throw new Error('Unknown preview_id. Call preview_schedule (or preview_replan) first and use the previewId it returns.');
    if (pv.status === 'used') throw new Error('That preview was already used for an apply request. Preview again.');
    if (ctx.clock.now().getTime() - Date.parse(pv.updated_at) > PREVIEW_MAX_AGE_MS) throw new Error(`That preview is older than ${PREVIEW_MAX_AGE_MS / 60_000} minutes and is stale. Preview again.`);
    const meta = pv.result._apply as { fingerprint: string; inputsHash: string; willRemove: number; willWrite: number; missedCount: number; trims: unknown; moved: unknown; demo: boolean };
    if (inputsHash(ctx) !== meta.inputsHash) throw new Error('Your tasks or availability changed since that preview, so it is stale and nothing was requested. Preview again.');
    const open = openApply(ctx);
    if (open) throw new Error(`Another apply request is already waiting for the user's approval in Tally (expires ${open.expires_at}). Only one can be pending at a time; wait for it to be approved, rejected or to expire (get_pending_apply).`);
    const applyId = createPendingApply(ctx, { previewId: pv.id, days: pv.result.days, replan: pv.result.mode === 'replan', fingerprint: meta.fingerprint, inputsHash: meta.inputsHash, previewedAt: pv.result.previewedAt },
      { willRemove: meta.willRemove, willWrite: meta.willWrite, missedCount: meta.missedCount, trims: meta.trims, moved: meta.moved, simulated: pv.result.calendar.simulated, demo: meta.demo });
    setJob(ctx, pv.id, { status: 'used' });
    const j = getJob(ctx, applyId)!;
    return {
      status: 'pending', applyId, expiresAt: j.expires_at, ttlMinutes: APPLY_TTL_MS / 60_000,
      willRemove: meta.willRemove, willWrite: meta.willWrite, calendar: pv.result.calendar,
      message: 'Nothing has been written. The user must click Approve on the Schedule screen in Tally. Check get_pending_apply.',
    };
  }));

  server.registerTool('get_pending_apply', {
    title: 'Pending apply status', description: 'Where the most recent apply_schedule request stands: pending (waiting for the user), applied (approved and written), rejected, expired, stale (things changed, nothing written), cancelled or failed.',
    inputSchema: z.object({ apply_id: z.string().uuid().optional() }).strict(), annotations: READ,
  }, run('get_pending_apply', (a: { apply_id?: string }) => {
    const j = a.apply_id ? getJob(ctx, a.apply_id) : latestApply(ctx);
    if (!j || j.kind !== 'apply') return { status: 'none', message: 'No apply request has been made.' };
    expireJobs(ctx);
    const cur = getJob(ctx, j.id)!;
    return { applyId: cur.id, status: cur.status, requestedAt: cur.created_at, expiresAt: cur.expires_at, updatedAt: cur.updated_at, willRemove: cur.result?.summary?.willRemove ?? null, willWrite: cur.result?.summary?.willWrite ?? null, message: cur.status === 'pending' ? 'Waiting for the user to approve or reject in Tally.' : cur.error ?? cur.result?.message ?? cur.status };
  }));

  // ------------------------------------------------------------------ import: a dry run, then a separate confirmation
  const pending = new Map<string, { text: string; fingerprint: string }>();
  const MAX_PENDING = 5;

  server.registerTool('import_dry_run', {
    title: 'Import: dry run',
    description: 'Check an import file (the JSON described in docs/IMPORT_FORMAT.md) and return what it WOULD do: new items, changed items (field by field, noting fields you edited locally that will not be overwritten), unchanged items and items missing from the file. Writes nothing. Returns a diff_id; to write, call import_confirm with that same diff_id.',
    inputSchema: z.object({ import_file: z.record(z.string(), z.unknown()) }).strict(), annotations: READ,
  }, run('import_dry_run', (a) => {
    const text = JSON.stringify(a.import_file);
    if (text.length > LIMITS.import) throw new Error(`The import file is too large (${text.length} characters; the limit is ${LIMITS.import}). Split it into smaller files.`);
    const r = startReview(d, text, 'the import file from Claude');
    const diffId = r.id;
    pending.set(diffId, { text, fingerprint: fingerprintOf(r) });
    while (pending.size > MAX_PENDING) { const old = pending.keys().next().value!; pending.delete(old); closeReview(d, old); }
    return {
      diff_id: diffId, term: r.term, termWillBeCreated: r.termIsNew, note: r.note,
      willAdd: r.willAdd, willUpdate: r.willUpdate,
      entries: r.entries.map((x) => ({ kind: x.kind, course: x.course, title: x.title, type: x.type, due: x.dueText, gradeWeight: x.weight, estimateMinutes: x.estimate, lowConfidence: x.lowConfidence, changes: x.changes })),
      unchangedCount: r.unchanged.length, missingFromFile: r.missing,
      next: 'Nothing has been written. To apply exactly this, call import_confirm with this diff_id (it needs "Allow Claude to change my tasks" and refuses if your data changed since this dry run).',
    };
  }));

  server.registerTool('import_confirm', {
    title: 'Import: confirm',
    description: 'Write the import previewed by import_dry_run, identified by its diff_id. Refuses if the diff_id is unknown, or if your tasks changed since the dry run so the diff is no longer what was previewed (run the dry run again). Needs "Allow Claude to change my tasks". A verified backup is taken after a real import.',
    inputSchema: z.object({ diff_id: z.string().uuid() }).strict(), annotations: WRITE,
  }, run('import_confirm', async (a) => {
    needWrites();
    const p = pending.get(a.diff_id);
    if (!p) throw new Error('Unknown diff_id (or it was already used). Run import_dry_run again.');
    // Rebuild the diff from the stored file against the data as it is NOW, and require it to be identical to what was previewed.
    closeReview(d, a.diff_id);
    const fresh = startReview(d, p.text, 'the import file from Claude');
    if (fingerprintOf(fresh) !== p.fingerprint) {
      closeReview(d, fresh.id);
      pending.delete(a.diff_id);
      throw new Error('Your tasks changed since that dry run, so the diff is different now. Nothing was written. Run import_dry_run again and confirm the new diff.');
    }
    pending.delete(a.diff_id);
    const tracker = trackChanges(ctx);
    let change: ChangeReport | null = null;
    const res = await applyReview(d, fresh.id, () => {
      change = tracker.finish({ actor: ACTOR, tool: 'import_confirm', summary: `Imported ${fresh.willAdd} new, ${fresh.willUpdate} updated item(s) for ${fresh.term}` });
    });
    return { ...(change ? { changed: true, ...(change as ChangeReport) } : { changed: false }), inserted: res.inserted, updated: res.updated, termCreated: res.termCreated, keptLocalEdits: res.keptLocalEdits, backup: res.backup, backupError: res.backupError, message: res.message, undoNote: res.termCreated ? 'Undo restores the tasks but leaves the new term in place.' : undefined };
  }));
}
