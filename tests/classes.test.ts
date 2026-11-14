import { describe, it, expect } from 'vitest';
import { buildClassReport, formatClassReport } from '../src/schedule/classes';
import { parseWorkingHours } from '../src/schedule/workingHours';
import { routineJson, iv, loc, TZ } from './helpers';

const hours = (parseWorkingHours(routineJson()) as any).data;

describe('class report', () => {
  const busy = [
    iv('2026-11-10T08:30', '2026-11-10T10:30'), // Tue gym
    iv('2026-11-10T11:30', '2026-11-10T14:30'), // Tue class
    iv('2026-11-10T17:00', '2026-11-10T17:30'), // 30 min
    iv('2026-11-14T10:00', '2026-11-14T11:00'), // Saturday: rule not used
  ];
  const r = buildClassReport(busy, loc('2026-11-09T00:00'), loc('2026-11-16T00:00'), TZ, hours, {});
  it('lists the first class per class-rule day, ignoring gym and short blocks, with reasons', () => {
    const tue = r.days.find((d) => d.date === '2026-11-10')!;
    expect(tue.usesRule).toBe(true);
    expect(tue.first).toEqual(iv('2026-11-10T11:30', '2026-11-10T14:30'));
    expect(tue.ignored.map((i) => i.reason).join('|')).toMatch(/fixed|gym/i);
    expect(tue.ignored.map((i) => i.reason).join('|')).toMatch(/shorter than 45/);
  });
  it('days without a class fall back to the default start; weekend days do not use the rule', () => {
    expect(r.days.find((d) => d.date === '2026-11-09')!.first).toBeUndefined();
    expect(r.days.find((d) => d.date === '2026-11-14')!.usesRule).toBe(false);
  });
  it('formats plainly', () => {
    const text = formatClassReport(r, TZ);
    expect(text).toMatch(/Tue Nov 10\s+FIRST CLASS 11:30 AM–2:30 PM/);
    expect(text).toMatch(/Mon Nov 9\s+no class/);
    expect(text).toMatch(/ignored.*8:30–10:30 AM.*fixed/s);
    expect(text).toMatch(/Sat Nov 14\s+\(class rule not used\)/);
  });
});
