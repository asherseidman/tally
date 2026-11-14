import type { Interval } from './types';

export interface ExamSource {
  id: number;
  title: string;
  course?: string | null;
  type: string;
  due_date: string | null;
  time_assumed: number;
  status: string;
  deleted_at: string | null;
}

export interface ExamWindow {
  taskId: number;
  title: string;
  course?: string | null;
  start: number;
  /** end of the exam itself (start + duration), without the buffer */
  end: number;
}

/**
 * Exam-type tasks with a real (stated, not assumed) time are fixed events: busy for `durationMin`
 * from that time, plus `bufferMin` afterwards, so no work is scheduled during or right after.
 * A duration of 0 turns the rule off.
 */
export function examBusyIntervals(tasks: ExamSource[], durationMin: number, bufferMin: number): { busy: Interval[]; windows: ExamWindow[] } {
  const busy: Interval[] = [];
  const windows: ExamWindow[] = [];
  if (durationMin <= 0) return { busy, windows };
  for (const t of tasks) {
    if (t.type !== 'exam' || !t.due_date || t.time_assumed || t.status === 'done' || t.deleted_at) continue;
    const start = new Date(t.due_date).getTime();
    const end = start + durationMin * 60_000;
    windows.push({ taskId: t.id, title: t.title, course: t.course, start, end });
    busy.push({ start, end: end + bufferMin * 60_000 });
  }
  return { busy, windows };
}
