import type { CalendarClient, CalendarInfo, NewEvent } from './calendar';
import type { Interval } from './types';

export const NOT_SET_UP_MESSAGE = 'Google Calendar is not set up, so nothing can be written to it. Tally still plans from your Availability grid; to also write blocks to a calendar, set up Google Calendar in Settings > Google.';

/**
 * Stands in for Google when no client file has been set up (the app ships without one). It reads as an empty calendar:
 * no calendars, no busy time. So every screen and the scheduler work from the free windows alone, with no errors, no
 * "reconnect" prompts and no failed jobs. It has no network code. Writing is the one thing it refuses, in plain words.
 */
export class NoGoogleCalendar implements CalendarClient {
  readonly unavailable = true;
  async listCalendars(): Promise<CalendarInfo[]> { return []; }
  async freeBusy(calendarIds: string[], _fromMs?: number, _toMs?: number): Promise<Record<string, Interval[]>> { return Object.fromEntries(calendarIds.map((id) => [id, []])); }
  async findPlannerCalendarId(): Promise<string | undefined> { return undefined; }
  async ensurePlannerCalendar(): Promise<string> { throw new Error(NOT_SET_UP_MESSAGE); }
  async createPlannerEvent(_ev: NewEvent): Promise<string> { throw new Error(NOT_SET_UP_MESSAGE); }
  async deletePlannerEvent(_eventId: string): Promise<void> { throw new Error(NOT_SET_UP_MESSAGE); }
}
