import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import type { CalendarClient } from '../schedule/calendar';
import { listTerms, useTerm } from '../core/terms';
import { listBackups } from '../core/backup';
import { buildWeek, clipToDay } from './week';
import { weekBusy } from './busy';
import {
  setWindow, eraseWindow, clearDate, copyWeek, targetRows, restoreRows, parseRange, type Target,
} from '../schedule/availabilityWindows';
import { createHash } from 'node:crypto';
import { computePlan, applyPlan, previewMoves, previewTrims, previewRemoveCount, type PlanReport } from '../schedule/service';
import { trimHeading, trimLines, movedLines, creditedLines } from '../schedule/format';
import { eventTitle } from '../schedule/eventTitle';
import { addTask, editTask, getTask, listTasks, completeTask, uncompleteTask, deleteTask, undoDelete, TASK_TYPES, type EditPatch, type Task } from '../core/tasks';
import { createList, renameList, deleteList, listLists, moveTask } from '../core/lists';
import { addDependency, removeDependency, allBlockers, dependents } from '../core/dependencies';
import { openSessions, logWork } from '../core/timer';
import { startExclusive, stopAll } from './timerOps';
import { computeViews, loadViewSettings } from '../core/views';
import { getOrder, saveOrder, applyOrder, LIST_ORDER_KEY, taskOrderKey } from '../core/ordering';
import { SIZE_UNITS } from '../core/size';
import { ratesHandlers } from './ratesApi';
import { parseQuickAdd } from '../core/quickAdd';
import { claudeScheduleAllowed } from '../core/claudeAccess';
import { NOT_SET_UP_MESSAGE } from '../schedule/noCalendar';
import { ReconnectRequiredError } from '../schedule/googleCalendar';
import { currentProblem, problemMessage, classifyCode } from '../schedule/googleHealth';
import { getJob, setJob, expireJobs, requestedJobs, openApply, latestApply, inputsHash, type Job } from '../core/connectorJobs';
import { notifyHandlers, undoRecordedChange, settingsView, schemeState, checkScheme, setSettingValue, resetSettingValue, termRows, termHandlers, backupsView, backupNow, restoreFrom, googleHandlers, googleClientHandlers, type AppHooks } from './settingsApi';
import { startReview, toggleEntry, editEntry, closeReview, applyReview } from './importReview';
import { makeDtoBuilder, type TaskDto } from './taskDto';
import { checkPin, createPin, movePin, removePin, getPin, pinsForPlan } from '../schedule/pins';
import { googleBusy } from '../schedule/busyTime';
import { loadWindows, resolveDay as resolveWindowDay } from '../schedule/availabilityWindows';
import { subtractIntervals as cut, mergeIntervals as merge } from '../schedule/availability';
import { runInbox, undoImport, inboxEnabled, inboxList, inboxStatus, lastCheck, importedCount, recentImports, DEFAULT_INBOX_LIST } from '../phone/inbox';
import { loadNotifySettings } from './notifier';
import type { InboxView, InboxCheckResult } from './types';
import { reviewState, ensureReviewClock, getReview, applyStep, finishReview, type ReviewState, type ReviewData, type StepResult } from '../core/review';
import type { PinResult, PendingState, PendingApplyView, BannerDto, RecentNotice, SettingsView, TermRow, ArchivedTerm, BackupsView, GoogleStatus, ImportReview, ImportApplied, SchedulePreview, ScheduleApplied, QuickPreview, AppInfo, BusyResult, DryRunResult, PaintResult, ViewsResult, TimerStatus, ListInfo, TaskDetail } from './types';

/**
 * The whole surface the UI may call. Every function takes validated arguments and delegates to the same core
 * functions the CLI uses; there is no business logic here. Results are plain JSON.
 */
export interface ApiDeps {
  ctx: Ctx;
  dbFile: string;
  demo: boolean;
  backupFolder: string;
  /** lazily creates the calendar client (Google, or simulated for the demo database) */
  hooks?: AppHooks;
  calendar: () => { calendar: CalendarClient; classCalendarIds?: string[]; simulated?: boolean; unavailable?: boolean };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => DateTime.fromISO(s).isValid, 'not a real date');
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const target = z.union([z.object({ date }), z.object({ weekday: z.number().int().min(1).max(7) })]);
const range = z.object({ start: hm, end: hm }).refine((r) => r.end > r.start, 'end must be after start');
const row = z.object({ date: date.nullable(), weekday: z.number().int().min(1).max(7).nullable(), start: hm, end: hm, kind: z.enum(['free', 'blocked']) });

const id = z.object({ id: z.number().int().positive() });
const taskType = z.enum(TASK_TYPES);
const patchSchema = z
  .object({
    title: z.string(), notes: z.string().nullable(), due: z.string(), list: z.string(), course: z.string(), type: taskType,
    est: z.number().int().positive().nullable(), weight: z.number().min(0).max(100).nullable(), repeat: z.string(), term: z.string(),
    size: z.object({ amount: z.number().positive(), unit: z.enum(SIZE_UNITS) }).nullable(), availableFrom: z.string(),
    optional: z.boolean(), deadlineOnly: z.boolean(), estFromSize: z.boolean(),
  })
  .partial();

const scheduleArgs = z.object({ days: z.number().int().min(1).max(60).default(14), replan: z.boolean().default(false) });
const PLANNER_CALENDAR_NAME = 'Planner Blocks';

const planFingerprint = (r: PlanReport, replan: boolean): string =>
  createHash('sha1').update(JSON.stringify([replan, r.blocks.map((b) => [b.taskId, b.start, b.end, b.pinned ? b.pinId : 0])])).digest('hex');

/** The plan as plain JSON for the UI (blocks with their per-day spans, problems, skipped tasks). */
function planDto(d: ApiDeps, r: PlanReport): DryRunResult {
  const title = (id: number) => {
    const t = r.tasks.get(id);
    return t ? eventTitle({ course: t.course, title: t.title, isExam: !!t.isExam }) : `#${id}`;
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const spansOf = (startMs: number, endMs: number) => {
    const out: { date: string; start: number; end: number }[] = [];
    for (let day = DateTime.fromMillis(startMs, { zone: d.ctx.tz }).startOf('day'); day.toMillis() < endMs; day = day.plus({ days: 1 })) {
      const sp = clipToDay({ start: startMs, end: endMs }, day.toISODate()!, d.ctx.tz);
      if (sp) out.push({ date: day.toISODate()!, ...sp });
    }
    return out;
  };
  const mk = (b: { taskId: number; start: number; end: number; part: number; parts: number; pinned?: boolean; pinId?: number }, tentative: boolean) => {
    const t = r.tasks.get(b.taskId)!;
    return { taskId: b.taskId, title: eventTitle({ course: t.course, title: t.title, isExam: !!t.isExam, part: b.part, parts: b.parts }), start: iso(b.start), end: iso(b.end), tentative, ...(b.pinned ? { pinned: true, pinId: b.pinId } : {}), spans: spansOf(b.start, b.end) };
  };
  return {
    blocks: [...r.blocks.map((b) => mk(b, false)), ...r.tentative.map((b) => mk(b, true))],
    problems: [
      ...r.problems.map((p) => ({ taskId: p.taskId, title: title(p.taskId), reason: p.reason, tentative: false, shortMinutes: Math.round(p.neededMinutes - p.placedMinutes) })),
      ...r.tentativeProblems.map((p) => ({ taskId: p.taskId, title: title(p.taskId), reason: p.reason, tentative: true, shortMinutes: Math.round(p.neededMinutes - p.placedMinutes) })),
    ],
    skipped: r.skipped.map((s) => ({ taskId: s.task.id, title: s.task.title, reason: s.reason })),
    horizonEnd: iso(r.horizonEndMs),
    pinWarnings: r.pinWarnings.map((w) => ({ pinId: w.pinId, taskId: w.taskId, title: w.title, start: iso(w.start), end: iso(w.end), reason: w.reason, message: w.message })),
  };
}

// ---- pinned blocks (moved or resized by hand). The check needs Google busy time for the days around the drop.
async function busyAround(d: ApiDeps, startMs: number, endMs: number) {
  const from = DateTime.fromMillis(startMs, { zone: d.ctx.tz }).startOf('day').toMillis();
  const to = Math.max(DateTime.fromMillis(endMs, { zone: d.ctx.tz }).endOf('day').toMillis() + 1, from + 3 * 86_400_000);
  const c = d.calendar();
  return googleBusy(d.ctx, c.calendar, from, to, c.classCalendarIds);
}
const pinArgs = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) });
async function placePin(d: ApiDeps, input: { taskId: number; start: number; end: number; pinId?: number }): Promise<PinResult> {
  const res = checkPin(d.ctx, input, await busyAround(d, input.start, input.end));
  if (!res.ok) return res;
  const p = input.pinId ? movePin(d.ctx, input.pinId, input.start, input.end) : createPin(d.ctx, input.taskId, input.start, input.end);
  return { ok: true, pin: { id: p.id, taskId: p.task_id, start: p.start, end: p.end } };
}

const timerStatus = (d: ApiDeps): TimerStatus[] =>
  openSessions(d.ctx).map((s) => {
    const t = getTask(d.ctx, s.task_id);
    return { sessionId: s.id, taskId: s.task_id, title: t?.title ?? `#${s.task_id}`, startedAt: s.started_at };
  });

const taskDetail = (d: ApiDeps, taskId: number): TaskDetail => {
  const t = getTask(d.ctx, taskId, { includeDeleted: true });
  if (!t) throw new Error(`No task #${taskId}.`);
  const dto = makeDtoBuilder(d.ctx);
  return {
    task: dto(t),
    blockers: allBlockers(d.ctx, taskId).map((b) => ({ id: b.id, title: b.title, open: b.open })),
    blocks: dependents(d.ctx, taskId).map((b) => ({ id: b.id, title: b.title })),
    parent: t.parent_task_id ? (() => { const p = getTask(d.ctx, t.parent_task_id!); return p ? { id: p.id, title: p.title } : null; })() : null,
    steps: d.ctx.db.all<Task>('SELECT * FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL ORDER BY id', [taskId]).map((s) => ({ id: s.id, title: s.title, done: s.status === 'done' })),
    sessions: d.ctx.db.all<{ started_at: string; ended_at: string | null }>('SELECT started_at, ended_at FROM time_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 20', [taskId]).map((x) => ({ startedAt: x.started_at, endedAt: x.ended_at })),
    lists: listLists(d.ctx).map((l) => l.name),
  };
};

type Handler = (d: ApiDeps, args: unknown) => unknown | Promise<unknown>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const handlers: Record<string, Handler> = {
  ...ratesHandlers,
  'app.info': (d): AppInfo => {
    const terms = listTerms(d.ctx);
    const cur = terms.find((t) => t.is_current && !t.archived_at);
    const last = listBackups(d.backupFolder)[0];
    const now = d.ctx.clock.now();
    return {
      dbFile: d.dbFile, demo: d.demo, tz: d.ctx.tz, today: DateTime.fromJSDate(now, { zone: d.ctx.tz }).toISODate()!,
      terms: terms.map((t) => ({ id: t.id, name: t.name, start_date: t.start_date, end_date: t.end_date, is_current: !!t.is_current, archived: !!t.archived_at })),
      currentTermId: cur?.id ?? null, backupFolder: d.backupFolder,
      lastBackup: last ? { name: last.name, takenAt: last.takenAt.toISOString(), ageHours: Math.round(((now.getTime() - last.takenAt.getTime()) / 3_600_000) * 10) / 10 } : null,
    };
  },

  'terms.use': (d, a) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(a);
    useTerm(d.ctx, name);
    return handlers['app.info'](d, undefined);
  },

  'views.get': (d, a): ViewsResult => {
    const { allTerms } = z.object({ allTerms: z.boolean().optional() }).parse(a ?? {});
    const v = computeViews(d.ctx, { scope: { allTerms } });
    const dto = makeDtoBuilder(d.ctx);
    const conv = (xs: typeof v.dueSoon) => xs.map((x) => ({ task: dto(x.task), reason: x.reason, minutes: x.minutes, score: (x as { score?: number }).score ?? null }));
    const s = loadViewSettings(d.ctx);
    return { dueSoon: conv(v.dueSoon), highImpact: conv(v.highImpact), quickWins: conv(v.quickWins), blocked: conv(v.blocked), dueSoonHours: s.dueSoonHours, quickWinMinutes: s.quickWinMinutes, timers: timerStatus(d) };
  },

  'timer.status': (d): TimerStatus[] => timerStatus(d),
  // One timer at a time: starting a new one stops (and records) the running one first.
  'timer.start': (d, a) => {
    const { id: taskId } = id.parse(a);
    startExclusive(d.ctx, taskId);
    return timerStatus(d);
  },
  'timer.stop': (d) => {
    const stopped = stopAll(d.ctx);
    return { stopped, timers: timerStatus(d) };
  },

  'tasks.add': (d, a): TaskDto => {
    const p = z.object({
      title: z.string().min(1), parseTitle: z.boolean().optional(), due: z.string().optional(), list: z.string().optional(), course: z.string().optional(), type: taskType.optional(),
      est: z.number().int().positive().optional(), weight: z.number().min(0).max(100).optional(), notes: z.string().optional(),
      size: z.object({ amount: z.number().positive().max(100000), unit: z.enum(SIZE_UNITS) }).optional(),
    }).parse(a);
    const { parseTitle, size, ...fields } = p;
    const clean: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v !== undefined));
    // Quick-add: take the due date from the end of the title, unless a due date was given explicitly (that wins and the title is kept as typed).
    if (parseTitle && !clean.due) {
      const q = parseQuickAdd(p.title, d.ctx.tz, d.ctx.clock, d.ctx.defaultTime);
      if (q.dueUtc && q.phrase) { clean.title = q.title; clean.due = q.phrase; } // addTask re-parses the phrase with the same parser, so time_assumed is kept
    }
    const added = d.ctx.db.transaction(() => { const t = addTask(d.ctx, clean as never); return size ? editTask(d.ctx, t.id, { size }) : t; });
    return makeDtoBuilder(d.ctx)(added);
  },
  'tasks.parseQuick': (d, a): QuickPreview => {
    const p = z.object({ text: z.string(), due: z.string().optional() }).parse(a);
    if (p.due?.trim()) return { title: p.text.trim(), due: null, dueText: null, timeAssumed: false, phrase: null, explicitDue: true };
    const q = parseQuickAdd(p.text, d.ctx.tz, d.ctx.clock, d.ctx.defaultTime);
    const dt = q.dueUtc ? DateTime.fromISO(q.dueUtc, { zone: 'utc' }).setZone(d.ctx.tz) : null;
    return { title: q.title, due: q.dueUtc, dueText: dt ? dt.toFormat('ccc LLL d, h:mm a') : null, timeAssumed: q.timeAssumed, phrase: q.phrase, explicitDue: false };
  },
  'tasks.list': (d, a): TaskDto[] => {
    const f = z.object({
      list: z.string().optional(), status: z.enum(['open', 'done', 'all']).default('open'), text: z.string().optional(), allTerms: z.boolean().optional(), limit: z.number().int().positive().max(500).optional(),
    }).parse(a ?? {});
    let tasks = listTasks(d.ctx, { scope: { allTerms: f.allTerms }, status: f.status === 'all' ? undefined : f.status, text: f.text });
    if (f.list === 'none') tasks = applyOrder(tasks.filter((t) => t.list_id == null), getOrder(d.ctx, taskOrderKey(null)));
    else if (f.list) {
      const l = listLists(d.ctx).find((x) => x.name.toLowerCase() === f.list!.toLowerCase());
      tasks = l ? applyOrder(tasks.filter((t) => t.list_id === l.id), getOrder(d.ctx, taskOrderKey(l.id))) : [];
    }
    const dto = makeDtoBuilder(d.ctx);
    return tasks.slice(0, f.limit ?? 500).map(dto);
  },
  'tasks.get': (d, a): TaskDetail => taskDetail(d, id.parse(a).id),
  'tasks.edit': (d, a): TaskDetail => {
    const p = z.object({ id: z.number().int().positive(), patch: patchSchema }).parse(a);
    editTask(d.ctx, p.id, p.patch as EditPatch);
    return taskDetail(d, p.id);
  },
  'tasks.done': (d, a) => {
    const r = completeTask(d.ctx, id.parse(a).id);
    return { next: r.next ? r.next.id : null };
  },
  'tasks.undone': (d, a) => { uncompleteTask(d.ctx, id.parse(a).id); return { ok: true }; },
  'tasks.delete': (d, a) => { const t = deleteTask(d.ctx, id.parse(a).id); return { id: t.id, title: t.title }; },
  'tasks.undelete': (d, a) => { undoDelete(d.ctx, id.parse(a).id); return { ok: true }; },
  'tasks.move': (d, a) => {
    const p = z.object({ id: z.number().int().positive(), list: z.string() }).parse(a);
    const before = getTask(d.ctx, p.id)?.list_id ?? null;
    const moved = moveTask(d.ctx, p.id, p.list === '' ? null : p.list);
    // a moved task joins the end of its new list; forget its place in the old order (and any stale place in the new one)
    for (const lid of new Set([before, moved.list_id])) {
      const key = taskOrderKey(lid);
      const cur = getOrder(d.ctx, key);
      if (cur.includes(p.id)) saveOrder(d.ctx, key, cur.filter((x) => x !== p.id));
    }
    return { ok: true };
  },
  'tasks.reorder': (d, a) => {
    const p = z.object({ listId: z.number().int().positive().nullable(), ids: z.array(z.number().int().positive()) }).parse(a);
    saveOrder(d.ctx, taskOrderKey(p.listId), p.ids);
    return { ok: true };
  },
  'tasks.log': (d, a) => {
    const p = z.object({ id: z.number().int().positive(), minutes: z.number().int().positive().max(1440) }).parse(a);
    return logWork(d.ctx, p.id, p.minutes);
  },

  // weekly review: reading writes nothing; each step writes only when its decisions are sent, through the same core functions (and the undo history)
  'review.state': (d): ReviewState => { ensureReviewClock(d.ctx); return reviewState(d.ctx); },
  'review.get': (d): ReviewData => { ensureReviewClock(d.ctx); return getReview(d.ctx); },
  'review.apply': (d, a): StepResult => {
    const p = z.object({ step: z.enum(['a', 'b', 'c']), decisions: z.array(z.record(z.string(), z.unknown())).min(1).max(200) }).parse(a);
    return applyStep(d.ctx, p.step, p.decisions);
  },
  'review.finish': (d): ReviewState => finishReview(d.ctx),

  'inbox.get': (d): InboxView => inboxView(d),
  // "Check now" and "Retry": run one pass now, even if the switch is off or permission was denied before
  'inbox.check': async (d): Promise<InboxCheckResult> => {
    const source = d.hooks?.reminders;
    if (!source) throw new Error('Phone capture needs Apple Reminders, which is only available in the Tally app on a Mac.');
    const pass = await runInbox(d.ctx, source, { force: true });
    return { ...inboxView(d), pass: { ran: pass.ran, skipped: pass.skipped, imported: pass.imported, completeFailed: pass.completeFailed, retriedComplete: pass.retriedComplete, waiting: pass.waiting } };
  },
  'inbox.undo': (d, a): InboxView => { undoImport(d.ctx, z.object({ reminderId: z.string().min(1).max(300) }).parse(a).reminderId); return inboxView(d); },
  'inbox.openPrivacy': (d) => { if (!d.hooks?.openPrivacyPane) throw new Error('This build cannot open System Settings.'); d.hooks.openPrivacyPane(); return { ok: true }; },

  'deps.add': (d, a): TaskDetail => {
    const p = z.object({ task: z.number().int().positive(), blockedBy: z.number().int().positive() }).parse(a);
    addDependency(d.ctx, p.task, p.blockedBy);
    return taskDetail(d, p.task);
  },
  'deps.remove': (d, a): TaskDetail => {
    const p = z.object({ task: z.number().int().positive(), blockedBy: z.number().int().positive() }).parse(a);
    removeDependency(d.ctx, p.task, p.blockedBy);
    return taskDetail(d, p.task);
  },

  'lists.list': (d): ListInfo[] => {
    const lists = applyOrder(listLists(d.ctx), getOrder(d.ctx, LIST_ORDER_KEY));
    const counts = new Map(d.ctx.db.all<{ l: number; open: number; done: number }>("SELECT list_id l, SUM(status <> 'done') open, SUM(status = 'done') done FROM tasks WHERE list_id IS NOT NULL AND deleted_at IS NULL GROUP BY list_id").map((r) => [r.l, r]));
    return lists.map((l) => ({ id: l.id, name: l.name, termId: l.term_id, open: counts.get(l.id)?.open ?? 0, done: counts.get(l.id)?.done ?? 0 }));
  },
  'lists.create': (d, a) => { createList(d.ctx, z.object({ name: z.string().min(1) }).parse(a).name); return handlers['lists.list'](d, undefined); },
  'lists.rename': (d, a) => { const p = z.object({ name: z.string().min(1), newName: z.string().min(1) }).parse(a); renameList(d.ctx, p.name, p.newName); return handlers['lists.list'](d, undefined); },
  'lists.delete': (d, a) => { const r = deleteList(d.ctx, z.object({ name: z.string().min(1) }).parse(a).name); return { ...r, lists: handlers['lists.list'](d, undefined) }; },
  'lists.reorder': (d, a) => { saveOrder(d.ctx, LIST_ORDER_KEY, z.object({ ids: z.array(z.number().int().positive()) }).parse(a).ids); return handlers['lists.list'](d, undefined); },

  // Import: the file is read by the window (file picker or drop) and its text sent here; nothing is written until import.apply.
  'import.review': (d, a): ImportReview => { const p = z.object({ text: z.string().max(5_000_000), fileName: z.string().max(300).default('the file') }).parse(a); return startReview(d, p.text, p.fileName); },
  'import.toggle': (d, a): ImportReview => { const p = z.object({ id: z.string(), num: z.number().int().positive(), included: z.boolean() }).parse(a); return toggleEntry(d, p.id, p.num, p.included); },
  'import.edit': (d, a): ImportReview => { const p = z.object({ id: z.string(), num: z.number().int().positive(), field: z.string(), value: z.string() }).parse(a); return editEntry(d, p.id, p.num, p.field, p.value); },
  'import.close': (d, a) => closeReview(d, z.object({ id: z.string() }).parse(a).id),
  'import.apply': (d, a): Promise<ImportApplied> => { const p = z.object({ id: z.string(), confirm: z.literal(true, { error: 'Importing needs an explicit confirmation.' }) }).parse(a); return applyReview(d, p.id); },

  // Settings (same validation as `config set`; the main process supplies the hooks that need Electron)
  'settings.get': (d): SettingsView => settingsView(d),
  // Color scheme: every window asks for the stylesheet text to inject ('' = the built-in default); the Custom picker asks whether two colors would be accepted.
  'appearance.get': (d) => { const s = schemeState(d); return { value: s.value, css: s.css }; },
  'appearance.check': (d, a) => { const p = z.object({ primary: z.string().max(40), accent: z.string().max(40) }).parse(a); return checkScheme(p.primary, p.accent); },
  'settings.set': (d, a): SettingsView => { const p = z.object({ key: z.string(), value: z.string() }).parse(a); return setSettingValue(d, p.key, p.value); },
  'changes.undo': (d, a): SettingsView => undoRecordedChange(d, z.object({ id: z.number().int().positive() }).parse(a).id),
  'settings.reset': (d, a): SettingsView => resetSettingValue(d, z.object({ key: z.string() }).parse(a).key),
  'notifications.test': (d): Promise<RecentNotice> => notifyHandlers.test(d),
  'banners.list': (d): BannerDto[] => notifyHandlers.banners(d),
  'banners.dismiss': (d, a) => notifyHandlers.dismiss(d, z.object({ id: z.number().int() }).parse(a).id),
  'notifications.check': (d) => notifyHandlers.check(d),
  'notifications.recent': (d): RecentNotice[] => notifyHandlers.recent(d),
  'terms.list': (d): TermRow[] => termRows(d),
  'terms.create': (d, a) => termHandlers.create(d, a),
  'terms.switch': (d, a) => termHandlers.use(d, a),
  'terms.archive': (d, a) => termHandlers.archive(d, a),
  'terms.unarchive': (d, a) => termHandlers.unarchive(d, a),
  'terms.archived': (d, a): ArchivedTerm => termHandlers.archived(d, a),
  'backups.list': (d): BackupsView => backupsView(d),
  'backups.now': (d): Promise<BackupsView> => backupNow(d),
  'backups.restore': (d, a) => { const p = z.object({ name: z.string(), typed: z.string() }).parse(a); return restoreFrom(d, p.name, p.typed); },
  'google.status': (d) => googleHandlers(d, 'status'),
  'google.check': (d) => googleHandlers(d, 'check'),
  'google.connect': (d) => googleHandlers(d, 'connect'),
  'google.disconnect': (d) => googleHandlers(d, 'disconnect'),
  // The client file (the app ships without one): the open dialog runs in the main process; the renderer never sees the file or its secret.
  'google.chooseClient': (d, a) => googleClientHandlers.choose(d, z.object({ confirmReplace: z.boolean().default(false) }).parse(a ?? {}).confirmReplace),
  'google.removeClient': (d, a) => { z.object({ confirm: z.literal(true, { error: 'Removing the client file needs an explicit confirmation.' }) }).parse(a ?? {}); return googleClientHandlers.remove(d); },

  'availability.week': (d, a) => buildWeek(d.ctx, z.object({ date }).parse(a).date),

  'availability.paint': (d, a): PaintResult => {
    const { target: t, range: r } = z.object({ target, range }).parse(a);
    const before = targetRows(d.ctx, t as Target);
    const res = setWindow(d.ctx, t as Target, r, 'free');
    return { before, materialized: res.materialized };
  },

  'availability.erase': (d, a): PaintResult => {
    const { target: t, range: r } = z.object({ target, range }).parse(a);
    const before = targetRows(d.ctx, t as Target);
    const res = eraseWindow(d.ctx, t as Target, r);
    return { before, materialized: res.materialized };
  },

  'availability.block': (d, a): PaintResult => {
    const { target: t, range: r } = z.object({ target, range }).parse(a);
    const before = targetRows(d.ctx, t as Target);
    const res = setWindow(d.ctx, t as Target, r, 'blocked');
    return { before, materialized: res.materialized };
  },

  'availability.restore': (d, a) => {
    const { target: t, rows } = z.object({ target, rows: z.array(row) }).parse(a);
    restoreRows(d.ctx, t as Target, rows);
    return { ok: true };
  },

  'availability.clearDate': (d, a) => {
    const { date: dt } = z.object({ date }).parse(a);
    const before = targetRows(d.ctx, { date: dt });
    clearDate(d.ctx, dt);
    return { before, materialized: false } satisfies PaintResult;
  },

  'availability.copyWeek': (d, a) => {
    const { from, to } = z.object({ from: date, to: date }).parse(a);
    return copyWeek(d.ctx, from, to);
  },

  'calendar.busy': async (d, a): Promise<BusyResult> => {
    const { date: dt } = z.object({ date }).parse(a);
    try {
      const c = d.calendar();
      return { busy: await weekBusy(d.ctx, c.calendar, dt, c.classCalendarIds) };
    } catch (e) {
      const r = reconnectInfo(d, e);
      return { busy: {}, error: r?.message ?? message(e), ...(r ? { errorCode: r.code } : {}) };
    }
  },

  // Pinning: drag a block to another time (or resize it). Refusals come back as data (with suggested times), not as errors.
  'pins.create': (d, a): Promise<PinResult> => {
    const p = pinArgs.extend({ taskId: z.number().int().positive() }).parse(a);
    return placePin(d, { taskId: p.taskId, start: Date.parse(p.start), end: Date.parse(p.end) });
  },
  'pins.move': (d, a): Promise<PinResult> => {
    const p = pinArgs.extend({ pinId: z.number().int().positive() }).parse(a);
    const pin = getPin(d.ctx, p.pinId);
    if (!pin) throw new Error(`No pinned block #${p.pinId}.`);
    return placePin(d, { taskId: pin.task_id, start: Date.parse(p.start), end: Date.parse(p.end), pinId: pin.id });
  },
  'pins.unpin': (d, a) => {
    const p = z.object({ pinId: z.number().int().positive() }).parse(a);
    const r = removePin(d.ctx, p.pinId);
    return { ok: true, taskId: r.task_id };
  },
  'pins.list': (d) => pinsForPlan(d.ctx, d.ctx.clock.now().getTime()).active.map((p) => ({ id: p.id, taskId: p.taskId, title: p.task.title, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() })),

  'schedule.dryRun': async (d, a): Promise<DryRunResult> => {
    const { days } = z.object({ days: z.number().int().min(1).max(60).default(14) }).parse(a ?? {});
    const c = d.calendar();
    return planDto(d, await computePlan(d.ctx, c.calendar, { days, classCalendarIds: c.classCalendarIds }));
  },

  // Schedule screen. Preview never writes anything; apply refuses unless the caller confirms AND the plan is still the one that was previewed.
  'schedule.preview': async (d, a): Promise<SchedulePreview> => {
    const { days, replan } = scheduleArgs.parse(a ?? {});
    const c = d.calendar();
    const r = await computePlan(d.ctx, c.calendar, { days, classCalendarIds: c.classCalendarIds });
    const { moved, missedCount } = previewMoves(d.ctx, r, replan);
    const trims = previewTrims(d.ctx, r);
    return {
      ...planDto(d, r), replan, days, simulated: c.simulated ?? d.demo, demo: d.demo, ...(c.unavailable ? { calendarOff: true } : {}),
      calendarName: PLANNER_CALENDAR_NAME, fingerprint: planFingerprint(r, replan),
      willRemove: previewRemoveCount(d.ctx, r, replan), willWrite: r.blocks.length, missedCount,
      trims: { heading: trimHeading(true), lines: trimLines(r, trims), count: trims.length },
      moved: { heading: 'WOULD MOVE:', lines: movedLines(r, moved), count: moved.length },
      logged: { heading: 'WORK ALREADY LOGGED (planning uses the remaining estimate, never the full one):', lines: creditedLines(r), count: creditedLines(r).length },
      nowIso: new Date(r.nowMs).toISOString(),
    };
  },
  // The Claude connector's pending apply (docs/MCP.md): shown on the Schedule screen; only these two channels can approve or reject.
  'pending.get': (d): PendingState => pendingState(d),
  'pending.approve': (d, a) => approvePending(d, z.object({ id: z.string().uuid(), confirm: z.literal(true, { error: 'Approving needs an explicit confirmation.' }) }).parse(a).id),
  'pending.reject': (d, a) => rejectPending(d, z.object({ id: z.string().uuid() }).parse(a).id),
  'schedule.apply': async (d, a): Promise<ScheduleApplied> => {
    const p = scheduleArgs.extend({ confirm: z.literal(true, { error: 'Applying needs an explicit confirmation.' }), fingerprint: z.string().min(1) }).parse(a);
    const c = d.calendar();
    if (c.unavailable) throw new Error(NOT_SET_UP_MESSAGE);
    if ((c.simulated ?? d.demo) && !d.demo) throw new Error('Refusing to apply: this is a simulated calendar.');
    const r = await computePlan(d.ctx, c.calendar, { days: p.days, classCalendarIds: c.classCalendarIds });
    if (planFingerprint(r, p.replan) !== p.fingerprint) throw new Error('The plan changed since you previewed it (time passed, or something was edited). Nothing was written. Review the new preview and apply again.');
    const res = await applyPlan(d.ctx, c.calendar, r, { replan: p.replan });
    return {
      deleted: res.deleted, created: res.created, missedRemoved: res.missedRemoved,
      trimmed: { heading: trimHeading(false), lines: trimLines(r, res.trimmed), count: res.trimmed.length },
      moved: { heading: 'MOVED:', lines: movedLines(r, res.moved), count: res.moved.length },
      message: `Applied: removed ${res.deleted} earlier block(s)${res.missedRemoved ? ` and ${res.missedRemoved} missed block(s)` : ''}, wrote ${res.created} to "${PLANNER_CALENDAR_NAME}".`,
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// The Claude connector's hand-off (src/core/connectorJobs.ts). The connector never talks to Google: it files a request, and
// THIS process (which holds the Google access) answers it. A write to the calendar happens only in approvePending, which the
// window calls when the user clicks Approve, through the same schedule.apply handler a normal Apply uses.
// ---------------------------------------------------------------------------------------------------------------------
const lineGroup = (g: { heading: string; lines: string[]; count: number }) => ({ heading: g.heading, lines: g.lines, count: g.count });

/** The preview as Claude sees it: the same sections as the Schedule screen, in plain JSON, plus an id and a timestamp. */
function claudePreview(d: ApiDeps, id: string, p: SchedulePreview, hash: string) {
  const fmt = (iso: string, end: string) => `${DateTime.fromISO(iso, { zone: 'utc' }).setZone(d.ctx.tz).toFormat('ccc LLL d, h:mm a')} to ${DateTime.fromISO(end, { zone: 'utc' }).setZone(d.ctx.tz).toFormat('h:mm a')}`;
  const blk = (b: SchedulePreview['blocks'][number]) => ({ taskId: b.taskId, title: b.title, start: b.start, end: b.end, local: fmt(b.start, b.end), pinned: !!b.pinned });
  return {
    previewId: id, previewedAt: d.ctx.clock.now().toISOString(), timezone: d.ctx.tz, mode: p.replan ? 'replan' : 'schedule', days: p.days, horizonEnd: p.horizonEnd,
    calendar: { name: p.calendarName, simulated: p.simulated },
    summary: { blocksToWrite: p.willWrite, blocksToRemove: p.willRemove, missedBlocks: p.missedCount, tentativeBlocks: p.blocks.filter((b) => b.tentative).length },
    blocks: p.blocks.filter((b) => !b.tentative).map(blk),
    tentative: p.blocks.filter((b) => b.tentative).map(blk),
    moved: lineGroup(p.moved), trimmed: lineGroup(p.trims), workAlreadyLogged: lineGroup(p.logged),
    doesNotFit: p.problems.map((x) => ({ taskId: x.taskId, title: x.title, reason: x.reason, tentative: x.tentative, shortMinutes: x.shortMinutes })),
    notScheduled: p.skipped.map((x) => ({ taskId: x.taskId, title: x.title, reason: x.reason })),
    pinnedBlockWarnings: (p.pinWarnings ?? []).map((w) => ({ taskId: w.taskId, title: w.title, start: w.start, end: w.end, reason: w.reason, message: w.message })),
    // internal, used by apply_schedule: what this preview was computed from
    _apply: { fingerprint: p.fingerprint, inputsHash: hash, willRemove: p.willRemove, willWrite: p.willWrite, missedCount: p.missedCount, trims: lineGroup(p.trims), moved: lineGroup(p.moved), demo: p.demo },
  };
}

/** Called by the main process every second or two: answer the connector's preview requests, expire old applies, cancel ones the user switched off. */
export async function processConnectorJobs(d: ApiDeps): Promise<void> {
  expireJobs(d.ctx);
  if (!claudeScheduleAllowed(d.ctx.db)) {
    const open = openApply(d.ctx);
    if (open?.status === 'pending') setJob(d.ctx, open.id, { status: 'cancelled', error: 'Allow Claude to apply schedules to Google was turned off.' });
  }
  for (const job of requestedJobs(d.ctx)) {
    try {
      if (job.kind === 'freetime') { setJob(d.ctx, job.id, { status: 'ready', result: await freeTimeAnswer(d, job.request) }); continue; }
      if (job.kind === 'conflicts') { setJob(d.ctx, job.id, { status: 'ready', result: await conflictsAnswer(d, job.request) }); continue; }
      const hash = inputsHash(d.ctx);
      const p = (await handlers['schedule.preview'](d, { days: job.request.days, replan: !!job.request.replan })) as SchedulePreview;
      setJob(d.ctx, job.id, { status: 'ready', result: claudePreview(d, job.id, p, hash) });
    } catch (e) {
      setJob(d.ctx, job.id, { status: 'failed', error: reconnectInfo(d, e)?.message ?? message(e) });
    }
  }
}

const hmOf = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat('HH:mm');
/** Tally's own blocks (written, plus pins not written yet) between two times. */
function tallyBlocks(d: ApiDeps, fromMs: number, toMs: number) {
  const rows = d.ctx.db.all<{ task_id: number; start: string; end: string; title: string; pin_id: number | null }>(
    `SELECT b.task_id, b.start, b."end", t.title, b.pin_id FROM scheduled_blocks b JOIN tasks t ON t.id = b.task_id WHERE b."end" > ? AND b.start < ? AND t.deleted_at IS NULL`,
    [new Date(fromMs).toISOString(), new Date(toMs).toISOString()]);
  const out = rows.map((r) => ({ taskId: r.task_id, title: r.title, start: Date.parse(r.start), end: Date.parse(r.end), pinned: r.pin_id != null }));
  for (const p of pinsForPlan(d.ctx, d.ctx.clock.now().getTime()).active) {
    if (p.end > fromMs && p.start < toMs && !out.some((o) => o.pinned && o.start === p.start && o.end === p.end && o.taskId === p.taskId)) out.push({ taskId: p.taskId, title: p.task.title, start: p.start, end: p.end, pinned: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * For the connector's get_free_time with Google: per day, your availability windows minus Google busy time (free/busy only, the
 * calendars the scheduler uses) minus Tally's planned blocks. Only free intervals go back: no titles, attendees or calendar names.
 */
async function freeTimeAnswer(d: ApiDeps, req: { startDate: string; days: number }) {
  const tz = d.ctx.tz;
  const first = DateTime.fromISO(req.startDate, { zone: tz }).startOf('day');
  const last = first.plus({ days: req.days });
  const c = d.calendar();
  const busy = await googleBusy(d.ctx, c.calendar, first.toMillis(), last.toMillis(), c.classCalendarIds);
  const blocks = tallyBlocks(d, first.toMillis(), last.toMillis());
  const rows = loadWindows(d.ctx);
  const days = [];
  for (let day = first; day < last; day = day.plus({ days: 1 })) {
    const date = day.toISODate()!;
    const free = cut(resolveWindowDay(rows, date, tz).free, merge([...busy, ...blocks]))
      .map((f) => ({ start: Math.max(f.start, day.toMillis()), end: Math.min(f.end, day.plus({ days: 1 }).toMillis()) })).filter((f) => f.end > f.start);
    days.push({ date, weekday: day.toFormat('ccc'), free: free.map((f) => ({ start: hmOf(f.start, tz), end: f.end >= day.plus({ days: 1 }).toMillis() ? '24:00' : hmOf(f.end, tz) })), freeMinutes: Math.round(free.reduce((s, f) => s + f.end - f.start, 0) / 60_000) });
  }
  return { days, simulated: !!c.simulated };
}

/** For get_schedule with Google: planned blocks that overlap busy time on your calendars, without saying what the busy time is. */
async function conflictsAnswer(d: ApiDeps, req: { days: number }) {
  const from = DateTime.fromJSDate(d.ctx.clock.now(), { zone: d.ctx.tz }).startOf('day');
  const to = from.plus({ days: req.days });
  const c = d.calendar();
  const busy = await googleBusy(d.ctx, c.calendar, from.toMillis(), to.toMillis(), c.classCalendarIds);
  const conflicts = tallyBlocks(d, from.toMillis(), to.toMillis()).flatMap((b) => {
    const overlap = busy.reduce((s, x) => s + Math.max(0, Math.min(x.end, b.end) - Math.max(x.start, b.start)), 0);
    return overlap > 0 ? [{ taskId: b.taskId, title: b.title, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), pinned: b.pinned, overlapMinutes: Math.round(overlap / 60_000) }] : [];
  });
  return { conflicts, simulated: !!c.simulated };
}

const pendingView = (j: Job): PendingApplyView => ({
  id: j.id, status: j.status as 'pending' | 'approving', createdAt: j.created_at, expiresAt: j.expires_at!, days: j.request.days, replan: !!j.request.replan,
  willRemove: j.result.summary.willRemove, willWrite: j.result.summary.willWrite, missedCount: j.result.summary.missedCount,
  calendarName: PLANNER_CALENDAR_NAME, simulated: !!j.result.summary.simulated, demo: !!j.result.summary.demo,
  trims: j.result.summary.trims, moved: j.result.summary.moved, previewedAt: j.request.previewedAt,
});

const FINISHED_NOTE: Record<string, string> = {
  applied: 'Approved and written.', rejected: 'You rejected it.', expired: 'It expired (10 minutes) before it was approved.', stale: 'It was out of date, so nothing was written.',
  cancelled: 'It was cancelled.', failed: 'It failed, so nothing was written.',
};

function pendingState(d: ApiDeps): PendingState {
  const open = openApply(d.ctx);
  const last = latestApply(d.ctx);
  const recent = last && !['pending', 'approving'].includes(last.status) && d.ctx.clock.now().getTime() - Date.parse(last.updated_at) < 3_600_000 ? last : null;
  return {
    pending: open ? pendingView(open) : null,
    last: recent ? { id: recent.id, status: recent.status, at: recent.updated_at, message: recent.error ?? recent.result?.message ?? FINISHED_NOTE[recent.status] ?? recent.status } : null,
  };
}

async function approvePending(d: ApiDeps, id: string): Promise<{ message: string }> {
  expireJobs(d.ctx);
  const job = getJob(d.ctx, id);
  if (!job || job.kind !== 'apply') throw new Error('That request no longer exists.');
  if (job.status === 'expired') throw new Error('That request expired (10 minutes). Ask Claude to preview and apply again.');
  if (job.status !== 'pending') throw new Error(`That request is ${job.status}; there is nothing to approve.`);
  const r = job.request as { days: number; replan: boolean; fingerprint: string; inputsHash: string };
  if (inputsHash(d.ctx) !== r.inputsHash) {
    setJob(d.ctx, id, { status: 'stale', error: 'Your tasks or availability changed since the preview, so nothing was written. Ask Claude to preview again.' });
    throw new Error('Your tasks or availability changed since the preview, so nothing was written. Ask Claude to preview again.');
  }
  setJob(d.ctx, id, { status: 'approving' });
  try {
    // exactly what the Apply button does
    const res = (await handlers['schedule.apply'](d, { days: r.days, replan: r.replan, confirm: true, fingerprint: r.fingerprint })) as ScheduleApplied;
    setJob(d.ctx, id, { status: 'applied', result: { ...(job.result ?? {}), message: res.message, created: res.created, deleted: res.deleted } });
    return { message: res.message };
  } catch (e) {
    const m = message(e);
    setJob(d.ctx, id, { status: /changed since you previewed/.test(m) ? 'stale' : 'failed', error: m });
    throw e;
  }
}

function rejectPending(d: ApiDeps, id: string): { ok: true } {
  const job = getJob(d.ctx, id);
  if (!job || job.kind !== 'apply' || job.status !== 'pending') throw new Error('There is nothing pending to reject.');
  setJob(d.ctx, id, { status: 'rejected', error: 'The user rejected it in Tally.' });
  return { ok: true };
}

/**
 * TEST ONLY (demo database + a self-test run; the main process refuses it otherwise): put a pending apply on the Schedule
 * screen without a connector, so the UI test can click Approve and Reject. It goes through the same job functions.
 */
export async function seedPendingApplyForTest(d: ApiDeps): Promise<{ id: string }> {
  if (!d.demo) throw new Error('Test-only, demo database only.');
  const { requestPreview, createPendingApply } = await import('../core/connectorJobs');
  const prev = requestPreview(d.ctx, { days: 14, replan: false });
  await processConnectorJobs(d);
  const pv = getJob(d.ctx, prev)!;
  if (pv.status !== 'ready') throw new Error(`preview ${pv.status}: ${pv.error}`);
  const m = pv.result._apply;
  setJob(d.ctx, prev, { status: 'used' });
  return { id: createPendingApply(d.ctx, { previewId: prev, days: 14, replan: false, fingerprint: m.fingerprint, inputsHash: m.inputsHash, previewedAt: pv.result.previewedAt }, { willRemove: m.willRemove, willWrite: m.willWrite, missedCount: m.missedCount, trims: m.trims, moved: m.moved, simulated: pv.result.calendar.simulated, demo: m.demo }) };
}

/** Channel names the renderer may invoke (the preload exposes exactly these). */
export const CHANNELS = Object.keys(handlers);

/**
 * An expired or revoked Google sign-in, in the app's words and with a code the window can act on (a Reconnect button).
 * Uses what the app recorded about the problem (why, how old the sign-in was); falls back to what the error itself says.
 */
export function reconnectInfo(d: ApiDeps, e: unknown): { message: string; code: 'google_reconnect' | 'google_client' } | undefined {
  if (!(e instanceof ReconnectRequiredError)) return undefined;
  if (e.code === 'not_connected') return { message: problemMessage({ kind: 'none', code: 'not_connected', tokenAgeDays: null, testingLikely: false }), code: 'google_reconnect' };
  const rec = currentProblem(d.ctx.db);
  const p = rec && rec.code === e.code ? rec : { kind: classifyCode(e.code) ?? e.kind, code: e.code, tokenAgeDays: null, testingLikely: false };
  return { message: problemMessage(p), code: e.kind === 'client' ? 'google_client' : 'google_reconnect' };
}

export async function dispatch(deps: ApiDeps, channel: string, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string; code?: string }> {
  const h = handlers[channel];
  if (!h) return { ok: false, error: `Unknown request "${channel}".` };
  try {
    return { ok: true, value: await h(deps, args) };
  } catch (e) {
    const rc = reconnectInfo(deps, e);
    if (rc) return { ok: false, error: rc.message, code: rc.code };
    if (e instanceof z.ZodError) return { ok: false, error: `Invalid request: ${e.issues.map((i) => `${i.path.join('.') || '(value)'}: ${i.message}`).join('; ')}` };
    return { ok: false, error: message(e) };
  }
}

export { parseRange };


function inboxView(d: ApiDeps): InboxView {
  const ctx = d.ctx;
  const st = inboxStatus(ctx);
  return {
    enabled: inboxEnabled(ctx), list: inboxList(ctx), defaultList: DEFAULT_INBOX_LIST, state: st?.state ?? null, message: st?.message ?? null, lastCheck: lastCheck(ctx),
    imported: importedCount(ctx), notify: loadNotifySettings(ctx).phoneInbox, canOpenPane: !!d.hooks?.openPrivacyPane,
    recent: recentImports(ctx, 8).map((i) => ({ ...i, dueText: i.due ? DateTime.fromISO(i.due, { zone: 'utc' }).setZone(ctx.tz).toFormat('ccc LLL d, h:mm a') : null })),
  };
}

/** One background pass (the app's timer calls this; it does nothing while the switch is off or permission is waiting for a Retry). */
export async function inboxTick(d: ApiDeps): Promise<void> {
  if (d.hooks?.reminders) await runInbox(d.ctx, d.hooks.reminders);
}
