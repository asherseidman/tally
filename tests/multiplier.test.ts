import { describe, it, expect } from 'vitest';
import { computeMultipliers, applyMultiplier } from '../src/core/learning';

const row = (type: string, est: number, actual: number) => ({ type, estimated_minutes: est, actual_minutes: actual });

describe('multipliers', () => {
  it('ratio of total actual to total estimated per type', () => {
    const m = computeMultipliers([row('homework', 60, 90), row('homework', 30, 45), row('homework', 30, 45), row('exam', 100, 50)]);
    expect(m.get('homework')).toEqual({ multiplier: 1.5, samples: 3 });
    expect(m.get('exam')).toEqual({ multiplier: 0.5, samples: 1 });
  });
  it('ignores rows missing or non-positive estimate/actual', () => {
    const m = computeMultipliers([row('quiz', 0, 10), row('quiz', 10, 0), { type: 'quiz', estimated_minutes: null, actual_minutes: 5 }, row('quiz', 10, 20)]);
    expect(m.get('quiz')).toEqual({ multiplier: 2, samples: 1 });
  });
  it('applies only with at least 3 samples', () => {
    const two = computeMultipliers([row('homework', 60, 90), row('homework', 60, 90)]);
    expect(applyMultiplier(60, 'homework', two)).toEqual({ minutes: 60, applied: false, multiplier: 1.5, samples: 2 });
    const three = computeMultipliers([row('homework', 60, 90), row('homework', 60, 90), row('homework', 60, 90)]);
    expect(applyMultiplier(60, 'homework', three)).toEqual({ minutes: 90, applied: true, multiplier: 1.5, samples: 3 });
  });
  it('rounds, and unknown type is unchanged', () => {
    const t = computeMultipliers([row('a', 10, 14), row('a', 10, 14), row('a', 10, 14)]);
    expect(applyMultiplier(7, 'a', t).minutes).toBe(10); // 9.8
    expect(applyMultiplier(7, 'zzz', t)).toEqual({ minutes: 7, applied: false, multiplier: null, samples: 0 });
  });
  it('minSamples is configurable', () => {
    const t = computeMultipliers([row('a', 10, 20)]);
    expect(applyMultiplier(10, 'a', t, 1).minutes).toBe(20);
  });
});
