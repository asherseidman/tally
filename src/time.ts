import { DateTime } from 'luxon';

export interface ResolvedDue {
  dueUtc: string | null;
  timeAssumed: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

export function assertTimezone(tz: string): void {
  if (!DateTime.local().setZone(tz).isValid) throw new Error(`Invalid IANA timezone: "${tz}"`);
}

/**
 * Convert an ISO 8601 date or datetime into a UTC timestamp.
 * - date only  -> defaultTime ("HH:mm") in `tz`, timeAssumed = true
 * - datetime w/o offset -> interpreted in `tz`
 * - datetime with offset -> honored as written
 */
export function resolveDue(input: string | null | undefined, tz: string, defaultTime: string): ResolvedDue {
  if (input == null) return { dueUtc: null, timeAssumed: false };
  assertTimezone(tz);
  let dt: DateTime;
  let assumed = false;
  if (DATE_ONLY.test(input)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(defaultTime);
    if (!m) throw new Error(`Invalid default due time: "${defaultTime}" (expected HH:mm)`);
    dt = DateTime.fromISO(input, { zone: tz }).set({ hour: Number(m[1]), minute: Number(m[2]) });
    assumed = true;
  } else if (HAS_OFFSET.test(input)) {
    dt = DateTime.fromISO(input, { setZone: true });
  } else {
    dt = DateTime.fromISO(input, { zone: tz });
  }
  if (!dt.isValid) throw new Error(`Invalid date "${input}": ${dt.invalidExplanation ?? dt.invalidReason}`);
  return { dueUtc: dt.toUTC().toISO()!, timeAssumed: assumed };
}

/** Format a UTC timestamp for display in `tz`. */
export function formatLocal(utcIso: string | null, tz: string, assumed = false): string {
  if (!utcIso) return '(no date)';
  const dt = DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(tz);
  return assumed ? dt.toFormat("ccc LLL d yyyy") + ` ${dt.toFormat('h:mm a')}*` : dt.toFormat('ccc LLL d yyyy h:mm a');
}
