// Writes the PRETEND Reminders state that the UI self-test reads (demo database only; never touches the real Reminders app).
import { writeFileSync } from 'node:fs';
const file = process.argv[2] ?? '/tmp/planner-fake-reminders.json';
const mk = (id, title, extra = {}) => ({ id, title, notes: null, dueUtc: null, dueDay: null, createdUtc: null, ...extra });
writeFileSync(file, JSON.stringify({
  lists: {
    'Tally Inbox': [
      mk('smoke-1', 'SMOKE phone read chapter 5 due friday 5pm', { createdUtc: '2026-11-01T10:00:00.000Z' }),
      mk('smoke-2', 'SMOKE phone buy a stapler', { createdUtc: '2026-11-01T10:01:00.000Z' }),
      mk('smoke-3', '', { createdUtc: '2026-11-01T10:02:00.000Z' }),
    ],
    Groceries: [mk('groc-1', 'SMOKE never touched: milk')],
  },
  completed: [],
}));
console.log('wrote', file);
