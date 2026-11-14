import type { Ctx } from './ctx';
import { listTasks, type Task } from './tasks';
import { effectiveEstimate, loadLearnedRates, loadRates } from './size';

export interface EstimateDiffRow {
  task: Task;
  /** the estimate the scheduler uses today (null = none), and where it comes from */
  current: number | null;
  currentSource: string | null;
  sizeBased: number;
  formula: string;
}

/** Open tasks whose size-based estimate differs from what they have now (a manual estimate, or none). Nothing is changed. */
export function estimateDiff(ctx: Ctx): EstimateDiffRow[] {
  const { all } = loadRates(ctx);
  const learned = loadLearnedRates(ctx, all);
  const rows: EstimateDiffRow[] = [];
  for (const t of listTasks(ctx, { status: 'open' })) {
    const e = effectiveEstimate(t, all, learned);
    if (!e.size) continue;
    if (e.source === 'size' && t.estimate_source === 'size' && t.estimated_minutes === e.size.minutes) continue;
    if (e.source === 'manual' && e.minutes === e.size.minutes) continue;
    rows.push({ task: t, current: e.source === 'manual' ? e.minutes : null, currentSource: e.source === 'manual' ? (t.estimate_source ?? 'manual') : null, sizeBased: e.size.minutes, formula: e.size.formula });
  }
  return rows;
}
