import { describe, it, expect } from 'vitest';
import { GoogleCalendarClient, ReconnectRequiredError, PLANNER_CALENDAR_NAME, GOOGLE_SCOPES } from '../src/schedule/googleCalendar';

type Call = { url: string; method: string; body?: any; auth?: string };
function mockFetch(routes: (c: Call) => { status?: number; json?: any } | undefined) {
  const calls: Call[] = [];
  const fn = (async (input: any, init: any = {}) => {
    const c: Call = { url: String(input), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization };
    calls.push(c);
    const r = routes(c) ?? { status: 404, json: { error: { message: 'no route' } } };
    return new Response(r.status === 204 ? null : JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const tokens = { getAccessToken: async () => 'tok123' };
const B = 'https://www.googleapis.com/calendar/v3';

describe('GoogleCalendarClient', () => {
  it('requests only the three minimum scopes', () => {
    expect(GOOGLE_SCOPES).toEqual([
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.app.created',
    ]);
  });
  it('lists calendars across pages with a bearer token', async () => {
    const { fn, calls } = mockFetch((c) => {
      if (!c.url.startsWith(`${B}/users/me/calendarList`)) return;
      return c.url.includes('pageToken=p2')
        ? { json: { items: [{ id: 'b', summary: 'B', accessRole: 'freeBusyReader' }] } }
        : { json: { items: [{ id: 'a', summary: 'A', accessRole: 'owner', primary: true }], nextPageToken: 'p2' } };
    });
    const cals = await new GoogleCalendarClient(tokens, fn).listCalendars();
    expect(cals.map((c) => [c.id, c.accessRole, !!c.primary])).toEqual([['a', 'owner', true], ['b', 'freeBusyReader', false]]);
    expect(calls.every((c) => c.auth === 'Bearer tok123' && c.method === 'GET')).toBe(true);
  });
  it('freeBusy posts the range and calendars, returns busy intervals per calendar', async () => {
    const { fn, calls } = mockFetch((c) =>
      c.url === `${B}/freeBusy` ? { json: { calendars: { a: { busy: [{ start: '2026-11-09T15:00:00Z', end: '2026-11-09T16:00:00Z' }] }, b: { busy: [] } } } } : undefined);
    const r = await new GoogleCalendarClient(tokens, fn).freeBusy(['a', 'b'], Date.parse('2026-11-09T00:00:00Z'), Date.parse('2026-11-10T00:00:00Z'));
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({ timeMin: '2026-11-09T00:00:00.000Z', timeMax: '2026-11-10T00:00:00.000Z', items: [{ id: 'a' }, { id: 'b' }] });
    expect(r.a).toEqual([{ start: Date.parse('2026-11-09T15:00:00Z'), end: Date.parse('2026-11-09T16:00:00Z') }]);
    expect(r.b).toEqual([]);
  });
  it('freeBusy surfaces per-calendar errors instead of silently treating them as free', async () => {
    const { fn } = mockFetch((c) => (c.url === `${B}/freeBusy` ? { json: { calendars: { a: { errors: [{ reason: 'notFound' }] } } } } : undefined));
    await expect(new GoogleCalendarClient(tokens, fn).freeBusy(['a'], 0, 1000)).rejects.toThrow(/a.*notFound/s);
  });
  it('freeBusy splits more than 50 calendars into several requests', async () => {
    const { fn, calls } = mockFetch((c) => {
      if (c.url !== `${B}/freeBusy`) return;
      return { json: { calendars: Object.fromEntries(c.body.items.map((i: any) => [i.id, { busy: [] }])) } };
    });
    const ids = Array.from({ length: 120 }, (_, i) => `c${i}`);
    const r = await new GoogleCalendarClient(tokens, fn).freeBusy(ids, 0, 1000);
    expect(calls).toHaveLength(3);
    expect(Object.keys(r)).toHaveLength(120);
  });
  it('finds an existing Planner Blocks calendar without creating one', async () => {
    const { fn, calls } = mockFetch((c) =>
      c.url.startsWith(`${B}/users/me/calendarList`) ? { json: { items: [{ id: 'pb1', summary: PLANNER_CALENDAR_NAME, accessRole: 'owner' }, { id: 'x', summary: 'Other', accessRole: 'owner' }] } } : undefined);
    const c = new GoogleCalendarClient(tokens, fn);
    expect(await c.findPlannerCalendarId()).toBe('pb1');
    expect(await c.ensurePlannerCalendar()).toBe('pb1');
    expect(calls.some((x) => x.method === 'POST')).toBe(false);
  });
  it('creates the calendar when missing (POST /calendars) and then writes events only to it', async () => {
    const { fn, calls } = mockFetch((c) => {
      if (c.url.startsWith(`${B}/users/me/calendarList`)) return { json: { items: [{ id: 'primary', summary: 'Me', accessRole: 'owner', primary: true }] } };
      if (c.method === 'POST' && c.url === `${B}/calendars`) return { json: { id: 'newcal', summary: PLANNER_CALENDAR_NAME } };
      if (c.method === 'POST' && c.url === `${B}/calendars/newcal/events`) return { json: { id: 'ev1' } };
      if (c.method === 'DELETE' && c.url === `${B}/calendars/newcal/events/ev1`) return { status: 204 };
    });
    const c = new GoogleCalendarClient(tokens, fn);
    const id = await c.createPlannerEvent({ summary: 'Study', description: 'd', startMs: Date.parse('2026-11-09T15:00:00Z'), endMs: Date.parse('2026-11-09T16:00:00Z'), timeZone: 'America/Detroit' });
    expect(id).toBe('ev1');
    await c.deletePlannerEvent('ev1');
    const created = calls.find((x) => x.url === `${B}/calendars`)!;
    expect(created.body).toMatchObject({ summary: PLANNER_CALENDAR_NAME });
    const ev = calls.find((x) => x.url === `${B}/calendars/newcal/events`)!;
    expect(ev.body).toMatchObject({ summary: 'Study', start: { dateTime: '2026-11-09T15:00:00.000Z', timeZone: 'America/Detroit' }, end: { dateTime: '2026-11-09T16:00:00.000Z' } });
    // every write targets the planner calendar and nothing else
    const writes = calls.filter((x) => x.method !== 'GET' && !x.url.endsWith('/freeBusy'));
    expect(writes.every((w) => w.url === `${B}/calendars` || w.url.startsWith(`${B}/calendars/newcal/`))).toBe(true);
  });
  it('treats an already-deleted event (404/410) as success', async () => {
    for (const status of [404, 410]) {
      const { fn } = mockFetch((c) => {
        if (c.url.startsWith(`${B}/users/me/calendarList`)) return { json: { items: [{ id: 'pb', summary: PLANNER_CALENDAR_NAME, accessRole: 'owner' }] } };
        if (c.method === 'DELETE') return { status, json: { error: { message: 'gone' } } };
      });
      await expect(new GoogleCalendarClient(tokens, fn).deletePlannerEvent('zzz')).resolves.toBeUndefined();
    }
  });
  it('a 401 means reconnect, with a clear message', async () => {
    const { fn } = mockFetch(() => ({ status: 401, json: { error: { message: 'Invalid Credentials' } } }));
    await expect(new GoogleCalendarClient(tokens, fn).listCalendars()).rejects.toBeInstanceOf(ReconnectRequiredError);
    await expect(new GoogleCalendarClient(tokens, fn).listCalendars()).rejects.toThrow(/calendar connect/);
  });
  it('other API errors carry the status and Google message', async () => {
    const { fn } = mockFetch(() => ({ status: 403, json: { error: { message: 'Insufficient Permission' } } }));
    await expect(new GoogleCalendarClient(tokens, fn).listCalendars()).rejects.toThrow(/403.*Insufficient Permission/s);
  });
  it('an expired/revoked refresh token (invalid_grant) from the token provider means reconnect', async () => {
    const bad = { getAccessToken: async () => { throw new ReconnectRequiredError('invalid_grant'); } };
    const { fn, calls } = mockFetch(() => ({ json: {} }));
    await expect(new GoogleCalendarClient(bad, fn).listCalendars()).rejects.toThrow(/calendar connect/);
    expect(calls).toHaveLength(0);
  });
});
