import { DateTime } from 'luxon';
import type { Task } from './tasks';

export type GroupKey = 'overdue' | 'today' | 'upcoming' | 'no_date' | 'done';
export interface TaskGroup {
  key: GroupKey;
  label: string;
  tasks: Task[];
}

const ORDER: [GroupKey, string][] = [
  ['overdue', 'OVERDUE'],
  ['today', 'TODAY'],
  ['upcoming', 'UPCOMING'],
  ['no_date', 'NO DUE DATE'],
  ['done', 'DONE'],
];

/**
 * Daily-view grouping. Overdue = due before now; today = due from now to the end of the LOCAL day;
 * upcoming = after that. Done tasks are never overdue. Empty groups are omitted; tasks within a
 * group are ordered by due date (then id).
 */
export function groupTasks(tasks: Task[], now: Date, tz: string): TaskGroup[] {
  const endOfToday = DateTime.fromJSDate(now, { zone: tz }).endOf('day').toMillis();
  const buckets = new Map<GroupKey, Task[]>(ORDER.map(([k]) => [k, []]));
  for (const t of tasks) {
    let key: GroupKey;
    if (t.status === 'done') key = 'done';
    else if (!t.due_date) key = 'no_date';
    else {
      const due = new Date(t.due_date).getTime();
      key = due < now.getTime() ? 'overdue' : due <= endOfToday ? 'today' : 'upcoming';
    }
    buckets.get(key)!.push(t);
  }
  const byDue = (a: Task, b: Task) => (a.due_date ?? '9').localeCompare(b.due_date ?? '9') || a.id - b.id;
  return ORDER.filter(([k]) => buckets.get(k)!.length).map(([key, label]) => ({ key, label, tasks: buckets.get(key)!.sort(byDue) }));
}
