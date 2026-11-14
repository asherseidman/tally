import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import { currentTerm } from '../core/terms';
import type { CalendarClient } from './calendar';
import type { Interval } from './types';
import { buildAvailability } from './availability';
import { splitLongBusy } from './busy';
import { dayKeys, type WorkingHours } from './workingHours';
import { getClassCalendars, loadOverrides, loadWorkingHours } from './settings';
import { loadWindows, type WindowRow } from './availabilityWindows';

export interface SeedOptions {
  /** number of weeks of dated windows, starting today (default 4) */
  weeks?: number;
  /** overwrite the template and any dated windows already in that range */
  replace?: boolean;
  /** class calendar ids instead of the saved setting (previews) */
  classCalendarIds?: string[];
}

export interface SeedResult {
  from: string;
  to: string;
  datedDays: number;
  templateRows: WindowRow[];
  notes: string[];
}

type Raw = Omit<WindowRow, 'id' | 'date' | 'weekday'>;

const hmOf = (ms: number, tz: string, dayEndMs: number): string => (ms >= dayEndMs ? '24:00' : DateTime.fromMillis(ms, { zone: tz }).toFormat('HH:mm'));
const signature = (rows: Raw[]) => rows.map((r) => `${r.start}-${r.end}-${r.kind}`).join('|');

/**
 * Migration helper: generates the weekly template and dated windows for the next N weeks from the saved
 * working-hours JSON (its rules: after_first_class, end times, gym windows, per-date overrides) and the REAL class
 * calendar (to find each day's first class). After this the JSON is no longer consulted by the scheduler.
 */
export async function seedAvailability(ctx: Ctx, calendar: CalendarClient, opts: SeedOptions = {}): Promise<SeedResult> {
  const weeks = opts.weeks ?? 4;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26) throw new Error('--weeks must be a whole number from 1 to 26.');
  const tz = ctx.tz;
  const notes: string[] = [];
  const term = currentTerm(ctx);
  const { hours, usingDefault } = loadWorkingHours(ctx, term?.id);
  if (usingDefault) notes.push('No working_hours were saved, so the built-in default (9 AM-9 PM daily) was used as the starting point.');
  const overrides = loadOverrides(ctx);

  const start = DateTime.fromMillis(ctx.clock.now().getTime(), { zone: tz }).startOf('day');
  const end = start.plus({ days: weeks * 7 });
  const existing = loadWindows(ctx);
  const inRange = existing.filter((w) => w.date && w.date >= start.toISODate()! && w.date < end.toISODate()!);
  if (!opts.replace && (inRange.length || existing.some((w) => w.weekday))) {
    throw new Error('Your database already has availability windows in that range (or a weekly template). Seeding would overwrite edits you may have made; re-run with --replace to do that anyway.');
  }

  const usesClassRule = Object.values(hours.days).some((d) => d.start === 'after_first_class');
  const classIds = opts.classCalendarIds ?? getClassCalendars(ctx) ?? [];
  let classBusy: Interval[] = [];
  if (usesClassRule && !classIds.length) notes.push('There is no class calendar chosen, so weekdays that start "after the first class" use the default start time instead.');
  else if (usesClassRule) {
    const known = await calendar.listCalendars();
    for (const id of classIds) if (!known.some((c) => c.id === id)) throw new Error(`Class calendar "${id}" was not found.`);
    const fb = await calendar.freeBusy(classIds, start.toMillis(), end.plus({ days: 1 }).toMillis());
    classBusy = classIds.flatMap((id) => splitLongBusy(fb[id] ?? [], hours.ignore_busy_at_least_hours).kept);
  }

  const perDate = new Map<string, Raw[]>();
  const voters = new Map<number, string[]>();
  const byDate = new Map<string, Raw[]>();
  for (let d = start; d < end; d = d.plus({ days: 1 }).startOf('day')) {
    const date = d.toISODate()!;
    const next = d.plus({ days: 1 }).startOf('day').toMillis();
    const rows: Raw[] = [];
    const ov = overrides[date];
    if (ov?.unavailable) rows.push({ start: '00:00', end: '24:00', kind: 'blocked' });
    else {
      const free = buildAvailability({ fromMs: d.toMillis(), toMs: next, tz, hours, overrides, busy: [], classBusy });
      for (const w of free) {
        const s = hmOf(w.start, tz, next);
        const e = hmOf(w.end, tz, next);
        if (s !== e) rows.push({ start: s, end: e, kind: 'free' });
      }
      if (!rows.length) rows.push({ start: '00:00', end: '24:00', kind: 'blocked' });
      else {
        const lo = rows[0].start;
        const hi = rows[rows.length - 1].end;
        const cfg = hours.days[dayKeys[d.weekday - 1]];
        for (const f of [...cfg.unavailable, ...(ov?.unavailable_windows ?? [])]) if (f.end > lo && f.start < hi) rows.push({ start: f.start < lo ? lo : f.start, end: f.end > hi ? hi : f.end, kind: 'blocked' });
      }
    }
    byDate.set(date, rows);
    perDate.set(date, rows);
    if (!ov) voters.set(d.weekday, [...(voters.get(d.weekday) ?? []), signature(rows)]);
  }

  // Template: per weekday, the pattern seen on most (non-overridden) days; ties go to the earliest.
  const templateRows: WindowRow[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    const sigs = voters.get(wd) ?? [];
    const counts = new Map<string, number>();
    for (const s of sigs) counts.set(s, (counts.get(s) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || sigs.indexOf(a[0]) - sigs.indexOf(b[0]))[0]?.[0];
    if (best === undefined) continue;
    const date = [...byDate.keys()].find((k) => DateTime.fromISO(k, { zone: tz }).weekday === wd && signature(byDate.get(k)!) === best)!;
    for (const r of byDate.get(date)!) templateRows.push({ date: null, weekday: wd, ...r });
  }

  ctx.db.transaction(() => {
    ctx.db.run('DELETE FROM availability_windows WHERE weekday IS NOT NULL');
    ctx.db.run('DELETE FROM availability_windows WHERE date >= ? AND date < ?', [start.toISODate(), end.toISODate()]);
    const ins = (date: string | null, wd: number | null, r: Raw) =>
      ctx.db.run('INSERT INTO availability_windows(date, weekday, start, "end", kind) VALUES(?,?,?,?,?)', [date, wd, r.start, r.end, r.kind]);
    for (const [date, rows] of perDate) for (const r of rows) ins(date, null, r);
    for (const r of templateRows) ins(null, r.weekday, r);
  });
  return { from: start.toISODate()!, to: end.minus({ days: 1 }).toISODate()!, datedDays: perDate.size, templateRows, notes };
}

export type { WorkingHours };
