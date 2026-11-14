import type { Ctx } from './ctx';
import { loadOverrides, groupKeyOf, groupMultiplierTable, loadMultiplierOff } from './rateGroups';

export interface MultiplierEntry {
  multiplier: number;
  samples: number;
}
export type MultiplierTable = Map<string, MultiplierEntry>;

export interface LearningRow {
  type: string;
  estimated_minutes: number | null;
  actual_minutes: number | null;
}

export const MIN_SAMPLES = 3;

/** Per task type: total actual minutes / total estimated minutes. Plain ratios, no ML. */
export function computeMultipliers(rows: LearningRow[]): MultiplierTable {
  const acc = new Map<string, { est: number; act: number; n: number }>();
  for (const r of rows) {
    if (!r.estimated_minutes || !r.actual_minutes || r.estimated_minutes <= 0 || r.actual_minutes <= 0) continue;
    const a = acc.get(r.type) ?? { est: 0, act: 0, n: 0 };
    a.est += r.estimated_minutes;
    a.act += r.actual_minutes;
    a.n++;
    acc.set(r.type, a);
  }
  const out: MultiplierTable = new Map();
  for (const [type, a] of acc) out.set(type, { multiplier: Math.round((a.act / a.est) * 1000) / 1000, samples: a.n });
  return out;
}

export interface Applied {
  minutes: number;
  applied: boolean;
  multiplier: number | null;
  samples: number;
}

/** Scale an estimate by the learned multiplier, but only once there are `minSamples` samples. */
export function applyMultiplier(estimate: number, type: string, table: MultiplierTable, minSamples = MIN_SAMPLES): Applied {
  const e = table.get(type);
  if (!e) return { minutes: estimate, applied: false, multiplier: null, samples: 0 };
  if (e.samples < minSamples) return { minutes: estimate, applied: false, multiplier: e.multiplier, samples: e.samples };
  return { minutes: Math.round(estimate * e.multiplier), applied: true, multiplier: e.multiplier, samples: e.samples };
}

/**
 * Loads history across ALL terms (archived included). Learned estimates are excluded so a
 * multiplier is never learned from an estimate that was itself already multiplied.
 */
export function loadMultipliers(ctx: Ctx): MultiplierTable {
  const rows = ctx.db.all<LearningRow>(
    `SELECT type, estimated_minutes, actual_minutes FROM tasks
     WHERE status = 'done' AND deleted_at IS NULL AND estimated_minutes > 0 AND actual_minutes > 0
       AND (estimate_source IS NULL OR estimate_source IN ('manual','imported'))`,
  );
  return computeMultipliers(rows);
}

export interface LearnedApplied extends Applied {
  /** where the multiplier came from: this assignment group, the task type, or nowhere */
  scope: 'group' | 'type' | 'none';
}

/**
 * Learning, most specific first: this task's assignment group (course + title stem + unit) once it has MIN_SAMPLES finished timed tasks,
 * else the task type, else none. A group whose multiplier was switched off gets none at all. Size-based estimates never come here
 * (the caller skips them), as before.
 */
export function buildLearning(ctx: Ctx): { apply(minutes: number, t: { id?: number; course: string | null; title: string; type: string; size_unit: string | null }): LearnedApplied } {
  const types = loadMultipliers(ctx);
  const groups = groupMultiplierTable(ctx);
  const off = loadMultiplierOff(ctx);
  const ov = loadOverrides(ctx);
  return {
    apply(minutes, t) {
      const gk = groupKeyOf(t, ov);
      if (off.has(gk)) return { minutes, applied: false, multiplier: null, samples: 0, scope: 'none' };
      const g = groups.get(`${gk}|${t.size_unit ?? ''}`);
      if (g && g.samples >= MIN_SAMPLES) return { minutes: Math.round(minutes * g.multiplier), applied: true, multiplier: g.multiplier, samples: g.samples, scope: 'group' };
      const a = applyMultiplier(minutes, t.type, types);
      return { ...a, scope: a.applied ? 'type' : 'none' };
    },
  };
}
