import type { CalendarClient, CalendarInfo, NewEvent } from './calendar';
import type { Interval } from './types';

export const PLANNER_CALENDAR_NAME = 'Planner Blocks';

/** The minimum scopes: free/busy only, calendar names only, and manage events on calendars this app created. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.app.created',
];

/**
 * Google no longer accepts the saved sign-in. `code` is Google's reason (invalid_grant, invalid_token, http_401, not_connected) and
 * `kind` says whether signing in again can fix it ('reconnect') or the app's OAuth client is the problem ('client').
 * The message is the command-line wording; the app builds its own from `code` (src/schedule/googleHealth.ts).
 */
export class ReconnectRequiredError extends Error {
  constructor(detail?: string, public code: string = 'invalid_grant', public kind: 'reconnect' | 'client' = 'reconnect') {
    super(
      kind === 'client'
        ? `Google does not recognise this app's OAuth client${detail ? ` (${detail})` : ''}. Check that google-client.json is the current "Desktop app" client of your Google Cloud project.`
        : `Google Calendar access expired or was revoked${detail ? ` (${detail})` : ''}. ` +
          'Connections from a Google Cloud project in "Testing" mode expire after 7 days. Reconnect with: npm run plan -- calendar connect',
    );
    this.name = 'ReconnectRequiredError';
  }
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

const BASE = 'https://www.googleapis.com/calendar/v3';
const FREEBUSY_MAX_CALENDARS = 50;
const FREEBUSY_CHUNK_MS = 30 * 86_400_000;

export class GoogleCalendarClient implements CalendarClient {
  private plannerId?: string;

  constructor(
    private tokens: AccessTokenProvider,
    private fetchFn: typeof fetch = fetch,
    private timeZone = 'UTC',
    /** called when Google answers 401 even with a fresh access token (the app records it as a sign-in problem) */
    private onUnauthorized?: () => void,
  ) {}

  private async api(path: string, init: { method?: string; body?: unknown } = {}, okStatuses: number[] = []): Promise<any> {
    const token = await this.tokens.getAccessToken();
    const res = await this.fetchFn(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 401) { this.onUnauthorized?.(); throw new ReconnectRequiredError('HTTP 401', 'http_401'); }
    if (res.status === 204 || okStatuses.includes(res.status)) return undefined;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google Calendar API error ${res.status}: ${data?.error?.message ?? res.statusText}`);
    return data;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const out: CalendarInfo[] = [];
    let page: string | undefined;
    do {
      const data = await this.api(`/users/me/calendarList?maxResults=250${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      for (const c of data.items ?? []) out.push({ id: c.id, summary: c.summaryOverride ?? c.summary, accessRole: c.accessRole, primary: !!c.primary });
      page = data.nextPageToken;
    } while (page);
    return out;
  }

  async freeBusy(ids: string[], fromMs: number, toMs: number): Promise<Record<string, Interval[]>> {
    const out: Record<string, Interval[]> = Object.fromEntries(ids.map((id) => [id, []]));
    for (let t = fromMs; t < toMs; t += FREEBUSY_CHUNK_MS) {
      const tMax = Math.min(t + FREEBUSY_CHUNK_MS, toMs);
      for (let i = 0; i < ids.length; i += FREEBUSY_MAX_CALENDARS) {
        const group = ids.slice(i, i + FREEBUSY_MAX_CALENDARS);
        const data = await this.api('/freeBusy', {
          method: 'POST',
          body: { timeMin: new Date(t).toISOString(), timeMax: new Date(tMax).toISOString(), items: group.map((id) => ({ id })) },
        });
        for (const id of group) {
          const c = data.calendars?.[id];
          if (c?.errors?.length) throw new Error(`Free/busy for calendar "${id}" failed: ${c.errors.map((e: any) => e.reason).join(', ')}`);
          for (const b of c?.busy ?? []) out[id].push({ start: Date.parse(b.start), end: Date.parse(b.end) });
        }
      }
    }
    return out;
  }

  async findPlannerCalendarId(): Promise<string | undefined> {
    if (this.plannerId) return this.plannerId;
    const found = (await this.listCalendars()).find((c) => c.summary === PLANNER_CALENDAR_NAME && c.accessRole === 'owner');
    this.plannerId = found?.id;
    return this.plannerId;
  }

  async ensurePlannerCalendar(): Promise<string> {
    const existing = await this.findPlannerCalendarId();
    if (existing) return existing;
    const created = await this.api('/calendars', {
      method: 'POST',
      body: { summary: PLANNER_CALENDAR_NAME, description: 'Work blocks planned by todo-planner. Safe to hide; it is rewritten on every schedule run.', timeZone: this.timeZone },
    });
    this.plannerId = created.id;
    return created.id;
  }

  async createPlannerEvent(ev: NewEvent): Promise<string> {
    const cal = await this.ensurePlannerCalendar();
    const data = await this.api(`/calendars/${encodeURIComponent(cal)}/events`, {
      method: 'POST',
      body: {
        summary: ev.summary,
        description: ev.description,
        start: { dateTime: new Date(ev.startMs).toISOString(), timeZone: ev.timeZone },
        end: { dateTime: new Date(ev.endMs).toISOString(), timeZone: ev.timeZone },
        transparency: 'opaque',
        reminders: { useDefault: false },
      },
    });
    return data.id;
  }

  async deletePlannerEvent(eventId: string): Promise<void> {
    const cal = await this.findPlannerCalendarId();
    if (!cal) return;
    // 404/410: already deleted by hand, which is the state we wanted
    await this.api(`/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }, [404, 410]);
  }
}
