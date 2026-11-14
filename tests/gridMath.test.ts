import { describe, it, expect } from 'vitest';
import { nowTop, ROWS, rowStart, hm, label12, rowAt, rangeFromRows, isFreeRow, placement, moveCursor, modeFor } from '../renderer/src/gridMath';

describe('grid math', () => {
  it('has 36 half-hour rows from 6 AM to midnight', () => {
    expect(ROWS).toBe(36);
    expect(hm(rowStart(0))).toBe('06:00');
    expect(hm(rowStart(35))).toBe('23:30');
    expect(label12(18 * 60 + 30)).toBe('6:30 PM');
    expect(label12(12 * 60)).toBe('12 PM');
    expect(label12(0)).toBe('12 AM');
  });
  it('maps pointer positions to rows, clamped', () => {
    expect(rowAt(0, 24)).toBe(0);
    expect(rowAt(47, 24)).toBe(1);
    expect(rowAt(-10, 24)).toBe(0);
    expect(rowAt(99999, 24)).toBe(35);
  });
  it('turns a drag between two rows (either direction) into an inclusive time range; the last row ends at 24:00', () => {
    expect(rangeFromRows(6, 9)).toEqual({ start: '09:00', end: '11:00' });
    expect(rangeFromRows(9, 6)).toEqual({ start: '09:00', end: '11:00' });
    expect(rangeFromRows(34, 35)).toEqual({ start: '23:00', end: '24:00' });
    expect(rangeFromRows(0, 0)).toEqual({ start: '06:00', end: '06:30' });
  });
  it('knows which rows are free, and the first cell of a drag picks paint vs erase', () => {
    const free = [{ start: 9 * 60, end: 12 * 60 }];
    expect(isFreeRow(free, 6)).toBe(true); // 9:00
    expect(isFreeRow(free, 11)).toBe(true); // 11:30
    expect(isFreeRow(free, 12)).toBe(false); // 12:00
    expect(modeFor(true)).toBe('erase');
    expect(modeFor(false)).toBe('paint');
  });
  it('places spans in px and clips to the visible range', () => {
    expect(placement({ start: 9 * 60, end: 10 * 60 }, 20)).toEqual({ top: 120, height: 40 });
    expect(placement({ start: 4 * 60, end: 7 * 60 }, 20)).toEqual({ top: 0, height: 40 });
    expect(placement({ start: 1, end: 100 }, 20)).toBeUndefined();
  });
  it('moves the keyboard cursor and stops at the edges', () => {
    expect(moveCursor({ day: 0, row: 0 }, 'ArrowUp')).toEqual({ day: 0, row: 0 });
    expect(moveCursor({ day: 6, row: 35 }, 'ArrowDown')).toEqual({ day: 6, row: 35 });
    expect(moveCursor({ day: 2, row: 5 }, 'ArrowRight')).toEqual({ day: 3, row: 5 });
    expect(moveCursor({ day: 0, row: 5 }, 'ArrowLeft')).toEqual({ day: 0, row: 5 });
    expect(moveCursor({ day: 1, row: 5 }, 'End')).toEqual({ day: 1, row: 35 });
  });
});

describe('nowTop (the "now" line)', () => {
  const tz = 'America/Detroit';
  it('is pixels from 6 AM at the row height, in the app time zone', () => {
    expect(nowTop(Date.parse('2026-11-12T11:00:00Z'), tz, 22)).toBe(0);            // 6:00 AM EST
    expect(nowTop(Date.parse('2026-11-12T17:00:00Z'), tz, 22)).toBe(12 * 22);       // noon = 12 half-hours after 6 AM
    expect(nowTop(Date.parse('2026-11-12T17:15:00Z'), tz, 22)).toBe(12.5 * 22);
    expect(nowTop(Date.parse('2026-11-12T17:00:00Z'), 'America/Los_Angeles', 22)).toBe(6 * 2 * 22 - 6 * 22 + 0); // 9 AM there
  });
  it('is null before 6 AM and when the day is over (nothing to draw)', () => {
    expect(nowTop(Date.parse('2026-11-12T08:00:00Z'), tz, 22)).toBeNull(); // 3 AM
    expect(nowTop(Date.parse('2026-11-12T10:59:00Z'), tz, 22)).toBeNull(); // 5:59 AM
  });
});
