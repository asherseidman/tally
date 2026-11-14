import type { Ctx } from '../core/ctx';
import type { CalendarClient } from './calendar';
import type { Interval } from './types';
import { getBusyCalendars, getClassCalendars, loadWorkingHours } from './settings';
import { loadScheduleSettings } from './params';
import { splitLongBusy } from './busy';
import { mergeIntervals } from './availability';
import { currentTerm } from '../core/terms';

/**
 * Busy time from Google exactly as the scheduler sees it (the busy calendars, plus the class calendars, never "Planner Blocks",
 * all-day-length blocks ignored by the same rule), merged into plain intervals. Free/busy only: no titles, attendees or
 * calendar names ever leave this function.
 */
export async function googleBusy(ctx: Ctx, calendar: CalendarClient, fromMs: number, toMs: number, classCalendarIds?: string[]): Promise<Interval[]> {
  const calendars = await calendar.listCalendars();
  const plannerId = await calendar.findPlannerCalendarId();
  const classIds = classCalendarIds ?? getClassCalendars(ctx) ?? [];
  const ids = [...new Set([...(getBusyCalendars(ctx) ?? calendars.map((c) => c.id)), ...classIds])].filter((id) => id !== plannerId);
  if (!ids.length) return [];
  const { hours } = loadScheduleSettings(ctx, loadWorkingHours(ctx, currentTerm(ctx)?.id).hours);
  const fb = await calendar.freeBusy(ids, fromMs, toMs);
  return mergeIntervals(ids.flatMap((id) => splitLongBusy(fb[id] ?? [], hours.ignore_busy_at_least_hours).kept));
}
