import { DateTime } from 'luxon';

export interface Rule {
  freq: 'daily' | 'weekly';
  interval: number;
  /** ISO weekdays (1=Mon..7=Sun), weekly only */
  days?: number[];
}

const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function parseRecurrence(input: string): Rule {
  const s = input.trim().toLowerCase();
  if (s === 'daily' || s === 'every day') return { freq: 'daily', interval: 1 };
  if (s === 'weekly' || s === 'every week') return { freq: 'weekly', interval: 1 };
  if (s === 'weekdays') return { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] };
  const every = /^every\s+(\d+)\s+(day|days|week|weeks)$/.exec(s);
  if (every) {
    const n = Number(every[1]);
    if (n < 1) throw new Error(`Invalid repeat "${input}": interval must be at least 1.`);
    return { freq: every[2].startsWith('day') ? 'daily' : 'weekly', interval: n };
  }
  const list = /^(?:weekly:)?([a-z]+(?:\s*,\s*[a-z]+)*)$/.exec(s);
  if (list) {
    const days = list[1].split(/\s*,\s*/).map((d) => DAY_NAMES.indexOf(d.slice(0, 3)) + 1);
    const full = list[1].split(/\s*,\s*/);
    if (days.every((d) => d > 0) && full.every((d) => d.length === 3 || DAY_FULL.includes(d))) {
      return { freq: 'weekly', interval: 1, days: [...new Set(days)].sort((a, b) => a - b) };
    }
  }
  throw new Error(`Invalid repeat "${input}". Use: daily, weekly, weekdays, "every 3 days", "every 2 weeks", or days like mon,wed,fri.`);
}
const DAY_FULL = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export const serializeRule = (r: Rule): string => JSON.stringify(r);
export const deserializeRule = (s: string): Rule => JSON.parse(s) as Rule;

export function describeRule(r: Rule): string {
  if (r.days) return `weekly on ${r.days.map((d) => DAY_LABEL[d - 1]).join(', ')}`;
  if (r.freq === 'daily') return r.interval === 1 ? 'daily' : `every ${r.interval} days`;
  return r.interval === 1 ? 'weekly' : `every ${r.interval} weeks`;
}

/**
 * Next due time after `dueUtc`, keeping the same LOCAL wall-clock time in `tz`, so a 9:00 AM
 * task stays 9:00 AM across daylight saving changes. If `notBefore` is given, occurrences at
 * or before it are skipped. A wall time that doesn't exist (spring-forward gap) is moved
 * forward by luxon rather than rejected.
 */
export function nextOccurrence(dueUtc: string, rule: Rule, tz: string, notBefore?: Date): string {
  const base = DateTime.fromISO(dueUtc, { zone: 'utc' }).setZone(tz);
  const floor = Math.max(DateTime.fromISO(dueUtc).toMillis(), notBefore ? notBefore.getTime() : -Infinity);
  for (let k = 1; k <= 20000; k++) {
    let cand: DateTime | undefined;
    if (rule.days) {
      const c = base.plus({ days: k });
      if (rule.days.includes(c.weekday)) cand = c;
    } else {
      cand = base.plus({ days: k * rule.interval * (rule.freq === 'weekly' ? 7 : 1) });
    }
    if (cand && cand.toMillis() > floor) return cand.toUTC().toISO()!;
  }
  throw new Error('Could not compute next occurrence.');
}
