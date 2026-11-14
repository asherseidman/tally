import { describe, it, expect } from 'vitest';
import { buildIcs, icsEscape, foldLine } from '../src/core/export';

describe('ics', () => {
  it('escapes special characters', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\;c\\\\d\\ne');
  });
  it('folds long lines at 75 octets with continuation space', () => {
    const folded = foldLine('SUMMARY:' + 'x'.repeat(200));
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(lines.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe('SUMMARY:' + 'x'.repeat(200));
  });
  it('builds VEVENTs for dated, non-deleted tasks only, with UTC stamps', () => {
    const ics = buildIcs(
      [
        { id: 1, title: 'HW, 1', due_date: '2026-09-07T03:59:00.000Z', course: 'MATH 101', notes: 'n', status: 'todo', deleted_at: null, time_assumed: 1 },
        { id: 2, title: 'No date', due_date: null, course: null, notes: null, status: 'todo', deleted_at: null, time_assumed: 0 },
        { id: 3, title: 'Gone', due_date: '2026-09-08T00:00:00.000Z', course: null, notes: null, status: 'todo', deleted_at: 'x', time_assumed: 0 },
      ],
      new Date('2026-09-01T12:00:00Z'),
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('DTSTART:20260907T035900Z');
    expect(ics).toContain('DTSTAMP:20260901T120000Z');
    expect(ics).toContain('SUMMARY:HW\\, 1');
    expect(ics).toContain('UID:task-1@todo-planner');
    expect(ics).not.toContain('Gone');
  });
});
