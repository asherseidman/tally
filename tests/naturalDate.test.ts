import { describe, it, expect } from 'vitest';
import { parseNaturalDue } from '../src/core/naturalDate';
import { fixedClock } from '../src/clock';

const TZ = 'America/Detroit';
// Sun Nov 8 2026, 8:45 PM EST = Mon Nov 9 01:45Z. Note UTC date is already Monday.
const clock = fixedClock('2026-11-09T01:45:00Z');
const p = (s: string, tz = TZ, dt = '23:59') => parseNaturalDue(s, tz, clock, dt);

describe('parseNaturalDue', () => {
  it('"fri 5pm" is the coming Friday 5 PM local (EST), time not assumed', () => {
    expect(p('fri 5pm')).toEqual({ dueUtc: '2026-11-13T22:00:00.000Z', timeAssumed: false });
  });
  it('"tomorrow" uses the LOCAL date (Mon Nov 9), default time, assumed', () => {
    expect(p('tomorrow')).toEqual({ dueUtc: '2026-11-10T04:59:00.000Z', timeAssumed: true });
  });
  it('weekday name equal to today means today while the (default) time is ahead, else a week later', () => {
    expect(p('sunday').dueUtc).toBe('2026-11-09T04:59:00.000Z');
    expect(p('sunday 5pm').dueUtc).toBe('2026-11-15T22:00:00.000Z'); // 5 PM has passed (it is 8:45 PM)
    expect(p('sunday 9pm').dueUtc).toBe('2026-11-09T02:00:00.000Z'); // 9 PM is still ahead
    expect(p('next sunday').dueUtc).toBe('2026-11-16T04:59:00.000Z');
  });
  it('"in 3 days" has no stated time -> default time', () => {
    expect(p('in 3 days')).toEqual({ dueUtc: '2026-11-12T04:59:00.000Z', timeAssumed: true });
  });
  it('"today 3pm"', () => {
    expect(p('today 3pm').dueUtc).toBe('2026-11-08T20:00:00.000Z');
  });
  it('explicit month/day without year picks the next occurrence', () => {
    expect(p('nov 20').dueUtc).toBe('2026-11-21T04:59:00.000Z');
    expect(p('jan 5 9am').dueUtc).toBe('2027-01-05T14:00:00.000Z');
  });
  it('respects configured default time and timezone', () => {
    expect(p('tomorrow', TZ, '17:00').dueUtc).toBe('2026-11-09T22:00:00.000Z');
    expect(p('fri 5pm', 'America/Los_Angeles').dueUtc).toBe('2026-11-14T01:00:00.000Z');
  });
  it('accepts ISO date and datetime', () => {
    expect(p('2026-12-01')).toEqual({ dueUtc: '2026-12-02T04:59:00.000Z', timeAssumed: true });
    expect(p('2026-12-01T09:00')).toEqual({ dueUtc: '2026-12-01T14:00:00.000Z', timeAssumed: false });
  });
  it('uses DST-correct offset for the target date (summer date)', () => {
    expect(p('jun 10 5pm').dueUtc).toBe('2027-06-10T21:00:00.000Z');
  });
  it('nonexistent spring-forward time does not throw', () => {
    expect(() => p('mar 14 2:30am')).not.toThrow();
  });
  it('rejects unparseable and partially-parsed text', () => {
    expect(() => p('whenever')).toThrow(/understand/i);
    expect(() => p('fri 5pm and then some')).toThrow(/understand/i);
    expect(() => p('')).toThrow();
  });
});
