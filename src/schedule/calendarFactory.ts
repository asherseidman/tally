import { OAuthTokenProvider, makeOAuthClient, type HealthHooks } from './auth';
import { KeychainSecretStore, type SecretStore } from './secretStore';
import { GoogleCalendarClient } from './googleCalendar';
import { simulatedCalendar, SIMULATED_CLASS_CALENDAR_ID } from './fakeCalendar';
import type { CalendarClient } from './calendar';

export interface CalendarHandle {
  calendar: CalendarClient;
  simulated: boolean;
  /** class calendar ids to use instead of the saved setting (only for the simulated calendar) */
  classCalendarIds?: string[];
}

/** The real Google calendar (free/busy read-only; writes only to "Planner Blocks"), or the simulated one for the demo database. */
export function createCalendar(tz: string, demo: boolean, store: SecretStore = new KeychainSecretStore(), health?: HealthHooks): CalendarHandle {
  if (demo) return { calendar: simulatedCalendar(tz), simulated: true, classCalendarIds: [SIMULATED_CLASS_CALENDAR_ID] };
  const provider = new OAuthTokenProvider(makeOAuthClient(), store, undefined, health);
  return { calendar: new GoogleCalendarClient(provider, fetch, tz, () => health?.problem('http_401', 'reconnect')), simulated: false };
}
