import { describe, it, expect } from 'vitest';
import { parseQuickAdd } from '../src/core/quickAdd';
import { parseNaturalDue } from '../src/core/naturalDate';
import { fixedClock } from '../src/clock';

const TZ = 'America/Detroit';
// Thu Nov 12 2026, 3:00 PM EST (20:00Z)
const clock = fixedClock('2026-11-12T20:00:00Z');
const q = (s: string, c = clock) => parseQuickAdd(s, TZ, c, '23:59');
const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null);

describe('parseQuickAdd', () => {
  it('"due friday 5pm" is stripped from the title', () => {
    const r = q('written homework due friday 5pm');
    expect(r.title).toBe('written homework');
    expect(local(r.dueUtc)).toBe('Fri, Nov 13, 5:00 PM');
    expect(r.timeAssumed).toBe(false);
  });
  it('"by <when>" and a trailing date with no keyword', () => {
    expect(q('essay by fri 5pm')).toMatchObject({ title: 'essay', dueUtc: q('x fri 5pm').dueUtc });
    const r = q('read chapter fri 5pm');
    expect(r.title).toBe('read chapter');
    expect(local(r.dueUtc)).toBe('Fri, Nov 13, 5:00 PM');
  });
  it('"due on friday" drops both words', () => expect(q('lab report due on friday').title).toBe('lab report'));
  it('weekday names and abbreviations; no time uses the default and is flagged', () => {
    for (const w of ['friday', 'fri']) {
      const r = q(`quiz ${w}`);
      expect(r.title).toBe('quiz');
      expect(r.timeAssumed).toBe(true);
      expect(local(r.dueUtc)).toBe('Fri, Nov 13, 11:59 PM');
    }
  });
  it('today, tonight, tomorrow', () => {
    expect(local(q('call mom today').dueUtc)).toBe('Thu, Nov 12, 11:59 PM');
    expect(local(q('call mom tonight').dueUtc)?.startsWith('Thu, Nov 12')).toBe(true);
    expect(local(q('call mom tomorrow').dueUtc)).toBe('Fri, Nov 13, 11:59 PM');
    expect(q('call mom tomorrow').title).toBe('call mom');
  });
  it('"next friday", "in 3 days", "nov 20", "11/20"', () => {
    expect(local(q('x next friday').dueUtc)).toBe('Fri, Nov 20, 11:59 PM'); // the Friday of next week
    expect(q('x next friday').title).toBe('x');
    expect(local(q('x in 3 days').dueUtc)).toBe('Sun, Nov 15, 11:59 PM');
    expect(q('x in 3 days').title).toBe('x');
    expect(local(q('x nov 20').dueUtc)).toBe('Fri, Nov 20, 11:59 PM');
    expect(local(q('x 11/20').dueUtc)).toBe('Fri, Nov 20, 11:59 PM');
    expect(local(q('x due 11/20').dueUtc)).toBe('Fri, Nov 20, 11:59 PM');
  });
  it('times: 5pm, 5:30 pm, 17:00, noon, midnight', () => {
    expect(local(q('x tomorrow 5pm').dueUtc)).toBe('Fri, Nov 13, 5:00 PM');
    expect(local(q('x tomorrow 5:30 pm').dueUtc)).toBe('Fri, Nov 13, 5:30 PM');
    expect(local(q('x fri 17:00').dueUtc)).toBe('Fri, Nov 13, 5:00 PM');
    expect(local(q('x fri noon').dueUtc)).toBe('Fri, Nov 13, 12:00 PM');
    expect(local(q('x fri midnight').dueUtc)).toBe('Fri, Nov 13, 12:00 AM');
  });
  it('a time with no date: today if still ahead, tomorrow if it has passed', () => {
    expect(local(q('x 5pm').dueUtc)).toBe('Thu, Nov 12, 5:00 PM'); // it is 3 PM
    expect(local(q('x 2pm').dueUtc)).toBe('Fri, Nov 13, 2:00 PM');
    expect(local(q('x noon').dueUtc)).toBe('Fri, Nov 13, 12:00 PM');
    expect(local(q('x 17:00').dueUtc)).toBe('Thu, Nov 12, 5:00 PM');
    expect(q('x 5pm').timeAssumed).toBe(false);
  });
  it('a weekday that is today: today if the time is ahead, otherwise next week', () => {
    expect(local(q('x thursday 5pm').dueUtc)).toBe('Thu, Nov 12, 5:00 PM');
    expect(local(q('x thu 2pm').dueUtc)).toBe('Thu, Nov 19, 2:00 PM');
    expect(local(q('x thursday').dueUtc)).toBe('Thu, Nov 12, 11:59 PM'); // default time is still ahead
    const late = fixedClock('2026-11-13T04:30:00Z'); // Thu 11:30 PM local, default 23:59 still ahead
    expect(local(q('x thursday', late).dueUtc)).toBe('Thu, Nov 12, 11:59 PM');
    const later = fixedClock('2026-11-13T04:59:30Z'); // 11:59:30 PM, default has passed
    expect(local(q('x thursday', later).dueUtc)).toBe('Thu, Nov 19, 11:59 PM');
    expect(local(q('x next thursday').dueUtc)).toBe('Thu, Nov 19, 11:59 PM');
  });
  it('uses the injectable clock and the configured time zone and default time', () => {
    expect(local(parseQuickAdd('x fri', TZ, clock, '17:00').dueUtc)).toBe('Fri, Nov 13, 5:00 PM');
    const west = parseQuickAdd('x fri 5pm', 'America/Los_Angeles', clock, '23:59');
    expect(west.dueUtc).toBe('2026-11-14T01:00:00.000Z');
  });
  it('an empty title keeps the original text and sets no date', () => {
    for (const s of ['friday 5pm', 'due friday', 'tomorrow']) {
      expect(q(s)).toEqual({ title: s, dueUtc: null, timeAssumed: false, phrase: null });
    }
  });
  it('the word "due" without a date is just text', () => {
    expect(q('due diligence notes')).toEqual({ title: 'due diligence notes', dueUtc: null, timeAssumed: false, phrase: null });
    expect(q('pay the due amount').dueUtc).toBeNull();
  });
  it('durations and mid-sentence dates are not due dates', () => {
    expect(q('2 hours of work').dueUtc).toBeNull();
    expect(q('study for 90 minutes').dueUtc).toBeNull();
    expect(q('fri review notes').dueUtc).toBeNull();
    expect(q('read 3 chapters').dueUtc).toBeNull();
  });
  it('trailing punctuation is ignored and the title is trimmed', () => {
    expect(q('  call dentist, fri 5pm.  ').title).toBe('call dentist');
  });
  it('agrees with parseNaturalDue on the phrase it found (one parser)', () => {
    const r = q('thing due tomorrow 9am');
    const direct = parseNaturalDue('tomorrow 9am', TZ, clock, '23:59');
    expect(r.dueUtc).toBe(direct.dueUtc);
  });
});
