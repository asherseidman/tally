import { DateTime } from 'luxon';
import type { Ctx } from '../core/ctx';
import type { CalendarClient } from '../schedule/calendar';
import { getBusyCalendars, getClassCalendars, loadWorkingHours } from '../schedule/settings';
import { loadScheduleSettings } from '../schedule/params';
import { splitLongBusy } from '../schedule/busy';
import { clipToDay, weekStartOf, type LabeledSpan } from './week';

/** Busy calendar events for a week, per local day, labeled with the calendar they come from (read-only, grey on the grid). */
export async function weekBusy(ctx: Ctx, calendar: CalendarClient, anyDate: string, classCalendarIds?: string[]): Promise<Record<string, LabeledSpan[]>> {
  const start = weekStartOf(anyDate, ctx.tz);
  const first = DateTime.fromISO(start, { zone: ctx.tz }).startOf('day');
  const from = first.toMillis();
  const to = first.plus({ days: 7 }).toMillis();
  const cals = await calendar.listCalendars();
  const plannerId = await calendar.findPlannerCalendarId();
  const classIds = classCalendarIds ?? getClassCalendars(ctx) ?? [];
  const ids = [...new Set([...(getBusyCalendars(ctx) ?? cals.map((c) => c.id)), ...classIds])].filter((id) => id !== plannerId);
  const { hours } = loadScheduleSettings(ctx, loadWorkingHours(ctx).hours);
  const fb = ids.length ? await calendar.freeBusy(ids, from, to) : {};
  const out: Record<string, LabeledSpan[]> = {};
  for (let i = 0; i < 7; i++) out[first.plus({ days: i }).toISODate()!] = [];
  for (const id of ids) {
    const label = cals.find((c) => c.id === id)?.summary ?? id;
    for (const b of splitLongBusy(fb[id] ?? [], hours.ignore_busy_at_least_hours).kept) {
      for (const date of Object.keys(out)) {
        const span = clipToDay(b, date, ctx.tz);
        if (span) out[date].push({ ...span, label });
      }
    }
  }
  for (const d of Object.values(out)) d.sort((a, b) => a.start - b.start);
  return out;
}
