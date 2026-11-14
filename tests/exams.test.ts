import { describe, it, expect } from 'vitest';
import { examBusyIntervals, type ExamSource } from '../src/schedule/exams';
import { parseWorkingHours } from '../src/schedule/workingHours';
import { loc, fmt, routineJson } from './helpers';

const exam = (o: Partial<ExamSource> = {}): ExamSource => ({
  id: 1, title: 'Exam', type: 'exam', due_date: new Date(loc('2026-11-11T20:00')).toISOString(), time_assumed: 0, status: 'todo', deleted_at: null, ...o,
});
const spans = (xs: { start: number; end: number }[]) => xs.map((x) => `${fmt(x.start)}..${fmt(x.end)}`);

describe('examBusyIntervals', () => {
  it('an exam with a real time blocks 2 hours from that time, plus the buffer after it', () => {
    expect(spans(examBusyIntervals([exam()], 120, 10).busy)).toEqual(['2026-11-11T20:00..2026-11-11T22:10']);
  });
  it('reports the exam window itself (without the buffer) for display', () => {
    const r = examBusyIntervals([exam()], 120, 10);
    expect(spans(r.windows.map((w) => ({ start: w.start, end: w.end })))).toEqual(['2026-11-11T20:00..2026-11-11T22:00']);
    expect(r.windows[0].taskId).toBe(1);
  });
  it('ignores exams whose time was only assumed (a date with no stated time)', () => {
    expect(examBusyIntervals([exam({ time_assumed: 1 })], 120, 10).busy).toEqual([]);
  });
  it('ignores other task types, done and deleted exams, and exams without a date', () => {
    expect(examBusyIntervals([exam({ type: 'quiz' }), exam({ type: 'homework' }), exam({ status: 'done' }), exam({ deleted_at: 'x' }), exam({ due_date: null })], 120, 10).busy).toEqual([]);
  });
  it('duration is configurable and 0 turns the rule off', () => {
    expect(spans(examBusyIntervals([exam()], 90, 0).busy)).toEqual(['2026-11-11T20:00..2026-11-11T21:30']);
    expect(examBusyIntervals([exam()], 0, 10).busy).toEqual([]);
  });
  it('handles several exams', () => {
    const r = examBusyIntervals([exam({ id: 1 }), exam({ id: 2, due_date: new Date(loc('2026-11-09T18:00')).toISOString() })], 120, 10);
    expect(r.busy).toHaveLength(2);
    expect(r.windows.map((w) => w.taskId).sort()).toEqual([1, 2]);
  });
});

describe('exam duration setting', () => {
  it('defaults to 120 minutes and is validated', () => {
    expect((parseWorkingHours(routineJson()) as any).data.exam_duration_minutes).toBe(120);
    const bad = routineJson();
    bad.exam_duration_minutes = 1000;
    expect(parseWorkingHours(bad).ok).toBe(false);
    bad.exam_duration_minutes = 0;
    expect(parseWorkingHours(bad).ok).toBe(true);
  });
});
