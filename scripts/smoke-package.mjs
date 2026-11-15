// Runs the whole UI self-test suite against the PACKAGED app (release/mac-arm64/Tally.app), on the demo database only.
// Same four launches as npm run smoke:ui (window UI, quick-add window, menu-bar icon, and a restart check), plus the real-process quit check.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const FAKE_REMINDERS = '/tmp/planner-pkg-fake-reminders.json';
import { join } from 'node:path';

const app = process.env.PLANNER_APP || 'release/mac-arm64/Tally.app';
const bin = join(app, 'Contents/MacOS/Tally');
if (!existsSync(bin)) { console.error(`Not found: ${bin}. Run: npm run build`); process.exit(1); }
execFileSync('npx', ['tsx', 'src/cli/seed.ts'], { stdio: 'ignore' }); // a fresh DEMO database
const base = { ...process.env, PLANNER_DEMO: '1' };
delete base.ELECTRON_RUN_AS_NODE;
const launch = (extra, timeout = 120000) => spawnSync(bin, [], { env: { ...base, ...extra }, encoding: 'utf8', timeout });
const grab = (out, prefix) => out.split('\n').filter((l) => l.startsWith(prefix)).map((l) => JSON.parse(l.slice(prefix.length)));
let failures = 0;
const report = (title, steps) => {
  const bad = steps.filter((s) => !s.ok);
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${title}: ${steps.length - bad.length}/${steps.length} steps`);
  for (const b of bad) { console.log(`        - ${b.name}: ${String(b.error).slice(0, 220)}`); }
  if (bad.length) failures++;
};

execFileSync('node', ['scripts/seed-fake-reminders.mjs', FAKE_REMINDERS], { stdio: 'ignore' }); // PRETEND Reminders for the phone-capture steps
const ui = launch({ PLANNER_FAKE_REMINDERS: FAKE_REMINDERS, PLANNER_NOTIFY_TIMEOUT_MS: '300', PLANNER_SELFTEST: '/tmp/planner-pkg-ui.png', PLANNER_SELFTEST_SCRIPT: 'scripts/smoke-ui.js' });
const u = grab(ui.stdout, 'SMOKEUI ')[0];
if (!u) { console.log('FAIL  window UI: no report\n' + (ui.stdout + ui.stderr).slice(0, 600)); failures++; } else { report('window UI (the CSP-protected packaged page)', u.steps); if (u.errors.length) { console.log('        alerts on screen: ' + u.errors.join(' | ')); failures++; } }
const re = launch({ PLANNER_SELFTEST: '/tmp/planner-pkg-ui2.png', PLANNER_SELFTEST_SCRIPT: 'scripts/smoke-restart.js' });
const r = grab(re.stdout, 'SMOKEUI ')[0];
if (r) report('after a restart', r.steps); else { console.log('FAIL  restart check: no report'); failures++; }
const q = launch({ PLANNER_SELFTEST_QUICK_SCRIPT: 'scripts/smoke-quick.js' });
const qq = grab(q.stdout, 'SMOKEQUICK ')[0];
if (qq) { report('quick-add window', qq.result.steps); if (!qq.reopened || qq.afterVisible) { console.log('FAIL  quick window hide/reopen'); failures++; } } else { console.log('FAIL  quick-add window: no report'); failures++; }
const t = launch({ PLANNER_SELFTEST_TRAY: '1' });
const tt = grab(t.stdout, 'SMOKETRAY ')[0];
if (tt) report('menu-bar icon', tt.steps); else { console.log('FAIL  menu-bar icon: no report\n' + (t.stdout + t.stderr).slice(0, 400)); failures++; }

execFileSync('node', ['scripts/seed-fake-google-client.mjs'], { stdio: 'ignore' }); // FAKE client files under /tmp, and no saved client
const gg = launch({ PLANNER_SELFTEST_GOOGLE_PANEL: '1', PLANNER_GOOGLE_CLIENT: '/tmp/planner-smoke-google/google-client.json', PLANNER_SELFTEST: '/tmp/planner-pkg-google.png', PLANNER_SELFTEST_SCRIPT: 'scripts/smoke-google.js' });
const g = grab(gg.stdout, 'SMOKEUI ')[0];
if (g) report('no Google client file / client-file panel', g.steps); else { console.log('FAIL  Google client panel: no report\n' + (gg.stdout + gg.stderr).slice(0, 400)); failures++; }

const quit = spawnSync('node', ['scripts/quit-flow-check.mjs'], { env: { ...process.env, PLANNER_APP_BIN: bin }, encoding: 'utf8', timeout: 180000 });
const results = [...quit.stdout.matchAll(/== choice: (\w+)[\s\S]*?RESULT: (PASS|FAIL)/g)].map((m) => `${m[1]}: ${m[2]}`);
console.log(`${quit.status === 0 ? 'PASS' : 'FAIL'}  quit with a running timer (real process): ${results.join(', ')}`);
if (quit.status !== 0) { failures++; console.log(quit.stdout.slice(-800)); }
console.log(failures ? `\n${failures} group(s) FAILED` : '\nEverything passed against the packaged app.');
process.exit(failures ? 1 : 0);
