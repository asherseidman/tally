import { parseArgs } from './args';
import { openDb } from '../db/index';
import { dbPath } from '../paths';
import { getSetting } from '../db/repo';
import { formatLocal } from '../time';

const { flags } = parseArgs();
const demo = flags.has('demo');
const db = openDb(dbPath(demo));
const tz = getSetting(db, 'timezone') ?? 'America/Detroit';
console.log(`${demo ? '[DEMO DATABASE]' : '[REAL DATABASE]'} ${dbPath(demo)}\n`);
for (const t of db.all<any>('SELECT * FROM terms ORDER BY start_date')) {
  console.log(`Term: ${t.name} (${t.start_date}..${t.end_date})${t.is_current ? ' [current]' : ''}${t.archived_at ? ' [archived]' : ''}`);
  for (const g of db.all<any>('SELECT * FROM grading_breakdown WHERE term_id = ? ORDER BY course, category', [t.id])) {
    console.log(`  grading ${g.course}: ${g.category} ${g.percent}%`);
  }
  for (const k of db.all<any>('SELECT * FROM tasks WHERE term_id = ? AND deleted_at IS NULL ORDER BY due_date IS NULL, due_date, id', [t.id])) {
    console.log(`  #${k.id} ${formatLocal(k.due_date, tz, !!k.time_assumed).padEnd(24)} ${k.course ?? ''} · ${k.title} (${k.type}${k.grade_weight != null ? `, ${k.grade_weight}%` : ''}) ${k.confidence === 'low' ? 'LOW' : ''}`);
  }
}
db.close();
