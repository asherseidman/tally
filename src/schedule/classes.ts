import { DateTime } from 'luxon';
import type { Interval } from './types';
import { classifyDay, classRulesFor, describeDay } from './availability';
import { timeRange } from './format';
import type { Overrides, WorkingHours } from './workingHours';

export interface ClassDay {
  date: string;
  usesRule: boolean;
  first?: Interval;
  counted: Interval[];
  ignored: { block: Interval; reason: string }[];
}

/** Per local day: which busy block is treated as the first class, and which were ignored and why. */
export function buildClassReport(classBusy: Interval[], fromMs: number, toMs: number, tz: string, hours: WorkingHours, overrides: Overrides): { days: ClassDay[] } {
  const days: ClassDay[] = [];
  for (let d = DateTime.fromMillis(fromMs, { zone: tz }).startOf('day'); d.toMillis() < toMs; d = d.plus({ days: 1 }).startOf('day')) {
    const date = d.toISODate()!;
    const c = classifyDay(date, classBusy, tz, classRulesFor(date, tz, hours, overrides));
    days.push({ date, usesRule: describeDay(date, { tz, overrides, classBusy, hours }).usesClassRule, first: c.first, counted: c.counted, ignored: c.ignored });
  }
  return { days };
}

export function formatClassReport(r: { days: ClassDay[] }, tz: string): string {
  const out: string[] = ['How the scheduler reads your class calendar (first class of each day sets the earliest start):'];
  for (const d of r.days) {
    const label = DateTime.fromISO(d.date, { zone: tz }).toFormat('ccc LLL d').padEnd(11);
    if (!d.usesRule) {
      out.push(`${label}  (class rule not used)`);
    } else if (d.first) {
      out.push(`${label}  FIRST CLASS ${timeRange(d.first.start, d.first.end, tz)}  → work can start at ${DateTime.fromMillis(d.first.end, { zone: tz }).toFormat('h:mm a')}` + (d.counted.length > 1 ? `   (later classes: ${d.counted.filter((c) => c !== d.first).map((c) => timeRange(c.start, c.end, tz)).join(', ')})` : ''));
    } else {
      out.push(`${label}  no class found → default start`);
    }
    for (const i of d.ignored) out.push(`${' '.repeat(13)}ignored ${timeRange(i.block.start, i.block.end, tz)}: ${i.reason}`);
  }
  return out.join('\n');
}
