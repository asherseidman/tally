import type { Ctx } from '../core/ctx';
import { getSetting } from '../db/repo';
import type { WorkingHours } from './workingHours';

export type PlacementStyle = 'early' | 'late';

export interface PlacementSettings {
  placement_style: PlacementStyle;
  /** a task becomes eligible this many days before its deadline (big tasks: more, see leadDays) */
  early_lead_days: number;
  /** early placement: work finishes at least this many minutes before the deadline */
  finish_before_deadline_minutes: number;
  /** early placement: soft cap on scheduled work per local day */
  max_daily_work_minutes: number;
  include_optional_tasks: boolean;
}

export const DEFAULT_PLACEMENT: PlacementSettings = {
  placement_style: 'early',
  early_lead_days: 3,
  finish_before_deadline_minutes: 240,
  max_daily_work_minutes: 300,
  include_optional_tasks: false,
};

/** Numeric scheduling knobs. They are plain settings now (config set <key> <n>); the old working_hours JSON is only a fallback. */
export const NUMERIC_KEYS = [
  'min_block_minutes', 'max_block_minutes', 'buffer_minutes', 'deadline_slack_minutes', 'min_lead_minutes',
  'long_task_minutes', 'long_task_min_block_minutes', 'spread_threshold_minutes', 'spread_daily_max_minutes',
  'spread_days_before_deadline', 'exam_prep_end_before_minutes', 'exam_prep_daily_max_minutes', 'exam_duration_minutes',
  'ignore_busy_at_least_hours', 'early_lead_days', 'finish_before_deadline_minutes', 'max_daily_work_minutes',
] as const;
export type NumericKey = (typeof NUMERIC_KEYS)[number];
export const SCHEDULE_KEYS: string[] = [...NUMERIC_KEYS, 'placement_style', 'include_optional_tasks'];

/** Validate a value for `config set`; returns the text to store. Throws a readable message. */
export function checkScheduleSetting(key: string, value: string): string {
  if (key === 'placement_style') {
    if (value !== 'early' && value !== 'late') throw new Error('placement_style must be "early" or "late".');
    return value;
  }
  if (key === 'include_optional_tasks') {
    if (!/^(true|false|yes|no|on|off)$/i.test(value)) throw new Error('include_optional_tasks must be true or false.');
    return /^(true|yes|on)$/i.test(value) ? 'true' : 'false';
  }
  const n = Number(value);
  const min = key === 'min_block_minutes' || key === 'max_block_minutes' || key === 'long_task_min_block_minutes' ? 5 : 0;
  if (!Number.isInteger(n) || n < min || n > 100_000) throw new Error(`${key} must be a whole number${min ? ` of at least ${min}` : ''}.`);
  return String(n);
}

export interface ScheduleSettings {
  /** the legacy hours with every numeric knob overlaid by its plain setting, when one is set */
  hours: WorkingHours;
  placement: PlacementSettings;
}

export function loadScheduleSettings(ctx: Ctx, legacy: WorkingHours): ScheduleSettings {
  const hours: Record<string, unknown> = { ...legacy };
  const placement: Record<string, unknown> = { ...DEFAULT_PLACEMENT };
  for (const key of NUMERIC_KEYS) {
    const raw = getSetting(ctx.db, key);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Setting "${key}" is not a number (${raw}). Fix it with: config set ${key} <n>`);
    if (key in DEFAULT_PLACEMENT) placement[key] = n;
    else hours[key] = n;
  }
  const style = getSetting(ctx.db, 'placement_style');
  if (style !== undefined) {
    if (style !== 'early' && style !== 'late') throw new Error(`Setting "placement_style" is "${style}"; it must be early or late.`);
    placement.placement_style = style;
  }
  const opt = getSetting(ctx.db, 'include_optional_tasks');
  if (opt !== undefined) placement.include_optional_tasks = opt === 'true';
  return { hours: hours as unknown as WorkingHours, placement: placement as unknown as PlacementSettings };
}
