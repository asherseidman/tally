// Real-flow check of "quit with a running timer" (demo database copy only; nothing touches your data or Google).
//   node scripts/quit-flow-check.mjs [stop|keep|cancel ...]
// For each choice: run the app, start a timer from the tray, call app.quit() (what Cmd+Q does), answer the dialog with the
// choice, then check: did the process really exit, what is in the database file, and what does a relaunch show.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const Database = require('better-sqlite3');

function run(env, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const bin = process.env.PLANNER_APP_BIN; // set to test the packaged app instead of the dev build
    const child = spawn(bin || electron, bin ? [] : ['.'], { env: { ...process.env, PLANNER_DEMO: '1', PLANNER_NO_OS_NOTIFICATIONS: '1', PLANNER_TRACE_STDOUT: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let exiting = null;
    const onData = (d) => { out += d; if (exiting === null && /finishing the quit|calling app\.quit/.test(String(d))) exiting = Date.now(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const started = Date.now();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ exited: false, code: null, ms: Date.now() - started, out, quitMs: null }); }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ exited: true, code, signal, ms: Date.now() - started, out, quitMs: exiting === null ? null : Date.now() - exiting }); });
  });
}
const line = (out, prefix) => { const m = out.split('\n').filter((l) => l.startsWith(prefix)).pop(); return m ? JSON.parse(m.slice(prefix.length)) : null; };
const sessions = (file) => { const db = new Database(file, { readonly: true }); try { return db.prepare('SELECT id, task_id, started_at, ended_at FROM time_sessions ORDER BY id').all(); } finally { db.close(); } };
const bad = (out) => out.split('\n').filter((l) => /Uncaught|TypeError|destroyed|Error:|A JavaScript error/.test(l) && !l.startsWith('QUITFLOW'));

let failures = 0;
for (const choice of process.argv.slice(2).length ? process.argv.slice(2) : ['stop', 'keep', 'cancel']) {
  const dir = mkdtempSync(join(tmpdir(), `quitflow-${choice}-`));
  const file = join(dir, 'demo.db');
  execFileSync('npx', ['tsx', 'src/cli/seed.ts'], { env: { ...process.env, PLANNER_DEMO_DB: file }, stdio: 'ignore' }); // a private, freshly seeded demo database
  const base = { PLANNER_DEMO_DB: file, PLANNER_SELFTEST_QUIT_FLOW: 'start-and-quit', PLANNER_QUIT_TIMER: choice };
  // for "cancel" the app must stay open; the autopilot then has nothing more to do, so we expect a timeout and kill it
  const r1 = await run(base, choice === 'cancel' ? 14000 : 25000);
  const q = line(r1.out, 'QUITFLOW ');
  const rows = sessions(file);
  const open = rows.filter((x) => !x.ended_at);
  console.log(`\n== choice: ${choice}`);
  console.log(`   timer started: ${q?.phase === 'quitting' ? `yes (session #${q.sessionId}, title "${q.title}")` : 'NO ' + JSON.stringify(q)}`);
  console.log(`   process exited by itself: ${r1.exited ? `yes (code ${r1.code}, after ${(r1.ms / 1000).toFixed(1)}s)` : 'NO (still running; killed after the timeout)'}`);
  if (r1.quitMs != null) console.log(`   from the decision to the process being gone: ${r1.quitMs} ms`);
  console.log(`   database: ${rows.length} session(s), ${open.length} open (no end time)`);
  const errs = bad(r1.out);
  if (errs.length) console.log('   errors printed:\n     ' + errs.slice(0, 5).join('\n     '));
  let ok = true;
  if (choice === 'keep') {
    ok = r1.exited && open.length === 1 && String(open[0].started_at) === q?.startedAt && r1.quitMs != null && r1.quitMs < 2000; // a decided quit must finish promptly
    if (open[0]) console.log(`   open session started_at ${open[0].started_at} (expected ${q?.startedAt})`);
    if (ok) {
      const r2 = await run({ PLANNER_DEMO_DB: file, PLANNER_SELFTEST_QUIT_FLOW: 'relaunch' });
      const x = line(r2.out, 'QUITFLOW ');
      console.log(`   relaunch: ${x ? JSON.stringify(x) : 'NO REPORT'}`);
      console.log(`   relaunch process exited: ${r2.exited}`);
      const full = x && x.elapsedMs >= 2000 && x.startedAt === q.startedAt && /\d+:\d\d/.test(x.trayTitle ?? '') && /\d/.test(x.timerBar ?? '');
      ok = !!full && r2.exited;
      console.log(`   relaunch shows the SAME session with the full elapsed time in the tray and the window: ${full ? 'yes' : 'NO'}`);
    }
  } else if (choice === 'stop') {
    ok = r1.exited && open.length === 0 && rows.length >= 1 && rows.every((x) => x.ended_at) && r1.quitMs != null && r1.quitMs < 2000;
  } else {
    ok = !r1.exited && open.length === 1; // cancel: still running, timer untouched
  }
  console.log(`   RESULT: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) failures++;
}
process.exit(failures ? 1 : 0);
