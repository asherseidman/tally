import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import type { Interval } from './types';
import { mergeIntervals, subtractIntervals } from './availability';

export type WindowKind = 'free' | 'blocked';

/** One stored window. Exactly one of `date` (YYYY-MM-DD) and `weekday` (1 = Mon .. 7 = Sun) is set. Times are local wall-clock HH:mm; an end of 24:00 means midnight. */
export interface WindowRow {
  id?: number;
  date: string | null;
  weekday: number | null;
  start: string;
  end: string;
  kind: WindowKind;
}

export const WEEKDAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const hmToMin = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};
export const minToHm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "09:00-12:30" -> {start, end}. Both ends 24-hour; the end may be 24:00. Throws with a readable message. */
export function parseRange(text: string): { start: string; end: string } {
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a time range like 09:00-12:30 (24-hour, local time).`);
  const norm = (s: string) => (s.length === 4 ? `0${s}` : s);
  const start = norm(m[1]);
  const end = norm(m[2]);
  if (!HM.test(start)) throw new Error(`"${m[1]}" is not a valid 24-hour time (HH:mm).`);
  if (!HM.test(end) && end !== '24:00') throw new Error(`"${m[2]}" is not a valid 24-hour time (HH:mm, or 24:00 for midnight).`);
  if (hmToMin(end) <= hmToMin(start)) throw new Error(`The end (${end}) must be after the start (${start}).`);
  return { start, end };
}

export function parseTarget(text: string): { date: string } | { weekday: number } {
  if (DATE.test(text) && DateTime.fromISO(text).isValid) return { date: text };
  const wd = WEEKDAY_NAMES.findIndex((n) => text.toLowerCase().startsWith(n));
  if (wd >= 0 && text.length >= 3) return { weekday: wd + 1 };
  throw new Error(`"${text}" is neither a date like 2026-11-14 nor a weekday like mon.`);
}

/** Local wall-clock time on a local day -> epoch ms. DST-safe: the day is built by calendar, so a 23- or 25-hour day just works. */
export function wallToMs(date: string, hm: string, tz: string): number {
  const day = DateTime.fromISO(date, { zone: tz }).startOf('day');
  if (hm === '24:00') return day.plus({ days: 1 }).startOf('day').toMillis();
  const [h, m] = hm.split(':').map(Number);
  return day.set({ hour: h, minute: m }).toMillis();
}

export interface ResolvedDay {
  date: string;
  /** 'date' = per-date windows replaced the template; 'template' = the weekday template; 'none' = nothing set */
  source: 'date' | 'template' | 'none';
  rows: WindowRow[];
  /** free windows minus blocked windows, merged, in epoch ms */
  free: Interval[];
}

/**
 * Precedence: if the date has ANY per-date window (free or blocked) those windows alone apply and the weekday
 * template is ignored. Otherwise the template for that weekday applies. Within the chosen set, free windows are
 * merged (overlaps/touching join) and blocked windows are subtracted, so blocked always wins an overlap.
 */
export function resolveDay(rows: WindowRow[], date: string, tz: string): ResolvedDay {
  const weekday = DateTime.fromISO(date, { zone: tz }).weekday;
  const dated = rows.filter((r) => r.date === date);
  const chosen = dated.length ? dated : rows.filter((r) => r.weekday === weekday);
  const source = dated.length ? 'date' : chosen.length ? 'template' : 'none';
  const toIv = (r: WindowRow): Interval => ({ start: wallToMs(date, r.start, tz), end: wallToMs(date, r.end, tz) });
  const free = mergeIntervals(chosen.filter((r) => r.kind === 'free').map(toIv));
  const blocked = chosen.filter((r) => r.kind === 'blocked').map(toIv);
  return { date, source, rows: chosen, free: subtractIntervals(free, blocked) };
}

/** Selected free time between fromMs and toMs, minus busy time, keeping only pieces of at least minBlockMin. */
export function buildFreeIntervals(rows: WindowRow[], fromMs: number, toMs: number, tz: string, busy: Interval[], minBlockMin: number): Interval[] {
  const out: Interval[] = [];
  let day = DateTime.fromMillis(fromMs, { zone: tz }).startOf('day');
  while (day.toMillis() < toMs) {
    out.push(...resolveDay(rows, day.toISODate()!, tz).free);
    day = day.plus({ days: 1 }).startOf('day');
  }
  const clipped = out.map((w) => ({ start: Math.max(w.start, fromMs), end: Math.min(w.end, toMs) })).filter((w) => w.end > w.start);
  return subtractIntervals(clipped, busy)
    .filter((w) => w.end - w.start >= minBlockMin * 60_000)
    .sort((a, b) => a.start - b.start);
}

/**
 * Add a window to a list of rows (all for the same date or weekday). The newest edit wins: the opposite kind is
 * carved out where they overlap, and same-kind windows that overlap or touch are merged.
 */
export function addWindow(rows: WindowRow[], add: WindowRow): WindowRow[] {
  const a = { s: hmToMin(add.start), e: hmToMin(add.end) };
  const out: WindowRow[] = [];
  let s = a.s;
  let e = a.e;
  for (const r of rows) {
    const rs = hmToMin(r.start);
    const re = hmToMin(r.end);
    if (r.kind === add.kind) {
      if (re >= a.s && rs <= a.e) {
        s = Math.min(s, rs);
        e = Math.max(e, re);
      } else out.push(r);
    } else if (re <= a.s || rs >= a.e) out.push(r);
    else {
      if (rs < a.s) out.push({ ...r, start: r.start, end: minToHm(a.s) });
      if (re > a.e) out.push({ ...r, start: minToHm(a.e), end: r.end });
    }
  }
  out.push({ ...add, start: minToHm(s), end: e === 1440 ? '24:00' : minToHm(e) });
  return out.sort((x, y) => hmToMin(x.start) - hmToMin(y.start));
}

/**
 * Remove `kind` coverage from the range (paint-erase): same-kind windows are cut where they overlap; nothing is added.
 */
export function carveWindow(rows: WindowRow[], range: { start: string; end: string }, kind: WindowKind): WindowRow[] {
  const s = hmToMin(range.start);
  const e = hmToMin(range.end);
  const out: WindowRow[] = [];
  for (const r of rows) {
    if (r.kind !== kind) { out.push(r); continue; }
    const rs = hmToMin(r.start);
    const re = hmToMin(r.end);
    if (re <= s || rs >= e) { out.push(r); continue; }
    if (rs < s) out.push({ ...r, end: minToHm(s) });
    if (re > e) out.push({ ...r, start: minToHm(e) });
  }
  return out.sort((x, y) => hmToMin(x.start) - hmToMin(y.start));
}

/* ---------------------------------------------------------------- database */

const COLS = 'id, date, weekday, start, "end" AS end, kind';

export const loadWindows = (ctx: Ctx): WindowRow[] =>
  ctx.db.all<WindowRow>(`SELECT ${COLS} FROM availability_windows ORDER BY date, weekday, start`);

const rowsFor = (ctx: Ctx, t: { date: string } | { weekday: number }): WindowRow[] =>
  'date' in t
    ? ctx.db.all<WindowRow>(`SELECT ${COLS} FROM availability_windows WHERE date = ? ORDER BY start`, [t.date])
    : ctx.db.all<WindowRow>(`SELECT ${COLS} FROM availability_windows WHERE weekday = ? ORDER BY start`, [t.weekday]);

function replaceRows(ctx: Ctx, t: Target, rows: WindowRow[]) {
  if ('date' in t) ctx.db.run('DELETE FROM availability_windows WHERE date = ?', [t.date]);
  else ctx.db.run('DELETE FROM availability_windows WHERE weekday = ?', [t.weekday]);
  for (const r of rows) {
    ctx.db.run('INSERT INTO availability_windows(date, weekday, start, "end", kind) VALUES(?,?,?,?,?)', [
      'date' in t ? t.date : null,
      'weekday' in t ? t.weekday : null,
      r.start,
      r.end,
      r.kind,
    ]);
  }
}

export interface SetResult {
  materialized: boolean;
}

/**
 * Set a window on a date or weekday. The first edit of a date copies that weekday's template windows onto the date
 * (because per-date windows replace the template), so blocking one hour does not delete the rest of the day.
 */
export function setWindow(ctx: Ctx, target: { date: string } | { weekday: number }, range: { start: string; end: string }, kind: WindowKind): SetResult {
  return ctx.db.transaction(() => {
    let rows = rowsFor(ctx, target);
    let materialized = false;
    if ('date' in target && !rows.length) {
      const wd = DateTime.fromISO(target.date, { zone: ctx.tz }).weekday;
      rows = rowsFor(ctx, { weekday: wd }).map((r) => ({ ...r, date: target.date, weekday: null }));
      materialized = rows.length > 0;
    }
    const base: WindowRow = { date: 'date' in target ? target.date : null, weekday: 'weekday' in target ? target.weekday : null, ...range, kind };
    replaceRows(ctx, target, addWindow(rows, base));
    return { materialized };
  });
}

export type Target = { date: string } | { weekday: number };

/** The stored rows of one date or weekday (what undo needs to snapshot). */
export const targetRows = (ctx: Ctx, t: Target): WindowRow[] => rowsFor(ctx, t);

/** Put back exactly these rows for a target (undo). */
export function restoreRows(ctx: Ctx, t: Target, rows: WindowRow[]): void {
  ctx.db.transaction(() => replaceRows(ctx, t, rows));
}

/**
 * Erase free time in a range (a paint-erase drag). Like setWindow, the first edit of a date copies the weekday
 * template onto it so the rest of the day is unchanged.
 */
export function eraseWindow(ctx: Ctx, target: Target, range: { start: string; end: string }): SetResult {
  return ctx.db.transaction(() => {
    let rows = rowsFor(ctx, target);
    let materialized = false;
    if ('date' in target && !rows.length) {
      const wd = DateTime.fromISO(target.date, { zone: ctx.tz }).weekday;
      rows = rowsFor(ctx, { weekday: wd }).map((r) => ({ ...r, date: target.date, weekday: null }));
      materialized = rows.length > 0;
    }
    replaceRows(ctx, target, carveWindow(rows, range, 'free'));
    return { materialized };
  });
}

/** Remove a date's own windows so the weekday template applies again. */
export function clearDate(ctx: Ctx, date: string): number {
  if (!DATE.test(date) || !DateTime.fromISO(date).isValid) throw new Error(`"${date}" is not a date like 2026-11-14.`);
  return ctx.db.run('DELETE FROM availability_windows WHERE date = ?', [date]).changes;
}

const weekStart = (date: string, tz: string) => DateTime.fromISO(date, { zone: tz }).startOf('day').minus({ days: DateTime.fromISO(date, { zone: tz }).weekday - 1 });

/** Copy the 7 days of the week containing `from` onto the week containing `to` (as per-date windows; replaces what was there). */
export function copyWeek(ctx: Ctx, from: string, to: string): { days: number } {
  for (const d of [from, to]) if (!DATE.test(d) || !DateTime.fromISO(d).isValid) throw new Error(`"${d}" is not a date like 2026-11-16.`);
  const src = weekStart(from, ctx.tz);
  const dst = weekStart(to, ctx.tz);
  if (src.toISODate() === dst.toISODate()) throw new Error('The source and target weeks are the same.');
  return ctx.db.transaction(() => {
    const all = loadWindows(ctx);
    let days = 0;
    for (let i = 0; i < 7; i++) {
      const sd = src.plus({ days: i }).toISODate()!;
      const dd = dst.plus({ days: i }).toISODate()!;
      const eff = resolveDay(all, sd, ctx.tz);
      replaceRows(ctx, { date: dd }, eff.rows);
      if (eff.rows.length) days++;
    }
    return { days };
  });
}

export function describeRows(rows: WindowRow[]): string {
  if (!rows.length) return '(nothing set)';
  return [...rows].sort((a, b) => hmToMin(a.start) - hmToMin(b.start)).map((r) => `${r.start}-${r.end} ${r.kind}`).join(' · ');
}

/** Lines for `availability show`: the weekly template, or the 7 days of a week (with where each day's windows come from). */
export function showTemplate(ctx: Ctx): string[] {
  const all = loadWindows(ctx);
  return WEEKDAY_NAMES.map((n, i) => `${n[0].toUpperCase()}${n.slice(1)}  ${describeRows(all.filter((r) => r.weekday === i + 1))}`);
}

export function showWeek(ctx: Ctx, anyDate: string): string[] {
  const all = loadWindows(ctx);
  const start = weekStart(anyDate, ctx.tz);
  return Array.from({ length: 7 }, (_, i) => {
    const d = start.plus({ days: i });
    const r = resolveDay(all, d.toISODate()!, ctx.tz);
    return `${d.toFormat('ccc LLL d')}  ${describeRows(r.rows)}   [${r.source === 'date' ? 'this date only' : r.source === 'template' ? 'weekly template' : 'nothing set'}]`;
  });
}
