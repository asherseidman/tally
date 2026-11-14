import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DateTime } from 'luxon';
import type { Cli } from './args';
import type { CliContext } from './context';
import { parseNaturalDue } from '../core/naturalDate';
import { OAuth2Client } from 'google-auth-library';
import { KeychainSecretStore } from '../schedule/secretStore';
import { OAuthTokenProvider, type HealthHooks, connectInteractive, makeOAuthClient, REFRESH_TOKEN_KEY, defaultClientFile } from '../schedule/auth';
import { GoogleCalendarClient } from '../schedule/googleCalendar';
import { recordConnected, recordProblem, recordWorking, tokenAgeDays, testingNote, currentProblem, problemMessage, publishStatus, forgetConnection } from '../schedule/googleHealth';
import { FakeCalendar, simulatedCalendar, SIMULATED_CLASS_CALENDAR_ID, type FakeState } from '../schedule/fakeCalendar';
import type { CalendarClient } from '../schedule/calendar';
import { applyPlan, computePlan, previewMoves, previewTrims } from '../schedule/service';
import { formatPlan } from '../schedule/format';
import { getBusyCalendars, getClassCalendars } from '../schedule/settings';
import { clearDate, copyWeek, describeRows, loadWindows, parseRange, parseTarget, resolveDay, setWindow, showTemplate, showWeek, WEEKDAY_NAMES } from '../schedule/availabilityWindows';
import { seedAvailability } from '../schedule/seedAvailability';
import { buildBusyReport, formatBusyReport, splitLongBusy } from '../schedule/busy';
import { buildClassReport, formatClassReport } from '../schedule/classes';
import { loadOverrides, loadWorkingHours } from '../schedule/settings';
import { currentTerm } from '../core/terms';

const store = new KeychainSecretStore();

interface Cal {
  calendar: CalendarClient;
  note: string;
  simulated: boolean;
  persist: () => void;
}

const stateFile = (cx: CliContext) => join(dirname(cx.dbFile), 'demo-calendar.json');

function makeCalendar(cx: CliContext, cli: Cli): Cal {
  const tz = cx.ctx.tz;
  if (cx.demo) {
    const f = stateFile(cx);
    const state: FakeState | undefined = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
    const fake = simulatedCalendar(tz, state);
    return { calendar: fake, simulated: true, note: 'DEMO: simulated classes Mon-Fri 10:00-11:00 and 1:00-2:30 PM, kept in demo-calendar.json. Google is not contacted.', persist: () => writeFileSync(f, JSON.stringify(fake.toState())) };
  }
  if (cli.flags.has('fake-calendar')) {
    return { calendar: simulatedCalendar(tz), simulated: true, note: 'SIMULATED classes Mon-Fri 10:00-11:00 and 1:00-2:30 PM. NOT your real calendar; preview only, cannot be applied.', persist: () => {} };
  }
  const health = healthFor(cx);
  const provider = new OAuthTokenProvider(makeOAuthClient(), store, undefined, health);
  return { calendar: new GoogleCalendarClient(provider, fetch, tz, () => health.problem('http_401', 'reconnect')), simulated: false, note: 'Google Calendar (free/busy read-only; writes only to "Planner Blocks")', persist: () => {} };
}

/** The CLI records the same sign-in health the app does (why it failed, how old it is), in the same database. */
const healthFor = (cx: CliContext): HealthHooks => ({
  problem: (code, kind) => { recordProblem(cx.ctx.db, cx.ctx.clock.now(), code, kind); },
  working: () => recordWorking(cx.ctx.db, cx.ctx.clock.now()),
});

export async function runSchedule(cx: CliContext, cli: Cli, replan: boolean): Promise<void> {
  const o = cli.opts;
  const days = o.days ? Number(o.days) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('--days must be a whole number from 1 to 60.');
  const apply = cli.flags.has('apply');
  if (o.hours) throw new Error('--hours no longer exists: free time now comes from your availability windows. See: npm run plan -- availability show');

  const cal = makeCalendar(cx, cli);
  if (apply && cal.simulated && !cx.demo) throw new Error('Refusing --apply with a simulated calendar; it is a preview only.');
  const report = await computePlan(cx.ctx, cal.calendar, { days, classCalendarIds: cal.simulated ? [SIMULATED_CLASS_CALENDAR_ID] : undefined });

  if (!apply) {
    const { moved } = replan ? previewMoves(cx.ctx, report, true) : { moved: [] };
    console.log(formatPlan(report, { dryRun: true, replan, calendarNote: cal.note, moved, trims: previewTrims(cx.ctx, report) }));
    console.log(`\nNothing was written. To write these blocks to the "Planner Blocks" calendar: npm run ${replan ? 'replan' : 'schedule'} -- --apply${days !== 7 ? ` --days ${days}` : ''}`);
    return;
  }
  const res = await applyPlan(cx.ctx, cal.calendar, report, { replan });
  cal.persist();
  console.log(formatPlan(report, { dryRun: false, replan, calendarNote: cal.note, moved: res.moved, trims: res.trimmed }));
  console.log(`\nApplied: removed ${res.deleted} earlier block(s)${res.missedRemoved ? ` and ${res.missedRemoved} missed block(s)` : ''}, wrote ${res.created} to "Planner Blocks".`);
}

export async function runCalendar(cx: CliContext, cli: Cli, rest: string[]): Promise<void> {
  const [sub] = rest;
  if (sub === 'connect') {
    if (cx.demo) return console.log('The demo database uses a simulated calendar; there is nothing to connect.');
    await connectInteractive(store, defaultClientFile(), console.log, () => recordConnected(cx.ctx.db, cx.ctx.clock.now()));
    console.log('Connected. Your refresh token is stored in the OS keychain (not in any file).\nNext: npm run plan -- calendar list');
  } else if (sub === 'disconnect') {
    await store.delete(REFRESH_TOKEN_KEY);
    forgetConnection(cx.ctx.db);
    console.log('Removed the stored Google token from the keychain.\nTo also revoke access on Google\'s side: https://myaccount.google.com/permissions');
  } else if (sub === 'status') {
    if (cx.demo) return console.log('DEMO: simulated calendar (no Google connection).');
    console.log(`OAuth client file: ${defaultClientFile()} ${existsSync(defaultClientFile()) ? '(found)' : '(MISSING)'}`);
    if (!(await store.get(REFRESH_TOKEN_KEY))) console.log('Google: not connected. Run: npm run plan -- calendar connect');
    else {
      try {
        await new OAuthTokenProvider(makeOAuthClient() as OAuth2Client, store, undefined, healthFor(cx)).getAccessToken();
        console.log('Google: connected (access token refreshed OK).');
      } catch (e) {
        const p = currentProblem(cx.ctx.db);
        console.log(`Google: ${p ? problemMessage(p, true) : (e as Error).message}`);
      }
      const age = tokenAgeDays(cx.ctx.db, cx.ctx.clock.now());
      console.log(`sign-in age: ${age === null ? 'unknown (made before Tally kept track; Connect again to start tracking)' : `${Math.round(age * 10) / 10} days`}   project status: ${publishStatus(cx.ctx.db).status}`);
      const tn = testingNote(cx.ctx.db, cx.ctx.clock.now());
      if (tn) console.log(`Testing mode: this sign-in expires about ${tn.expiresAt.slice(0, 10)} (${tn.daysLeft} days left)${tn.close ? '. Close to the limit; see docs/GOOGLE_PRODUCTION.md' : ''}`);
    }
    console.log(`class calendars: ${(getClassCalendars(cx.ctx) ?? []).join(', ') || '(not set)'}`);
    console.log(`busy calendars:  ${(getBusyCalendars(cx.ctx) ?? ['all except Planner Blocks']).join(', ')}`);
  } else if (sub === 'list' || !sub) {
    const cal = makeCalendar(cx, cli);
    const classIds = getClassCalendars(cx.ctx) ?? [];
    const busyIds = getBusyCalendars(cx.ctx);
    console.log(`(${cal.note})\n`);
    for (const c of await cal.calendar.listCalendars()) {
      const tags = [classIds.includes(c.id) ? 'CLASS' : '', busyIds && !busyIds.includes(c.id) && !classIds.includes(c.id) ? 'ignored' : '', c.summary === 'Planner Blocks' ? 'ours: excluded from busy time' : ''].filter(Boolean);
      console.log(`${c.id}\n    ${c.summary}  [${c.accessRole}]${c.primary ? ' primary' : ''}${tags.length ? '  ← ' + tags.join(', ') : ''}`);
    }
    console.log('\nChoose which calendars hold your classes:  npm run plan -- config set class_calendars <id,id>');
  } else if (sub === 'busy') {
    const days = cli.opts.days ? Number(cli.opts.days) : 7;
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('--days must be a whole number from 1 to 60.');
    const cal = makeCalendar(cx, cli);
    const all = await cal.calendar.listCalendars();
    const planner = await cal.calendar.findPlannerCalendarId();
    const ids = (getBusyCalendars(cx.ctx) ?? all.map((c) => c.id)).filter((id) => id !== planner);
    const from = cx.ctx.clock.now().getTime();
    const to = from + days * 86_400_000;
    const fb = await cal.calendar.freeBusy(ids, from, to);
    const rows = ids.map((id) => ({ id, summary: all.find((c) => c.id === id)?.summary ?? id, accessRole: all.find((c) => c.id === id)?.accessRole ?? '?', busy: fb[id] ?? [] }));
    console.log(formatBusyReport(buildBusyReport(rows, from, to), cx.ctx.tz));
  } else if (sub === 'classes') {
    const days = cli.opts.days ? Number(cli.opts.days) : 7;
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('--days must be a whole number from 1 to 60.');
    const classIds = getClassCalendars(cx.ctx) ?? [];
    if (!classIds.length) throw new Error('No class calendars chosen. Run: npm run plan -- config set class_calendars <id>');
    const cal = makeCalendar(cx, cli);
    const from = cx.ctx.clock.now().getTime();
    const to = from + days * 86_400_000;
    const { hours } = loadWorkingHours(cx.ctx, currentTerm(cx.ctx)?.id);
    const fb = await cal.calendar.freeBusy(classIds, from, to);
    const busy = classIds.flatMap((id) => splitLongBusy(fb[id] ?? [], hours.ignore_busy_at_least_hours).kept);
    console.log(formatClassReport(buildClassReport(busy, from, to, cx.ctx.tz, hours, loadOverrides(cx.ctx)), cx.ctx.tz));
  } else throw new Error('Usage: calendar connect | status | list | busy [--days N] | classes [--days N] | disconnect');
}

/** Accepts 2026-11-14 or a natural date ("sat", "nov 14"); returns the local YYYY-MM-DD. */
export function localDate(text: string, cx: CliContext): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const d = parseNaturalDue(text, cx.ctx.tz, cx.ctx.clock, cx.ctx.defaultTime);
  return DateTime.fromISO(d.dueUtc!, { zone: 'utc' }).setZone(cx.ctx.tz).toISODate()!;
}

const todayLocal = (cx: CliContext) => DateTime.fromMillis(cx.ctx.clock.now().getTime(), { zone: cx.ctx.tz }).toISODate()!;

export function runAway(cx: CliContext, rest: string[]): void {
  const [sub, ...a] = rest;
  if (sub === 'add') {
    if (!a[0]) throw new Error('Usage: away add <date> [HH:mm-HH:mm]   e.g. away add 2026-11-14   |   away add 2026-11-09 16:00-18:00   (same as: availability set <date> <range> blocked)');
    const date = localDate(a[0], cx);
    const range = a[1] && /^\d{1,2}:\d{2}\s*-/.test(a[1]) ? parseRange(a[1]) : { start: '00:00', end: '24:00' };
    setWindow(cx.ctx, { date }, range, 'blocked');
    console.log(range.start === '00:00' && range.end === '24:00' ? `${date} is blocked all day. No work will be scheduled that day.` : `${date} ${range.start}-${range.end} is blocked. The rest of that day keeps its free windows.`);
  } else if (sub === 'rm') {
    if (!a[0]) throw new Error('Usage: away rm <date>   (clears that date\'s own windows; the weekly template applies again)');
    const date = localDate(a[0], cx);
    console.log(clearDate(cx.ctx, date) ? `${date} now follows the weekly template.` : `${date} had no windows of its own.`);
  } else if (sub === 'ls' || !sub) {
    const today = todayLocal(cx);
    const dates = [...new Set(loadWindows(cx.ctx).filter((w) => w.date && w.date >= today).map((w) => w.date!))].sort();
    if (!dates.length) return console.log('(no per-date windows)');
    for (const d of dates) console.log(`${d}  ${describeRows(resolveDay(loadWindows(cx.ctx), d, cx.ctx.tz).rows)}`);
  } else throw new Error('Usage: away add <date> [HH:mm-HH:mm] | away rm <date> | away ls');
}

const targetOf = (text: string, cx: CliContext) => {
  try {
    return parseTarget(text);
  } catch {
    return { date: localDate(text, cx) };
  }
};

export async function runAvailability(cx: CliContext, cli: Cli, rest: string[]): Promise<void> {
  const [sub, ...a] = rest;
  const { ctx } = cx;
  if (sub === 'show' || !sub) {
    if ('week' in cli.opts) {
      const any = cli.opts.week ? localDate(cli.opts.week, cx) : todayLocal(cx);
      console.log(`Week of ${any} (windows are local time; "this date only" days ignore the weekly template):`);
      showWeek(ctx, any).forEach((l) => console.log('  ' + l));
    } else {
      console.log('Weekly template (applies to any date with no windows of its own):');
      showTemplate(ctx).forEach((l) => console.log('  ' + l));
      const n = new Set(loadWindows(ctx).filter((w) => w.date).map((w) => w.date)).size;
      console.log(`\n${n} date(s) have their own windows. See them with: availability show --week [date]`);
    }
  } else if (sub === 'set') {
    if (a.length < 2) throw new Error('Usage: availability set <date|weekday> HH:mm-HH:mm [free|blocked]   e.g. availability set mon 09:00-17:00   |   availability set 2026-11-14 13:00-18:00 free');
    const target = targetOf(a[0], cx);
    const kind = (a[2] ?? 'free').toLowerCase();
    if (kind !== 'free' && kind !== 'blocked') throw new Error('The last word must be free or blocked.');
    const range = parseRange(a[1]);
    const r = setWindow(ctx, target, range, kind);
    const label = 'date' in target ? target.date : WEEKDAY_NAMES[target.weekday - 1];
    console.log(`${label} ${range.start}-${range.end} set ${kind}.${r.materialized ? ' (This date now has its own windows: the weekly template was copied onto it first, so the rest of the day is unchanged.)' : ''}`);
    if ('date' in target) showWeek(ctx, target.date).filter((l) => l.includes(DateTime.fromISO(target.date, { zone: ctx.tz }).toFormat('LLL d'))).forEach((l) => console.log('  ' + l));
    else showTemplate(ctx).filter((l) => l.toLowerCase().startsWith(label)).forEach((l) => console.log('  ' + l));
  } else if (sub === 'clear') {
    if (!a[0]) throw new Error('Usage: availability clear <date>');
    const date = localDate(a[0], cx);
    console.log(clearDate(ctx, date) ? `${date} cleared: it follows the weekly template again.` : `${date} had no windows of its own.`);
  } else if (sub === 'copy-week') {
    if (a.length < 2) throw new Error('Usage: availability copy-week <from-date> <to-date>   (any date in each week; copies Mon-Sun)');
    const r = copyWeek(ctx, localDate(a[0], cx), localDate(a[1], cx));
    console.log(`Copied ${r.days} day(s) with windows from the week of ${a[0]} onto the week of ${a[1]}.`);
  } else if (sub === 'seed') {
    const cal = makeCalendar(cx, cli);
    const weeks = cli.opts.weeks ? Number(cli.opts.weeks) : 4;
    const res = await seedAvailability(ctx, cal.calendar, { weeks, replace: cli.flags.has('replace'), classCalendarIds: cal.simulated ? [SIMULATED_CLASS_CALENDAR_ID] : undefined });
    console.log(`Seeded ${res.datedDays} dated day(s), ${res.from} to ${res.to}, plus a weekly template, from your saved working hours and ${cal.simulated ? 'a SIMULATED' : 'your real'} class calendar.`);
    res.notes.forEach((n) => console.log(`  note: ${n}`));
    console.log('\nWeekly template:');
    showTemplate(ctx).forEach((l) => console.log('  ' + l));
    console.log(`\nReview a week: availability show --week ${res.from}\nFrom now on the scheduler reads only these windows (the working_hours JSON is no longer used).`);
  } else throw new Error('Usage: availability show [--week [date]] | set <date|weekday> HH:mm-HH:mm [free|blocked] | clear <date> | copy-week <from> <to> | seed [--weeks N] [--replace]');
}
