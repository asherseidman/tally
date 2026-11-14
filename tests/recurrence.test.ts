import { describe, it, expect } from 'vitest';
import { parseRecurrence, nextOccurrence, serializeRule, deserializeRule, describeRule } from '../src/core/recurrence';

const TZ = 'America/Detroit';

describe('parseRecurrence', () => {
  it('parses presets and custom days', () => {
    expect(parseRecurrence('daily')).toEqual({ freq: 'daily', interval: 1 });
    expect(parseRecurrence('weekly')).toEqual({ freq: 'weekly', interval: 1 });
    expect(parseRecurrence('every 3 days')).toEqual({ freq: 'daily', interval: 3 });
    expect(parseRecurrence('mon,wed,fri')).toEqual({ freq: 'weekly', interval: 1, days: [1, 3, 5] });
    expect(parseRecurrence('weekly:Sun')).toEqual({ freq: 'weekly', interval: 1, days: [7] });
    expect(parseRecurrence('weekdays')).toEqual({ freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] });
  });
  it('rejects garbage', () => {
    expect(() => parseRecurrence('sometimes')).toThrow();
    expect(() => parseRecurrence('every 0 days')).toThrow();
    expect(() => parseRecurrence('funday')).toThrow();
  });
  it('round-trips and describes', () => {
    const r = parseRecurrence('mon,thu');
    expect(deserializeRule(serializeRule(r))).toEqual(r);
    expect(describeRule(r)).toBe('weekly on Mon, Thu');
    expect(describeRule(parseRecurrence('daily'))).toBe('daily');
  });
});

describe('nextOccurrence', () => {
  it('daily adds a day, keeping local wall time', () => {
    expect(nextOccurrence('2026-09-07T03:59:00.000Z', parseRecurrence('daily'), TZ)).toBe('2026-09-08T03:59:00.000Z');
  });
  it('every N days', () => {
    expect(nextOccurrence('2026-09-07T03:59:00.000Z', parseRecurrence('every 3 days'), TZ)).toBe('2026-09-10T03:59:00.000Z');
  });
  it('weekly adds 7 days', () => {
    expect(nextOccurrence('2026-09-07T03:59:00.000Z', parseRecurrence('weekly'), TZ)).toBe('2026-09-14T03:59:00.000Z');
  });
  it('weekly custom days picks the next listed weekday (local date)', () => {
    // Mon Sep 7 2026 9:00 AM EDT
    const mon = '2026-09-07T13:00:00.000Z';
    const r = parseRecurrence('mon,wed,fri');
    expect(nextOccurrence(mon, r, TZ)).toBe('2026-09-09T13:00:00.000Z'); // Wed
    expect(nextOccurrence('2026-09-11T13:00:00.000Z', r, TZ)).toBe('2026-09-14T13:00:00.000Z'); // Fri -> Mon
  });
  it('uses the LOCAL weekday, not UTC (11:30 PM Sunday is Monday in UTC)', () => {
    // Sun Sep 6 2026 11:30 PM EDT = Mon Sep 7 03:30Z
    expect(nextOccurrence('2026-09-07T03:30:00.000Z', parseRecurrence('sun,wed'), TZ)).toBe('2026-09-10T03:30:00.000Z'); // Wed 11:30 PM EDT
  });
  it('daily keeps 9:00 AM local across fall-back DST (Nov 1 2026)', () => {
    // Sat Oct 31 9:00 EDT = 13:00Z -> Sun Nov 1 9:00 EST = 14:00Z
    expect(nextOccurrence('2026-10-31T13:00:00.000Z', parseRecurrence('daily'), TZ)).toBe('2026-11-01T14:00:00.000Z');
  });
  it('weekly keeps 9:00 AM local across fall-back', () => {
    expect(nextOccurrence('2026-10-28T13:00:00.000Z', parseRecurrence('weekly'), TZ)).toBe('2026-11-04T14:00:00.000Z');
  });
  it('daily keeps wall time across spring-forward (Mar 14 2027)', () => {
    // Sat Mar 13 2027 9:00 EST = 14:00Z -> Sun Mar 14 9:00 EDT = 13:00Z
    expect(nextOccurrence('2027-03-13T14:00:00.000Z', parseRecurrence('daily'), TZ)).toBe('2027-03-14T13:00:00.000Z');
  });
  it('a time inside the skipped hour moves forward, not to a bad date', () => {
    // Sat Mar 13 2027 2:30 AM EST = 07:30Z -> Mar 14 2:30 AM does not exist -> 3:30 EDT = 07:30Z
    expect(nextOccurrence('2027-03-13T07:30:00.000Z', parseRecurrence('daily'), TZ)).toBe('2027-03-14T07:30:00.000Z');
  });
  it('11:59 PM weekly across fall-back stays 11:59 PM local', () => {
    // Fri Oct 30 11:59 PM EDT -> Fri Nov 6 11:59 PM EST
    expect(nextOccurrence('2026-10-31T03:59:00.000Z', parseRecurrence('weekly'), TZ)).toBe('2026-11-07T04:59:00.000Z');
  });
  it('notBefore skips occurrences already in the past', () => {
    const r = parseRecurrence('daily');
    const out = nextOccurrence('2026-09-01T13:00:00.000Z', r, TZ, new Date('2026-09-10T00:00:00Z'));
    expect(out).toBe('2026-09-10T13:00:00.000Z');
  });
});
