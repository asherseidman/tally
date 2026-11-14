export const IMPORT_FIELDS = ['type', 'due_date', 'time_assumed', 'grade_weight', 'notes', 'source_quote', 'estimated_minutes', 'size_amount', 'size_unit', 'available_from', 'optional', 'deadline_only', 'depends_on'] as const;
/**
 * Fields a re-import may change on an EXISTING task. Estimates are deliberately excluded: they come from
 * the app (the user's own numbers, or a cleared estimate such as for labs), never from a file. A NEW task
 * still takes the file's estimate as its starting value.
 */
const REIMPORT_FIELDS = IMPORT_FIELDS.filter((f) => f !== 'estimated_minutes');
export type ImportField = (typeof IMPORT_FIELDS)[number];

type SnapVal = string | number | boolean | null;
export type Snapshot = Record<ImportField, SnapVal>;

export interface Candidate {
  import_key: string;
  course: string;
  title: string;
  type: string;
  due_date: string | null; // UTC ISO
  time_assumed: boolean;
  grade_weight: number | null;
  notes: string | null;
  source_quote: string | null;
  estimated_minutes: number | null;
  size_amount: number | null;
  size_unit: string | null;
  available_from: string | null;
  optional: boolean;
  deadline_only?: boolean;
  /** plan steps: the step this one waits on, as a sorted comma-joined list of their import keys (null = none) */
  depends_on?: string | null;
  /** plan steps: the parent task (by course + title) and display-only titles of the steps this one waits on */
  parent?: { course: string; title: string };
  depends_on_titles?: string[];
  confidence: 'low' | 'medium' | 'high';
  expanded_from_recurring: boolean;
}

export interface ExistingTask {
  id: number;
  import_key: string;
  course: string | null;
  title: string;
  type: string;
  due_date: string | null;
  time_assumed: boolean;
  grade_weight: number | null;
  notes: string | null;
  source_quote: string | null;
  estimated_minutes: number | null;
  size_amount: number | null;
  size_unit: string | null;
  available_from: string | null;
  optional: boolean;
  deadline_only?: boolean;
  depends_on?: string | null;
  parent_task_id?: number | null;
  status: string;
  deleted_at: string | null;
  /** Values as last imported; lets us tell file changes from local edits. Null for legacy rows. */
  import_snapshot: Snapshot | null;
}

export interface FieldChange {
  field: ImportField;
  from: Snapshot[ImportField];
  to: Snapshot[ImportField];
}

export interface ChangedItem {
  candidate: Candidate;
  existing: ExistingTask;
  /** Fields the file changed relative to last import (including conflicted ones). */
  fields: FieldChange[];
  /** Subset of `fields` that were also edited locally; these are never overwritten. */
  conflicts: ImportField[];
}

export interface DiffResult {
  new: Candidate[];
  changed: ChangedItem[];
  unchanged: { candidate: Candidate; existing: ExistingTask }[];
  missing: ExistingTask[];
}

export function snapshotOf(c: Candidate): Snapshot {
  const out = {} as Snapshot;
  for (const f of IMPORT_FIELDS) out[f] = (f === 'deadline_only' ? !!c[f] : ((c[f] as SnapVal | undefined) ?? null)) as SnapVal;
  return out;
}

const eq = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
/** field-aware equality: deadline_only is a boolean that old data/candidates may leave undefined (= false) */
const eqf = (f: ImportField, a: unknown, b: unknown) => (f === 'deadline_only' ? !!a === !!b : eq(a, b));

export function diffImport(candidates: Candidate[], existing: ExistingTask[]): DiffResult {
  const byKey = new Map(existing.map((e) => [e.import_key, e]));
  const res: DiffResult = { new: [], changed: [], unchanged: [], missing: [] };
  const fileKeys = new Set(candidates.map((c) => c.import_key));

  for (const c of candidates) {
    const e = byKey.get(c.import_key);
    if (!e) {
      res.new.push(c);
      continue;
    }
    if (e.deleted_at) {
      // Deleted locally: never resurrect.
      res.unchanged.push({ candidate: c, existing: e });
      continue;
    }
    const base: Snapshot = e.import_snapshot ?? (Object.fromEntries(IMPORT_FIELDS.map((f) => [f, e[f]])) as Snapshot);
    const fields: FieldChange[] = [];
    const conflicts: ImportField[] = [];
    for (const f of REIMPORT_FIELDS) {
      if (!eqf(f, c[f], base[f])) {
        fields.push({ field: f, from: base[f], to: c[f] as Snapshot[ImportField] });
        if (!eqf(f, e[f], base[f])) conflicts.push(f);
      }
    }
    if (fields.length) res.changed.push({ candidate: c, existing: e, fields, conflicts });
    else res.unchanged.push({ candidate: c, existing: e });
  }

  const courses = new Set(candidates.map((c) => c.course.toLowerCase()));
  for (const e of existing) {
    if (e.deleted_at || fileKeys.has(e.import_key)) continue;
    if (e.course && courses.has(e.course.toLowerCase())) res.missing.push(e);
  }
  return res;
}
