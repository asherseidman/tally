import { DateTime } from 'luxon';
import type { Interval } from './types';
import { dayKeys, type DayOverride, type Overrides, type WorkingHours } from './workingHours';

/** Busy blocks longer than this (all-day events) are never treated as "a class". */
export const MAX_CLASS_SPAN_MS = 12 * 3_600_000;

const at = (day: DateTime, hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 }).toMillis();
};

export function mergeIntervals(xs: Interval[]): Interval[] {
  const sorted = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

export function subtractIntervals(windows: Interval[], blocks: Interval[]): Interval[] {
  const bs = mergeIntervals(blocks);
  const out: Interval[] = [];
  for (const w of windows) {
    let cur = w.start;
    for (const b of bs) {
      if (b.end <= cur) continue;
      if (b.start >= w.end) break;
      if (b.start > cur) out.push({ start: cur, end: b.start });
      cur = Math.max(cur, b.end);
    }
    if (cur < w.end) out.push({ start: cur, end: w.end });
  }
  return out;
}

export interface ClassRules {
  /** busy blocks starting at/after this local time are not classes (evening exams, etc.) */
  cutoff: string;
  /** busy blocks shorter than this many minutes are not classes */
  minMinutes: number;
  /** fixed unavailable windows (gym): a busy block inside one of these is not a class */
  fixed: { start: string; end: string }[];
}

export interface ClassifyResult {
  /** the first class of the day: earliest-starting qualifying block */
  first?: Interval;
  counted: Interval[];
  ignored: { block: Interval; reason: string }[];
}

/**
 * Sorts the class-calendar busy blocks that START on a local date (YYYY-MM-DD) into real classes and
 * blocks that are not classes (with the reason). Free/busy has no titles, so "class" = any busy block
 * on a class calendar that is not all-day, not too short, not a gym/fixed window, and starts before the cutoff.
 */
export function classifyDay(date: string, classBusy: Interval[], tz: string, rules: ClassRules): ClassifyResult {
  const day = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const dayStart = day.toMillis();
  const dayEnd = day.plus({ days: 1 }).startOf('day').toMillis();
  const cut = at(day, rules.cutoff);
  const fixed = rules.fixed.map((w) => ({ start: at(day, w.start), end: at(day, w.end) }));
  const counted: Interval[] = [];
  const ignored: ClassifyResult['ignored'] = [];
  for (const b of [...classBusy].sort((x, y) => x.start - y.start)) {
    if (b.start < dayStart || b.start >= dayEnd) continue;
    const minutes = (b.end - b.start) / 60_000;
    let reason: string | undefined;
    if (b.end - b.start > MAX_CLASS_SPAN_MS) reason = 'all-day (over 12 hours)';
    else if (minutes < rules.minMinutes) reason = `shorter than ${rules.minMinutes} min`;
    else if (fixed.some((f) => b.start >= f.start && b.end <= f.end)) reason = 'inside a fixed unavailable window (gym)';
    else if (b.start >= cut) reason = `starts at or after the ${rules.cutoff} cutoff`;
    if (reason) ignored.push({ block: b, reason });
    else counted.push(b);
  }
  const first = [...counted].sort((x, y) => x.start - y.start || y.end - x.end)[0];
  return { first, counted, ignored };
}

export const firstClass = (date: string, classBusy: Interval[], tz: string, rules: ClassRules): Interval | undefined => classifyDay(date, classBusy, tz, rules).first;

/** Class-detection rules for one local day, taken from that weekday's fixed windows and any per-date override. */
export function classRulesFor(date: string, tz: string, hours: WorkingHours, overrides: Overrides): ClassRules {
  const cfg = hours.days[dayKeys[DateTime.fromISO(date, { zone: tz }).weekday - 1]];
  const ov = overrides[date];
  return {
    cutoff: hours.class_cutoff,
    minMinutes: hours.min_class_minutes,
    fixed: [...cfg.unavailable, ...(ov?.unavailable_windows ?? [])].map((w) => ({ start: w.start, end: w.end })),
  };
}

export interface AvailabilityInput {
  fromMs: number;
  toMs: number;
  tz: string;
  hours: WorkingHours;
  overrides: Overrides;
  /** busy time from all considered calendars (class time included) */
  busy: Interval[];
  /** busy time from the calendars that hold classes */
  classBusy: Interval[];
}

/** What applies on one local day, for the plan's per-day header. */
export interface DayInfo {
  date: string;
  unavailableLabel?: string;
  /** first class of the day (only on days that use the after_first_class rule) */
  firstClass?: Interval;
  usesClassRule: boolean;
}

function dayWindow(day: DateTime, i: AvailabilityInput): Interval[] {
  const date = day.toISODate()!;
  const cfg = i.hours.days[dayKeys[day.weekday - 1]];
  const ov: DayOverride | undefined = i.overrides[date];
  if (ov?.unavailable) return [];
  const startSpec = ov?.start ?? cfg.start ?? i.hours.default_start;
  const endSpec = ov?.end ?? cfg.end;
  let start: number;
  if (startSpec === 'after_first_class') {
    const fc = firstClass(date, i.classBusy, i.tz, classRulesFor(date, i.tz, i.hours, i.overrides));
    start = fc ? fc.end : at(day, i.hours.default_start);
  } else start = at(day, startSpec);
  const end = at(day, endSpec);
  if (end <= start) return [];
  const fixed = [...cfg.unavailable, ...(ov?.unavailable_windows ?? [])].map((w) => ({ start: at(day, w.start), end: at(day, w.end) }));
  return subtractIntervals([{ start, end }], fixed);
}

/** Free working windows between fromMs and toMs, after fixed windows and busy time, sorted. */
export function buildAvailability(i: AvailabilityInput): Interval[] {
  const out: Interval[] = [];
  let day = DateTime.fromMillis(i.fromMs, { zone: i.tz }).startOf('day');
  while (day.toMillis() < i.toMs) {
    out.push(...dayWindow(day, i));
    day = day.plus({ days: 1 }).startOf('day');
  }
  const clipped = out.map((w) => ({ start: Math.max(w.start, i.fromMs), end: Math.min(w.end, i.toMs) })).filter((w) => w.end > w.start);
  const free = subtractIntervals(clipped, i.busy);
  return free.filter((w) => w.end - w.start >= i.hours.min_block_minutes * 60_000).sort((a, b) => a.start - b.start);
}

/** Per-day facts used when printing a plan (unavailable labels, class end). */
export function describeDay(date: string, i: Pick<AvailabilityInput, 'tz' | 'overrides' | 'classBusy' | 'hours'>): DayInfo {
  const ov = i.overrides[date];
  const key = dayKeys[DateTime.fromISO(date, { zone: i.tz }).weekday - 1];
  const usesClassRule = (ov?.start ?? i.hours.days[key].start) === 'after_first_class';
  return {
    date,
    unavailableLabel: ov?.unavailable ? (ov.label ?? 'unavailable') : undefined,
    usesClassRule,
    firstClass: usesClassRule ? firstClass(date, i.classBusy, i.tz, classRulesFor(date, i.tz, i.hours, i.overrides)) : undefined,
  };
}
