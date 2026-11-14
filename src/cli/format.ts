import type { Ctx } from '../core/ctx';
import type { Task } from '../core/tasks';
import { formatLocal } from '../time';
import { describeRule, deserializeRule } from '../core/recurrence';

export function taskLine(ctx: Ctx, t: Task, names: { terms: Map<number, string>; lists: Map<number, string> }): string {
  const mark = t.status === 'done' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
  const bits = [t.type];
  if (t.estimated_minutes) bits.push(`~${t.estimated_minutes}m`);
  if (t.size_unit) bits.push(`${t.size_amount ?? '?'} ${t.size_unit}`);
  if (t.optional) bits.push('optional');
  if (t.deadline_only) bits.push('deadline only');
  if (t.available_from) bits.push(`from ${t.available_from}`);
  if (t.actual_minutes) bits.push(`${t.actual_minutes}m spent`);
  if (t.grade_weight != null) bits.push(`${t.grade_weight}%`);
  if (t.list_id && names.lists.get(t.list_id)) bits.push(`list: ${names.lists.get(t.list_id)}`);
  if (t.recurrence_rule) bits.push(`repeats ${describeRule(deserializeRule(t.recurrence_rule))}`);
  const course = t.course ? `${t.course} · ` : '';
  return `#${String(t.id).padEnd(4)} ${mark} ${formatLocal(t.due_date, ctx.tz, !!t.time_assumed).padEnd(24)} ${course}${t.title}  (${bits.join(', ')})`;
}

export function nameMaps(ctx: Ctx) {
  return {
    terms: new Map(ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM terms').map((r) => [r.id, r.name])),
    lists: new Map(ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM lists').map((r) => [r.id, r.name])),
  };
}
