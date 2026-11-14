import { describe, it, expect } from 'vitest';
import { makeCtx, routineJson, iv, TZ } from './helpers';
import { createTerm } from '../src/core/terms';
import { addTask } from '../src/core/tasks';
import { computePlan } from '../src/schedule/service';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { saveWorkingHoursJson, saveClassCalendars } from '../src/schedule/settings';
import { seedAvailability } from '../src/schedule/seedAvailability';
import { setWindow } from '../src/schedule/availabilityWindows';
import { formatPlan, timeRange } from '../src/schedule/format';
import { loc } from './helpers';

describe('timeRange', () => {
  it('shares the AM/PM when both ends match', () => {
    expect(timeRange(loc('2026-11-09T15:00'), loc('2026-11-09T17:00'), TZ)).toBe('3:00–5:00 PM');
    expect(timeRange(loc('2026-11-09T11:00'), loc('2026-11-09T13:00'), TZ)).toBe('11:00 AM–1:00 PM');
  });
});

describe('formatPlan', () => {
  it('shows free windows per day, an unavailable day, blocks, and what was not scheduled', async () => {
    const ctx = makeCtx('2026-11-09T02:30:00Z');
    createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
    saveWorkingHoursJson(ctx, routineJson());
    saveClassCalendars(ctx, ['classes']);
    addTask(ctx, { title: 'HW', course: 'MATH 214', due: '2026-11-11T23:59', est: 120 });
    addTask(ctx, { title: 'no estimate', due: '2026-11-11T23:59' });
    const cal = new FakeCalendar({ calendars: [{ id: 'classes', summary: 'Classes', busy: [iv('2026-11-09T13:00', '2026-11-09T14:30')] }] });
    await seedAvailability(ctx, cal, { weeks: 2 });
    setWindow(ctx, { date: '2026-11-14' }, { start: '00:00', end: '24:00' }, 'blocked');
    const text = formatPlan(await computePlan(ctx, cal, { days: 7 }), { dryRun: true, calendarNote: 'test' });
    expect(text).toMatch(/SCHEDULE \(dry run: nothing written\)/);
    expect(text).toMatch(/Mon Nov 9 .*free 2:30–10:30 PM/);
    expect(text).toMatch(/Sat Nov 14 .*no free working time/);
    expect(text).toMatch(/Placement: EARLY/);
    expect(text).toMatch(/Availability: your selected free windows/);
    expect(text).toMatch(/MATH 214: HW/);
    expect(text).toMatch(/NOT SCHEDULED:[\s\S]*no estimate: no estimate/);
  });
});
