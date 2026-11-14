import { z } from 'zod';
import { DateTime } from 'luxon';
import { SIZE_UNITS } from '../core/size';

const isoDateOnly = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid, {
  message: 'must be a real calendar date like 2026-09-06',
});

const dueDate = z
  .string()
  .refine(
    (s) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s) && DateTime.fromISO(s, { setZone: true }).isValid,
    { message: 'must be ISO 8601: 2026-09-06 or 2026-09-06T17:00:00 (optionally with offset), or null' },
  )
  .nullable()
  .default(null);

const pct = z.number().min(0).max(100);

const item = z.object({
  course: z.string().trim().min(1),
  title: z.string().trim().min(1),
  type: z.enum(['homework', 'project', 'exam', 'quiz', 'reading', 'attendance', 'other']),
  due_date: dueDate,
  grade_weight: pct.nullable().default(null),
  notes: z.string().nullable().default(null),
  source_quote: z.string().nullable().default(null),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
  expanded_from_recurring: z.boolean().default(false),
  estimated_minutes: z.number().int().positive().nullable().default(null),
  size: z
    .object({ amount: z.number().positive().nullable().default(null), unit: z.enum(SIZE_UNITS) })
    .nullable()
    .default(null),
  available_from: isoDateOnly.nullable().default(null),
  optional: z.boolean().default(false),
  /** an event or deadline to show, not work to schedule */
  deadline_only: z.boolean().default(false),
});

const step = z.object({
  title: z.string().trim().min(1),
  estimated_minutes: z.number().int().positive(),
  due_date: dueDate,
  /** 0-based positions of other steps in this plan that must be finished first */
  depends_on: z.array(z.number().int().min(0)).default([]),
});

const plan = z.object({
  parent: z.object({ course: z.string().trim().min(1), title: z.string().trim().min(1) }),
  steps: z.array(step).min(1),
});

const breakdown = z.object({
  course: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1),
  percent: pct,
});

const fileSchema = z.object({
  term: z.object({
    name: z.string().trim().min(1),
    start_date: isoDateOnly,
    end_date: isoDateOnly,
  }),
  items: z.array(item).default([]),
  plans: z.array(plan).default([]),
  grading_breakdown: z.array(breakdown).default([]),
});

export type ImportItem = z.infer<typeof item>;
export type ImportPlan = z.infer<typeof plan>;
export interface ImportFile {
  term: { name: string; start_date: string; end_date: string };
  items: ImportItem[];
  plans: ImportPlan[];
  grading_breakdown: { course: string; category: string; percent: number }[];
}

export type ParseResult = { ok: true; data: ImportFile } | { ok: false; errors: string[] };

function describePath(path: PropertyKey[], raw: any): string {
  const parts: string[] = [];
  for (const p of path) parts.push(typeof p === 'number' ? `[${p}]` : parts.length ? `.${String(p)}` : String(p));
  const head = parts.join('');
  const m = /^items\[(\d+)\]/.exec(head);
  if (m) {
    const t = raw?.items?.[Number(m[1])]?.title;
    if (typeof t === 'string') return head.replace(m[0], `${m[0]} ("${t}")`);
  }
  return head || '(file)';
}

export function parseImportFile(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['File must contain a JSON object with "term", "items" and optionally "grading_breakdown".'] };
  }
  const r = fileSchema.safeParse(raw);
  const errors: string[] = [];
  if (!r.success) {
    for (const issue of r.error.issues) errors.push(`${describePath(issue.path, raw)}: ${issue.message}`);
    return { ok: false, errors };
  }
  const d = r.data;
  if (d.term.end_date < d.term.start_date) errors.push('term.end_date: must not be before term.start_date');

  const seen = new Map<string, number>();
  d.items.forEach((it, i) => {
    const k = `${it.course.toLowerCase()}|${it.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
    if (seen.has(k)) errors.push(`items[${i}] ("${it.title}"): duplicate of items[${seen.get(k)}] (same course and title); titles must be unique per course`);
    else seen.set(k, i);
  });

  const seenParents = new Set<string>();
  d.plans.forEach((p, pi) => {
    const pk = `${p.parent.course.toLowerCase()}|${p.parent.title.toLowerCase()}`;
    if (seenParents.has(pk)) errors.push(`plans[${pi}] ("${p.parent.title}"): this parent already has a plan in the file; put all its steps in one plan`);
    seenParents.add(pk);
    const titles = new Set<string>();
    p.steps.forEach((s, si) => {
      const tk = s.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (titles.has(tk)) errors.push(`plans[${pi}].steps[${si}] ("${s.title}"): duplicate step title in this plan`);
      titles.add(tk);
      s.depends_on.forEach((dep, di) => {
        if (dep >= p.steps.length) errors.push(`plans[${pi}].steps[${si}].depends_on[${di}]: step index ${dep} does not exist (this plan has ${p.steps.length} steps, numbered from 0)`);
        else if (dep === si) errors.push(`plans[${pi}].steps[${si}] ("${s.title}"): a step cannot depend on itself`);
      });
    });
    // cycle check (only if indexes are valid)
    if (!errors.some((e) => e.startsWith(`plans[${pi}]`))) {
      const state = new Map<number, number>();
      const visit = (i: number, path: number[]): number[] | undefined => {
        if (state.get(i) === 1) return [...path.slice(path.indexOf(i)), i];
        if (state.get(i) === 2) return undefined;
        state.set(i, 1);
        for (const n of p.steps[i].depends_on) { const c = visit(n, [...path, i]); if (c) return c; }
        state.set(i, 2);
        return undefined;
      };
      for (let i = 0; i < p.steps.length; i++) {
        const c = visit(i, []);
        if (c) { errors.push(`plans[${pi}] ("${p.parent.title}"): steps depend on each other in a loop: ${c.map((x) => `[${x}] ${p.steps[x].title}`).join(' -> ')}`); break; }
      }
    }
  });

  const courses = [...new Set([...d.items.map((i) => i.course), ...d.plans.map((p) => p.parent.course)])];
  const breakdown: ImportFile['grading_breakdown'] = [];
  d.grading_breakdown.forEach((b, i) => {
    const course = b.course ?? (courses.length === 1 ? courses[0] : undefined);
    if (!course) errors.push(`grading_breakdown[${i}].course: required when the file contains more than one course`);
    else breakdown.push({ course, category: b.category, percent: b.percent });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, data: { term: d.term, items: d.items, plans: d.plans, grading_breakdown: breakdown } };
}
