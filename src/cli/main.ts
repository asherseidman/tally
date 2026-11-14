import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { parseCli, type Cli } from './args';
import { resolveCommand } from './aliases';
import { groupTasks } from '../core/grouping';
import { runDoctor, hasFailures } from '../core/doctor';
import { openContext, backupFolderFor, type CliContext } from './context';
import { nameMaps, taskLine } from './format';
import { appDataDir } from '../paths';
import { getSetting, setSetting } from '../db/repo';
import { assertTimezone, formatLocal } from '../time';
import {
  addTask, addStep, editTask, completeTask, uncompleteTask, deleteTask, undoDelete, listTasks, getTask,
  type AddInput, type EditPatch, type Task, type TaskFilter,
} from '../core/tasks';
import { createList, renameList, deleteList, listLists, moveTask } from '../core/lists';
import { createTerm, useTerm, archiveTerm, unarchiveTerm, listTerms, currentTerm, getTermByName } from '../core/terms';
import { listChanges, undoChange } from '../core/changeLog';
import { createBackup, listBackups, restoreBackup, verifyBackup, KEEP_BACKUPS, pruneBackups } from '../core/backup';
import { buildIcs, buildJsonExport } from '../core/export';
import { loadMultipliers, applyMultiplier, MIN_SAMPLES } from '../core/learning';
import { startSession, stopSession, openSessions, logWork } from '../core/timer';
import { parseNaturalDue } from '../core/naturalDate';
import { runSchedule, runCalendar, runAway, runAvailability } from './scheduleCmd';
import { addDependency, removeDependency, allBlockers, dependents } from '../core/dependencies';
import { computeViews, loadViewSettings, VIEW_KEYS, checkViewSetting, type ViewItem } from '../core/views';
import { parseSize } from '../core/size';
import { estimateDiff } from '../core/estimateDiff';
import { effectiveEstimate, loadLearnedRates, loadRates, setRate, removeRate, describeRule, rateKey, SIZE_UNITS } from '../core/size';
import { SCHEDULE_KEYS, checkScheduleSetting } from '../schedule/params';
import { loadWorkingHours, saveWorkingHoursJson, saveTermWorkingHours, saveClassCalendars, saveBusyCalendars, getClassCalendars, getBusyCalendars } from '../schedule/settings';
import { readFileSync as readFile } from 'node:fs';

const HELP = `planner: usage: npm run plan -- <command> [options]   (add --demo to use the demo database)

Tasks
  add "title" [--due fri 5pm] [--list L] [--course C] [--type homework|...] [--est 45]
              [--weight 5] [--notes ..] [--repeat daily|weekly|mon,wed|"every 3 days"] [--term T]
  edit <id> [same options; use "none" to clear a due/list/course/repeat/est/weight/notes]
            [--size 12 pages | 5 problems | 40 video_minutes | 3 items | 100 points | none]  [--available-from D|none]
            [--optional | --required]  [--deadline-only | --schedulable]  [--est-from-size]    (a manual --est always wins; --est-from-size switches to size)
  done <id> | undone <id> | rm <id> | undo [id]      rm is a soft delete; undo restores it
  mv <id> <list|none>      show <id>
  step <parent id> <title>   add a step (a small task under a parent task)
  changes [undo <id>]      what the Claude connector changed (and undo one)
  ls [--list L] [--course C] [--status todo|in_progress|done] [--from D] [--to D] [--q text]
     [--done] [--all] [--deleted] [--term T] [--all-terms] [--by course|list]
  ls --needs-size          tasks that have a size unit but no amount yet (e.g. a video whose length I haven't entered)
  estimates [--apply]      tasks whose size-based estimate differs from their current one (--apply switches them to size-based)
  search <text>            (all statuses)
  (ls groups tasks as OVERDUE / TODAY / UPCOMING / NO DUE DATE; --by course|list or --deleted gives a flat list)

Deps:     dep add <task> <blocked-by-task> | dep rm <task> <blocker> | dep ls [task]      (a blocked task is not scheduled until its blockers are done)
Lists:   list new <name> [--term T] | list rename <old> <new> | list rm <name> | list ls
Terms:   term ls | term new <name> --start YYYY-MM-DD --end YYYY-MM-DD [--current]
         term use <name> | term archive <name> | term unarchive <name>
Data:    backup | backups | restore [file] [--yes] | export [--out dir]
Timer:   timer <id>       log <id> <minutes> [--start 7:20pm]   (log work done without the timer; the scheduler plans only the remaining estimate)
Views:   views [--term T] [--all-terms]   (Due Soon, High Grade Impact, Quick Wins, Blocked)
Learning: multipliers
Rates:   rates | rates set <minutes per unit> --unit points [--course "EECS 183"] [--match zyBooks] | rates set 60 --per-assignment [--course "EECS 183"] [--match Lab] | rates rm <n>   (size-based or flat estimates; decimals are fine)
Config:  config | config set <key> <value>   (timezone, default_due_time, backup_folder, class_calendars, busy_calendars,
         size_rates @file.json, and the schedule knobs: placement_style early|late, early_lead_days, finish_before_deadline_minutes,
         max_daily_work_minutes, include_optional_tasks, min_block_minutes, max_block_minutes, buffer_minutes, min_lead_minutes, ...)
Availability (when work may be scheduled; replaces the working-hours JSON):
         availability show [--week [date]] | set <date|weekday> HH:mm-HH:mm [free|blocked] | clear <date>
         availability copy-week <from> <to> | seed [--weeks 4] [--replace]
Schedule: schedule [--days 7] [--apply] | replan [--apply]      (dry run unless --apply; writes only to the "Planner Blocks" calendar)
          schedule --fake-calendar [--hours file.json]            (preview with simulated classes; never applies)
          calendar connect | status | list | disconnect           away add <date> [HH:mm-HH:mm] | away rm <date> | away ls   (shortcuts for availability)
Check:   doctor      (database, backups, term, timezone)
Short aliases: a = add, d = done, l = ls, s = search

Default views show the CURRENT term plus tasks with no term. Use --term <name> or --all-terms to change that.`;

const num = (s: string | undefined, what: string): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a number, got "${s}".`);
  return n;
};
const idArg = (s: string | undefined): number => {
  const n = Number(s);
  if (!s || !Number.isInteger(n) || n <= 0) throw new Error('Expected a task id, e.g. 12.');
  return n;
};

function printTasks(cx: CliContext, tasks: Task[], by?: string) {
  const names = nameMaps(cx.ctx);
  if (!tasks.length) return console.log('(no tasks)');
  if (!by) return tasks.forEach((t) => console.log(taskLine(cx.ctx, t, names)));
  const key = (t: Task) => (by === 'list' ? (t.list_id ? names.lists.get(t.list_id) : null) : t.course) ?? `(no ${by})`;
  const groups = new Map<string, Task[]>();
  for (const t of tasks) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
  for (const [g, ts] of groups) {
    console.log(`\n${g}`);
    ts.forEach((t) => console.log('  ' + taskLine(cx.ctx, t, names)));
  }
}

function printGrouped(cx: CliContext, tasks: Task[]) {
  const names = nameMaps(cx.ctx);
  const groups = groupTasks(tasks, cx.ctx.clock.now(), cx.ctx.tz);
  if (!groups.length) return console.log('(no tasks)');
  for (const g of groups) {
    console.log(`\n${g.label} (${g.tasks.length})`);
    g.tasks.forEach((t) => console.log('  ' + taskLine(cx.ctx, t, names)));
  }
}

function scopeNote(cx: CliContext, cli: Cli) {
  if (cli.flags.has('all-terms')) return 'all terms (including archived)';
  if (cli.opts.term) return `term "${cli.opts.term}" + tasks with no term`;
  const cur = currentTerm(cx.ctx);
  return cur ? `current term "${cur.name}" + tasks with no term` : 'no current term: showing only tasks with no term';
}

async function cmdTimer(cx: CliContext, id: number) {
  const { ctx } = cx;
  const task = getTask(ctx, id);
  if (!task) throw new Error(`No task #${id}.`);
  const stale = openSessions(ctx, id);
  if (stale.length) console.log(`Note: ${stale.length} earlier unfinished session(s) for this task are ignored (never counted).`);
  const sid = startSession(ctx, id);
  const started = Date.now();
  console.log(`Timing #${id}: ${task.title}\nPress any key (or Ctrl-C) to stop.`);
  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(tick);
    if (stdin.isTTY) stdin.setRawMode(false);
    const r = stopSession(ctx, sid);
    console.log(`\nStopped. This session: ${r.minutes} min. Total on task: ${r.total} min.`);
    cx.close();
    process.exit(0);
  };
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    stdout.write(`\r  ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}  `);
  }, 1000);
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', finish);
  stdin.on('end', finish);
  await new Promise(() => {});
}

async function run() {
  const cli = parseCli();
  const [rawCmd, ...rest] = cli.positional;
  const cmd = rawCmd && resolveCommand(rawCmd);
  if (!cmd || cli.flags.has('help') || cmd === 'help') return console.log(HELP);
  const demo = cli.flags.has('demo');
  const cx = await openContext(demo);
  const { ctx } = cx;
  const o = cli.opts;
  try {
    if (demo) console.log('[DEMO DATABASE]');
    switch (cmd) {
      case 'add': {
        const input: AddInput = {
          title: rest.join(' '), due: o.due, list: o.list, course: o.course, type: o.type, est: num(o.est, '--est'),
          weight: num(o.weight, '--weight'), notes: o.notes, repeat: o.repeat, term: o.term,
        };
        const t = addTask(ctx, input);
        printTasks(cx, [t]);
        if (t.time_assumed) console.log(`  (no time given: assumed ${ctx.defaultTime})`);
        if (t.estimated_minutes) {
          const a = applyMultiplier(t.estimated_minutes, t.type, loadMultipliers(ctx));
          if (a.applied) console.log(`  Hint: your ${t.type} tasks run ${a.multiplier}x their estimates (${a.samples} samples), so plan for ~${a.minutes} min.`);
        }
        break;
      }
      case 'edit': {
        const id = idArg(rest[0]);
        const p: EditPatch = {};
        if (o.title !== undefined) p.title = o.title;
        if (o.notes !== undefined) p.notes = o.notes === 'none' ? null : o.notes;
        if (o.due !== undefined) p.due = o.due;
        if (o.list !== undefined) p.list = o.list;
        if (o.course !== undefined) p.course = o.course;
        if (o.type !== undefined) p.type = o.type;
        if (o.est !== undefined) p.est = o.est === 'none' ? null : num(o.est, '--est');
        if (o.weight !== undefined) p.weight = o.weight === 'none' ? null : num(o.weight, '--weight');
        if (o.repeat !== undefined) p.repeat = o.repeat;
        if (o.term !== undefined) p.term = o.term;
        if (o.size !== undefined) p.size = o.size.trim().toLowerCase() === 'none' ? null : parseSize(o.size, rest[1] ?? o.unit);
        if (o['available-from'] !== undefined) p.availableFrom = o['available-from'];
        if (cli.flags.has('optional')) p.optional = true;
        if (cli.flags.has('required')) p.optional = false;
        if (cli.flags.has('deadline-only')) p.deadlineOnly = true;
        if (cli.flags.has('schedulable')) p.deadlineOnly = false;
        if (cli.flags.has('est-from-size')) p.estFromSize = true;
        const before = getTask(ctx, id);
        const edited = editTask(ctx, id, p);
        printTasks(cx, [edited]);
        if (o.size !== undefined && before && before.estimate_source !== 'size' && before.estimated_minutes != null && !cli.flags.has('est-from-size') && edited.size_amount) {
          const { all } = loadRates(ctx);
          const e = effectiveEstimate(edited, all, loadLearnedRates(ctx, all));
          if (e.size) console.log(`  Kept your manual estimate (${edited.estimated_minutes} min). Size-based would be ${e.size.formula}. Switch with: edit ${id} --est-from-size`);
        }
        break;
      }
      case 'done': {
        const r = completeTask(ctx, idArg(rest[0]));
        printTasks(cx, [r.completed]);
        if (r.next) console.log('  next occurrence:'), printTasks(cx, [r.next]);
        break;
      }
      case 'undone':
        printTasks(cx, [uncompleteTask(ctx, idArg(rest[0]))]);
        break;
      case 'rm': {
        const t = deleteTask(ctx, idArg(rest[0]));
        console.log(`Deleted #${t.id} "${t.title}". Restore with: undo ${t.id}`);
        break;
      }
      case 'undo':
        printTasks(cx, [undoDelete(ctx, rest[0] ? idArg(rest[0]) : undefined)]);
        break;
      case 'step': {
        // step <parent id> <title...>: a small task under a parent task
        if (!rest[0] || !rest[1]) throw new Error('Usage: step <parent id> <title>');
        printTasks(cx, [addStep(ctx, idArg(rest[0]), rest.slice(1).join(' '))]);
        break;
      }
      case 'changes': {
        // history of changes made through the Claude connector; `changes undo <id>` puts the rows back
        if (rest[0] === 'undo') {
          if (!rest[1]) throw new Error('Usage: changes undo <id>   (ids from: changes)');
          console.log(`Undone: ${undoChange(ctx, idArg(rest[1])).summary}`);
          break;
        }
        const rows = listChanges(ctx, { limit: 30 });
        if (!rows.length) console.log('No recorded changes yet.');
        for (const c of rows) console.log(`#${c.id}  ${formatLocal(c.at, ctx.tz)}  ${c.actor}  ${c.summary}${c.undone ? '  (undone)' : ''}`);
        break;
      }
      case 'mv': {
        const to = rest.slice(1).join(' ');
        if (!to) throw new Error('Usage: mv <id> <list|none>');
        printTasks(cx, [moveTask(ctx, idArg(rest[0]), to.toLowerCase() === 'none' ? null : to)]);
        break;
      }
      case 'show': {
        const t = getTask(ctx, idArg(rest[0]), { includeDeleted: true });
        if (!t) throw new Error('No such task.');
        printTasks(cx, [t]);
        {
          const { all } = loadRates(ctx);
          const e = effectiveEstimate(t, all, loadLearnedRates(ctx, all));
          if (e.source === 'size') console.log(`  estimate: ${e.minutes} min, size-based: ${e.formula}`);
          else if (e.source === 'manual') console.log(`  estimate: ${e.minutes} min (${t.estimate_source ?? 'manual'})${e.size ? `. Size-based would be ${e.size.formula}` : ''}`);
          else if (t.size_unit && t.size_amount == null) console.log(`  estimate: none yet. Size unknown (${t.size_unit}); add it with: edit ${t.id} --size <amount> ${t.size_unit}`);
          else if (t.size_amount) console.log(`  estimate: none. No rate for ${t.size_amount} ${t.size_unit} in ${t.course ?? 'this course'} (config set size_rates)`);
          const bits = [t.size_unit ? `size ${t.size_amount ?? '?'} ${t.size_unit}` : '', t.available_from ? `available from ${t.available_from}` : '', t.optional ? 'optional (not scheduled unless include_optional_tasks)' : ''].filter(Boolean);
          if (bits.length) console.log(`  ${bits.join(' · ')}`);
        }
        {
          const bl = allBlockers(ctx, t.id);
          if (bl.length) console.log(`  blocked by: ${bl.map((b) => `#${b.id} ${b.title}${b.open ? '' : ' (done)'}`).join('; ')}`);
          const ds = dependents(ctx, t.id);
          if (ds.length) console.log(`  blocks: ${ds.map((d) => `#${d.id} ${d.title}`).join('; ')}`);
          if (t.parent_task_id) console.log(`  step of: #${t.parent_task_id} ${getTask(ctx, t.parent_task_id)?.title ?? ''}`);
          const steps = ctx.db.all<{ id: number; title: string; status: string }>('SELECT id, title, status FROM tasks WHERE parent_task_id = ? AND deleted_at IS NULL ORDER BY id', [t.id]);
          if (steps.length) console.log(`  steps: ${steps.map((s) => `#${s.id} ${s.title}${s.status === 'done' ? ' [done]' : ''}`).join('; ')}`);
        }
        if (t.notes) console.log(`  notes: ${t.notes}`);
        if (t.source_quote) console.log(`  source: “${t.source_quote}”`);
        if (t.deleted_at) console.log(`  DELETED ${formatLocal(t.deleted_at, ctx.tz)} (undo ${t.id})`);
        console.log(`  created ${formatLocal(t.created_at, ctx.tz)} · source ${t.source}${t.completed_at ? ` · completed ${formatLocal(t.completed_at, ctx.tz)}` : ''}`);
        break;
      }
      case 'ls':
      case 'search': {
        const f: TaskFilter = {
          scope: { term: o.term, allTerms: cli.flags.has('all-terms') },
          list: o.list, course: o.course, from: o.from, to: o.to,
          text: cmd === 'search' ? rest.join(' ') : o.q, deleted: cli.flags.has('deleted'),
          status: (o.status as TaskFilter['status']) ?? (cli.flags.has('done') ? 'done' : cli.flags.has('all') || cmd === 'search' ? undefined : 'open'),
        };
        console.log(`Showing: ${scopeNote(cx, cli)}`);
        let found = listTasks(ctx, f);
        if (cli.flags.has('needs-size')) {
          found = found.filter((t) => t.size_unit && t.size_amount == null && t.status !== 'done');
          console.log(`NEEDS SIZE: ${found.length} task(s) with a size unit but no amount (fill in with: edit <id> --size <amount> <unit>)`);
        }
        if (o.by || f.deleted) printTasks(cx, found, o.by);
        else printGrouped(cx, found);
        break;
      }
      case 'list': {
        const [sub, ...a] = rest;
        if (sub === 'new') console.log(`Created list "${createList(ctx, a.join(' '), { term: o.term }).name}"`);
        else if (sub === 'rename') console.log(`Renamed to "${renameList(ctx, a[0], a.slice(1).join(' ')).name}"`);
        else if (sub === 'rm') console.log(`Deleted list; ${deleteList(ctx, a.join(' ')).tasksUnlinked} task(s) kept without a list.`);
        else if (sub === 'ls' || !sub) {
          const terms = new Map(listTerms(ctx).map((t) => [t.id, t.name]));
          for (const l of listLists(ctx, { allTerms: cli.flags.has('all-terms') })) console.log(`${l.name}${l.term_id ? `  [term: ${terms.get(l.term_id)}]` : '  [all terms]'}`);
        } else throw new Error('Usage: list new|rename|rm|ls');
        break;
      }
      case 'term': {
        const [sub, ...a] = rest;
        const name = a.join(' ');
        if (sub === 'new') {
          if (!o.start || !o.end) throw new Error('Usage: term new <name> --start YYYY-MM-DD --end YYYY-MM-DD [--current]');
          const t = createTerm(ctx, { name, start_date: o.start, end_date: o.end }, { makeCurrent: cli.flags.has('current') });
          console.log(`Created term "${t.name}"${t.is_current ? ' (now current)' : ''}`);
        } else if (sub === 'use') console.log(`Current term: "${useTerm(ctx, name).name}"`);
        else if (sub === 'archive') console.log(`Archived "${archiveTerm(ctx, name).name}". Its data is kept; use --term "${name}" or --all-terms to see it.`);
        else if (sub === 'unarchive') console.log(`Unarchived "${unarchiveTerm(ctx, name).name}"`);
        else if (sub === 'ls' || !sub) {
          for (const t of listTerms(ctx)) {
            const n = ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM tasks WHERE term_id = ? AND deleted_at IS NULL', [t.id])!.c;
            console.log(`${t.is_current ? '*' : ' '} ${t.name}  ${t.start_date}..${t.end_date}  ${n} task(s)${t.archived_at ? '  [archived]' : ''}`);
          }
        } else throw new Error('Usage: term ls|new|use|archive|unarchive');
        break;
      }
      case 'backup': {
        const folder = o.folder ?? cx.backupFolder;
        const b = await createBackup(ctx, folder);
        const pruned = pruneBackups(folder, KEEP_BACKUPS);
        console.log(`Backup saved and verified (integrity check ok): ${b.path} (${b.bytes} bytes)`);
        if (pruned.length) console.log(`Pruned ${pruned.length} old backup(s); keeping the newest ${KEEP_BACKUPS}.`);
        break;
      }
      case 'backups': {
        const bs = listBackups(cx.backupFolder);
        console.log(`Backup folder: ${cx.backupFolder}`);
        if (!bs.length) console.log('(none yet)');
        for (const b of bs) console.log(`${b.name}  ${formatLocal(b.takenAt.toISOString(), ctx.tz)}  ${b.bytes} bytes  ${verifyBackup(b.path).ok ? 'ok' : 'FAILED INTEGRITY CHECK'}`);
        break;
      }
      case 'export': {
        const dir = resolve(o.out ?? join(appDataDir(), demo ? 'exports-demo' : 'exports'));
        mkdirSync(dir, { recursive: true });
        const now = ctx.clock.now();
        const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z/, '').replace('T', '-');
        const jsonPath = join(dir, `planner-export-${stamp}.json`);
        const icsPath = join(dir, `planner-export-${stamp}.ics`);
        writeFileSync(jsonPath, JSON.stringify(buildJsonExport(ctx.db, now), null, 2));
        writeFileSync(icsPath, buildIcs(ctx.db.all('SELECT * FROM tasks'), now));
        console.log(`Exported everything (archived terms and deleted tasks included):\n  ${jsonPath}\n  ${icsPath}`);
        break;
      }
      case 'restore': {
        if (!rest[0]) {
          const bs = listBackups(cx.backupFolder);
          console.log(`Backups in ${cx.backupFolder}:`);
          bs.forEach((b) => console.log(`  ${b.name}  ${formatLocal(b.takenAt.toISOString(), ctx.tz)}`));
          console.log('\nRestore with: npm run restore <file name or path>');
          break;
        }
        const target = existsSync(rest[0]) ? resolve(rest[0]) : join(cx.backupFolder, rest[0]);
        if (!existsSync(target)) throw new Error(`No such backup: ${target}`);
        const check = verifyBackup(target);
        if (!check.ok) throw new Error(`Backup failed its integrity check (${check.detail}); not restoring.`);
        console.log(`This will REPLACE your current database with:\n  ${target}\nYour current data is saved first as pre-restore-*.db in ${cx.backupFolder}.`);
        if (!cli.flags.has('yes')) {
          const rl = createInterface({ input: stdin, output: stdout });
          const ans = (await rl.question('Type "restore" to continue: ').catch(() => '')).trim();
          rl.close();
          if (ans !== 'restore') return console.log('Cancelled. Nothing changed.');
        }
        const dbFile = cx.dbFile, folder = cx.backupFolder, clock = ctx.clock;
        cx.close();
        const r = await restoreBackup(dbFile, target, folder, clock);
        console.log(`Restored. Previous database saved at: ${r.safetyBackup ?? '(none)'}`);
        return;
      }
      case 'log': {
        const id = idArg(rest[0]);
        const mins = num(rest[1], 'minutes');
        if (mins === undefined) throw new Error('Usage: log <id> <minutes> [--start 7:20pm]');
        const start = o.start ? parseNaturalDue(o.start, ctx.tz, ctx.clock, ctx.defaultTime).dueUtc! : undefined;
        const r = logWork(ctx, id, mins, start);
        const t = getTask(ctx, id)!;
        console.log(`Logged ${mins} min on #${id} "${t.title}" (${formatLocal(r.startedAt, ctx.tz)} to ${formatLocal(r.endedAt, ctx.tz)}). Total logged: ${r.total} min${t.estimated_minutes ? `; remaining estimate ${Math.max(0, t.estimated_minutes - r.total)} min` : ''}.`);
        break;
      }
      case 'timer':
        await cmdTimer(cx, idArg(rest[0]));
        return;
      case 'multipliers': {
        const table = loadMultipliers(ctx);
        if (!table.size) console.log('No history yet: complete tasks that have both an estimate and tracked time (timer).');
        for (const [type, e] of [...table].sort()) {
          console.log(`${type.padEnd(12)} ${e.multiplier.toFixed(2)}x  (${e.samples} sample${e.samples === 1 ? '' : 's'})${e.samples < MIN_SAMPLES ? `  not applied yet: needs ${MIN_SAMPLES}` : ''}`);
        }
        break;
      }
      case 'rates': {
        const [sub2, ...more] = rest;
        if (sub2 === 'set') {
          // rates set <minutes-per-unit> --unit points [--course "EECS 183"] [--match zyBooks]
          const m = Number(more[0]);
          // rates set 60 --per-assignment --course "EECS 183" --match Lab   (a flat time for every matching task; no size or unit needed)
          const r = setRate(ctx, { unit: o.unit ?? '', minutes_per_unit: m, course: o.course, title_match: o.match, per_assignment: cli.flags.has('per-assignment') });
          return console.log(`Saved: ${describeRule(r)}. It is tried before the built-in rates; ones you set later come first.`);
        }
        if (sub2 === 'rm') { const g = removeRate(ctx, Number(more[0])); return console.log(`Removed: ${describeRule(g)}`); }
        const { user, all } = loadRates(ctx);
        const learned = loadLearnedRates(ctx, all);
        console.log('YOUR RATES (tried first, in this order):');
        if (!user.length) console.log('  (none)');
        user.forEach((r, i) => console.log(`  ${i + 1}. ${describeRule(r)}${learned.has(rateKey(r)) ? `   [learned: ${learned.get(rateKey(r))!.minutesPerUnit} from ${learned.get(rateKey(r))!.samples} finished tasks]` : ''}`));
        console.log('BUILT-IN RATES:');
        all.slice(user.length).forEach((r) => console.log(`  ${describeRule(r)}${learned.has(rateKey(r)) ? `   [learned: ${learned.get(rateKey(r))!.minutesPerUnit} from ${learned.get(rateKey(r))!.samples} finished tasks]` : ''}`));
        console.log(`Set one:  npm run plan -- rates set 0.3 --unit points --course "EECS 183" --match zyBooks     (units: ${SIZE_UNITS.join(', ')}; decimals are fine)\n          or a flat time per task:  npm run plan -- rates set 60 --per-assignment --course "EECS 183" --match Lab`);
        break;
      }
      case 'schedule':
      case 'replan':
        await runSchedule(cx, cli, cmd === 'replan');
        break;
      case 'calendar':
        await runCalendar(cx, cli, rest);
        break;
      case 'dep': {
        const [sub, a1, a2] = rest;
        if (sub === 'add') { addDependency(ctx, idArg(a1), idArg(a2)); console.log(`#${a1} is now blocked by #${a2}.`); }
        else if (sub === 'rm') console.log(removeDependency(ctx, idArg(a1), idArg(a2)) ? `#${a1} is no longer blocked by #${a2}.` : 'No such dependency.');
        else if (sub === 'ls' || !sub) {
          const rows = a1 ? [idArg(a1)] : ctx.db.all<{ t: number }>('SELECT DISTINCT task_id t FROM dependencies ORDER BY t').map((r) => r.t);
          if (!rows.length) return console.log('(no dependencies)');
          for (const id of rows) {
            const t = getTask(ctx, id);
            if (!t) continue;
            console.log(`#${id} ${t.title}${t.status === 'done' ? ' [done]' : ''}`);
            for (const b of allBlockers(ctx, id)) console.log(`    blocked by #${b.id} ${b.title}  ${b.open ? 'OPEN' : '(done/deleted)'}`);
            if (a1) for (const d of dependents(ctx, id)) console.log(`    blocks #${d.id} ${d.title}`);
          }
        } else throw new Error('Usage: dep add <task> <blocked-by-task> | dep rm <task> <blocker> | dep ls [task]');
        break;
      }
      case 'views': {
        const v = computeViews(ctx, { scope: { term: o.term, allTerms: cli.flags.has('all-terms') } });
        const s = loadViewSettings(ctx);
        const show = (title: string, items: ViewItem[], empty: string) => {
          console.log(`\n${title} (${items.length})`);
          if (!items.length) return console.log(`  ${empty}`);
          for (const i of items) console.log(`  #${String(i.task.id).padEnd(4)} ${i.task.course ? i.task.course + ' · ' : ''}${i.task.title}\n         ${i.reason}`);
        };
        console.log(`Showing: ${scopeNote(cx, cli)}`);
        show(`DUE SOON (next ${s.dueSoonHours} hours, plus overdue)`, v.dueSoon, 'nothing due soon');
        console.log(`\nHIGH GRADE IMPACT (top ${s.impactLimit}: grade weight x urgency x effort; overdue excluded)`);
        if (!v.highImpact.length) console.log('  no graded work due ahead');
        for (const i of v.highImpact) console.log(`  #${String(i.task.id).padEnd(4)} ${i.task.course ? i.task.course + ' · ' : ''}${i.task.title}   score ${i.score.toFixed(2)}\n         ${i.reason}`);
        show(`QUICK WINS (${s.quickWinMinutes} min or less, unblocked)`, v.quickWins, 'no quick wins');
        show('BLOCKED', v.blocked, 'nothing is blocked');
        break;
      }
      case 'away':
        runAway(cx, rest);
        break;
      case 'availability':
        await runAvailability(cx, cli, rest);
        break;
      case 'estimates': {
        const rows = estimateDiff(ctx);
        if (!rows.length) return console.log('No differences: every sized task already uses its size-based estimate (or has none to compare).');
        console.log(`${'id'.padEnd(5)}${'task'.padEnd(52)}${'now'.padEnd(18)}${'size-based'.padEnd(12)}formula`);
        for (const r of rows) {
          const name = `${r.task.course ? r.task.course + ' · ' : ''}${r.task.title}`.slice(0, 50);
          console.log(`#${String(r.task.id).padEnd(4)}${name.padEnd(52)}${(r.current == null ? 'none' : `${r.current} min (${r.currentSource})`).padEnd(18)}${`${r.sizeBased} min`.padEnd(12)}${r.formula}`);
        }
        if (cli.flags.has('apply')) {
          for (const r of rows) editTask(ctx, r.task.id, { estFromSize: true });
          console.log(`\nSwitched ${rows.length} task(s) to their size-based estimate.`);
        } else console.log(`\n${rows.length} difference(s). Nothing changed. To switch them all: npm run plan -- estimates --apply   (or one at a time: edit <id> --est-from-size)`);
        break;
      }
      case 'doctor': {
        const checks = runDoctor({ ctx, dbFile: cx.dbFile, backupFolder: cx.backupFolder, backupFolderConfigured: !!getSetting(ctx.db, 'backup_folder') });
        for (const c of checks) console.log(`[${c.status.toUpperCase()}] ${c.name}: ${c.detail}`);
        const failed = checks.filter((c) => c.status === 'fail').length;
        const warned = checks.filter((c) => c.status === 'warn').length;
        console.log(hasFailures(checks) ? `\n${failed} problem(s) to fix${warned ? `, ${warned} warning(s)` : ''}.` : `\nAll checks passed${warned ? ` (${warned} warning(s))` : ''}.`);
        if (hasFailures(checks)) process.exitCode = 1;
        break;
      }
      case 'config': {
        if (rest[0] === 'set') {
          const [, key, ...v] = rest;
          const value = v.join(' ');
          if (key === 'timezone') assertTimezone(value);
          else if (key === 'default_due_time') { if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('default_due_time must be HH:mm, e.g. 23:59'); }
          else if (key === 'backup_folder') { if (value) mkdirSync(value, { recursive: true }); }
          else if (key === 'working_hours') {
            const text = value.startsWith('@') ? readFile(resolve(value.slice(1)), 'utf8') : value;
            let json: unknown;
            try { json = JSON.parse(text); } catch (e) { throw new Error(`working_hours must be JSON or @file.json (${(e as Error).message})`); }
            if (o.term) saveTermWorkingHours(ctx, getTermByName(ctx, o.term).id, json);
            else saveWorkingHoursJson(ctx, json);
            return console.log(o.term ? `Saved working-hours override for term "${o.term}".` : 'Saved working hours.');
          }
          else if (key === 'class_calendars' || key === 'busy_calendars') {
            const ids = value.split(',').map((x) => x.trim()).filter(Boolean);
            if (key === 'class_calendars') saveClassCalendars(ctx, ids);
            else if (value.trim().toLowerCase() === 'all') ctx.db.run("DELETE FROM settings WHERE key = 'busy_calendars'");
            else saveBusyCalendars(ctx, ids);
            return console.log(`${key} = ${value}`);
          }
          else if (key === 'size_rates') {
            const text = value.startsWith('@') ? readFile(resolve(value.slice(1)), 'utf8') : value;
            try { JSON.parse(text); } catch (e) { throw new Error(`size_rates must be JSON or @file.json (${(e as Error).message})`); }
            setSetting(ctx.db, key, text);
            loadRates(ctx); // validates
            return console.log('Saved size_rates (your rules are tried before the built-in defaults).');
          }
          else if (VIEW_KEYS.includes(key)) {
            const v = checkViewSetting(key, value);
            setSetting(ctx.db, key, v);
            return console.log(`${key} = ${v}`);
          }
          else if (SCHEDULE_KEYS.includes(key)) {
            const v = checkScheduleSetting(key, value);
            setSetting(ctx.db, key, v);
            return console.log(`${key} = ${v}`);
          }
          else throw new Error(`Settable keys: timezone, default_due_time, backup_folder, working_hours (seed input only), class_calendars, busy_calendars, size_rates, ${SCHEDULE_KEYS.join(', ')}, ${VIEW_KEYS.join(', ')}`);
          setSetting(ctx.db, key, value);
          console.log(`${key} = ${value}`);
        } else if (rest[0] === 'get' && rest[1] === 'working_hours') {
          const w = loadWorkingHours(ctx, o.term ? getTermByName(ctx, o.term).id : currentTerm(ctx)?.id);
          console.log(`${w.usingDefault ? '(built-in default; nothing saved)\n' : ''}${JSON.stringify(w.hours, null, 2)}`);
        } else {
          console.log(`timezone         ${getSetting(ctx.db, 'timezone')}`);
          console.log(`availability     ${ctx.db.get<{ c: number }>('SELECT COUNT(*) c FROM availability_windows')!.c} window(s)  (availability show)`);
          console.log(`placement_style  ${getSetting(ctx.db, 'placement_style') ?? 'early (default)'}`);
          console.log(`working_hours    ${loadWorkingHours(ctx).usingDefault ? 'none saved' : 'saved; used ONLY as input for: availability seed'}`);
          console.log(`class_calendars  ${(getClassCalendars(ctx) ?? []).join(', ') || '(not set)'}`);
          console.log(`busy_calendars   ${(getBusyCalendars(ctx) ?? ['all except Planner Blocks']).join(', ')}`);
          console.log(`default_due_time ${getSetting(ctx.db, 'default_due_time')}`);
          console.log(`backup_folder    ${backupFolderFor(getSetting(ctx.db, 'backup_folder'), cx.dbFile, demo)}${getSetting(ctx.db, 'backup_folder') ? '' : '  (default; point this at a cloud-synced folder)'}`);
          console.log(`database         ${cx.dbFile}`);
        }
        break;
      }
      default:
        throw new Error(`Unknown command "${cmd}". Run: npm run plan -- help`);
    }
  } finally {
    try { cx.close(); } catch { /* already closed */ }
  }
}

run().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
