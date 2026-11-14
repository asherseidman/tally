import type { Db } from '../db/index';

export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545 line folding: max 75 octets per line, continuation lines start with one space. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines lose one octet to the leading space
    if (bytes + b > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ' ' + l : l)).join('\r\n');
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface IcsTask {
  id: number;
  title: string;
  due_date: string | null;
  course: string | null;
  notes: string | null;
  status: string;
  deleted_at: string | null;
  time_assumed: number;
}

/** Calendar file with one short event at each task's due time (universally importable). */
export function buildIcs(tasks: IcsTask[], now: Date): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//todo-planner//EN', 'CALSCALE:GREGORIAN'];
  for (const t of tasks) {
    if (!t.due_date || t.deleted_at) continue;
    const start = new Date(t.due_date);
    const end = new Date(start.getTime() + 15 * 60_000);
    const desc = [t.course, t.notes, t.time_assumed ? '(due time assumed)' : null].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:task-${t.id}@todo-planner`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${icsEscape((t.status === 'done' ? '✓ ' : '') + t.title)}`,
    );
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

const TABLES = ['terms', 'lists', 'tasks', 'dependencies', 'grading_breakdown', 'time_sessions', 'scheduled_blocks', 'settings'];

/** Everything, including archived terms and soft-deleted tasks. */
export function buildJsonExport(db: Db, now: Date): Record<string, unknown> {
  const out: Record<string, unknown> = {
    exported_at: now.toISOString(),
    format: 'todo-planner-export',
    schema_version: db.get<{ user_version: number }>('PRAGMA user_version')!.user_version,
  };
  for (const t of TABLES) out[t] = db.all(`SELECT * FROM ${t}`);
  return out;
}
