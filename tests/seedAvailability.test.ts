import { describe, it, expect } from 'vitest';
import { makeCtx, routineJson } from './helpers';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { seedAvailability } from '../src/schedule/seedAvailability';
import { loadWindows, resolveDay } from '../src/schedule/availabilityWindows';
import { saveWorkingHoursJson, saveClassCalendars, addAwayWindow, addAway } from '../src/schedule/settings';
import { DateTime } from 'luxon';

const TZ = 'America/Detroit';
const hm = (ms: number) => DateTime.fromMillis(ms, { zone: TZ }).toFormat('HH:mm');
const spans = (iv: { start: number; end: number }[]) => iv.map((i) => `${hm(i.start)}-${hm(i.end)}`);

function setup(now = '2026-11-09T13:00:00Z') {
  const ctx = makeCtx(now); // Mon Nov 9 2026, 8:00 AM Detroit
  saveWorkingHoursJson(ctx, routineJson());
  saveClassCalendars(ctx, ['classcal']);
  // class: Mon-Fri 10:00-11:00 (class calendar), except Tue where the first class is 9:00-10:30
  const busy = (from: number, to: number) => {
    const out: { start: number; end: number }[] = [];
    for (let d = DateTime.fromMillis(from, { zone: TZ }).startOf('day'); d.toMillis() < to; d = d.plus({ days: 1 })) {
      if (d.weekday <= 5) {
        const k = d.weekday === 2 ? ['09:00', '10:30'] : ['10:00', '11:00'];
        const at = (h: string) => d.set({ hour: Number(h.slice(0, 2)), minute: Number(h.slice(3)) }).toMillis();
        out.push({ start: at(k[0]), end: at(k[1]) });
      }
    }
    return out;
  };
  const cal = new FakeCalendar({ calendars: [{ id: 'classcal', summary: 'School', busy }] });
  return { ctx, cal };
}

describe('availability seed', () => {
  it('writes dated windows for the next N weeks from the routine and the real class calendar', async () => {
    const { ctx, cal } = setup();
    const r = await seedAvailability(ctx, cal, { weeks: 2 });
    expect(r.datedDays).toBe(14);
    const rows = loadWindows(ctx);
    // Mon Nov 9: first class ends 11:00 -> free 11:00-22:30
    expect(spans(resolveDay(rows, '2026-11-09', TZ).free)).toEqual(['11:00-22:30']);
    // Tue Nov 10: first class ends 10:30; gym 8:30-10:30 is blocked; free 10:30-22:30
    expect(spans(resolveDay(rows, '2026-11-10', TZ).free)).toEqual(['10:30-22:30']);
    // Thu: ends 20:30
    expect(spans(resolveDay(rows, '2026-11-12', TZ).free)).toEqual(['11:00-20:30']);
    // Sat: gym 11-13 leaves 09:00-11:00 and 13:00-20:00
    expect(spans(resolveDay(rows, '2026-11-14', TZ).free)).toEqual(['09:00-11:00', '13:00-20:00']);
    // Sun: 13:00-22:30 minus gym 11-13 (before the start) = 13:00-22:30
    expect(spans(resolveDay(rows, '2026-11-15', TZ).free)).toEqual(['13:00-22:30']);
  });
  it('also writes a weekly template (the most common pattern per weekday) that covers dates beyond the seeded weeks', async () => {
    const { ctx, cal } = setup();
    await seedAvailability(ctx, cal, { weeks: 2 });
    const rows = loadWindows(ctx);
    const far = resolveDay(rows, '2027-01-11', TZ); // a Monday, well past the seeded range
    expect(far.source).toBe('template');
    expect(spans(far.free)).toEqual(['11:00-22:30']);
    expect(spans(resolveDay(rows, '2027-01-12', TZ).free)).toEqual(['10:30-22:30']); // Tuesday template
  });
  it('turns old per-date overrides into blocked windows and unavailable days into all-day blocks', async () => {
    const { ctx, cal } = setup();
    addAwayWindow(ctx, '2026-11-11', '16:00', '18:00', 'before midterm');
    addAway(ctx, '2026-11-13', 'trip');
    await seedAvailability(ctx, cal, { weeks: 2 });
    const rows = loadWindows(ctx);
    const wed = resolveDay(rows, '2026-11-11', TZ).free;
    expect(spans(wed)).toEqual(['11:00-16:00', '18:00-22:30']); // Wed gym 16-17 and the 16-18 override merge
    expect(resolveDay(rows, '2026-11-13', TZ).free).toEqual([]);
    expect(resolveDay(rows, '2026-11-13', TZ).source).toBe('date');
  });
  it('refuses to overwrite existing windows unless asked; --replace overwrites', async () => {
    const { ctx, cal } = setup();
    await seedAvailability(ctx, cal, { weeks: 1 });
    await expect(seedAvailability(ctx, cal, { weeks: 1 })).rejects.toThrow(/already has availability/);
    await expect(seedAvailability(ctx, cal, { weeks: 1, replace: true })).resolves.toBeTruthy();
  });
  it('a weekday with no class falls back to the default start; no class calendar set is reported, not fatal', async () => {
    const { ctx } = setup();
    ctx.db.run("DELETE FROM settings WHERE key = 'class_calendars'");
    const r = await seedAvailability(ctx, new FakeCalendar({ calendars: [] }), { weeks: 1 });
    expect(r.notes.join(' ')).toMatch(/no class calendar/i);
    expect(spans(resolveDay(loadWindows(ctx), '2026-11-09', TZ).free)).toEqual(['09:00-22:30']);
  });
});
