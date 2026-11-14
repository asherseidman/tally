// A fixed, FAKE set of tasks for UI screenshots (demo database only: run with PLANNER_DEMO_DB pointing at a scratch file).
// Fake courses, due dates relative to now, a running timer, a blocked task, so every panel on Today has something to show.
import { openContext } from '../src/cli/context';
import { addTask, editTask } from '../src/core/tasks';
import { logWork } from '../src/core/timer';
import { addDependency } from '../src/core/dependencies';
import { createList } from '../src/core/lists';
import { setWindow } from '../src/schedule/availabilityWindows';
import { DateTime } from 'luxon';

if (!process.env.PLANNER_DEMO_DB) { console.error('Refusing: set PLANNER_DEMO_DB to a scratch file.'); process.exit(2); }
const cx = await openContext(true);
const ctx = cx.ctx;
const at = (days: number, hhmm: string) => DateTime.now().setZone(ctx.tz).plus({ days }).toFormat('yyyy-MM-dd') + 'T' + hhmm;
try { createList(ctx, 'Personal'); } catch { /* exists */ }
const ps = addTask(ctx, { title: 'Problem Set 6', course: 'CHEM 130', type: 'homework', due: at(1, '23:59'), est: 90, weight: 4 });
const paper = addTask(ctx, { title: 'Response paper 3', course: 'HIST 210', type: 'homework', due: at(2, '17:00'), est: 120, weight: 10 });
addTask(ctx, { title: 'Quiz 4', course: 'STATS 250', type: 'quiz', due: DateTime.now().setZone(ctx.tz).plus({ hours: 6 }).toFormat("yyyy-MM-dd'T'HH:mm"), est: 20, weight: 2 });
addTask(ctx, { title: 'Read chapter 5', course: 'ENGLISH 125', type: 'reading', due: at(3, '09:00'), est: 15 });
addTask(ctx, { title: 'Midterm 2', course: 'CHEM 130', type: 'exam', due: at(5, '19:00'), est: 300, weight: 20 });
addTask(ctx, { title: 'Email advisor about spring classes', list: 'Personal', due: at(1, '12:00'), est: 10 });
const draft = addTask(ctx, { title: 'Final paper draft', course: 'HIST 210', type: 'project', due: at(6, '23:59'), est: 240, weight: 15 });
addDependency(ctx, draft.id, paper.id);
ctx.db.run('INSERT INTO time_sessions(task_id, started_at) VALUES(?,?)', [ps.id, new Date(Date.now() - 25 * 60_000).toISOString()]);
addTask(ctx, { title: 'Renew parking permit', list: 'Personal', due: at(4, '17:00'), est: 15 });
addTask(ctx, { title: 'Call the bank about the card', list: 'Personal', est: 10 });
addTask(ctx, { title: 'Plan weekend trip', list: 'Personal', due: at(8, '12:00'), est: 45 });
// size-based work for the Rates screen (fake course CS 101: zyBooks-style points; HIST 210: pages)
const sz = (id: number, amount: number, unit: 'points' | 'pages') => editTask(ctx, id, { size: { amount, unit } });
sz(addTask(ctx, { title: 'Lecture 4 zyBooks', course: 'CS 101', type: 'homework', due: at(10, '23:59') }).id, 100, 'points');
sz(addTask(ctx, { title: 'Lecture 5 zyBooks', course: 'CS 101', type: 'homework', due: at(12, '23:59') }).id, 80, 'points');
addTask(ctx, { title: 'Lecture 6 zyBooks', course: 'CS 101', type: 'homework', due: at(14, '23:59') });
for (const [n, pts, min] of [[1, 100, 36], [2, 100, 40], [3, 90, 33]] as const) {
  const t = addTask(ctx, { title: `Lecture ${n} zyBooks`, course: 'CS 101', type: 'homework', due: at(-6 + n, '23:59') });
  sz(t.id, pts, 'points');
  ctx.db.run("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?", [new Date(Date.now() - n * 86_400_000).toISOString(), t.id]);
  logWork(ctx, t.id, min);
}
sz(addTask(ctx, { title: 'Course Pack reading 7', course: 'HIST 210', type: 'reading', due: at(9, '12:00') }).id, 30, 'pages');
sz(addTask(ctx, { title: 'Course Pack reading 8', course: 'HIST 210', type: 'reading', due: at(11, '12:00') }).id, 25, 'pages');
// weekly free time, so Schedule and Availability have something to show
for (let wd = 1; wd <= 7; wd++) setWindow(ctx, { weekday: wd }, wd >= 6 ? { start: '10:00', end: '18:00' } : { start: '09:00', end: '21:00' }, 'free');
cx.close();
console.log('fixture ready');
