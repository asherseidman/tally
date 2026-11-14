import type { Ctx } from '../core/ctx';
import { getSetting, setSetting } from '../db/repo';
import {
  DEFAULT_WORKING_HOURS, parseOverrides, parseWorkingHours, resolveWorkingHours,
  migrateLegacyHours, type Overrides, type WorkingHours,
} from './workingHours';

const K = {
  hours: 'working_hours',
  termHours: (termId: number) => `working_hours.term.${termId}`,
  overrides: 'schedule_overrides',
  classCals: 'class_calendars',
  busyCals: 'busy_calendars',
};

const readJson = (ctx: Ctx, key: string): unknown => {
  const v = getSetting(ctx.db, key);
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    throw new Error(`Setting "${key}" is not valid JSON. Reset it with: npm run plan -- config set ${key} <json>`);
  }
};

/** Reads a JSON setting; upgrades the old "after_last_class" rule name in place so saved data keeps working. */
const readMigrated = (ctx: Ctx, key: string): unknown => {
  const raw = readJson(ctx, key);
  if (raw === undefined) return undefined;
  const m = migrateLegacyHours(raw);
  if (m.changed) setSetting(ctx.db, key, JSON.stringify(m.data));
  return m.data;
};

const fmtErrors = (what: string, errors: string[]) => `Invalid ${what}:\n${errors.map((e) => `  - ${e}`).join('\n')}`;

/** Global working hours (or the built-in default), plus the current term's override if one is set. */
export function loadWorkingHours(ctx: Ctx, termId?: number): { hours: WorkingHours; usingDefault: boolean } {
  const raw = readMigrated(ctx, K.hours);
  let hours = DEFAULT_WORKING_HOURS;
  let usingDefault = true;
  if (raw !== undefined) {
    const r = parseWorkingHours(raw);
    if (!r.ok) throw new Error(fmtErrors('saved working_hours', r.errors));
    hours = r.data;
    usingDefault = false;
  }
  if (termId !== undefined) {
    const ov = readMigrated(ctx, K.termHours(termId));
    if (ov !== undefined) return { hours: resolveWorkingHours(hours, ov), usingDefault: false };
  }
  return { hours, usingDefault };
}

export function saveWorkingHoursJson(ctx: Ctx, raw: unknown): WorkingHours {
  const r = parseWorkingHours(migrateLegacyHours(raw).data);
  if (!r.ok) throw new Error(fmtErrors('working hours', r.errors));
  setSetting(ctx.db, K.hours, JSON.stringify(r.data));
  return r.data;
}

/** Per-term override: only the keys you want to change. Validated against the global hours. */
export function saveTermWorkingHours(ctx: Ctx, termId: number, rawOverride: unknown): void {
  const base = loadWorkingHours(ctx).hours;
  resolveWorkingHours(base, rawOverride); // throws with readable errors
  setSetting(ctx.db, K.termHours(termId), JSON.stringify(rawOverride));
}

export function loadOverrides(ctx: Ctx): Overrides {
  const raw = readMigrated(ctx, K.overrides);
  if (raw === undefined) return {};
  const r = parseOverrides(raw);
  if (!r.ok) throw new Error(fmtErrors('saved schedule_overrides', r.errors));
  return r.data;
}

const saveOverrides = (ctx: Ctx, o: Overrides) => setSetting(ctx.db, K.overrides, JSON.stringify(o));

/** Mark a local date unavailable (game day, busy day, trip). */
export function addAway(ctx: Ctx, date: string, label?: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date like 2026-11-14.`);
  const o = loadOverrides(ctx);
  o[date] = { ...(o[date] ?? { unavailable_windows: [] }), unavailable: true, ...(label ? { label } : {}) };
  saveOverrides(ctx, o);
}

/** Block a time window on one date (e.g. right before a midterm) without making the whole day unavailable. */
export function addAwayWindow(ctx: Ctx, date: string, start: string, end: string, label?: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date like 2026-11-09.`);
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(start) || !hhmm.test(end)) throw new Error('Times must be 24-hour HH:mm, like 16:00.');
  if (end <= start) throw new Error('The end time must be after the start time.');
  const o = loadOverrides(ctx);
  const cur = o[date] ?? { unavailable_windows: [] };
  o[date] = { ...cur, unavailable_windows: [...cur.unavailable_windows, { start, end, ...(label ? { label } : {}) }] };
  saveOverrides(ctx, o);
}

export function removeAway(ctx: Ctx, date: string): boolean {
  const o = loadOverrides(ctx);
  if (!o[date]) return false;
  delete o[date];
  saveOverrides(ctx, o);
  return true;
}

const readIds = (ctx: Ctx, key: string): string[] | undefined => {
  const raw = readJson(ctx, key);
  return Array.isArray(raw) ? raw.map(String) : undefined;
};
export const getClassCalendars = (ctx: Ctx) => readIds(ctx, K.classCals);
export const saveClassCalendars = (ctx: Ctx, ids: string[]) => setSetting(ctx.db, K.classCals, JSON.stringify(ids));
export const getBusyCalendars = (ctx: Ctx) => readIds(ctx, K.busyCals);
export const saveBusyCalendars = (ctx: Ctx, ids: string[]) => setSetting(ctx.db, K.busyCals, JSON.stringify(ids));
