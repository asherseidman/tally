import { describe, it, expect } from 'vitest';
import { parseImportFile } from '../src/import/schema';

const base = () => ({
  term: { name: 'T1', start_date: '2026-08-31', end_date: '2026-12-15' },
  items: [{ course: 'MATH 101', title: 'HW 1', type: 'homework', due_date: '2026-09-06', grade_weight: 1.4 }],
  grading_breakdown: [{ category: 'Homework', percent: 15 }],
});

describe('parseImportFile', () => {
  it('accepts a valid file and applies defaults', () => {
    const r = parseImportFile(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items[0].confidence).toBe('medium');
      expect(r.data.items[0].expanded_from_recurring).toBe(false);
      expect(r.data.items[0].notes).toBeNull();
    }
  });
  it('names the item and field on error', () => {
    const f: any = base();
    f.items.push({ course: 'MATH 101', title: 'Bad one', type: 'homwork', due_date: 'soon' });
    const r = parseImportFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.errors.join('\n');
      expect(text).toContain('items[1]');
      expect(text).toContain('Bad one');
      expect(text).toContain('type');
      expect(text).toContain('due_date');
    }
  });
  it('requires term', () => {
    const f: any = base();
    delete f.term;
    const r = parseImportFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('term');
  });
  it('rejects end before start', () => {
    const f: any = base();
    f.term.end_date = '2026-01-01';
    expect(parseImportFile(f).ok).toBe(false);
  });
  it('rejects out-of-range weights and impossible dates', () => {
    const f: any = base();
    f.items[0].grade_weight = 140;
    f.items.push({ course: 'C', title: 'x', type: 'exam', due_date: '2026-02-31' });
    const r = parseImportFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
  it('rejects duplicate course+title within a file', () => {
    const f: any = base();
    f.items.push({ ...f.items[0] });
    const r = parseImportFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/duplicate/i);
  });
  it('accepts null and missing due_date; non-object input fails readably', () => {
    const f: any = base();
    f.items[0].due_date = null;
    expect(parseImportFile(f).ok).toBe(true);
    const r = parseImportFile('hello');
    expect(r.ok).toBe(false);
  });
  it('breakdown course defaults to the sole course; ambiguous requires course', () => {
    const r = parseImportFile(base());
    if (r.ok) expect(r.data.grading_breakdown[0].course).toBe('MATH 101');
    const f: any = base();
    f.items.push({ course: 'PHYS 101', title: 'x', type: 'exam' });
    expect(parseImportFile(f).ok).toBe(false);
  });
});
