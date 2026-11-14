import { describe, it, expect } from 'vitest';
import { ReviewSession } from '../src/import/review';
import type { Candidate } from '../src/import/diff';

const c = (title: string, due: string | null, o: Partial<Candidate> = {}): Candidate => ({
  import_key: title, course: 'C', title, type: 'homework', due_date: due, time_assumed: false,
  grade_weight: null, notes: null, source_quote: null, estimated_minutes: null, size_amount: null, size_unit: null, available_from: null, optional: false, confidence: 'medium', expanded_from_recurring: false, ...o,
});
const mk = () => new ReviewSession([c('B', '2026-09-10T00:00:00.000Z'), c('A', '2026-09-01T00:00:00.000Z'), c('N', null)], [], 'America/Detroit', '23:59');

describe('ReviewSession', () => {
  it('numbers by date, undated last', () => {
    expect(mk().entries().map((e) => e.candidate.title)).toEqual(['A', 'B', 'N']);
  });
  it('drop excludes from plan; restore re-includes', () => {
    const s = mk();
    s.drop(1);
    expect(s.plan().new.map((x) => x.title)).toEqual(['B', 'N']);
    s.restore(1);
    expect(s.plan().new).toHaveLength(3);
  });
  it('edit changes fields but never the import key', () => {
    const s = mk();
    s.edit(1, 'title', 'Renamed');
    s.edit(1, 'due', '2026-09-02');
    const e = s.plan().new.find((x) => x.import_key === 'A')!;
    expect(e.title).toBe('Renamed');
    expect(e.time_assumed).toBe(true);
  });
  it('rejects bad edits', () => {
    const s = mk();
    expect(() => s.edit(1, 'due', 'someday')).toThrow();
    expect(() => s.edit(1, 'weight', '500')).toThrow();
    expect(() => s.edit(1, 'type', 'nope')).toThrow();
    expect(() => s.edit(9, 'title', 'x')).toThrow(/No item/);
  });
  it('renders without throwing and flags low confidence', () => {
    const s = new ReviewSession([c('L', '2026-09-01T00:00:00.000Z', { confidence: 'low', source_quote: 'q' })], [], 'America/Detroit', '23:59');
    expect(s.render(false)).toContain('LOW CONFIDENCE');
  });
});
