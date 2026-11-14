import { DateTime } from 'luxon';
import { eventTitle } from './eventTitle';
import { resolveDay } from './availabilityWindows';
import type { MovedEntry, PlanReport, TrimEntry } from './service';

const t12 = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat('h:mm a');
const short = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat('ccc LLL d h:mm a');

/** "3:00–5:00 PM", or "11:00 AM–1:00 PM" when the meridiem differs. */
export function timeRange(startMs: number, endMs: number, tz: string): string {
  const s = DateTime.fromMillis(startMs, { zone: tz });
  const e = DateTime.fromMillis(endMs, { zone: tz });
  return s.toFormat('a') === e.toFormat('a') ? `${s.toFormat('h:mm')}–${e.toFormat('h:mm a')}` : `${s.toFormat('h:mm a')}–${e.toFormat('h:mm a')}`;
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`);

export interface FormatOptions {
  dryRun: boolean;
  replan?: boolean;
  /** shown in the header, e.g. "SIMULATED calendar" */
  calendarNote: string;
  moved?: MovedEntry[];
  /** in-progress blocks that apply would trim (dry run) or did trim */
  trims?: TrimEntry[];
}

export function formatPlan(r: PlanReport, o: FormatOptions): string {
  const tz = r.tz;
  const out: string[] = [];
  const first = DateTime.fromMillis(r.nowMs, { zone: tz }).startOf('day');
  const lastDay = DateTime.fromMillis(r.horizonEndMs - 1, { zone: tz }).startOf('day');
  out.push(`${o.replan ? 'REPLAN' : 'SCHEDULE'} (${o.dryRun ? 'dry run: nothing written' : 'applied'}): ${first.toFormat('ccc LLL d')} to ${lastDay.toFormat('ccc LLL d')} · times in ${tz}`);
  out.push(`Calendar: ${o.calendarNote}`);
  const dated = new Set(r.windowRows.filter((w) => w.date).map((w) => w.date)).size;
  out.push(`Availability: your selected free windows (${dated} dated day(s); the weekly template covers other days) minus busy calendar time · blocks ${r.hours.min_block_minutes}-${r.hours.max_block_minutes} min, ${r.hours.buffer_minutes} min between · nothing sooner than ${r.hours.min_lead_minutes} min from now`);
  const pl = r.placement;
  out.push(
    pl.placement_style === 'early'
      ? `Placement: EARLY. Work becomes eligible ${pl.early_lead_days} day(s) before it is due (big tasks: longer), goes in the earliest free slots, finishes at least ${hm(pl.finish_before_deadline_minutes)} before due (exams: ${hm(r.hours.exam_prep_end_before_minutes)}), about ${hm(pl.max_daily_work_minutes)} of work a day at most`
      : `Placement: LATE (as late as possible, finishing ${hm(r.hours.deadline_slack_minutes)} before due)`,
  );
  if (r.ignoredBusy.length) {
    out.push(`Ignoring ${r.ignoredBusy.length} all-day busy block(s) (${r.hours.ignore_busy_at_least_hours}h or longer, so they don't blank the day): ` +
      r.ignoredBusy.map((b) => `${b.calendar} ${short(b.start, tz)} → ${short(b.end, tz)}`).join('; '));
  }
  for (let day = first; day <= lastDay; day = day.plus({ days: 1 }).startOf('day')) {
    const date = day.toISODate()!;
    const dayEnd = day.plus({ days: 1 }).toMillis();
    const resolved = resolveDay(r.windowRows, date, tz);
    const ws = r.windows.filter((w) => w.start >= day.toMillis() && w.start < dayEnd);
    const notes: string[] = [];
    if (!ws.length) notes.push(resolved.source === 'none' ? 'no availability set' : 'no free working time');
    else notes.push(`free ${ws.slice(0, 4).map((w) => timeRange(w.start, w.end, tz)).join(', ')}${ws.length > 4 ? ', …' : ''}`);
    if (resolved.source === 'date') notes.push('(custom for this date)');
    for (const w of r.examWindows.filter((x) => x.start >= day.toMillis() && x.start < dayEnd)) notes.push(`EXAM ${timeRange(w.start, w.end, tz)} (blocked): ${eventTitle({ course: w.course ?? null, title: w.title, isExam: true }, { prep: false })}`);
    out.push('', `${day.toFormat('ccc LLL d')}   ${notes.join(' · ')}`);
    for (const b of r.blocks.filter((x) => x.start >= day.toMillis() && x.start < dayEnd)) {
      const t = r.tasks.get(b.taskId)!;
      const len = (b.end - b.start) / 60000;
      const bits = [hm(len)];
      if (b.padded) bits.push('padded to min block');
      if (t.multiplierApplied) bits.push(`est ${t.baseMinutes}m ×${t.multiplier}`);
      if (t.estimateSource === 'size') bits.push(`size-based est ${t.baseMinutes}m`);
      if (b.overCap) bits.push('over the daily work cap: would not fit otherwise');
      out.push(`   ${timeRange(b.start, b.end, tz).padEnd(20)} ${eventTitle({ course: t.course, title: t.title, isExam: !!t.isExam, part: b.part, parts: b.parts })}  (${bits.join(', ')})  #${t.id}, due ${short(t.dueMs, tz)}`);
    }
  }

  const total = r.blocks.reduce((s, b) => s + (b.end - b.start) / 60000, 0);
  out.push('', `${r.blocks.length} block(s), ${hm(Math.round(total))} of work in this window.` + (r.totalPlannedBlocks > r.blocks.length ? ` ${r.totalPlannedBlocks - r.blocks.length} more block(s) fall later, closer to their deadlines.` : ''));

  // TENTATIVE: blocked tasks planned as if their blockers finish at the end of their own planned blocks.
  const tentTasks = [...new Set(r.tentative.map((b) => b.taskId)), ...r.tentativeProblems.map((p) => p.taskId)].filter((id, i, a) => a.indexOf(id) === i);
  if (tentTasks.length) {
    out.push('', 'TENTATIVE projections (NOT written to Google on --apply; they become real once their blockers are done):');
    for (const id of tentTasks.sort((a, b) => (r.tasks.get(a)?.dueMs ?? 0) - (r.tasks.get(b)?.dueMs ?? 0))) {
      const t = r.tasks.get(id)!;
      const waits = r.waitingOn.get(id) ?? [];
      const problem = r.tentativeProblems.find((p) => p.taskId === id);
      out.push('', `TENTATIVE (waiting on ${waits.map((w) => `#${w.id} ${w.title}`).join(', ')}):`);
      out.push(`   #${t.id} ${eventTitle({ course: t.course, title: t.title, isExam: !!t.isExam })}, due ${short(t.dueMs, tz)}${problem ? `  -> WOULD NOT FIT (tentative): ${problem.kind === 'partial' ? `only ${hm(Math.round(problem.placedMinutes))} of ${hm(problem.neededMinutes)}` : `none of ${hm(problem.neededMinutes)}`}` : '  -> makes its deadline'}`);
      const mine = r.tentative.filter((b) => b.taskId === id);
      for (const b of mine) {
        out.push(`      ${short(b.start, tz)}  ${timeRange(b.start, b.end, tz)}  (${hm((b.end - b.start) / 60000)}${b.parts > 1 ? `, part ${b.part}/${b.parts}` : ''})`);
      }
    }
  }

  if (r.problems.length || r.tentativeProblems.length) {
    out.push('', 'DOES NOT FIT (not dropped; free up time or move the due date):');
    for (const p of r.problems) {
      const t = r.tasks.get(p.taskId)!;
      out.push(`   #${t.id} ${t.course ? `${t.course} · ` : ''}${t.title}: ${p.kind === 'partial' ? `placed ${hm(Math.round(p.placedMinutes))} of ${hm(p.neededMinutes)}` : `none of ${hm(p.neededMinutes)} placed`}; ${p.reason}; due ${short(t.dueMs, tz)}`);
    }
    for (const p of r.tentativeProblems) {
      const t = r.tasks.get(p.taskId)!;
      out.push(`   (tentative) #${t.id} ${t.course ? `${t.course} · ` : ''}${t.title}: ${p.kind === 'partial' ? `would place ${hm(Math.round(p.placedMinutes))} of ${hm(p.neededMinutes)}` : `none of ${hm(p.neededMinutes)} would be placed`} once its blockers finish; ${p.reason}; due ${short(t.dueMs, tz)}`);
    }
  }
  const credit = creditedLines(r);
  if (credit.length) out.push('', 'WORK ALREADY LOGGED (planning uses the remaining estimate, never the full one):', ...credit);
  if (o.trims?.length) out.push('', trimHeading(o.dryRun), ...trimLines(r, o.trims));
  if (o.moved?.length) out.push('', o.dryRun ? 'WOULD MOVE:' : 'MOVED:', ...movedLines(r, o.moved));
  if (r.skipped.length) {
    out.push('', 'NOT SCHEDULED:');
    for (const s of r.skipped) out.push(`   #${s.task.id} ${s.task.course ? `${s.task.course} · ` : ''}${s.task.title}: ${s.reason}`);
  }
  return out.join('\n');
}

// Shared by the CLI report above and the Schedule screen, so both say exactly the same thing.
export const trimHeading = (dryRun: boolean) =>
  dryRun ? 'WOULD TRIM (in progress right now; the rest of the block is replaced by the new plan):' : 'TRIMMED (in progress when applied; the rest of the block was replaced by the new plan):';

export function creditedLines(r: PlanReport): string[] {
  return [...r.tasks.values()]
    .filter((t) => t.trackedMinutes > 0)
    .map((t) => `   #${t.id} ${t.title}: estimate ${t.baseMinutes} min - ${t.trackedMinutes} min logged = ${t.minutes} min still to plan`);
}

export function trimLines(r: PlanReport, trims: TrimEntry[]): string[] {
  const tz = r.tz;
  return trims.map((e) => `   #${e.taskId} ${e.title}: ${timeRange(e.block.start, e.block.end, tz)} ${e.action === 'trimmed' ? `-> ends at ${t12(r.nowMs, tz)}; the ${hm(e.keptMinutes)} that elapsed stays as history` : '-> removed (almost none had elapsed)'}. Not credited as work done: log it with  log ${e.taskId} <minutes>`);
}

export function movedLines(r: PlanReport, moved: MovedEntry[]): string[] {
  const tz = r.tz;
  return moved.map((m) => {
    const t = r.tasks.get(m.taskId);
    const name = t ? `#${m.taskId} ${t.title}` : `#${m.taskId}`;
    const from = m.from.map((x) => short(x.start, tz)).join(', ');
    const to = m.to.length ? m.to.map((x) => short(x.start, tz)).join(', ') : 'nothing (no longer scheduled)';
    return `   ${name}: ${m.reason === 'missed' ? 'MISSED' : m.reason}  ${from}  →  ${to}`;
  });
}
