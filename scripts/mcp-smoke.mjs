// npm run smoke:mcp. Starts the BUILT connector (dist-mcp/tally-mcp.mjs) against the DEMO database, as a Claude client would, and exercises
// every tool. Part B also launches the demo Tally app (a real Electron window) so schedule previews are answered by the app and an apply
// request is approved / rejected inside it. Demo database and the app's simulated calendar only: nothing touches your real data or Google.
// The script flips the three connector switches in the DEMO database (as you would in Settings) and turns them all off again at the end.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import BetterSqlite3 from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const demo = join(homedir(), 'Library', 'Application Support', 'todo-planner', 'demo.db');
const db = new BetterSqlite3(demo);
db.pragma('busy_timeout = 5000');
const setSwitch = (key, on) => db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, on ? 'true' : 'false');
const SW = { writes: 'mcp_allow_writes', deletes: 'mcp_allow_deletes', schedule: 'mcp_allow_schedule' };
const allOff = () => Object.values(SW).forEach((k) => setSwitch(k, false));
allOff();

const t = new StdioClientTransport({ command: process.execPath, args: [resolve('dist-mcp/tally-mcp.mjs')], env: { ...process.env, TALLY_MCP_DB: demo, TALLY_MCP_EXPECT: 'demo', TALLY_MCP_PREVIEW_WAIT_MS: '45000', TALLY_MCP_GOOGLE_WAIT_MS: '5000' }, stderr: 'pipe' });
let err = '';
const c = new Client({ name: 'smoke', version: '1' });
await c.connect(t);
t.stderr?.on('data', (b) => { err += b; });
const call = async (name, args = {}) => {
  try {
    const r = await c.callTool({ name, arguments: args });
    const text = r.content[0].text;
    let data = null; try { data = JSON.parse(text); } catch { /* plain text */ }
    return { isError: !!r.isError, text, data };
  } catch (e) { return { isError: true, text: String(e.message), data: null }; }
};
let failed = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${String(extra).replace(/\s+/g, ' ').slice(0, 150)})` : ''}`); if (!cond) failed++; };
const q = (sql, ...p) => db.prepare(sql).all(...p);
let app;
let appOut = '';

try {
  // ---------------------------------------------------------------- Part A: the connector alone
  console.log('--- Part A: the connector alone (demo database)');
  const tools = (await c.listTools()).tools.map((x) => x.name);
  check('lists 29 tools', tools.length === 29, tools.length);
  const st = await call('tally_status');
  check('says it is the DEMO database', st.data?.database?.kind === 'demo', st.data?.database?.path);
  check('all three switches are off', st.data && !st.data.claudeMayChangeTasks && !st.data.claudeMayDeleteTasks && !st.data.claudeMayRequestScheduleApply);
  check('banner on stderr names the database', /DEMO database/.test(err), err.split('\n')[0]);
  for (const n of ['list_tasks', 'get_views', 'get_free_time', 'get_settings', 'get_timer', 'get_pending_apply', 'get_review']) {
    const r = await call(n, n === 'get_free_time' ? { days: 3 } : {});
    check(`${n} works`, !r.isError, r.text.slice(0, 60));
  }
  const ftClosed = await call('get_free_time', { days: 2, include_google: true });
  check('get_free_time include_google with Tally closed: the Tally-only answer plus a warning', !ftClosed.isError && ftClosed.data.googleIncluded === false && /NOT included: Tally is not open/.test(ftClosed.data.warning ?? ''), ftClosed.data?.warning);
  check('no tool can create, move or remove a pinned block', !tools.some((n) => /pin/.test(n)));
  check('get_settings has no secrets', !/token|client|refresh|calendar_id|google/i.test(JSON.stringify((await call('get_settings')).data)));
  const open = (await call('list_tasks', { limit: 20 })).data.tasks;
  const t1 = open[0];
  const refusals = [['add_task', { title: 'x' }], ['edit_task', { id: t1.id, read_updated_at: t1.updatedAt, title: 'x' }], ['create_list', { name: 'x' }], ['add_step', { parent: t1.id, title: 'x' }],
    ['start_timer', { id: t1.id }], ['stop_timer', {}], ['remove_dependency', { task: t1.id, blocked_by: open[1].id }], ['delete_task', { id: t1.id }]];
  for (const [n, a] of refusals) { const r = await call(n, a); check(`${n} is refused while the switches are off`, r.isError && /turned off/.test(r.text), r.text.slice(0, 60)); }
  const ap = await call('apply_schedule', { preview_id: '3f2b8f0e-6a8e-4a52-9d4c-0e6f6a1d2b11' });
  check('apply_schedule is refused while its switch is off', ap.isError && /applying schedules is turned off/.test(ap.text));
  const before = q('SELECT COUNT(*) n FROM tasks')[0].n;
  check('nothing was written by any refused call', q('SELECT COUNT(*) n FROM tasks')[0].n === before && q('SELECT COUNT(*) n FROM change_log')[0].n === 0);

  console.log('--- Part A: full editing, lists, steps, dependencies, timers, delete (switches on)');
  setSwitch(SW.writes, true);
  setSwitch(SW.deletes, true);
  const added = await call('add_task', { title: 'SMOKE mcp task fri 5pm', course: t1.course ?? undefined, estimate_minutes: 30 });
  check('add_task understands the date in the title', !added.isError && added.data.task.title === 'SMOKE mcp task' && !!added.data.task.due, added.text.slice(0, 80));
  const id1 = added.data.task.id;
  const other = await call('add_task', { title: 'SMOKE mcp second', course: t1.course ?? undefined });
  const id2 = other.data.task.id;
  let task = (await call('get_task', { id: id1 })).data.task;
  const e1 = await call('edit_task', { id: id1, read_updated_at: task.updatedAt, title: 'SMOKE mcp edited', notes: 'from the smoke test', type: 'homework', grade_weight: 3, optional: true, available_from: '2027-01-01', size: { amount: 4, unit: 'problems' }, estimate_minutes: 45 });
  check('edit_task edits many fields at once and reports each from/to', !e1.isError && e1.data.updated[0].changes.title.to === 'SMOKE mcp edited' && e1.data.updated[0].changes.size_amount.to === 4, e1.text.slice(0, 100));
  check('a manual estimate stays manual', q('SELECT estimate_source s, estimated_minutes m FROM tasks WHERE id = ?', id1)[0].s === 'manual');
  db.prepare("UPDATE tasks SET notes = 'edited in Tally', updated_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(id1); // the user edits it in the app
  const stale = await call('edit_task', { id: id1, read_updated_at: e1.data.task.updatedAt, title: 'should be refused' });
  check('an edit from a stale read is refused', stale.isError && /changed in Tally after you read it/.test(stale.text), stale.text.slice(0, 80));
  check('...and wrote nothing', q('SELECT title, notes FROM tasks WHERE id = ?', id1)[0].title === 'SMOKE mcp edited');
  const lc = await call('create_list', { name: 'SMOKE MCP list' });
  const lr = await call('rename_list', { name: 'SMOKE MCP list', new_name: 'SMOKE MCP renamed' });
  task = (await call('get_task', { id: id2 })).data.task;
  const mv = await call('move_task_to_list', { id: id2, list: 'SMOKE MCP renamed', read_updated_at: task.updatedAt });
  check('create_list, rename_list, move_task_to_list', !lc.isError && !lr.isError && !mv.isError, [lc, lr, mv].map((x) => x.isError).join());
  const step = await call('add_step', { parent: id2, title: 'SMOKE step one', estimate_minutes: 10 });
  check('add_step creates a child task', !step.isError && q('SELECT parent_task_id p FROM tasks WHERE id = ?', step.data.step.id)[0].p === id2);
  const dep = await call('add_dependency', { task: id1, blocked_by: id2 });
  check('add_dependency', !dep.isError);
  const del1 = await call('delete_task', { id: id2 });
  check('delete_task is refused while open tasks wait on it', del1.isError && /waiting on/.test(del1.text) && /force: true/.test(del1.text), del1.text.slice(0, 90));
  const rd = await call('remove_dependency', { task: id1, blocked_by: id2 });
  check('remove_dependency', !rd.isError && rd.data.changed);
  await call('add_dependency', { task: id1, blocked_by: id2 });
  const del2 = await call('delete_task', { id: id2, force: true });
  check('delete_task force: soft delete, appears in the change log', !del2.isError && q('SELECT deleted_at d FROM tasks WHERE id = ?', id2)[0].d !== null && q("SELECT 1 FROM change_log WHERE tool = 'delete_task'").length === 1, del2.text.slice(0, 80));
  const s1 = await call('start_timer', { id: id1 });
  check('start_timer', !s1.isError && s1.data.running.length === 1);
  const other3 = (await call('list_tasks', { limit: 5 })).data.tasks.find((x) => x.id !== id1 && x.status !== 'done');
  const s2 = await call('start_timer', { id: other3.id });
  check('starting another timer stops and records the first', !s2.isError && s2.data.stoppedAndRecorded.length === 1 && q('SELECT COUNT(*) n FROM time_sessions WHERE ended_at IS NULL')[0].n === 1);
  const gt = await call('get_timer');
  check('get_timer shows the running timer', gt.data.running.length === 1 && gt.data.running[0].taskId === other3.id);
  const sp = await call('stop_timer');
  check('stop_timer records the session', !sp.isError && sp.data.recorded.length === 1 && q('SELECT COUNT(*) n FROM time_sessions WHERE ended_at IS NULL')[0].n === 0);
  check('every change is in the change log (and the call log has entries)', q('SELECT COUNT(*) n FROM change_log')[0].n >= 10 && q('SELECT COUNT(*) n FROM connector_calls')[0].n >= 20);
  check('the call log keeps at most 50', q('SELECT COUNT(*) n FROM connector_calls')[0].n <= 50);

  // ---------------------------------------------------------------- Part B: with the demo app running
  console.log('--- Part B: previews and the approval flow, with the demo Tally app open (its simulated calendar)');
  const electron = createRequire(import.meta.url)('electron');
  app = spawn(electron, ['.'], { env: { ...process.env, PLANNER_DEMO: '1', PLANNER_SELFTEST: '/tmp/mcp-smoke.png', PLANNER_SELFTEST_SCRIPT: 'scripts/smoke-approver.js', PLANNER_SELFTEST_WAIT: '3000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', (b) => { appOut += b; });
  app.stderr.on('data', (b) => { appOut += b; });
  const exited = new Promise((r) => app.on('exit', r));

  let pv;
  for (let i = 0; i < 4; i++) { pv = await call('preview_schedule', { days: 14 }); if (!pv.isError) break; }
  check('preview_schedule is answered by the app', !pv.isError && !!pv.data?.previewId, pv.text.slice(0, 100));
  const p = pv.data;
  check('it has the Schedule screen sections and an id and timestamp', p && ['blocks', 'tentative', 'doesNotFit', 'notScheduled', 'moved', 'trimmed'].every((k) => k in p) && !!p.previewedAt, Object.keys(p ?? {}).join());
  check('it names the simulated calendar and wrote nothing', p?.calendar?.simulated === true && p.calendar.name === 'Planner Blocks' && q('SELECT COUNT(*) n FROM scheduled_blocks')[0].n === (q('SELECT COUNT(*) n FROM scheduled_blocks')[0].n));
  const ftOpen = await call('get_free_time', { days: 3, include_google: true });
  check('get_free_time include_google, answered by the app: free intervals only, no calendar names or ids', !ftOpen.isError && ftOpen.data.googleIncluded === true && Array.isArray(ftOpen.data.days?.[0]?.free) && !/SIMULATED classes|simulated-classes/.test(ftOpen.text), ftOpen.text.slice(0, 120));
  const gs = await call('get_schedule', { days: 7, include_google: true });
  check('get_schedule include_google lists conflicts without describing the busy time', !gs.isError && gs.data.googleIncluded === true && Array.isArray(gs.data.conflicts) && !/SIMULATED classes|simulated-classes/.test(gs.text), `${gs.data?.conflicts?.length ?? '?'} conflicts`);
  // the user pins a block in Tally (here: written straight into the demo database); Claude sees it as pinned, read only
  const pinTask = q("SELECT id, due_date FROM tasks WHERE status <> 'done' AND deleted_at IS NULL AND due_date > ? ORDER BY due_date LIMIT 1", new Date(Date.now() + 5 * 86400000).toISOString())[0];
  const pinStart = new Date(Math.ceil((Date.now() + 2 * 86400000) / 3600000) * 3600000);
  const pinRow = pinTask ? db.prepare('INSERT INTO pins(task_id, start, "end", created_at, updated_at) VALUES(?,?,?,?,?)').run(pinTask.id, pinStart.toISOString(), new Date(pinStart.getTime() + 3600000).toISOString(), new Date().toISOString(), new Date().toISOString()) : null;
  const pp = await call('preview_schedule', { days: 7 });
  check('a pinned block shows as pinned in the preview', !!pinRow && !pp.isError && pp.data.blocks.some((b) => b.pinned && b.taskId === pinTask.id && b.start === pinStart.toISOString()), pinTask ? `task #${pinTask.id}` : 'no task to pin');
  if (pinRow) db.prepare('DELETE FROM pins WHERE id = ?').run(pinRow.lastInsertRowid);
  const rp = await call('preview_replan', { days: 7 });
  check('preview_replan works', !rp.isError && rp.data.mode === 'replan');

  const tStart = Date.now();
  await call('start_timer', { id: id1 });
  setSwitch(SW.schedule, true);
  const blocksBefore = q('SELECT COUNT(*) n FROM scheduled_blocks')[0].n;
  const pv1 = await call('preview_schedule', { days: 14 });
  const ask = await call('apply_schedule', { preview_id: pv1.data.previewId });
  check('apply_schedule only creates a PENDING request', !ask.isError && ask.data.status === 'pending', ask.text.slice(0, 100));
  const waitFor = async (id, want, ms = 60000) => { const until = Date.now() + ms; for (;;) { const r = await call('get_pending_apply', { apply_id: id }); if (r.data?.status === want || Date.now() > until) return r; await new Promise((x) => setTimeout(x, 400)); } };
  const applied = await waitFor(ask.data.applyId, 'applied');
  check('after Approve in the app, get_pending_apply says applied', applied.data?.status === 'applied', applied.text.slice(0, 120));
  const blocksAfter = q('SELECT COUNT(*) n FROM scheduled_blocks')[0].n;
  check('the app wrote the blocks (to its simulated calendar and the database)', blocksAfter === ask.data.willWrite && blocksAfter > 0, `${blocksBefore} -> ${blocksAfter}`);

  const pv2 = await call('preview_schedule', { days: 14 });
  const ask2 = await call('apply_schedule', { preview_id: pv2.data.previewId });
  check('a second request is made', !ask2.isError && ask2.data.status === 'pending', ask2.text.slice(0, 100));
  const rejected = await waitFor(ask2.data.applyId, 'rejected');
  check('after Reject in the app, get_pending_apply says rejected', rejected.data?.status === 'rejected', rejected.text.slice(0, 120));
  check('a rejected request wrote nothing', q('SELECT COUNT(*) n FROM scheduled_blocks')[0].n === blocksAfter);
  await new Promise((r) => setTimeout(r, 4000)); // give the window time to poll the timer
  await call('stop_timer');

  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 40000))]);
  if (code === 'timeout') app.kill();
  const m = /SMOKEUI (\{.*\})/.exec(appOut);
  const ui = m ? JSON.parse(m[1]) : null;
  check('the app saw the approve and reject through its own buttons\' channels', ui?.decisions?.length === 2 && ui.decisions[0].action === 'approve' && ui.decisions[0].ok && ui.decisions[1].action === 'reject' && ui.decisions[1].ok, JSON.stringify(ui?.decisions ?? appOut.slice(-300)));
  check('each request produced exactly one in-app banner ("Claude proposed a schedule: N blocks to write, M to remove...")', ui?.claudeBannerIds?.length === 2 && /\d+ blocks? to write, \d+ to remove\. Review on the Schedule tab/.test(ui.claudeBannerText ?? ''), ui?.claudeBannerText ?? 'no banner seen');
  const seenAfter = ui?.timerSeenAt ? ui.timerSeenAt - tStart : null;
  check('the open Tally window picked up the timer Claude started within a few seconds', seenAfter !== null && seenAfter < 9000, seenAfter === null ? 'never seen' : `${Math.round(seenAfter / 100) / 10} s`);
} catch (e) {
  console.log(`FAIL  unexpected error: ${e.stack || e}`);
  failed++;
} finally {
  allOff();
  db.close();
  try { await c.close(); } catch { /* closed */ }
  if (app && app.exitCode === null) app.kill();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nconnector smoke test passed (switches in the demo database are off again)');
process.exit(failed ? 1 : 0);
