import { DateTime } from 'luxon';
import type { CalendarClient, CalendarInfo, NewEvent } from './calendar';
import type { Interval } from './types';
import { PLANNER_CALENDAR_NAME } from './googleCalendar';

export interface FakeCalendarSpec {
  id: string;
  summary: string;
  busy: Interval[] | ((fromMs: number, toMs: number) => Interval[]);
  accessRole?: string;
}

export interface FakeWrite {
  op: 'createCalendar' | 'createEvent' | 'deleteEvent';
  calendarId: string;
  summary?: string;
  eventId?: string;
}

interface FakeEvent {
  id: string;
  summary: string;
  description: string;
  startMs: number;
  endMs: number;
}

export const FAKE_PLANNER_ID = 'planner-blocks-fake';

/** In-memory calendar for tests, the demo and previews. Records every write it receives. */
export class FakeCalendar implements CalendarClient {
  writes: FakeWrite[] = [];
  private events = new Map<string, FakeEvent>();
  private plannerExists: boolean;
  private seq = 0;

  constructor(private opts: { calendars: FakeCalendarSpec[]; plannerCalendarExists?: boolean; state?: FakeState }) {
    this.plannerExists = opts.plannerCalendarExists ?? !!opts.state?.plannerExists;
    for (const e of opts.state?.events ?? []) this.events.set(e.id, e);
    this.seq = opts.state?.seq ?? 0;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const out: CalendarInfo[] = this.opts.calendars.map((c) => ({ id: c.id, summary: c.summary, accessRole: c.accessRole ?? 'freeBusyReader' }));
    if (this.plannerExists) out.push({ id: FAKE_PLANNER_ID, summary: PLANNER_CALENDAR_NAME, accessRole: 'owner' });
    return out;
  }

  async freeBusy(ids: string[], fromMs: number, toMs: number): Promise<Record<string, Interval[]>> {
    const out: Record<string, Interval[]> = {};
    for (const id of ids) {
      if (id === FAKE_PLANNER_ID) {
        out[id] = [...this.events.values()].map((e) => ({ start: e.startMs, end: e.endMs }));
        continue;
      }
      const c = this.opts.calendars.find((x) => x.id === id);
      if (!c) throw new Error(`Free/busy for calendar "${id}" failed: notFound`);
      const busy = typeof c.busy === 'function' ? c.busy(fromMs, toMs) : c.busy;
      out[id] = busy.filter((b) => b.end > fromMs && b.start < toMs);
    }
    return out;
  }

  async findPlannerCalendarId() {
    return this.plannerExists ? FAKE_PLANNER_ID : undefined;
  }

  async ensurePlannerCalendar() {
    if (!this.plannerExists) {
      this.plannerExists = true;
      this.writes.push({ op: 'createCalendar', calendarId: FAKE_PLANNER_ID, summary: PLANNER_CALENDAR_NAME });
    }
    return FAKE_PLANNER_ID;
  }

  async createPlannerEvent(ev: NewEvent) {
    const calendarId = await this.ensurePlannerCalendar();
    const id = `fake-ev-${++this.seq}`;
    this.events.set(id, { id, summary: ev.summary, description: ev.description, startMs: ev.startMs, endMs: ev.endMs });
    this.writes.push({ op: 'createEvent', calendarId, summary: ev.summary, eventId: id });
    return id;
  }

  async deletePlannerEvent(eventId: string) {
    this.writes.push({ op: 'deleteEvent', calendarId: FAKE_PLANNER_ID, eventId });
    this.events.delete(eventId); // already gone is fine
  }

  plannerEvents() {
    return [...this.events.values()];
  }

  /** test helper: simulate the user deleting an event by hand in Google Calendar */
  removeBehindBack(id: string) {
    this.events.delete(id);
  }

  toState(): FakeState {
    return { plannerExists: this.plannerExists, events: this.plannerEvents(), seq: this.seq };
  }
}

export interface FakeState {
  plannerExists: boolean;
  events: FakeEvent[];
  seq: number;
}

/** Made-up class schedule (Mon-Fri 10:00-11:00 and 1:00-2:30 PM local) for demos and previews only. */
export function simulatedClasses(tz: string): (fromMs: number, toMs: number) => Interval[] {
  return (fromMs, toMs) => {
    const out: Interval[] = [];
    let day = DateTime.fromMillis(fromMs, { zone: tz }).startOf('day');
    while (day.toMillis() < toMs) {
      if (day.weekday <= 5) {
        out.push({ start: day.set({ hour: 10 }).toMillis(), end: day.set({ hour: 11 }).toMillis() });
        out.push({ start: day.set({ hour: 13 }).toMillis(), end: day.set({ hour: 14, minute: 30 }).toMillis() });
      }
      day = day.plus({ days: 1 }).startOf('day');
    }
    return out;
  };
}

export const SIMULATED_CLASS_CALENDAR_ID = 'simulated-classes';

export function simulatedCalendar(tz: string, state?: FakeState): FakeCalendar {
  return new FakeCalendar({
    calendars: [{ id: SIMULATED_CLASS_CALENDAR_ID, summary: 'SIMULATED classes (not your real calendar)', busy: simulatedClasses(tz) }],
    state,
  });
}
