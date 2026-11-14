import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { Clock } from '../clock';
import { resolveDue, assertTimezone, type ResolvedDue } from '../time';

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Parse human dates ("fri 5pm", "tomorrow", "nov 20") in the configured timezone.
 * chrono-node only understands UTC offsets/abbreviations, not IANA zones, so we hand it the
 * local wall-clock "now" as if it were UTC and convert the resulting wall-clock fields back
 * with luxon (which applies the correct DST offset for the target date).
 */
export function parseNaturalDue(text: string, tz: string, clock: Clock, defaultTime: string): ResolvedDue {
  const input = text.trim();
  if (!input) throw new Error('Empty date.');
  assertTimezone(tz);
  if (ISO.test(input)) return resolveDue(input, tz, defaultTime);

  const wall = DateTime.fromJSDate(clock.now(), { zone: tz });
  const ref = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute));
  const hit = chrono.parse(input, { instant: ref, timezone: 0 }, { forwardDate: true })[0];
  if (!hit || hit.text.trim().length !== input.length) {
    throw new Error(`Couldn't understand the date "${text}". Try things like "fri 5pm", "tomorrow", "nov 20", or 2026-11-20.`);
  }
  const c = hit.start;
  const timed = c.isCertain('hour');
  let hour: number, minute: number;
  if (timed) {
    hour = c.get('hour')!;
    minute = c.get('minute') ?? 0;
  } else {
    const m = /^(\d{1,2}):(\d{2})$/.exec(defaultTime);
    if (!m) throw new Error(`Invalid default due time: "${defaultTime}" (expected HH:mm)`);
    hour = Number(m[1]);
    minute = Number(m[2]);
  }
  let dt = DateTime.fromObject({ year: c.get('year')!, month: c.get('month')!, day: c.get('day')!, hour, minute }, { zone: tz });
  if (!dt.isValid) throw new Error(`Couldn't understand the date "${text}": ${dt.invalidExplanation}`);
  // A bare weekday that is today ("fri" on a Friday) means today while that time is still ahead, otherwise next week.
  // chrono's forwardDate always jumps a week, so correct it here ("next fri" keeps the jump).
  if (c.isCertain('weekday') && !c.isCertain('day') && !/\bnext\b/i.test(hit.text) && dt.weekday === wall.weekday) {
    const today = wall.set({ hour, minute, second: 0, millisecond: 0 });
    if (today > wall && dt.diff(today, 'days').days >= 6) dt = today;
  }
  return { dueUtc: dt.toUTC().toISO()!, timeAssumed: !timed };
}
