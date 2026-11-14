import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from '../db/index';
import { dbPath } from '../paths';
import { getSetting } from '../db/repo';
import { parseImportFile } from '../import/schema';
import { buildCandidates, applyImport } from '../import/apply';
import { systemClock } from '../clock';
import type { Ctx } from '../core/ctx';
import { createList } from '../core/lists';
import { addTask, completeTask } from '../core/tasks';
import { saveWorkingHoursJson, saveClassCalendars } from '../schedule/settings';
import { SIMULATED_CLASS_CALENDAR_ID, simulatedCalendar } from '../schedule/fakeCalendar';
import { seedAvailability } from '../schedule/seedAvailability';
import { editTask } from '../core/tasks';

/** Rebuild the DEMO database (never the real one) from samples/demo-*.json. */
export async function seedDemo(): Promise<string> {
  const path = dbPath(true);
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) rmSync(path + suffix);
  rmSync(join(dirname(path), 'demo-calendar.json'), { force: true });
  const db = openDb(path);
  const tz = getSetting(db, 'timezone')!;
  const dt = getSetting(db, 'default_due_time')!;
  for (const name of readdirSync('samples').filter((n) => n.startsWith("demo-") && n !== "demo-plan.json" && n.endsWith('.json'))) {
    const r = parseImportFile(JSON.parse(readFileSync(join('samples', name), 'utf8')));
    if (!r.ok) throw new Error(`${name}: ${r.errors.join('; ')}`);
    const c = buildCandidates(r.data, tz, dt);
    const res = applyImport(db, r.data, { new: c, changed: [] }, systemClock);
    console.log(`seeded ${name}: ${res.inserted} tasks`);
  }
  // Phase 2 demo data: lists, manual tasks, a recurring task, and finished work with tracked time
  // (enough history for the learned multipliers to kick in for homework).
  const ctx: Ctx = { db, clock: systemClock, tz, defaultTime: dt };
  createList(ctx, 'DEMO Personal');
  createList(ctx, 'DEMO Clubs');
  addTask(ctx, { title: 'DEMO Email advisor', list: 'DEMO Personal', due: 'tomorrow 5pm', est: 10 });
  addTask(ctx, { title: 'DEMO Club meeting prep', list: 'DEMO Clubs', due: 'fri 6pm', est: 30 });
  addTask(ctx, { title: 'DEMO Weekly review', list: 'DEMO Personal', due: 'sun 9am', repeat: 'weekly', est: 20 });
  [[60, 90], [30, 45], [45, 70], [90, 120]].forEach(([est, act], i) => {
    const t = addTask(ctx, { title: `DEMO Finished homework ${i + 1}`, course: 'DEMO PHYS 101', type: 'homework', est });
    completeTask(ctx, t.id);
    db.run('UPDATE tasks SET actual_minutes = ? WHERE id = ?', [act, t.id]);
  });
  // Phase 3 demo data: the proposed working hours, a simulated class calendar, and a week of estimated work.
  saveWorkingHoursJson(ctx, JSON.parse(readFileSync(join('samples', 'working-hours.json'), 'utf8')));
  saveClassCalendars(ctx, [SIMULATED_CLASS_CALENDAR_ID]);
  const work = [
    ['DEMO Problem set', 'wed 11:59pm', 150, 'homework'], ['DEMO Lab write-up', 'thu 5pm', 240, 'project'],
    ['DEMO Reading', 'tomorrow 9pm', 45, 'reading'], ['DEMO Quiz study', 'fri 10am', 90, 'quiz'],
    ['DEMO Big paper', 'next fri 11:59pm', 600, 'project'], ['DEMO Tiny form', 'sat 6pm', 5, 'other'],
  ] as const;
  for (const [title, due, est, type] of work) addTask(ctx, { title, course: 'DEMO PHYS 101', due, est, type });
  // Phase 3+ demo data: size-based estimates (one video whose length is not known yet), an optional reading, available_from.
  const sized = addTask(ctx, { title: 'DEMO Problem set 2', course: 'DEMO PHYS 101', due: 'thu 11pm', type: 'homework' });
  editTask(ctx, sized.id, { size: { amount: 8, unit: 'problems' }, availableFrom: 'today' });
  const video = addTask(ctx, { title: 'DEMO Lecture video', course: 'DEMO PHYS 101', due: 'fri 9am', type: 'reading' });
  db.run("UPDATE tasks SET size_unit = 'video_minutes' WHERE id = ?", [video.id]);
  const optional = addTask(ctx, { title: 'DEMO Background reading', course: 'DEMO PHYS 101', due: 'fri 9am', type: 'reading' });
  editTask(ctx, optional.id, { size: { amount: 20, unit: 'pages' }, optional: true });
  await seedAvailability(ctx, simulatedCalendar(tz), { weeks: 4, classCalendarIds: [SIMULATED_CLASS_CALENDAR_ID] });
  db.close();
  return path;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = await seedDemo();
  console.log(`\nDemo database ready: ${p}\nTry: npm run show -- --demo`);
}
