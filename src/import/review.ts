import type { Candidate, ChangedItem, DiffResult, ExistingTask } from './diff';
import { diffImport } from './diff';
import { formatLocal } from '../time';
import { parseNaturalDue } from '../core/naturalDate';
import { systemClock, type Clock } from '../clock';
import { normalizeTitle } from './importKey';
import type { ApprovedPlan } from './apply';

export interface ReviewEntry {
  num: number;
  kind: 'new' | 'changed';
  candidate: Candidate;
  changed?: ChangedItem;
  included: boolean;
}

/** Interactive review state, kept free of I/O so it can be tested. */
export class ReviewSession {
  private candidates: Candidate[];
  private excluded = new Set<string>();
  constructor(
    candidates: Candidate[],
    private existing: ExistingTask[],
    private tz: string,
    private defaultTime: string,
    private clock: Clock = systemClock,
  ) {
    this.candidates = candidates.map((c) => ({ ...c }));
  }

  get diff(): DiffResult {
    return diffImport(this.candidates, this.existing);
  }

  /** Actionable entries (new + changed), numbered in date order (undated last). */
  entries(): ReviewEntry[] {
    const d = this.diff;
    const all: Omit<ReviewEntry, 'num'>[] = [
      ...d.new.map((c) => ({ kind: 'new' as const, candidate: c, included: !this.excluded.has(c.import_key) })),
      ...d.changed.map((ch) => ({ kind: 'changed' as const, candidate: ch.candidate, changed: ch, included: !this.excluded.has(ch.candidate.import_key) })),
    ];
    all.sort((a, b) => {
      const x = a.candidate.due_date ?? '9999', y = b.candidate.due_date ?? '9999';
      return x === y ? a.candidate.title.localeCompare(b.candidate.title) : x < y ? -1 : 1;
    });
    return all.map((e, i) => ({ ...e, num: i + 1 }));
  }

  private find(num: number): ReviewEntry {
    const e = this.entries().find((x) => x.num === num);
    if (!e) throw new Error(`No item numbered ${num}.`);
    return e;
  }

  drop(num: number) {
    this.excluded.add(this.find(num).candidate.import_key);
  }
  restore(num: number) {
    this.excluded.delete(this.find(num).candidate.import_key);
  }

  /** Edit a field of the item before it is written. import_key is never changed. */
  edit(num: number, field: string, value: string) {
    const key = this.find(num).candidate.import_key;
    const c = this.candidates.find((x) => x.import_key === key)!;
    const nul = value === '' || value.toLowerCase() === 'null';
    switch (field) {
      case 'title':
        if (nul) throw new Error('Title cannot be empty.');
        c.title = value;
        break;
      case 'type':
        if (!['homework', 'project', 'exam', 'quiz', 'reading', 'attendance', 'other'].includes(value)) throw new Error(`Unknown type "${value}".`);
        c.type = value;
        break;
      case 'due': {
        // the same plain-words parser as everywhere else (ISO dates still work)
        const r = nul ? { dueUtc: null, timeAssumed: false } : parseNaturalDue(value, this.tz, this.clock, this.defaultTime);
        c.due_date = r.dueUtc;
        c.time_assumed = r.timeAssumed;
        break;
      }
      case 'weight': {
        const n = nul ? null : Number(value);
        if (n !== null && (!Number.isFinite(n) || n < 0 || n > 100)) throw new Error('Weight must be 0-100.');
        c.grade_weight = n;
        break;
      }
      case 'est': {
        const n = nul ? null : Number(value);
        if (n !== null && (!Number.isInteger(n) || n <= 0)) throw new Error('Estimate must be a positive whole number of minutes.');
        c.estimated_minutes = n;
        break;
      }
      case 'notes':
        c.notes = nul ? null : value;
        break;
      case 'course':
        throw new Error('Course cannot be edited here (it is part of the item identity).');
      default:
        throw new Error(`Unknown field "${field}". Use: title, type, due, weight, est, notes.`);
    }
  }

  plan(): ApprovedPlan {
    const d = this.diff;
    return {
      new: d.new.filter((c) => !this.excluded.has(c.import_key)),
      changed: d.changed.filter((c) => !this.excluded.has(c.candidate.import_key)),
    };
  }

  render(color = true): string {
    const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
    const d = this.diff;
    const out: string[] = [];
    const line = (e: ReviewEntry) => {
      const c = e.candidate;
      const low = c.confidence === 'low';
      const bits = [
        `${String(e.num).padStart(3)}.`,
        e.included ? '[x]' : '[ ]',
        formatLocal(c.due_date, this.tz, c.time_assumed).padEnd(24),
        `${c.course} · ${c.parent ? `${c.parent.title} > ` : ''}${c.title}`,
        `(${c.type}${c.grade_weight != null ? `, ${c.grade_weight}%` : ''}${c.estimated_minutes ? `, ~${c.estimated_minutes}m` : ''}${c.size_unit ? `, size ${c.size_amount ?? '?'} ${c.size_unit}` : ''}${c.optional ? ', optional' : ''}${c.deadline_only ? ', deadline only' : ''}${c.available_from ? `, from ${c.available_from}` : ''})`,
      ];
      if (c.depends_on_titles?.length) bits.push(`after: ${c.depends_on_titles.join(', ')}`);
      if (low) bits.push('LOW CONFIDENCE');
      if (c.expanded_from_recurring) bits.push('recurring');
      let s = bits.join(' ');
      if (!e.included) s = paint('2', s);
      else if (low) s = paint('33;1', s);
      out.push(s);
      if (c.source_quote && low) out.push(`       “${c.source_quote}”`);
      if (e.changed) {
        for (const f of e.changed.fields) {
          const show = (v: unknown) => (f.field === 'due_date' ? formatLocal(v as string | null, this.tz) : String(v ?? 'null'));
          const conflict = e.changed.conflicts.includes(f.field);
          out.push(`       ${f.field}: ${show(f.from)} -> ${show(f.to)}${conflict ? paint('31', '  (edited locally: will NOT overwrite)') : ''}`);
        }
      }
    };
    const entries = this.entries();
    const section = (title: string, es: ReviewEntry[]) => {
      if (!es.length) return;
      out.push('', paint('1', `${title} (${es.length})`));
      es.forEach(line);
    };
    section('NEW', entries.filter((e) => e.kind === 'new'));
    section('CHANGED', entries.filter((e) => e.kind === 'changed'));
    if (d.unchanged.length) {
      out.push('', paint('1', `UNCHANGED (${d.unchanged.length})`));
      for (const u of d.unchanged) out.push(`       ${u.existing.title}`);
    }
    if (d.missing.length) {
      out.push('', paint('1', `IN DATABASE BUT MISSING FROM FILE (${d.missing.length}) — left untouched`));
      for (const m of d.missing) out.push(`       ${m.title}  [${formatLocal(m.due_date, this.tz, m.time_assumed)}]`);
    }
    return out.join('\n');
  }
}

export { normalizeTitle };
