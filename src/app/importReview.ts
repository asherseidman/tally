import { randomUUID } from 'node:crypto';
import type { ApiDeps } from './api';
import { parseImportFile, type ImportFile } from '../import/schema';
import { buildCandidates, applyImport } from '../import/apply';
import { buildPlanCandidates, existingForImport } from '../import/plan';
import { ReviewSession } from '../import/review';
import { findTermByName, listTasksForImport } from '../db/repo';
import { syncSizeEstimates } from '../core/size';
import { backupAfterImport, shouldBackupAfterImport } from '../core/backup';
import { formatLocal } from '../time';
import type { ImportReview, ImportEntry, ImportApplied } from './types';

/** An import being reviewed. Lives in memory only: nothing touches the database until `applyReview`. */
interface Open {
  file: ImportFile;
  fileName: string;
  session: ReviewSession;
  termExists: boolean;
  note: string | null;
}
// Keyed by the database context, not the deps object: the main process builds a fresh deps object for every request.
const open = new WeakMap<object, Map<string, Open>>();
const sessions = (d: ApiDeps) => open.get(d.ctx) ?? open.set(d.ctx, new Map()).get(d.ctx)!;
const MAX_OPEN = 5;

const sizeText = (c: { size_amount: number | null; size_unit: string | null }) => (c.size_unit ? `${c.size_amount ?? '?'} ${c.size_unit.replace('_', ' ')}` : null);

function view(d: ApiDeps, id: string, o: Open): ImportReview {
  const tz = d.ctx.tz;
  const diff = o.session.diff;
  const entries: ImportEntry[] = o.session.entries().map((e) => {
    const c = e.candidate;
    return {
      num: e.num, kind: e.kind, included: e.included,
      course: c.course, title: c.title, parentTitle: c.parent?.title ?? null, type: c.type,
      dueText: c.due_date ? formatLocal(c.due_date, tz, c.time_assumed) : null,
      weight: c.grade_weight, estimate: c.estimated_minutes, size: sizeText(c),
      optional: c.optional, deadlineOnly: !!c.deadline_only, availableFrom: c.available_from,
      after: c.depends_on_titles ?? [], lowConfidence: c.confidence === 'low', recurring: c.expanded_from_recurring,
      quote: c.source_quote, notes: c.notes,
      changes: (e.changed?.fields ?? []).map((f) => ({
        field: f.field,
        from: f.field === 'due_date' ? (f.from ? formatLocal(f.from as string, tz) : 'none') : String(f.from ?? 'none'),
        to: f.field === 'due_date' ? (f.to ? formatLocal(f.to as string, tz) : 'none') : String(f.to ?? 'none'),
        conflict: e.changed!.conflicts.includes(f.field),
      })),
    };
  });
  const sel = entries.filter((e) => e.included);
  return {
    id, fileName: o.fileName, term: o.file.term.name, termIsNew: !o.termExists, note: o.note, tz, defaultTime: d.ctx.defaultTime,
    entries,
    unchanged: diff.unchanged.map((u) => u.existing.title),
    missing: diff.missing.map((m) => ({ title: m.title, dueText: m.due_date ? formatLocal(m.due_date, tz, m.time_assumed) : null })),
    willAdd: sel.filter((e) => e.kind === 'new').length,
    willUpdate: sel.filter((e) => e.kind === 'changed').length,
  };
}

const get = (d: ApiDeps, id: string): Open => {
  const o = sessions(d).get(id);
  if (!o) throw new Error('That import review is no longer open. Choose the file again.');
  return o;
};

/** Validate a file's text and build the review. Errors list every problem, with the item and field, like the CLI. */
export function startReview(d: ApiDeps, text: string, fileName: string): ImportReview {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${fileName} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = parseImportFile(raw);
  if (!parsed.ok) {
    throw new Error(`${fileName} is not a valid import file (${parsed.errors.length} problem${parsed.errors.length === 1 ? '' : 's'}):\n${parsed.errors.map((x) => `  - ${x}`).join('\n')}\nNothing was imported. See docs/IMPORT_FORMAT.md.`);
  }
  const f = parsed.data;
  const db = d.ctx.db;
  const term = findTermByName(db, f.term.name);
  const candidates = [...buildCandidates(f, d.ctx.tz, d.ctx.defaultTime), ...buildPlanCandidates(f, d.ctx.tz, d.ctx.defaultTime, db)];
  const existing = existingForImport(f, term ? listTasksForImport(db, term.id) : [], db);
  const note = term && (term.start_date !== f.term.start_date || term.end_date !== f.term.end_date)
    ? `Term "${term.name}" already exists with dates ${term.start_date} to ${term.end_date}; the file says ${f.term.start_date} to ${f.term.end_date}. The existing term dates are kept.`
    : null;
  const store = sessions(d);
  while (store.size >= MAX_OPEN) store.delete(store.keys().next().value!);
  const id = randomUUID();
  const o: Open = { file: f, fileName, session: new ReviewSession(candidates, existing, d.ctx.tz, d.ctx.defaultTime, d.ctx.clock), termExists: !!term, note };
  store.set(id, o);
  return view(d, id, o);
}

export function toggleEntry(d: ApiDeps, id: string, num: number, included: boolean): ImportReview {
  const o = get(d, id);
  if (included) o.session.restore(num); else o.session.drop(num);
  return view(d, id, o);
}

export function editEntry(d: ApiDeps, id: string, num: number, field: string, value: string): ImportReview {
  const o = get(d, id);
  o.session.edit(num, field, value);
  return view(d, id, o);
}

export function closeReview(d: ApiDeps, id: string): { ok: true } {
  sessions(d).delete(id);
  return { ok: true };
}

/** Write the approved items (one transaction), then take the verified backup, exactly as the CLI does. */
export async function applyReview(d: ApiDeps, id: string, onWritten?: () => void): Promise<ImportApplied> {
  const o = get(d, id);
  const plan = o.session.plan();
  const res = applyImport(d.ctx.db, o.file, plan, d.ctx.clock);
  syncSizeEstimates(d.ctx);
  onWritten?.(); // the rows are written; anything after this (the backup) is slow and async
  sessions(d).delete(id);
  let backup: string | null = null;
  let backupError: string | null = null;
  if (shouldBackupAfterImport(res)) {
    try {
      backup = (await backupAfterImport(d.ctx, d.backupFolder)).backup.path;
    } catch (e) {
      backupError = `The import itself was saved, but the backup after it FAILED: ${(e as Error).message}. Run a backup from the command line: npm run backup`;
    }
  }
  return {
    inserted: res.inserted, updated: res.updated, termCreated: res.termCreated,
    keptLocalEdits: res.skippedConflicts.map((c) => ({ taskId: c.taskId, fields: c.fields as string[] })),
    backup, backupError,
    message: `Done: ${res.inserted} added, ${res.updated} updated${res.termCreated ? `, term "${o.file.term.name}" created` : ''}.`,
  };
}
