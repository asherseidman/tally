import { describe, it, expect } from 'vitest';
import { groupTasks } from '../src/core/grouping';
import type { Task } from '../src/core/tasks';

const TZ = 'America/Detroit';
// Sun Nov 8 2026, 10:30 PM EST
const NOW = new Date('2026-11-09T03:30:00Z');
const t = (id: number, due: string | null, status = 'todo') => ({ id, due_date: due, status, title: `t${id}` }) as Task;
const ids = (g: ReturnType<typeof groupTasks>, key: string) => g.find((x) => x.key === key)?.tasks.map((x) => x.id);

describe('groupTasks', () => {
  it('splits into overdue / today / upcoming / no date, in that order', () => {
    const g = groupTasks(
      [t(1, null), t(2, '2026-11-12T15:00:00Z'), t(3, '2026-11-09T04:59:00Z'), t(4, '2026-11-08T12:00:00Z')],
      NOW, TZ,
    );
    expect(g.map((x) => x.key)).toEqual(['overdue', 'today', 'upcoming', 'no_date']);
    expect(ids(g, 'overdue')).toEqual([4]);
    expect(ids(g, 'today')).toEqual([3]);
    expect(ids(g, 'upcoming')).toEqual([2]);
    expect(ids(g, 'no_date')).toEqual([1]);
  });
  it('"today" is the LOCAL day: 11:59 PM tonight is today, local midnight is upcoming', () => {
    const g = groupTasks([t(1, '2026-11-09T04:59:59Z'), t(2, '2026-11-09T05:00:00Z')], NOW, TZ);
    expect(ids(g, 'today')).toEqual([1]);
    expect(ids(g, 'upcoming')).toEqual([2]);
  });
  it('earlier today but already past is overdue', () => {
    const g = groupTasks([t(1, '2026-11-08T14:00:00Z')], NOW, TZ); // 9 AM today, it is 10:30 PM
    expect(ids(g, 'overdue')).toEqual([1]);
  });
  it('local day boundary respects DST (fall-back day is 25h)', () => {
    const now = new Date('2026-11-01T12:00:00Z'); // Nov 1 7 AM EST, after the fall-back
    const g = groupTasks([t(1, '2026-11-02T04:59:00Z'), t(2, '2026-11-02T05:00:00Z')], now, TZ);
    expect(ids(g, 'today')).toEqual([1]);
    expect(ids(g, 'upcoming')).toEqual([2]);
  });
  it('done tasks go in a final group, never overdue', () => {
    const g = groupTasks([t(1, '2026-10-01T00:00:00Z', 'done'), t(2, '2026-11-12T15:00:00Z')], NOW, TZ);
    expect(g.map((x) => x.key)).toEqual(['upcoming', 'done']);
  });
  it('omits empty groups and keeps due-date order inside a group', () => {
    const g = groupTasks([t(1, '2026-11-01T00:00:00Z'), t(2, '2026-10-01T00:00:00Z')], NOW, TZ);
    expect(g.map((x) => x.key)).toEqual(['overdue']);
    expect(ids(g, 'overdue')).toEqual([2, 1]);
  });
  it('empty input gives no groups', () => {
    expect(groupTasks([], NOW, TZ)).toEqual([]);
  });
});
