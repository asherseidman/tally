import { execFile } from 'node:child_process';
import type { CompleteResult, FetchResult, RemindersSource } from './reminders';
import { DENIED_MESSAGE } from './reminders';

/**
 * The real Reminders source: JavaScript for Automation (JXA) run by /usr/bin/osascript, which talks to the Reminders app with Apple
 * events. Chosen over EventKit because it needs no native module (nothing to rebuild or sign inside the ad-hoc-signed package) and
 * its permission is the ordinary, revocable "Automation" prompt. The script is a fixed string; the list name and ids reach it only
 * as JSON in argv, never by string building, and it names exactly one list.
 */
const SCRIPT = String.raw`
function run(argv) {
  if (argv[0] === '__syntax') return JSON.stringify({ status: 'syntax-ok' });
  var a = JSON.parse(argv[0]);
  var app = Application('Reminders');
  var found = app.lists.whose({ name: a.list })();
  if (found.length === 0) return JSON.stringify({ status: 'missing_list' });
  if (found.length > 1) return JSON.stringify({ status: 'error', message: 'There are ' + found.length + ' Reminders lists named "' + a.list + '". Rename one so the name is unique.' });
  var list = found[0];
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function iso(d) { return d ? d.toISOString() : null; }
  if (a.op === 'complete') {
    var r = list.reminders.byId(a.id);
    try { r.id(); } catch (e) { return JSON.stringify({ status: 'gone' }); }
    r.completed = true;
    return JSON.stringify({ status: 'ok' });
  }
  var open = list.reminders.whose({ completed: false });
  var ids = open.id(), names = open.name(), bodies = open.body(), dues = open.dueDate(), created = open.creationDate();
  var allday = null;
  try { allday = open.alldayDueDate(); } catch (e) { allday = null; }
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var ad = allday && allday[i] ? ymd(allday[i]) : null;
    out.push({ id: ids[i], title: names[i] || '', notes: bodies[i] || null, dueUtc: ad ? null : iso(dues[i]), dueDay: ad, createdUtc: iso(created[i]) });
  }
  out.sort(function (x, y) { return (x.createdUtc || '') < (y.createdUtc || '') ? -1 : 1; });
  return JSON.stringify({ status: 'ok', total: out.length, items: out.slice(0, a.limit) });
}
`;

const OSASCRIPT = '/usr/bin/osascript';

function exec(arg: string, timeoutMs: number): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', SCRIPT, arg], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ out: String(stdout).trim(), err: String(stderr).trim(), code: error ? ((error as { code?: number }).code ?? 1) : 0 });
    });
  });
}

/** Turn osascript's failure text into one of our statuses. -1743 is "not authorized to send Apple events". */
export function classifyFailure(err: string): { status: 'denied' | 'error'; message: string } {
  if (/-1743|not authorized|not allowed/i.test(err)) return { status: 'denied', message: DENIED_MESSAGE };
  if (/-1712|timed out/i.test(err)) return { status: 'error', message: 'Reminders did not answer in time. Is it waiting on a dialog? Try again.' };
  const first = err.split('\n').find((l) => l.trim()) ?? 'unknown error';
  return { status: 'error', message: `Could not read Reminders: ${first.replace(/^.*?execution error:\s*/i, '').slice(0, 300)}` };
}

export class JxaReminders implements RemindersSource {
  async fetch(list: string, limit: number): Promise<FetchResult> {
    const r = await exec(JSON.stringify({ op: 'fetch', list, limit }), 60_000);
    if (r.code !== 0) return classifyFailure(r.err);
    try {
      const j = JSON.parse(r.out) as FetchResult & { message?: string };
      if (j.status === 'missing_list') return { status: 'missing_list', message: `There is no Reminders list named “${list}”. Create it in the Reminders app (on the Mac or the phone), then press Check now.` };
      return j;
    } catch { return { status: 'error', message: 'Reminders returned something Tally could not read.' }; }
  }
  async complete(list: string, id: string): Promise<CompleteResult> {
    const r = await exec(JSON.stringify({ op: 'complete', list, id }), 30_000);
    if (r.code !== 0) return classifyFailure(r.err);
    try { return JSON.parse(r.out) as CompleteResult; } catch { return { status: 'error', message: 'Reminders returned something Tally could not read.' }; }
  }
}

/** Compile-check the script with the real osascript WITHOUT opening the Reminders app (used by a test). */
export async function syntaxCheck(): Promise<string> {
  const r = await exec('__syntax', 15_000);
  return r.code === 0 ? r.out : `FAILED: ${r.err}`;
}
