import { INBOX_ENABLED_KEY, INBOX_LIST_KEY, checkListName } from '../phone/inbox';
import type { RemindersSource } from '../phone/reminders';
import { existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import type { ApiDeps } from './api';
import { getSetting, setSetting } from '../db/repo';
import { assertTimezone } from '../time';
import { NOTIFY_KEYS, NOTIFY_DEFAULTS, checkNotifySetting, loadNotifySettings, type Notice } from './notifier';
import { TRAY_TEXT_MODES, type TrayTextMode } from './trayModel';
import { validateAccelerator, DEFAULT_QUICK_ADD_SHORTCUT } from './accelerator';
import { NUMERIC_KEYS, DEFAULT_PLACEMENT, checkScheduleSetting, loadScheduleSettings } from '../schedule/params';
import { DEFAULT_WORKING_HOURS } from '../schedule/workingHours';
import { loadWorkingHours, getClassCalendars, getBusyCalendars } from '../schedule/settings';
import { VIEW_KEYS, DEFAULT_VIEW_SETTINGS, checkViewSetting, loadViewSettings } from '../core/views';
import { currentTerm, listTerms, createTerm, useTerm, archiveTerm, unarchiveTerm, getTermByName } from '../core/terms';
import { listTasks } from '../core/tasks';
import { listBackups, createBackup, verifyBackup } from '../core/backup';
import { backupFolderFor } from '../cli/context';
import { CLAUDE_WRITES_KEY, CLAUDE_DELETES_KEY, CLAUDE_SCHEDULE_KEY, claudeWritesAllowed, claudeDeletesAllowed, claudeScheduleAllowed } from '../core/claudeAccess';
import { listCalls } from '../core/connectorJobs';
import { setPublishStatus } from '../schedule/googleHealth';
import { listChanges, undoChange } from '../core/changeLog';
import { makeDtoBuilder } from './taskDto';
import type { BannerDto, RecentNotice, SettingsView, SettingItem, TermRow, BackupsView, ArchivedTerm, GoogleStatus } from './types';

/** Things only the Electron main process can do (swap the live database, sign in to Google, move the backup folder). Tests pass fakes. */
export interface AppHooks {
  /** the Reminders source for the phone inbox (the real one reads the Reminders app; tests pass a fake) */
  reminders?: RemindersSource;
  /** open the macOS settings pane where Tally's permission to control Reminders is switched on */
  openPrivacyPane?(): void;
  setBackupFolder?(folder: string): void;
  /** (Re)register the global quick-add shortcut; '' turns it off. Throws a readable message if the system refuses it. */
  setShortcut?(accelerator: string): void;
  /** apply the Appearance setting (system | light | dark) to every window */
  setTheme?(theme: Theme): void;
  /** apply a changed menu-bar setting right away */
  trayRefresh?(): void;
  /** whether the saved shortcut is currently registered with the system (it can fail at startup if another app took it) */
  shortcutActive?(): boolean;
  /** show a test desktop notification (ignores the switches and quiet hours) */
  notifyTest?(): Promise<RecentNotice>;
  /** run the notification check once, now, exactly as the timer does; returns what was announced */
  notifyCheck?(): Notice[];
  /** what was announced in this session (newest first) */
  notifyRecent?(): RecentNotice[];
  /** in-app banners waiting to be seen (the fallback when the system does not deliver a notification) */
  banners?(): BannerDto[];
  dismissBanner?(id: number): void;
  restore?(backupPath: string): Promise<{ safetyBackup?: string }>;
  google?: {
    status(): Promise<GoogleStatus>;
    check(): Promise<GoogleStatus>;
    connect(): Promise<GoogleStatus>;
    disconnect(): Promise<GoogleStatus>;
  };
}

interface Meta { key: string; label: string; help: string; kind: SettingItem['kind']; options?: string[]; unit?: string }

const SCHEDULING: Meta[] = [
  { key: 'placement_style', label: 'Placement', kind: 'choice', options: ['early', 'late'], help: 'early: start work as soon as a task becomes eligible. late: as close to the deadline as possible.' },
  { key: 'min_block_minutes', label: 'Shortest block', unit: 'min', kind: 'int', help: 'No work block is shorter than this (short tasks are padded up to it). At least 5.' },
  { key: 'max_block_minutes', label: 'Longest block', unit: 'min', kind: 'int', help: 'Longer tasks are split into blocks no longer than this. At least 5.' },
  { key: 'buffer_minutes', label: 'Gap between blocks', unit: 'min', kind: 'int', help: 'Minimum break between two planner blocks.' },
  { key: 'min_lead_minutes', label: 'Nothing sooner than', unit: 'min from now', kind: 'int', help: 'The scheduler never places a block starting sooner than this.' },
  { key: 'early_lead_days', label: 'Start this many days before due', unit: 'days', kind: 'int', help: 'Early placement: a task becomes eligible this long before its due date (big tasks start earlier).' },
  { key: 'finish_before_deadline_minutes', label: 'Finish this long before due', unit: 'min', kind: 'int', help: 'Early placement: work ends at least this long before the deadline.' },
  { key: 'max_daily_work_minutes', label: 'Soft daily work cap', unit: 'min', kind: 'int', help: 'Early placement: more than this per day is only used when work would not fit otherwise (flagged in the plan).' },
  { key: 'deadline_slack_minutes', label: 'Deadline slack (late placement)', unit: 'min', kind: 'int', help: 'Late placement: finish this long before the deadline.' },
  { key: 'exam_duration_minutes', label: 'Exam length', unit: 'min', kind: 'int', help: 'An exam with a real time blocks this long, so no work is placed during it. 0 turns this off.' },
  { key: 'exam_prep_end_before_minutes', label: 'Exam prep ends before the exam', unit: 'min', kind: 'int', help: 'Last exam-prep block ends this long before the exam starts.' },
  { key: 'exam_prep_daily_max_minutes', label: 'Exam prep per day (max)', unit: 'min', kind: 'int', help: 'At most this much prep for one exam per day.' },
  { key: 'include_optional_tasks', label: 'Schedule optional tasks', kind: 'bool', help: 'Tasks marked optional are skipped unless this is on.' },
];
const ADVANCED_LABELS: Record<string, string> = {
  long_task_minutes: 'Long task threshold', long_task_min_block_minutes: 'Shortest block for a long task', spread_threshold_minutes: 'Spread tasks at least this big over days',
  spread_daily_max_minutes: 'Spread: max per day', spread_days_before_deadline: 'Spread: finish this many days before due', ignore_busy_at_least_hours: 'Ignore calendar events at least this long (hours)',
};
const PRIORITY: Meta[] = [
  { key: 'impact_urgency_days', label: 'Urgency half-life', unit: 'days', kind: 'number', help: 'A task due this many days away counts half as urgent as one due now.' },
  { key: 'impact_effort_hours', label: 'Effort half-life', unit: 'hours', kind: 'number', help: 'A task needing this many hours of work counts half as attractive as a tiny one.' },
  { key: 'impact_default_minutes', label: 'Assumed effort when no estimate', unit: 'min', kind: 'number', help: 'Used for graded tasks that have no estimate.' },
  { key: 'impact_limit', label: 'Show this many', unit: 'tasks', kind: 'int', help: 'How many tasks the High Grade Impact panel lists.' },
  { key: 'views_due_soon_hours', label: 'Due soon window', unit: 'hours', kind: 'number', help: 'Tasks due within this long (and overdue ones) appear under Due soon.' },
  { key: 'views_quick_win_minutes', label: 'Quick win length', unit: 'min', kind: 'number', help: 'Tasks needing at most this long are quick wins.' },
];
const VIEW_DEFAULT: Record<string, number> = {
  views_due_soon_hours: DEFAULT_VIEW_SETTINGS.dueSoonHours, views_quick_win_minutes: DEFAULT_VIEW_SETTINGS.quickWinMinutes, impact_urgency_days: DEFAULT_VIEW_SETTINGS.impactUrgencyDays,
  impact_effort_hours: DEFAULT_VIEW_SETTINGS.impactEffortHours, impact_default_minutes: DEFAULT_VIEW_SETTINGS.impactDefaultMinutes, impact_limit: DEFAULT_VIEW_SETTINGS.impactLimit,
};
export const FORMULA = 'score = grade weight % × 1 / (1 + days left ÷ urgency half-life) × 1 / (1 + hours of work ÷ effort half-life). Overdue tasks are excluded; they stay under Due soon.';

const str = (v: unknown) => String(v);

export type Theme = 'system' | 'light' | 'dark';
export const THEMES: Theme[] = ['system', 'light', 'dark'];
/** Appearance: follow the system (default) or force light or dark. */
export const themeSetting = (d: ApiDeps): Theme => { const v = getSetting(d.ctx.db, 'theme'); return (THEMES as string[]).includes(v ?? '') ? (v as Theme) : 'system'; };

/** What the menu bar shows beside the icon: full (task + time), elapsed (time only), none (icon only). */
export const trayText = (d: ApiDeps): TrayTextMode => { const v = getSetting(d.ctx.db, 'tray_text'); return (TRAY_TEXT_MODES as string[]).includes(v ?? '') ? (v as TrayTextMode) : 'full'; };

/** The saved global quick-add shortcut ('' = turned off), else the default. */
export const quickAddShortcut = (d: ApiDeps): string => getSetting(d.ctx.db, 'quick_add_shortcut') ?? DEFAULT_QUICK_ADD_SHORTCUT;

const NOTIFY_META: { key: string; label: string; help: string; kind: SettingItem['kind'] }[] = [
  { key: 'notify_blocks', label: 'A planner block is about to start', kind: 'bool', help: 'One notification when a scheduled block is 10 minutes away.' },
  { key: 'notify_due_soon', label: 'A task is due soon', kind: 'bool', help: 'Once per task when it enters the Due soon window (see the Priority tab). Never for done tasks. A pile of tasks becomes one summary.' },
  { key: 'notify_backup_failure', label: 'A backup fails', kind: 'bool', help: 'Once per day while the daily backup keeps failing.' },
  { key: 'notify_claude_apply', label: 'Claude proposes a schedule', kind: 'bool', help: 'When Claude asks to apply a schedule (it waits for your approval on the Schedule tab): one notification right away, and one more when 2 minutes are left. Held back during quiet hours; never repeated for the same request.' },
  { key: 'notify_phone_inbox', label: 'Items arrive from your phone', kind: 'bool', help: 'One notification when reminders from your “Tally Inbox” list in Apple Reminders are turned into tasks (several at once become one notice). Held back during quiet hours; never repeated.' },
  { key: 'notify_quiet_enabled', label: 'Quiet hours', kind: 'bool', help: 'No notifications during these hours. Due-soon and backup notices wait and arrive afterwards; a block that starts while it is quiet is skipped.' },
  { key: 'notify_quiet_start', label: 'Quiet hours start', kind: 'int', help: 'Local time, HH:mm (for example 23:00).' },
  { key: 'notify_quiet_end', label: 'Quiet hours end', kind: 'int', help: 'Local time, HH:mm (for example 08:00). A window can cross midnight.' },
  { key: 'notify_delivery', label: 'How to show them', kind: 'choice', help: 'auto: a desktop notification, plus an in-app banner if macOS does not deliver it. both: always both. app: in-app banners only (the reliable choice while the app is not packaged).' },
];
function notificationItems(d: ApiDeps): SettingItem[] {
  const cur = loadNotifySettings(d.ctx);
  const val: Record<string, string> = { notify_blocks: String(cur.blocks), notify_due_soon: String(cur.dueSoon), notify_backup_failure: String(cur.backupFailure), notify_claude_apply: String(cur.claudeApply), notify_phone_inbox: String(cur.phoneInbox), notify_quiet_enabled: String(cur.quietEnabled), notify_quiet_start: cur.quietStart, notify_quiet_end: cur.quietEnd, notify_delivery: cur.delivery };
  const def: Record<string, string> = { notify_blocks: String(NOTIFY_DEFAULTS.blocks), notify_due_soon: String(NOTIFY_DEFAULTS.dueSoon), notify_backup_failure: String(NOTIFY_DEFAULTS.backupFailure), notify_claude_apply: String(NOTIFY_DEFAULTS.claudeApply), notify_phone_inbox: String(NOTIFY_DEFAULTS.phoneInbox), notify_quiet_enabled: String(NOTIFY_DEFAULTS.quietEnabled), notify_quiet_start: NOTIFY_DEFAULTS.quietStart, notify_quiet_end: NOTIFY_DEFAULTS.quietEnd, notify_delivery: NOTIFY_DEFAULTS.delivery };
  return NOTIFY_META.map((m) => ({ key: m.key, label: m.label, help: m.help, kind: m.kind, options: m.key === 'notify_delivery' ? ['auto', 'both', 'app'] : undefined, value: val[m.key], default: def[m.key], custom: getSetting(d.ctx.db, m.key) !== undefined }));
}

const claudeSwitch = (db: ApiDeps['ctx']['db'], key: string, label: string, help: string, on: boolean): SettingItem => ({ key, label, kind: 'bool', help, value: String(on), default: 'false', custom: getSetting(db, key) !== undefined });

export function settingsView(d: ApiDeps): SettingsView {
  const ctx = d.ctx;
  const legacy = loadWorkingHours(ctx, currentTerm(ctx)?.id).hours;
  const eff = loadScheduleSettings(ctx, legacy);
  const value = (key: string): unknown => (key in eff.placement ? (eff.placement as unknown as Record<string, unknown>)[key] : (eff.hours as unknown as Record<string, unknown>)[key]);
  // what applies when no plain setting is saved: the built-in placement default, or the saved routine's value (else the built-in default)
  const builtin = (key: string): unknown => (key in DEFAULT_PLACEMENT ? (DEFAULT_PLACEMENT as unknown as Record<string, unknown>)[key] : ((legacy as unknown as Record<string, unknown>)[key] ?? (DEFAULT_WORKING_HOURS as unknown as Record<string, unknown>)[key]));
  const item = (m: Meta, v: unknown, def: unknown): SettingItem => ({ key: m.key, label: m.label, help: m.help, kind: m.kind, options: m.options, unit: m.unit, value: str(v), default: str(def), custom: getSetting(ctx.db, m.key) !== undefined });
  const known = new Set(SCHEDULING.map((m) => m.key));
  const advanced = NUMERIC_KEYS.filter((k) => !known.has(k) && ADVANCED_LABELS[k]).map((k) => item({ key: k, label: ADVANCED_LABELS[k], kind: 'int', help: `Setting “${k}”.` }, value(k), builtin(k)));
  const vs = loadViewSettings(ctx);
  const viewValue: Record<string, number> = {
    views_due_soon_hours: vs.dueSoonHours, views_quick_win_minutes: vs.quickWinMinutes, impact_urgency_days: vs.impactUrgencyDays,
    impact_effort_hours: vs.impactEffortHours, impact_default_minutes: vs.impactDefaultMinutes, impact_limit: vs.impactLimit,
  };
  const folder = backupFolderFor(getSetting(ctx.db, 'backup_folder'), d.dbFile, d.demo);
  return {
    demo: d.demo, dbFile: d.dbFile,
    general: { timezone: ctx.tz, defaultDueTime: ctx.defaultTime, quickAddShortcut: quickAddShortcut(d), quickAddShortcutDefault: DEFAULT_QUICK_ADD_SHORTCUT, quickAddShortcutActive: d.hooks?.shortcutActive?.() ?? null, trayText: trayText(d), theme: themeSetting(d) },
    scheduling: SCHEDULING.map((m) => item(m, value(m.key), builtin(m.key))),
    advanced,
    notifications: notificationItems(d),
    claude: {
      writes: claudeSwitch(ctx.db, CLAUDE_WRITES_KEY, 'Allow Claude to change my tasks', 'Lets Claude add, edit, finish, reopen and reorganize tasks and lists, add steps and dependencies, log work, run the timer and confirm an import you previewed. It can never change settings, your term, or your availability. Every change is listed below and can be undone.', claudeWritesAllowed(ctx.db)),
      deletes: claudeSwitch(ctx.db, CLAUDE_DELETES_KEY, 'Allow Claude to delete tasks', 'Lets Claude delete ONE task at a time (the same soft delete as the app: it goes in the change list below with an Undo button). Needs the switch above as well. It can never delete lists or terms or delete in bulk.', claudeDeletesAllowed(ctx.db)),
      schedule: claudeSwitch(ctx.db, CLAUDE_SCHEDULE_KEY, 'Allow Claude to apply schedules to Google', 'Lets Claude ask to write a schedule to your “Planner Blocks” Google calendar. Claude only asks: nothing is written until you click Approve on the Schedule screen here in Tally. Claude never touches Google itself and has no access to your Google sign-in. Previews are always allowed.', claudeScheduleAllowed(ctx.db)),
      changes: listChanges(ctx, { limit: 15 }),
      calls: listCalls(ctx, 50),
    },
    priority: PRIORITY.map((m) => item(m, viewValue[m.key], VIEW_DEFAULT[m.key])),
    formula: FORMULA,
    calendars: { classIds: getClassCalendars(ctx) ?? [], busyIds: getBusyCalendars(ctx) ?? null },
    backupFolder: folder, backupFolderIsDefault: !getSetting(ctx.db, 'backup_folder'),
  };
}

/** Validate and save one setting, exactly as `config set` does. */
export function setSettingValue(d: ApiDeps, key: string, value: string): SettingsView {
  const ctx = d.ctx;
  const v = value.trim();
  if (key === 'timezone') {
    assertTimezone(v);
    setSetting(ctx.db, key, v);
    ctx.tz = v;
  } else if (key === 'default_due_time') {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error('Default due time must be HH:mm, for example 23:59.');
    const hhmm = v.length === 4 ? `0${v}` : v;
    setSetting(ctx.db, key, hhmm);
    ctx.defaultTime = hhmm;
  } else if (key === 'theme') {
    if (!(THEMES as string[]).includes(v)) throw new Error('Appearance must be system, light or dark.');
    setSetting(ctx.db, key, v);
    d.hooks?.setTheme?.(v as Theme);
  } else if (key === 'tray_text') {
    if (!(TRAY_TEXT_MODES as string[]).includes(v)) throw new Error('Menu bar text must be full, elapsed or none.');
    setSetting(ctx.db, key, v);
    d.hooks?.trayRefresh?.();
  } else if (key === 'quick_add_shortcut') {
    // '' turns the shortcut off. Otherwise it must be valid AND the system must accept it; only then is it saved.
    const accel = v === '' ? '' : validateAccelerator(v);
    d.hooks?.setShortcut?.(accel);
    setSetting(ctx.db, key, accel);
  } else if (NOTIFY_KEYS.includes(key)) {
    const checked = checkNotifySetting(key, v);
    if (key === 'notify_quiet_start' || key === 'notify_quiet_end') {
      const cur = loadNotifySettings(ctx);
      const a = key === 'notify_quiet_start' ? checked : cur.quietStart;
      const b = key === 'notify_quiet_end' ? checked : cur.quietEnd;
      if (a === b) throw new Error('Quiet hours cannot start and end at the same time. To turn them off, switch “Quiet hours” off.');
    }
    setSetting(ctx.db, key, checked);
  } else if (key === INBOX_ENABLED_KEY) {
    if (v !== 'true' && v !== 'false') throw new Error('The phone inbox switch must be on or off.');
    setSetting(ctx.db, key, v);
    if (v === 'true') ctx.db.run("DELETE FROM settings WHERE key = 'phone_inbox_status'"); // a fresh start: ask macOS again
  } else if (key === INBOX_LIST_KEY) {
    setSetting(ctx.db, key, checkListName(v));
    ctx.db.run("DELETE FROM settings WHERE key = 'phone_inbox_status'"); // a different list may exist or not: check again
  } else if (key === 'google_publish_status') {
    if (!['testing', 'production', 'unknown'].includes(v)) throw new Error('The Google project status must be testing, production or unknown.');
    setPublishStatus(ctx.db, v as 'testing' | 'production' | 'unknown', 'you');
  } else if (key === CLAUDE_WRITES_KEY || key === CLAUDE_DELETES_KEY || key === CLAUDE_SCHEDULE_KEY) {
    if (v !== 'true' && v !== 'false') throw new Error('That Claude connector switch must be on or off.');
    setSetting(ctx.db, key, v);
  } else if (key === 'backup_folder') {
    if (v) mkdirSync(v, { recursive: true });
    if (v) setSetting(ctx.db, key, v); else ctx.db.run("DELETE FROM settings WHERE key = 'backup_folder'");
    d.hooks?.setBackupFolder?.(backupFolderFor(v || undefined, d.dbFile, d.demo));
  } else if (VIEW_KEYS.includes(key)) {
    setSetting(ctx.db, key, checkViewSetting(key, v));
  } else if (SCHEDULING.some((m) => m.key === key) || NUMERIC_KEYS.includes(key as never)) {
    const checked = checkScheduleSetting(key, v);
    if (key === 'min_block_minutes' || key === 'max_block_minutes') {
      const min = Number(key === 'min_block_minutes' ? checked : getSettingNumber(d, 'min_block_minutes'));
      const max = Number(key === 'max_block_minutes' ? checked : getSettingNumber(d, 'max_block_minutes'));
      if (min > max) throw new Error('The shortest block cannot be longer than the longest block.');
    }
    setSetting(ctx.db, key, checked);
  } else throw new Error(`"${key}" is not a setting you can change here.`);
  return settingsView(d);
}
const getSettingNumber = (d: ApiDeps, key: string): number => Number(settingsView(d).scheduling.find((s) => s.key === key)!.value);

/** Remove a saved value so the default applies again. */
export function resetSettingValue(d: ApiDeps, key: string): SettingsView {
  const allowed = [...SCHEDULING.map((m) => m.key), ...NUMERIC_KEYS, ...VIEW_KEYS, 'backup_folder', 'quick_add_shortcut', 'tray_text', 'theme', CLAUDE_WRITES_KEY, CLAUDE_DELETES_KEY, CLAUDE_SCHEDULE_KEY, ...NOTIFY_KEYS, INBOX_ENABLED_KEY, INBOX_LIST_KEY];
  if (!allowed.includes(key)) throw new Error(`"${key}" cannot be reset here (timezone and default due time always have a value).`);
  d.ctx.db.run('DELETE FROM settings WHERE key = ?', [key]);
  if (key === 'backup_folder') d.hooks?.setBackupFolder?.(backupFolderFor(undefined, d.dbFile, d.demo));
  if (key === 'quick_add_shortcut') d.hooks?.setShortcut?.(DEFAULT_QUICK_ADD_SHORTCUT);
  if (key === 'tray_text') d.hooks?.trayRefresh?.();
  if (key === 'theme') d.hooks?.setTheme?.('system');
  return settingsView(d);
}

// ---- terms ----
export function termRows(d: ApiDeps): TermRow[] {
  const counts = new Map(d.ctx.db.all<{ t: number; open: number; done: number }>("SELECT term_id t, SUM(status <> 'done') open, SUM(status = 'done') done FROM tasks WHERE deleted_at IS NULL AND term_id IS NOT NULL GROUP BY term_id").map((r) => [r.t, r]));
  return listTerms(d.ctx).map((t) => ({
    id: t.id, name: t.name, start: t.start_date, end: t.end_date, current: !!t.is_current && !t.archived_at, archived: !!t.archived_at,
    archivedAt: t.archived_at ?? null, open: counts.get(t.id)?.open ?? 0, done: counts.get(t.id)?.done ?? 0,
  }));
}
export const termHandlers = {
  create: (d: ApiDeps, a: unknown): TermRow[] => {
    const p = z.object({ name: z.string().min(1), start: z.string(), end: z.string(), makeCurrent: z.boolean().optional() }).parse(a);
    createTerm(d.ctx, { name: p.name, start_date: p.start, end_date: p.end }, { makeCurrent: p.makeCurrent });
    return termRows(d);
  },
  use: (d: ApiDeps, a: unknown): TermRow[] => { useTerm(d.ctx, z.object({ name: z.string() }).parse(a).name); return termRows(d); },
  archive: (d: ApiDeps, a: unknown): TermRow[] => { archiveTerm(d.ctx, z.object({ name: z.string() }).parse(a).name); return termRows(d); },
  unarchive: (d: ApiDeps, a: unknown): TermRow[] => { unarchiveTerm(d.ctx, z.object({ name: z.string() }).parse(a).name); return termRows(d); },
  /** Read-only: the tasks of an archived term (open, done; deleted ones are not shown). */
  archived: (d: ApiDeps, a: unknown): ArchivedTerm => {
    const { id } = z.object({ id: z.number().int().positive() }).parse(a);
    const row = termRows(d).find((t) => t.id === id);
    if (!row) throw new Error(`No term #${id}.`);
    if (!row.archived) throw new Error(`Term "${row.name}" is not archived; open its tasks from Lists.`);
    const dto = makeDtoBuilder(d.ctx);
    const tasks = listTasks(d.ctx, { scope: { allTerms: true } }).filter((t) => t.term_id === id).map(dto);
    return { term: row, tasks };
  },
};

// ---- backups ----
export function backupsView(d: ApiDeps): BackupsView {
  const folder = backupFolderFor(getSetting(d.ctx.db, 'backup_folder'), d.dbFile, d.demo);
  const now = d.ctx.clock.now().getTime();
  const all = existsSync(folder) ? readAllBackupLike(folder) : [];
  return {
    folder, folderExists: existsSync(folder), isDefault: !getSetting(d.ctx.db, 'backup_folder'),
    backups: all.map((b) => ({ name: b.name, takenAt: b.takenAt.toISOString(), bytes: b.bytes, ageHours: Math.round(((now - b.takenAt.getTime()) / 3_600_000) * 10) / 10 })),
  };
}
const readAllBackupLike = (folder: string) => listBackups(folder);

export async function backupNow(d: ApiDeps): Promise<BackupsView> {
  const folder = backupFolderFor(getSetting(d.ctx.db, 'backup_folder'), d.dbFile, d.demo);
  await createBackup(d.ctx, folder);
  return backupsView(d);
}

export async function restoreFrom(d: ApiDeps, name: string, typed: string): Promise<{ safetyBackup: string | null; message: string }> {
  if (typed !== 'restore') throw new Error('Type the word "restore" to confirm. Nothing was changed.');
  const folder = backupFolderFor(getSetting(d.ctx.db, 'backup_folder'), d.dbFile, d.demo);
  if (basename(name) !== name) throw new Error('That is not a backup in your backup folder.');
  const b = listBackups(folder).find((x) => x.name === name);
  if (!b) throw new Error(`No backup named "${name}" in ${folder}.`);
  const check = verifyBackup(b.path);
  if (!check.ok) throw new Error(`Refusing to restore: that backup failed its integrity check (${check.detail}). Nothing was changed.`);
  if (!d.hooks?.restore) throw new Error('Restoring is only available in the app window.');
  const r = await d.hooks.restore(b.path);
  return { safetyBackup: r.safetyBackup ?? null, message: `Restored ${b.name}.${r.safetyBackup ? ` Your previous data was saved first as ${basename(r.safetyBackup)}.` : ''}` };
}

// ---- Google ----
export const googleHandlers = (d: ApiDeps, op: 'status' | 'check' | 'connect' | 'disconnect'): Promise<GoogleStatus> => {
  if (!d.hooks?.google) return Promise.resolve({ demo: d.demo, clientFile: null, clientFileFound: false, connected: false, message: d.demo ? 'Demo database: it uses a simulated calendar, so there is nothing to connect.' : 'Google is not available here.' });
  return d.hooks.google[op]();
};

// keep the unused import checker honest
void getTermByName;

export const notifyHandlers = {
  test: (d: ApiDeps): Promise<RecentNotice> => {
    if (!d.hooks?.notifyTest) throw new Error('Test notifications are only available in the app window.');
    return d.hooks.notifyTest();
  },
  check: (d: ApiDeps): Notice[] => {
    if (!d.hooks?.notifyCheck) throw new Error('Notifications are only available in the app window.');
    return d.hooks.notifyCheck();
  },
  recent: (d: ApiDeps): RecentNotice[] => d.hooks?.notifyRecent?.() ?? [],
  banners: (d: ApiDeps): BannerDto[] => d.hooks?.banners?.() ?? [],
  dismiss: (d: ApiDeps, id: number) => { d.hooks?.dismissBanner?.(id); return { ok: true as const }; },
};

/** Undo one recorded change (the Settings > Claude connector list). */
export function undoRecordedChange(d: ApiDeps, id: number): SettingsView {
  undoChange(d.ctx, id);
  return settingsView(d);
}
