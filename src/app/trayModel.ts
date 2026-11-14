import type { Ctx } from '../core/ctx';
import { getTask } from '../core/tasks';
import { computeViews } from '../core/views';
import { eventTitle } from '../schedule/eventTitle';
import { runningTimers, type RunningTimer } from './timerOps';

/** What the menu-bar icon shows and offers. Pure of Electron so it can be tested; `electron/main.ts` turns the model into a real Menu. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`);

/** Shown beside the icon while idle, so something is visible even if the image itself is not. */
export const IDLE_TITLE = '⏱';

/** Text next to the icon: the task and elapsed time while a timer runs; a timer glyph when idle. */
export type TrayTextMode = 'full' | 'elapsed' | 'none';
export const TRAY_TEXT_MODES: TrayTextMode[] = ['full', 'elapsed', 'none'];
/** full: task and elapsed time; elapsed: just the time (narrow, for a crowded menu bar); none: the icon alone. */
export function trayTitle(running: Pick<RunningTimer, 'title' | 'startedAtMs'> | null, nowMs: number, maxTitle = 22, mode: TrayTextMode = 'full'): string {
  if (mode === 'none') return '';
  if (!running) return IDLE_TITLE;
  const t = formatElapsed(nowMs - running.startedAtMs);
  return mode === 'elapsed' ? t : `${truncate(running.title, maxTitle)} ${t}`;
}

export interface TaskRef { id: number; title: string }
export interface TrayState {
  running: RunningTimer | null;
  /** the task "Start" would time: the one you worked on last if still open, else the most urgent due-soon task */
  startTarget: TaskRef | null;
  /** other open tasks worth timing (due soonest) */
  candidates: TaskRef[];
}

const label = (t: { course: string | null; title: string; type: string }) => eventTitle({ course: t.course, title: t.title, isExam: t.type === 'exam' });

export function trayState(ctx: Ctx, maxCandidates = 6): TrayState {
  const running = runningTimers(ctx)[0] ?? null;
  const dueSoon = computeViews(ctx).dueSoon.map((i) => i.task).filter((t) => t.status !== 'done');
  // the task most recently timed, if it is still open
  const last = ctx.db.get<{ task_id: number }>('SELECT task_id FROM time_sessions ORDER BY id DESC LIMIT 1');
  const lastTask = last ? getTask(ctx, last.task_id) : undefined;
  const lastOpen = lastTask && lastTask.status !== 'done' && !lastTask.deleted_at ? lastTask : undefined;
  const start = running ? undefined : lastOpen ?? dueSoon[0];
  const ref = (t: { id: number; course: string | null; title: string; type: string }): TaskRef => ({ id: t.id, title: label(t) });
  const candidates = dueSoon.filter((t) => t.id !== start?.id && t.id !== running?.taskId).slice(0, maxCandidates).map(ref);
  return { running, startTarget: start ? ref(start) : null, candidates };
}

export interface MenuItemModel {
  /** what happens when it is clicked: 'stop', 'start:<taskId>', 'quick', 'open', 'quit' */
  id?: string;
  label?: string;
  enabled?: boolean;
  type?: 'separator';
  submenu?: MenuItemModel[];
}

export function trayMenuModel(state: TrayState, nowMs: number, opts: { shortcut?: string } = {}): MenuItemModel[] {
  const out: MenuItemModel[] = [];
  const startItem = (t: TaskRef, prefix: string): MenuItemModel => ({ id: `start:${t.id}`, label: `${prefix}${truncate(t.title, 44)}` });
  if (state.running) {
    out.push({ label: `Timer: ${truncate(state.running.title, 36)} · ${formatElapsed(nowMs - state.running.startedAtMs)}`, enabled: false });
    out.push({ type: 'separator' });
    out.push({ id: 'stop', label: 'Stop timer' });
    if (state.startTarget || state.candidates.length) out.push({ label: 'Switch to another task', submenu: [...(state.startTarget ? [startItem(state.startTarget, '')] : []), ...state.candidates.map((t) => startItem(t, ''))] });
  } else {
    out.push({ label: 'No timer running', enabled: false });
    out.push({ type: 'separator' });
    if (state.startTarget) out.push(startItem(state.startTarget, 'Start timer: '));
    else out.push({ label: 'Start timer (no open task to time)', enabled: false });
    if (state.candidates.length) out.push({ label: 'Start a different task', submenu: state.candidates.map((t) => startItem(t, '')) });
  }
  out.push({ type: 'separator' });
  out.push({ id: 'quick', label: `Quick add…${opts.shortcut ? `   (${opts.shortcut.replace('CommandOrControl', 'Cmd/Ctrl')})` : ''}` });
  out.push({ id: 'open', label: 'Open Tally' });
  out.push({ type: 'separator' });
  out.push({ id: 'quit', label: 'Quit Tally' });
  return out;
}
