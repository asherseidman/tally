import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db/index';
import { fixedClock } from '../src/clock';
import type { Ctx } from '../src/core/ctx';

export function makeCtx(now = '2026-09-01T16:00:00Z'): Ctx {
  return { db: openDb(':memory:'), clock: fixedClock(now), tz: 'America/Detroit', defaultTime: '23:59' };
}

export const TZ = 'America/Detroit';
/** epoch ms of a local wall-clock time in Detroit, e.g. loc('2026-11-09T14:30') */
export const loc = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis();
/** inverse, for readable assertions */
export const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: TZ }).toFormat("yyyy-MM-dd'T'HH:mm");
export const iv = (a: string, b: string) => ({ start: loc(a), end: loc(b) });
export const routineJson = () => JSON.parse(readFileSync(new URL('../samples/working-hours.json', import.meta.url), 'utf8'));
