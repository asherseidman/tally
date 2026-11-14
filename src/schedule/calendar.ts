import type { Interval } from './types';

export interface CalendarInfo {
  id: string;
  summary: string;
  accessRole: string;
  primary?: boolean;
}

export interface NewEvent {
  summary: string;
  description: string;
  startMs: number;
  endMs: number;
  timeZone: string;
}

/**
 * Everything the scheduler needs from a calendar. Reads cover any calendar (busy/free only);
 * writes can ONLY ever go to the "Planner Blocks" calendar, by construction: there is no way to
 * name another calendar in a write.
 */
export interface CalendarClient {
  listCalendars(): Promise<CalendarInfo[]>;
  /** busy intervals per calendar id (free/busy only, no event details) */
  freeBusy(calendarIds: string[], fromMs: number, toMs: number): Promise<Record<string, Interval[]>>;
  /** id of the Planner Blocks calendar if it already exists; never creates it */
  findPlannerCalendarId(): Promise<string | undefined>;
  ensurePlannerCalendar(): Promise<string>;
  createPlannerEvent(ev: NewEvent): Promise<string>;
  deletePlannerEvent(eventId: string): Promise<void>;
}
