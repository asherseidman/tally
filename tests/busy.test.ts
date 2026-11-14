import { describe, it, expect } from 'vitest';
import { buildBusyReport, formatBusyReport, LONG_BUSY_HOURS, splitLongBusy } from '../src/schedule/busy';
import { iv, loc, TZ } from './helpers';

const cals = () => [
  { id: 'u', summary: 'School', accessRole: 'freeBusyReader', busy: [iv('2026-11-09T10:00', '2026-11-09T11:00'), iv('2026-11-10T00:00', '2026-11-11T00:00')] },
  { id: 'p', summary: 'Personal', accessRole: 'owner', busy: [] },
  { id: 'f', summary: 'Family', accessRole: 'owner', busy: [iv('2026-11-09T12:00', '2026-11-09T19:30')] },
];

describe('busy report', () => {
  it('flags blocks of 20+ hours with the calendar they come from, and not shorter ones', () => {
    const r = buildBusyReport(cals(), loc('2026-11-09T00:00'), loc('2026-11-16T00:00'));
    expect(LONG_BUSY_HOURS).toBe(20);
    expect(r.flagged).toHaveLength(1);
    expect(r.flagged[0]).toMatchObject({ calendarId: 'u', calendar: 'School', hours: 24 });
  });
  it('a 19h59m block is not flagged; exactly 20h is', () => {
    const mk = (mins: number) => [{ id: 'x', summary: 'X', accessRole: 'owner', busy: [{ start: loc('2026-11-09T00:00'), end: loc('2026-11-09T00:00') + mins * 60000 }] }];
    expect(buildBusyReport(mk(20 * 60 - 1), 0, 1e15).flagged).toHaveLength(0);
    expect(buildBusyReport(mk(20 * 60), 0, 1e15).flagged).toHaveLength(1);
  });
  it('prints plain start-end times per calendar, sorted, with the warning on long blocks', () => {
    const text = formatBusyReport(buildBusyReport(cals(), loc('2026-11-09T00:00'), loc('2026-11-16T00:00')), TZ);
    expect(text).toMatch(/School/);
    expect(text).toMatch(/Mon Nov 9\s+10:00 AM – 11:00 AM/);
    expect(text).toMatch(/Mon Nov 9\s+12:00 PM – 7:30 PM/);
    expect(text).toMatch(/\(none\)/); // Personal has no busy blocks
    expect(text).toMatch(/\(24h\)\s+⚠ LIKELY ALL-DAY EVENT/);
    expect(text).toMatch(/1 block of 20 hours or more: School/);
    expect(text).toMatch(/1 block of 20 hours or more/);
  });
});

describe('splitLongBusy', () => {
  const day = iv('2026-11-10T00:00', '2026-11-11T00:00');
  const short = iv('2026-11-09T10:00', '2026-11-09T11:00');
  it('separates busy blocks of at least N hours (all-day events) from normal ones', () => {
    const r = splitLongBusy([short, day], 20);
    expect(r.kept).toEqual([short]);
    expect(r.ignored).toEqual([day]);
  });
  it('the threshold is inclusive, so what is flagged is what is ignored', () => {
    const twenty = { start: loc('2026-11-10T00:00'), end: loc('2026-11-10T00:00') + 20 * 3600000 };
    const under = { start: twenty.start, end: twenty.end - 60000 };
    expect(splitLongBusy([twenty], 20).ignored).toEqual([twenty]);
    expect(splitLongBusy([under], 20).kept).toEqual([under]);
  });
  it('0 turns it off: nothing is ignored', () => {
    expect(splitLongBusy([short, day], 0)).toEqual({ kept: [short, day], ignored: [] });
  });
});
