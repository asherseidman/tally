import { describe, it, expect } from 'vitest';
import { resolveDue } from '../src/time';
import { fixedClock } from '../src/clock';

const TZ = 'America/Detroit';

describe('resolveDue', () => {
  it('null stays null and is not time_assumed', () => {
    expect(resolveDue(null, TZ, '23:59')).toEqual({ dueUtc: null, timeAssumed: false });
  });
  it('date-only gets default time in tz and is flagged (EDT, UTC-4)', () => {
    expect(resolveDue('2026-09-06', TZ, '23:59')).toEqual({
      dueUtc: '2026-09-07T03:59:00.000Z',
      timeAssumed: true,
    });
  });
  it('date-only in winter uses EST (UTC-5): DST-aware', () => {
    expect(resolveDue('2026-12-06', TZ, '23:59').dueUtc).toBe('2026-12-07T04:59:00.000Z');
  });
  it('respects configured default time', () => {
    expect(resolveDue('2026-09-06', TZ, '17:00').dueUtc).toBe('2026-09-06T21:00:00.000Z');
  });
  it('datetime without offset is interpreted in tz, not assumed', () => {
    expect(resolveDue('2026-09-06T17:30:00', TZ, '23:59')).toEqual({
      dueUtc: '2026-09-06T21:30:00.000Z',
      timeAssumed: false,
    });
  });
  it('datetime with offset is honored', () => {
    expect(resolveDue('2026-09-06T17:30:00-07:00', TZ, '23:59').dueUtc).toBe('2026-09-07T00:30:00.000Z');
    expect(resolveDue('2026-09-06T17:30:00Z', TZ, '23:59').dueUtc).toBe('2026-09-06T17:30:00.000Z');
  });
  it('different timezone changes result', () => {
    expect(resolveDue('2026-09-06', 'America/Los_Angeles', '23:59').dueUtc).toBe('2026-09-07T06:59:00.000Z');
  });
  it('rejects garbage', () => {
    expect(() => resolveDue('next friday', TZ, '23:59')).toThrow();
  });
  it('rejects invalid timezone', () => {
    expect(() => resolveDue('2026-09-06', 'Mars/Base', '23:59')).toThrow();
  });
});

describe('fixedClock', () => {
  it('returns the fixed time', () => {
    expect(fixedClock('2026-09-01T12:00:00Z').now().toISOString()).toBe('2026-09-01T12:00:00.000Z');
  });
});
