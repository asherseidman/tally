import { z } from 'zod';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be 24-hour HH:mm, like 22:30');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-11-14');

const windowSchema = z
  .object({ start: HHMM, end: HHMM, label: z.string().optional() })
  .refine((w) => w.end > w.start, { message: 'end must be after start' });

const START_RE = /^(([01]\d|2[0-3]):[0-5]\d|after_first_class)$/;
const startSchema = z.string().regex(START_RE, 'must be 24-hour HH:mm, or "after_first_class" (the old name "after_last_class" was renamed)');

const daySchema = z
  .object({
    /** "HH:mm", or "after_first_class" (earliest start = end of that day's FIRST class). Omitted = default_start. */
    start: startSchema.optional(),
    end: HHMM,
    /** fixed windows when no work is scheduled (gym, etc.) */
    unavailable: z.array(windowSchema).default([]),
  })
  .superRefine((d, ctx) => {
    if (d.start && d.start !== 'after_first_class' && d.end <= d.start) ctx.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' });
  });

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

const workingHoursSchema = z
  .object({
    min_block_minutes: z.number().int().min(5).max(240).default(25),
    max_block_minutes: z.number().int().min(15).max(480).default(120),
    buffer_minutes: z.number().int().min(0).max(120).default(10),
    /** work is planned to finish this long before the due time */
    deadline_slack_minutes: z.number().int().min(0).max(1440).default(120),
    /** busy blocks shorter than this are never a "class" (they still block the time) */
    min_class_minutes: z.number().int().min(0).max(240).default(45),
    /** nothing is scheduled sooner than this many minutes from now */
    min_lead_minutes: z.number().int().min(0).max(720).default(30),
    /** tasks of at least this many minutes (0 = off) never get a block shorter than long_task_min_block_minutes */
    long_task_minutes: z.number().int().min(0).max(1440).default(60),
    long_task_min_block_minutes: z.number().int().min(5).max(240).default(30),
    /** tasks of at least this many minutes (0 = off) are spread over days: at most spread_daily_max_minutes per day,
     *  and the last block ends at least spread_days_before_deadline days before the deadline */
    spread_threshold_minutes: z.number().int().min(0).max(5000).default(240),
    spread_daily_max_minutes: z.number().int().min(15).max(480).default(120),
    spread_days_before_deadline: z.number().int().min(0).max(7).default(1),
    /** exam prep (exam-type tasks big enough to spread): last block may end this long before the exam starts ... */
    exam_prep_end_before_minutes: z.number().int().min(0).max(1440).default(120),
    /** ... and at most this many minutes of that exam's prep are placed per day */
    exam_prep_daily_max_minutes: z.number().int().min(15).max(480).default(180),
    /** exam-type tasks with a real time are blocked for this long from that time (0 = off) */
    exam_duration_minutes: z.number().int().min(0).max(480).default(120),
    /** busy blocks at least this long (all-day events) are ignored instead of blanking the day (0 = off) */
    ignore_busy_at_least_hours: z.number().int().min(0).max(48).default(20),
    default_start: HHMM.default('09:00'),
    /** busy blocks that start at/after this time are not "classes" for the after_first_class rule */
    class_cutoff: HHMM.default('18:00'),
    days: z.object({ mon: daySchema, tue: daySchema, wed: daySchema, thu: daySchema, fri: daySchema, sat: daySchema, sun: daySchema }),
  })
  .superRefine((h, ctx) => {
    if (h.long_task_min_block_minutes > h.max_block_minutes) ctx.addIssue({ code: 'custom', path: ['long_task_min_block_minutes'], message: 'must not exceed max_block_minutes' });
    if (h.min_block_minutes > h.max_block_minutes) ctx.addIssue({ code: 'custom', path: ['min_block_minutes'], message: 'min_block_minutes must not exceed max_block_minutes' });
  });

export type WorkingHours = z.infer<typeof workingHoursSchema>;
export type DayHours = WorkingHours['days'][DayKey];

const overrideSchema = z.object({
  unavailable: z.boolean().optional(),
  label: z.string().optional(),
  start: startSchema.optional(),
  end: HHMM.optional(),
  unavailable_windows: z.array(windowSchema).default([]),
});
const overridesSchema = z.record(DATE, overrideSchema);
export type DayOverride = z.infer<typeof overrideSchema>;
export type Overrides = Record<string, DayOverride>;

export type Parsed<T> = { ok: true; data: T } | { ok: false; errors: string[] };

function pathText(path: PropertyKey[]): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i ? `.${String(p)}` : String(p))).join('') || '(root)';
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): Parsed<T> {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${pathText(i.path)}: ${i.message}`) };
}

export const parseWorkingHours = (raw: unknown): Parsed<WorkingHours> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? parseWith(workingHoursSchema, raw) : { ok: false, errors: ['working hours must be a JSON object'] };

export const parseOverrides = (raw: unknown): Parsed<Overrides> => parseWith(overridesSchema, raw) as Parsed<Overrides>;

const everyDay = (h: string) => ({ end: h, unavailable: [] });

/** Used when the user has not configured working hours: 9 AM-9 PM every day, no class rule. */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  min_block_minutes: 25,
  max_block_minutes: 120,
  buffer_minutes: 10,
  deadline_slack_minutes: 120,
  min_class_minutes: 45,
  min_lead_minutes: 30,
  long_task_minutes: 60,
  long_task_min_block_minutes: 30,
  spread_threshold_minutes: 240,
  spread_daily_max_minutes: 120,
  spread_days_before_deadline: 1,
  exam_prep_end_before_minutes: 120,
  exam_prep_daily_max_minutes: 180,
  exam_duration_minutes: 120,
  ignore_busy_at_least_hours: 20,
  default_start: '09:00',
  class_cutoff: '18:00',
  days: Object.fromEntries(DAY_KEYS.map((k) => [k, everyDay('21:00')])) as unknown as WorkingHours['days'],
};

export const dayKeys = DAY_KEYS;

/** Global hours with an optional per-term override merged on top (top-level keys and per-day entries). */
export function resolveWorkingHours(global: WorkingHours, override: any | undefined): WorkingHours {
  if (!override) return global;
  const days: Record<string, unknown> = {};
  for (const k of DAY_KEYS) days[k] = { ...global.days[k], ...(override.days?.[k] ?? {}) };
  const merged = { ...global, ...override, days };
  const r = parseWorkingHours(merged);
  if (!r.ok) throw new Error(`Invalid working hours after applying the term override: ${r.errors.join('; ')}`);
  return r.data;
}

/** Saved settings from before the rename: the rule "after_last_class" is now "after_first_class". */
export function migrateLegacyHours<T>(raw: T): { data: T; changed: boolean } {
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (v === 'after_last_class') {
      changed = true;
      return 'after_first_class';
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const data = walk(raw) as T;
  return { data: changed ? data : raw, changed };
}
