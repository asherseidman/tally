import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from './args';
import { openContext } from './context';
import { backupAfterImport, shouldBackupAfterImport } from '../core/backup';
import { getSetting, findTermByName, listTasksForImport } from '../db/repo';
import { parseImportFile } from '../import/schema';
import { buildCandidates, applyImport } from '../import/apply';
import { syncSizeEstimates } from '../core/size';
import { buildPlanCandidates, existingForImport } from '../import/plan';
import { ReviewSession } from '../import/review';
import { systemClock } from '../clock';

const HELP = `Commands:
  a              approve all checked items and write to the database
  d N / u N      uncheck (skip) / re-check item N
  e N field val  edit before writing; fields: title type due weight est notes
                 (e.g. "e 3 due 2026-10-01T17:00", "e 3 weight null")
  l              show the list again
  q              quit without writing anything`;

async function main() {
  const { positional, flags } = parseArgs();
  const demo = flags.has('demo');
  const file = positional[0];
  if (!file) {
    console.error('Usage: npm run import -- <file.json> [--demo] [--yes] [--dry-run]');
    process.exit(2);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  const parsed = parseImportFile(raw);
  if (!parsed.ok) {
    console.error(`\n${file} is not a valid import file (${parsed.errors.length} problem${parsed.errors.length === 1 ? '' : 's'}):\n`);
    for (const err of parsed.errors) console.error(`  - ${err}`);
    console.error('\nNothing was imported. See docs/IMPORT_FORMAT.md.');
    process.exit(1);
  }

  const cx = await openContext(demo); // also runs the daily backup, like the plan commands
  const db = cx.ctx.db;
  try {
    const tz = getSetting(db, 'timezone') ?? 'America/Detroit';
    const defaultTime = getSetting(db, 'default_due_time') ?? '23:59';
    const f = parsed.data;
    const term = findTermByName(db, f.term.name);
    if (term && (term.start_date !== f.term.start_date || term.end_date !== f.term.end_date)) {
      console.warn(`Note: term "${term.name}" exists with dates ${term.start_date}..${term.end_date}; file says ${f.term.start_date}..${f.term.end_date}. Keeping the existing term dates.`);
    }
    let steps: ReturnType<typeof buildPlanCandidates>;
    try {
      steps = buildPlanCandidates(f, tz, defaultTime, db);
    } catch (e) {
      console.error(`\n${(e as Error).message}\nNothing was imported.`);
      process.exit(1);
    }
    const candidates = [...buildCandidates(f, tz, defaultTime), ...steps];
    // Plan steps are only compared with the steps of the parents in this file; ordinary tasks only when the file has items.
    const existing = existingForImport(f, term ? listTasksForImport(db, term.id) : [], db);
    const session = new ReviewSession(candidates, existing, tz, defaultTime);

    console.log(`${demo ? '[DEMO DATABASE] ' : ''}Import review: ${f.term.name}${term ? '' : ' (new term)'} — times shown in ${tz}, * = time assumed (${defaultTime})`);
    console.log(session.render());

    const apply = async () => {
      const plan = session.plan();
      if (flags.has('dry-run')) {
        console.log(`\nDry run: would add ${plan.new.length}, update ${plan.changed.length}. Nothing written.`);
        return;
      }
      const res = applyImport(db, f, plan, systemClock);
      syncSizeEstimates(cx.ctx);
      console.log(`\nDone: ${res.inserted} added, ${res.updated} updated${res.termCreated ? `, term "${f.term.name}" created` : ''}.`);
      for (const c of res.skippedConflicts) console.log(`  task ${c.taskId}: kept your local edit of ${c.fields.join(', ')}`);
      if (!shouldBackupAfterImport(res)) return console.log('Nothing was written, so no extra backup was taken.');
      // Imports are the biggest data changes: back up right after writing, even if today already has a backup.
      try {
        const b = await backupAfterImport(cx.ctx, cx.backupFolder);
        console.log(`Backup after import saved and verified: ${b.backup.path}`);
      } catch (e) {
        console.error(`\n!! BACKUP AFTER IMPORT FAILED: ${(e as Error).message}\n!! The import itself was saved. Run: npm run backup`);
      }
    };

    if (flags.has('yes')) return await apply();

    if (!session.entries().length) {
      console.log('\nNothing new or changed.');
      return;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    console.log(`\n${HELP}`);
    for (;;) {
      const line = (await rl.question('\nreview> ').catch(() => 'q')).trim();
      const [cmd, ...rest] = line.split(/\s+/);
      try {
        if (cmd === 'a') { rl.close(); return await apply(); }
        else if (cmd === 'q') { rl.close(); console.log('Nothing written.'); return; }
        else if (cmd === 'l') console.log(session.render());
        else if (cmd === 'd') { session.drop(Number(rest[0])); console.log(session.render()); }
        else if (cmd === 'u') { session.restore(Number(rest[0])); console.log(session.render()); }
        else if (cmd === 'e') {
          if (rest.length < 2) throw new Error('Usage: e N field value');
          session.edit(Number(rest[0]), rest[1], rest.slice(2).join(' '));
          console.log(session.render());
        } else console.log(HELP);
      } catch (e) {
        console.log(`  ! ${(e as Error).message}`);
      }
    }
  } finally {
    cx.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
