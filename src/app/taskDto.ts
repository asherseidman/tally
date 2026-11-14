import type { Ctx } from '../core/ctx';
import type { Task } from '../core/tasks';
import { effectiveEstimate, loadLearnedRates, loadRates, explainEstimate } from '../core/size';
import { openBlockerMap } from '../core/dependencies';
import { formatLocal } from '../time';
import { describeRule, deserializeRule } from '../core/recurrence';

/** A task as the UI sees it: everything it displays, already formatted, so the renderer has no logic to get wrong. */
export interface TaskDto {
  id: number;
  title: string;
  notes: string | null;
  course: string | null;
  type: string;
  status: 'todo' | 'in_progress' | 'done';
  deleted: boolean;
  /** ISO UTC or null */
  due: string | null;
  /** "Thu Nov 12 2026 11:59 PM" */
  dueText: string;
  timeAssumed: boolean;
  gradeWeight: number | null;
  /** minutes used by the scheduler (manual or size-based), null = none */
  estimate: number | null;
  estimateSource: 'manual' | 'size' | null;
  /** how the estimate was made, e.g. "5 problems x 15 min = 75 min (default rate)" */
  estimateNote: string | null;
  /** which rate rule produced the estimate ("why this estimate"), or null when there is no size */
  estimateWhy: string | null;
  sizeAmount: number | null;
  sizeUnit: string | null;
  actualMinutes: number;
  availableFrom: string | null;
  optional: boolean;
  deadlineOnly: boolean;
  repeat: string | null;
  listId: number | null;
  listName: string | null;
  termId: number | null;
  termName: string | null;
  parentId: number | null;
  blockedBy: { id: number; title: string }[];
  source: string;
  sourceQuote: string | null;
  confidence: string | null;
  createdAt: string;
  /** changes whenever the task is edited; the Claude connector uses it to refuse an edit made from a stale read */
  updatedAt: string;
  completedAt: string | null;
}

export function makeDtoBuilder(ctx: Ctx): (t: Task) => TaskDto {
  const { user, all } = loadRates(ctx);
  const learned = loadLearnedRates(ctx, all);
  const lists = new Map(ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM lists').map((l) => [l.id, l.name]));
  const terms = new Map(ctx.db.all<{ id: number; name: string }>('SELECT id, name FROM terms').map((l) => [l.id, l.name]));
  const blockers = openBlockerMap(ctx);
  return (t) => {
    const e = effectiveEstimate(t, all, learned);
    return {
      id: t.id, title: t.title, notes: t.notes, course: t.course, type: t.type, status: t.status as TaskDto['status'], deleted: !!t.deleted_at,
      due: t.due_date, dueText: t.due_date ? formatLocal(t.due_date, ctx.tz) : '', timeAssumed: !!t.time_assumed, gradeWeight: t.grade_weight,
      estimate: e.minutes, estimateSource: e.source,
      estimateWhy: explainEstimate(t, all, user.length, learned),
      estimateNote: e.source === 'size' ? e.formula ?? null : e.source === 'manual' && e.size ? `Size-based would be ${e.size.formula}` : null,
      sizeAmount: t.size_amount, sizeUnit: t.size_unit, actualMinutes: t.actual_minutes ?? 0,
      availableFrom: t.available_from, optional: !!t.optional, deadlineOnly: !!t.deadline_only,
      repeat: t.recurrence_rule ? describeRule(deserializeRule(t.recurrence_rule)) : null,
      listId: t.list_id, listName: t.list_id ? lists.get(t.list_id) ?? null : null,
      termId: t.term_id, termName: t.term_id ? terms.get(t.term_id) ?? null : null, parentId: t.parent_task_id,
      blockedBy: (blockers.get(t.id) ?? []).map((b) => ({ id: b.id, title: b.title })),
      source: t.source, sourceQuote: t.source_quote, confidence: t.confidence, createdAt: t.created_at, updatedAt: t.updated_at, completedAt: t.completed_at,
    };
  };
}
