import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import type { Interval } from '../schedule/types';
import { loadWindows, resolveDay, type WindowRow } from '../schedule/availabilityWindows';
import { eventTitle } from '../schedule/eventTitle';

/** A span within one local day, in minutes since local midnight (0..1440). The grid works in wall-clock minutes. */
export interface Span {
  start: number;
  end: number;
}
export interface LabeledSpan extends Span {
  label: string;
}
/** A Tally block on the grid: which task it is for, and its pin if it was moved by hand (it can be dragged to pin or move it). */
export interface BlockSpan extends LabeledSpan {
  taskId: number;
  /** the written block (scheduled_blocks row); absent for a pin that is not written to the calendar yet */
  blockId?: number;
  pinId?: number;
  /** the whole block in UTC (it may cross midnight; spans are per day) */
  startIso: string;
  endIso: string;
}

export interface WeekDay {
  date: string;
  /** "Mon", "Tue", ... */
  weekday: string;
  /** 1 = Mon .. 7 = Sun */
  weekdayNumber: number;
  source: 'date' | 'template' | 'none';
  /** stored windows for this day (what the editor changes) */
  rows: WindowRow[];
  /** free time after blocked windows, merged */
  free: Span[];
  /** Planner Blocks scheduled this day, plus pinned blocks not written yet (pinId set, no blockId) */
  blocks: BlockSpan[];
}

export interface WeekView {
  /** Monday of the week, YYYY-MM-DD */
  start: string;
  days: WeekDay[];
  tz: string;
}

export const weekStartOf = (date: string, tz: string): string => {
  const d = DateTime.fromISO(date, { zone: tz });
  return d.minus({ days: d.weekday - 1 }).toISODate()!;
};

/** Clip a ms interval to one local day and express it in minutes since that day's local midnight. */
export function clipToDay(iv: Interval, date: string, tz: string): Span | undefined {
  const day = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const s = Math.max(iv.start, day.toMillis());
  const e = Math.min(iv.end, day.plus({ days: 1 }).startOf('day').toMillis());
  if (e <= s) return undefined;
  const nextMidnight = day.plus({ days: 1 }).startOf('day').toMillis();
  // wall-clock minutes (not elapsed minutes), so a 23/25-hour DST day still shows 09:00 as 540
  const mins = (ms: number) => (ms >= nextMidnight ? 1440 : DateTime.fromMillis(ms, { zone: tz }).hour * 60 + DateTime.fromMillis(ms, { zone: tz }).minute);
  return { start: mins(s), end: mins(e) };
}

/** The 7 days of the week containing `anyDate` with their windows and the Planner Blocks scheduled in them. */
export function buildWeek(ctx: Ctx, anyDate: string): WeekView {
  const start = weekStartOf(anyDate, ctx.tz);
  const rows = loadWindows(ctx);
  const first = DateTime.fromISO(start, { zone: ctx.tz }).startOf('day');
  const last = first.plus({ days: 7 });
  const range = [first.toUTC().toISO(), last.toUTC().toISO()];
  const written = ctx.db.all<{ id: number; task_id: number; pin_id: number | null; start: string; end: string; title: string; course: string | null; type: string }>(
    `SELECT b.id, b.task_id, p.id AS pin_id, b.start, b."end", t.title, t.course, t.type FROM scheduled_blocks b JOIN tasks t ON t.id = b.task_id
      LEFT JOIN pins p ON p.id = b.pin_id AND p.start = b.start AND p."end" = b."end"
      WHERE b."end" > ? AND b.start < ? ORDER BY b.start`, range,
  );
  // a pin that is not on the calendar yet (pinned after the last Apply, or moved since): drawn as a pinned block at its pinned time
  const shownPins = new Set(written.map((w) => w.pin_id).filter((x) => x != null));
  const pins = ctx.db.all<{ id: number; task_id: number; start: string; end: string; title: string; course: string | null; type: string }>(
    `SELECT p.id, p.task_id, p.start, p."end", t.title, t.course, t.type FROM pins p JOIN tasks t ON t.id = p.task_id
      WHERE p."end" > ? AND p.start < ? AND t.deleted_at IS NULL ORDER BY p.start`, range,
  ).filter((p) => !shownPins.has(p.id));
  // a written block whose pin was moved elsewhere is still on the calendar until the next Apply: shown as an ordinary block
  const blockRows = [
    ...written.map((w) => ({ start: w.start, end: w.end, title: w.title, course: w.course, type: w.type, taskId: w.task_id, blockId: w.id, pinId: w.pin_id ?? undefined })),
    ...pins.map((p) => ({ start: p.start, end: p.end, title: p.title, course: p.course, type: p.type, taskId: p.task_id, blockId: undefined, pinId: p.id })),
  ];
  const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const d = first.plus({ days: i });
    const date = d.toISODate()!;
    const r = resolveDay(rows, date, ctx.tz);
    const free = r.free.map((f) => clipToDay(f, date, ctx.tz)).filter((x): x is Span => !!x);
    const blocks = blockRows
      .map((b) => {
        const span = clipToDay({ start: Date.parse(b.start), end: Date.parse(b.end) }, date, ctx.tz);
        return span && { ...span, label: eventTitle({ course: b.course, title: b.title, isExam: b.type === 'exam' }), taskId: b.taskId, ...(b.blockId != null ? { blockId: b.blockId } : {}), ...(b.pinId != null ? { pinId: b.pinId } : {}), startIso: b.start, endIso: b.end };
      })
      .filter((x): x is BlockSpan => !!x);
    return { date, weekday: d.toFormat('ccc'), weekdayNumber: d.weekday, source: r.source, rows: r.rows, free, blocks };
  });
  return { start, days, tz: ctx.tz };
}
