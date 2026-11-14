import { DateTime } from 'luxon';
import type { Interval } from './types';

/** A busy block this long is almost certainly an all-day event. */
export const LONG_BUSY_HOURS = 20;

export interface CalendarBusy {
  id: string;
  summary: string;
  accessRole: string;
  busy: Interval[];
}
export interface FlaggedBlock {
  calendarId: string;
  calendar: string;
  start: number;
  end: number;
  hours: number;
}
export interface BusyReport {
  fromMs: number;
  toMs: number;
  calendars: CalendarBusy[];
  flagged: FlaggedBlock[];
}

export function buildBusyReport(calendars: CalendarBusy[], fromMs: number, toMs: number): BusyReport {
  const flagged: FlaggedBlock[] = [];
  const cleaned = calendars.map((c) => ({ ...c, busy: c.busy.filter((b) => b.end > fromMs && b.start < toMs).sort((a, b) => a.start - b.start) }));
  for (const c of cleaned) {
    for (const b of c.busy) {
      const hours = (b.end - b.start) / 3_600_000;
      if (hours >= LONG_BUSY_HOURS) flagged.push({ calendarId: c.id, calendar: c.summary, start: b.start, end: b.end, hours });
    }
  }
  return { fromMs, toMs, calendars: cleaned, flagged };
}

export function formatBusyReport(r: BusyReport, tz: string): string {
  const fmt = (ms: number, f: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat(f);
  const out: string[] = [`Busy blocks the scheduler sees, ${fmt(r.fromMs, 'ccc LLL d')} to ${fmt(r.toMs, 'ccc LLL d')} (${tz}):`];
  for (const c of r.calendars) {
    out.push('', `${c.summary}  [${c.id}, ${c.accessRole}]`);
    if (!c.busy.length) out.push('   (none)');
    for (const b of c.busy) {
      const hours = (b.end - b.start) / 3_600_000;
      const sameDay = fmt(b.start, 'yyyy-MM-dd') === fmt(b.end - 1, 'yyyy-MM-dd');
      const times = sameDay ? `${fmt(b.start, 'ccc LLL d').padEnd(11)}  ${fmt(b.start, 'h:mm a')} – ${fmt(b.end, 'h:mm a')}` : `${fmt(b.start, 'ccc LLL d h:mm a')} → ${fmt(b.end, 'ccc LLL d h:mm a')}`;
      out.push(`   ${times}${hours >= LONG_BUSY_HOURS ? `   (${Math.round(hours * 10) / 10}h)  ⚠ LIKELY ALL-DAY EVENT` : ''}`);
    }
  }
  out.push('', r.flagged.length ? `${r.flagged.length} block${r.flagged.length === 1 ? '' : 's'} of ${LONG_BUSY_HOURS} hours or more: ${[...new Set(r.flagged.map((f) => f.calendar))].join(', ')}` : `No blocks of ${LONG_BUSY_HOURS} hours or more.`);
  return out.join('\n');
}

/**
 * Splits busy blocks into ones that count and "all-day" ones (at least `atLeastHours` long) that
 * should not blank a whole day. 0 turns the rule off. Same threshold as the report's flag.
 */
export function splitLongBusy(busy: Interval[], atLeastHours: number): { kept: Interval[]; ignored: Interval[] } {
  if (atLeastHours <= 0) return { kept: busy, ignored: [] };
  const limit = atLeastHours * 3_600_000;
  return { kept: busy.filter((b) => b.end - b.start < limit), ignored: busy.filter((b) => b.end - b.start >= limit) };
}
