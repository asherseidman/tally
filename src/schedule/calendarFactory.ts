import { existsSync } from 'node:fs';
import { OAuthTokenProvider, makeOAuthClient, defaultClientFile, type HealthHooks } from './auth';
import { NoGoogleCalendar } from './noCalendar';
import { KeychainSecretStore, type SecretStore } from './secretStore';
import { GoogleCalendarClient } from './googleCalendar';
import { simulatedCalendar, SIMULATED_CLASS_CALENDAR_ID } from './fakeCalendar';
import type { CalendarClient } from './calendar';

export interface CalendarHandle {
  calendar: CalendarClient;
  simulated: boolean;
  /** no Google client file is set up: the calendar is empty and read-only in effect (free windows only) */
  unavailable?: boolean;
  /** class calendar ids to use instead of the saved setting (only for the simulated calendar) */
  classCalendarIds?: string[];
}

/** The real Google calendar (free/busy read-only; writes only to "Planner Blocks"), or the simulated one for the demo database. */
export function createCalendar(tz: string, demo: boolean, store: SecretStore = new KeychainSecretStore(), health?: HealthHooks, clientFile: string = defaultClientFile()): CalendarHandle {
  if (demo) return { calendar: simulatedCalendar(tz), simulated: true, classCalendarIds: [SIMULATED_CLASS_CALENDAR_ID] };
  // The app ships without a Google client. Without one there is nothing to sign in with: behave as an empty calendar, never as an error.
  if (!existsSync(clientFile)) return noGoogleHandle();
  const provider = new OAuthTokenProvider(makeOAuthClient(), store, undefined, health);
  return { calendar: new GoogleCalendarClient(provider, fetch, tz, () => health?.problem('http_401', 'reconnect')), simulated: false };
}

export const noGoogleHandle = (): CalendarHandle => ({ calendar: new NoGoogleCalendar(), simulated: false, unavailable: true });
