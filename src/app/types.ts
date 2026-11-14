import type { WindowRow } from '../schedule/availabilityWindows';
import type { LabeledSpan } from './week';
import type { TaskDto } from './taskDto';

export type { WeekView, WeekDay, Span, LabeledSpan } from './week';
export type { WindowRow };

export interface TermInfo {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
  archived: boolean;
}

export interface AppInfo {
  dbFile: string;
  demo: boolean;
  tz: string;
  today: string;
  terms: TermInfo[];
  currentTermId: number | null;
  backupFolder: string;
  lastBackup: { name: string; takenAt: string; ageHours: number } | null;
}

export type Target = { date: string } | { weekday: number };
export interface PaintResult {
  /** the rows this target had BEFORE the edit, for undo */
  before: WindowRow[];
  materialized: boolean;
}

export interface BusyResult {
  busy: Record<string, LabeledSpan[]>;
  error?: string;
  /** 'google_reconnect' when the error is an expired or revoked sign-in (offer Reconnect) */
  errorCode?: string;
}

export interface ProposedBlock {
  taskId: number;
  title: string;
  start: string;
  end: string;
  tentative: boolean;
  /** pinned by hand: fixed, never moved by the planner */
  pinned?: boolean;
  pinId?: number;
  /** the block clipped to each local day it touches, in wall-clock minutes (what the grid draws) */
  spans: { date: string; start: number; end: number }[];
}
export interface DryRunResult {
  blocks: ProposedBlock[];
  problems: { taskId: number; title: string; reason: string; tentative: boolean; shortMinutes: number }[];
  skipped: { taskId: number; title: string; reason: string }[];
  horizonEnd: string;
  /** pinned blocks the plan left out (task done or deleted, due date moved before the pin) or that now overlap busy time */
  pinWarnings?: { pinId: number; taskId: number; title: string; start: string; end: string; reason: 'done' | 'deleted' | 'after_due' | 'busy'; message: string }[];
}
/** The answer to a drop or a pin request: pinned, or why not and where it could go instead. */
export type PinResult =
  | { ok: true; pin: { id: number; taskId: number; start: string; end: string } }
  | { ok: false; reason: string; message: string; suggestions: { start: string; end: string; label: string }[] };

export type { TaskDto };
export interface ViewItemDto {
  task: TaskDto;
  reason: string;
  minutes: number | null;
  score: number | null;
}
export interface TimerStatus {
  sessionId: number;
  taskId: number;
  title: string;
  startedAt: string;
}
export interface ViewsResult {
  dueSoon: ViewItemDto[];
  highImpact: ViewItemDto[];
  quickWins: ViewItemDto[];
  blocked: ViewItemDto[];
  dueSoonHours: number;
  quickWinMinutes: number;
  timers: TimerStatus[];
}
export interface ListInfo {
  id: number;
  name: string;
  termId: number | null;
  open: number;
  done: number;
}
export interface TaskDetail {
  task: TaskDto;
  blockers: { id: number; title: string; open: boolean }[];
  blocks: { id: number; title: string }[];
  parent: { id: number; title: string } | null;
  steps: { id: number; title: string; done: boolean }[];
  sessions: { startedAt: string; endedAt: string | null }[];
  lists: string[];
}

/** What quick-add understood from the text, shown live under the box. */
export interface QuickPreview {
  title: string;
  due: string | null;
  dueText: string | null;
  timeAssumed: boolean;
  phrase: string | null;
  /** the due field is filled in, so the title is not parsed */
  explicitDue: boolean;
}

export interface MessageGroup {
  heading: string;
  /** the same lines the CLI prints */
  lines: string[];
  count: number;
}
/** What the Schedule screen shows before anything is written. */
export interface SchedulePreview extends DryRunResult {
  replan: boolean;
  days: number;
  /** the calendar is the simulated one (demo database) */
  simulated: boolean;
  demo: boolean;
  calendarName: string;
  /** identifies this exact plan; apply refuses if the plan has changed since */
  fingerprint: string;
  willRemove: number;
  willWrite: number;
  missedCount: number;
  trims: MessageGroup;
  moved: MessageGroup;
  logged: MessageGroup;
  nowIso: string;
}
/** A schedule apply Claude asked for, waiting for the user's approval in the Schedule screen. */
export interface PendingApplyView {
  id: string;
  status: 'pending' | 'approving';
  createdAt: string;
  expiresAt: string;
  days: number;
  replan: boolean;
  willRemove: number;
  willWrite: number;
  missedCount: number;
  calendarName: string;
  simulated: boolean;
  demo: boolean;
  trims: MessageGroup;
  moved: MessageGroup;
  previewedAt: string;
}
export interface PendingState {
  pending: PendingApplyView | null;
  /** how the most recent apply Claude asked for ended (shown for a while, so a click is never lost) */
  last: { id: string; status: string; at: string; message: string } | null;
}
export interface ScheduleApplied {
  deleted: number;
  created: number;
  missedRemoved: number;
  trimmed: MessageGroup;
  moved: MessageGroup;
  message: string;
}

export interface ImportEntry {
  num: number;
  kind: 'new' | 'changed';
  included: boolean;
  course: string;
  title: string;
  parentTitle: string | null;
  type: string;
  dueText: string | null;
  weight: number | null;
  estimate: number | null;
  size: string | null;
  optional: boolean;
  deadlineOnly: boolean;
  availableFrom: string | null;
  after: string[];
  lowConfidence: boolean;
  recurring: boolean;
  quote: string | null;
  notes: string | null;
  changes: { field: string; from: string; to: string; conflict: boolean }[];
}
export interface ImportReview {
  id: string;
  fileName: string;
  term: string;
  termIsNew: boolean;
  note: string | null;
  tz: string;
  defaultTime: string;
  entries: ImportEntry[];
  unchanged: string[];
  missing: { title: string; dueText: string | null }[];
  willAdd: number;
  willUpdate: number;
}
export interface ImportApplied {
  inserted: number;
  updated: number;
  termCreated: boolean;
  keptLocalEdits: { taskId: number; fields: string[] }[];
  backup: string | null;
  backupError: string | null;
  message: string;
}

export interface SettingItem {
  key: string;
  label: string;
  help: string;
  kind: 'int' | 'number' | 'choice' | 'bool';
  options?: string[];
  unit?: string;
  /** the value in effect */
  value: string;
  default: string;
  /** a value is saved for this key (otherwise the default applies) */
  custom: boolean;
}
export interface SettingsView {
  demo: boolean;
  dbFile: string;
  general: { timezone: string; defaultDueTime: string; quickAddShortcut: string; quickAddShortcutDefault: string; quickAddShortcutActive: boolean | null; trayText: 'full' | 'elapsed' | 'none'; theme: 'system' | 'light' | 'dark' };
  scheduling: SettingItem[];
  advanced: SettingItem[];
  notifications: SettingItem[];
  /** the Claude connector: the write switch (off by default) and the recent changes made through it */
  claude: { writes: SettingItem; deletes: SettingItem; schedule: SettingItem; changes: { id: number; at: string; actor: string; tool: string; summary: string; undone: boolean; tasks: number }[]; calls: { id: number; at: string; tool: string; ok: boolean; detail: string }[] };
  priority: SettingItem[];
  formula: string;
  calendars: { classIds: string[]; busyIds: string[] | null };
  backupFolder: string;
  backupFolderIsDefault: boolean;
}
export interface TermRow {
  id: number;
  name: string;
  start: string;
  end: string;
  current: boolean;
  archived: boolean;
  archivedAt: string | null;
  open: number;
  done: number;
}
export interface ArchivedTerm {
  term: TermRow;
  tasks: TaskDto[];
}
export interface BackupsView {
  folder: string;
  folderExists: boolean;
  isDefault: boolean;
  backups: { name: string; takenAt: string; bytes: number; ageHours: number }[];
}
export interface GoogleStatus {
  demo: boolean;
  clientFile: string | null;
  clientFileFound: boolean;
  connected: boolean;
  message: string;
  /** Google rejected the saved sign-in and signing in again fixes it (the Reconnect button) */
  needsReconnect?: boolean;
  /** why the last sign-in stopped working, in plain words */
  problem?: { at: string; kind: 'reconnect' | 'client'; code: string; tokenAgeDays: number | null; testingLikely: boolean; message: string } | null;
  /** when the saved sign-in was made (only known for sign-ins made since Tally started keeping track) */
  tokenAge?: { connectedAt: string; days: number } | null;
  /** whether the Google Cloud project is in Testing or Production, as you said or as detected */
  publish?: { status: 'testing' | 'production' | 'unknown'; source: 'you' | 'detected' | null };
  /** the 7-day Testing-mode countdown; only present when the project is known to be in Testing */
  testingNote?: { expiresAt: string; daysLeft: number; close: boolean } | null;
}

/** One notification attempt and what the system reported about it. */
export interface RecentNotice {
  id: number;
  at: string;
  kind: 'block' | 'due' | 'backup' | 'test' | 'claude' | 'google' | 'phone';
  title: string;
  body: string;
  taskId?: number;
  target?: 'schedule' | 'settings-google' | 'today';
  action?: 'reconnect';
  supported: boolean;
  showCalled: boolean;
  events: { event: string; ms: number; detail?: string }[];
  error: string | null;
  /** the outcome in plain words, when there is something to explain */
  reason: string | null;
  outcome: 'pending' | 'shown' | 'failed' | 'unsupported' | 'no-event' | 'error' | 'app-only';
  /** an in-app banner was queued because the system did not (or was not asked to) deliver it */
  banner: boolean;
}
/** `target` is a screen to open when the banner's Open button is used; `action` is a one-click fix (Reconnect). */
export interface BannerDto { id: number; at: string; kind: string; title: string; body: string; taskId?: number; target?: 'schedule' | 'settings-google' | 'today'; action?: 'reconnect' }

/** Whether the menu-bar icon exists and where macOS put it. */
export interface TrayInfo {
  created: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  title?: string;
  imageEmpty?: boolean;
  size?: { width: number; height: number };
  scaleFactors?: number[];
  template?: boolean;
  visiblePixels?: number;
  /** macOS gave the item a position (an all-zero rectangle means it did not) */
  placed?: boolean;
  /** the main display's width, to judge where the item sits */
  screenWidth?: number;
  /** the item sits in the middle or left part of the menu bar (under the notch or among the app menus): there was no room for it on the right, so macOS shows it nowhere */
  likelyHidden?: boolean;
}

// ---- phone capture (Apple Reminders) ----
export interface InboxItemDto { reminderId: string; taskId: number; title: string; taskTitle: string | null; due: string | null; dueText: string | null; importedAt: string; undone: boolean; taskDone: boolean; stillOpenOnPhone: boolean; canUndo: boolean; noDate: boolean }
export interface InboxView {
  enabled: boolean;
  list: string;
  defaultList: string;
  /** ok | denied | missing_list | error, or null before the first check */
  state: 'ok' | 'denied' | 'missing_list' | 'error' | null;
  message: string | null;
  lastCheck: string | null;
  imported: number;
  recent: InboxItemDto[];
  /** the notification switch */
  notify: boolean;
  /** this build can open the macOS pane */
  canOpenPane: boolean;
}
export interface InboxCheckResult extends InboxView { pass: { ran: boolean; skipped?: 'off' | 'blocked'; imported: number; completeFailed: number; retriedComplete: number; waiting: number } }
export type { ReviewState, ReviewData, StepResult, StepA, StepB, StepC, ReviewBlock, ReviewDueItem, ReviewSlipped, ReviewNeedsInfo, ReviewProblem } from '../core/review';

// ---- the Rates screen ----
export interface RateTaskDto { id: number; title: string; status: string; done: boolean; sizeAmount: number | null; sizeUnit: string | null; estimate: number | null; estimateSource: string | null; noSize: boolean; actualMinutes: number }
export interface RateGroupDto {
  key: string;
  course: string | null;
  name: string;
  autoName: string;
  renamed: boolean;
  orphan: boolean;
  /** the unit of this group's tasks (the most common one), or the unit of its saved rate */
  unit: string | null;
  tasks: RateTaskDto[];
  openCount: number;
  doneCount: number;
  /** the saved rate of this group (null = none: the built-in rate applies) */
  rule: { unit: string; minutes: number; match: string; number: number } | null;
  /** per unit (size x rate), a flat time per assignment, or no rate */
  mode: 'unit' | 'flat' | 'none';
  /** the group's flat per-assignment rule, or its no-rate rule's match text (minutes is 0) */
  flat: { minutes: number; match: string; number: number } | null;
  /** measured minutes per finished timed task (null under 3) */
  average: { minutesPerTask: number | null; n: number; enough: boolean };
  /** what the form starts from when there is no saved rate */
  suggestedMatch: string;
  rateInUse: { minutes: number; source: 'Your rate' | 'Built-in default' | 'Learned'; ruleNumber: number; ruleText: string } | null;
  actual: { minutesPerUnit: number | null; n: number; enough: boolean };
  openEstimatedMinutes: number;
  openWithoutEstimate: number;
  multiplier: { value: number | null; samples: number; enough: boolean; disabled: boolean; resetAt: string | null };
}
export interface RateRuleDto { number: number; mine: boolean; unit: string; course: string | null; match: string | null; minutes: number; text: string }
export interface RatesView {
  groups: RateGroupDto[];
  units: string[];
  /** the built-in rates, editable, in the order they are tried (after your own rates) */
  defaults: { index: number; unit: string; course: string | null; match: string | null; minutes: number; builtIn: number | null; edited: boolean }[];
  defaultsEdited: boolean;
  pointsMin: number;
  pointsMinDefault: number;
  /** every rule in the order it is tried: yours first, then the built-in ones; the first match wins */
  order: RateRuleDto[];
  courses: string[];
  /** tasks that would move to a different automatic group on Regroup */
  regroupPending: number;
}
export interface RegroupReportDto { changedTasks: { id: number; title: string; from: string; to: string }[]; groupsBefore: number; groupsAfter: number; overridesCarried: number; unresolved: string[]; unchanged: boolean }
export interface RatePreviewTask { id: number; title: string; status: string; group: string }
export interface RateApplyPreview { rows: { taskId: number; title: string; before: number | null; beforeSource: string | null; after: number; formula: string; wasManual: boolean }[]; keptManual: number; fingerprint: string; needsConfirm: boolean }
