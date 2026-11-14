import { createHash } from 'node:crypto';
import type { Ctx } from './ctx';
import { getSetting, setSetting } from '../db/repo';
import { getTask, refreshSizeEstimate, type Task } from './tasks';
import {
  loadRates, loadDefaults, loadLearnedRates, sizeEstimate, effectiveEstimate, matchRateIndex, ruleMatches, rateKey, parseUnit, describeRule,
  SIZE_UNITS, DEFAULTS_KEY, FLAT_UNIT, NONE_UNIT, isFlatRule, isNoRateRule, isSizeRule, flatRuleIndex, flatText, POINTS_MIN_KEY, MIN_POINTS_MINUTES, MIN_RATE_SAMPLES, type RateRule, type SizedTask,
} from './size';

/**
 * Assignment groups for the Rates screen. A group is a course plus a normalized title stem ("Lecture 22 zyBooks" and
 * "Lecture 25 zyBooks" are both "zyBooks"). A group is the unit of a rate rule, of a learned multiplier and of the
 * "apply to these tasks" action. The user's renames, merges and moves are saved in settings (rate_groups), keyed by
 * group key and task id, so a later import (new task rows with the same stems) lands in the same groups.
 */
export const GROUPS_KEY = 'rate_groups';
export const loadMultiplierOff = (ctx: Ctx) => loadOff(ctx);
export const MULT_OFF_KEY = 'rate_multiplier_off';
export const MULT_RESET_KEY = 'rate_multiplier_reset';

// ---------------------------------------------------------------- the stem
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const NUM = String.raw`\d+(?:\.\d+)*`;
const NAMED = String.raw`\b(?:lectures?|chapters?|chs?\.?|weeks?|wks?\.?|parts?|pt\.?|units?|modules?|sections?|sec\.?|sessions?)\s*#?\s*${NUM}(?:\s*(?:and|&|,|-|–|to|through)\s*${NUM})*`;
const ORDINAL_WORDS = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)';

/** The first-release stem (no subtitle cut). Kept only to find the old group keys when regrouping. */
export function stemV1(title: string): { key: string; display: string } {
  let s = ` ${title} `;
  s = s.replace(/\([^)]*\d[^)]*\)/g, ' '); // "(7.1-7.2)"
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ');
  s = s.replace(new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?\b`, 'gi'), ' ');
  s = s.replace(new RegExp(NAMED, 'gi'), ' ');
  s = s.replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ').replace(new RegExp(String.raw`\b${ORDINAL_WORDS}\b`, 'gi'), ' ');
  s = s.replace(new RegExp(String.raw`#?\b${NUM}(?:\s*[-–]\s*${NUM})?\b`, 'g'), ' ');
  s = s.replace(/#/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:and|&|[-–,:;.]+)\s*/i, '').replace(/\s*(?:and|&|[-–,:;.]+)$/i, '').trim();
  if (!s) s = title.replace(/[\d#.()/\-–]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = '(untitled)';
  return { key: s.toLowerCase(), display: s };
}

const ROMAN = String.raw`(?:x{0,2}(?:ix|iv|v?i{1,3}|v|x))\b`;
const NAMED2 = String.raw`\b(?:lectures?|chapters?|chs?\.?|weeks?|wks?\.?|parts?|pt\.?|units?|modules?|sections?|sec\.?|sessions?|nos?\.?|number)\s*#?\s*(?:${NUM}|${ROMAN})(?:\s*(?:and|&|,|-|–|to|through)\s*(?:${NUM}|${ROMAN}))*`;
const fold = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * "Video Discussion Post 4: Sample Subtitle" -> { key: 'video discussion post', display: 'Video Discussion Post' }.
 * Dropped: the subtitle (after the first colon or spaced dash), parenthetical text, numbering ("#6", "No. 3", "Part II",
 * "Week 9", "Lecture 22"), dates and ordinals. Case and accents are folded in the key; the display keeps the title's own look.
 * Distinctive words stay ("Final Project Phase Two Part III: ..." -> "final project phase two").
 */
export function stemOf(title: string): { key: string; display: string } {
  let s = title;
  const cut = s.search(/(?<!\d):|:(?!\d)|\s[-–—]\s/);
  if (cut > 0 && /[\p{L}\p{N}]/u.test(s.slice(0, cut))) s = s.slice(0, cut);
  s = ` ${s} `.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ');
  s = s.replace(new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?\b`, 'gi'), ' ');
  s = s.replace(new RegExp(NAMED2, 'gi'), ' ');
  s = s.replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ').replace(new RegExp(String.raw`\b${ORDINAL_WORDS}\b`, 'gi'), ' ');
  s = s.replace(new RegExp(String.raw`#?\b${NUM}(?:\s*[-–]\s*${NUM})?\b`, 'g'), ' ');
  s = s.replace(/#/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:and|&|[-–,:;.]+)\s*/i, '').replace(/\s*(?:and|&|[-–,:;.]+)$/i, '').trim();
  if (!s) s = fold(title).replace(/[\d#.()/\-–:]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = '(untitled)';
  return { key: fold(s).toLowerCase(), display: s };
}

export const baseGroupKey = (t: { course: string | null; title: string }) => `${(t.course ?? '').trim().toLowerCase()}|${stemOf(t.title).key}`;

// ---------------------------------------------------------------- overrides
export interface Overrides {
  /** group key -> the name the user gave it */
  names: Record<string, string>;
  /** group key -> the group it was merged into */
  merges: Record<string, string>;
  /** task id -> the group it was moved (or split) to */
  moves: Record<string, string>;
}
function readOverrides(ctx: Ctx): Overrides {
  const raw = getSetting(ctx.db, GROUPS_KEY);
  const empty: Overrides = { names: {}, merges: {}, moves: {} };
  if (!raw) return empty;
  try {
    const j = JSON.parse(raw) as Partial<Overrides>;
    return { names: j.names ?? {}, merges: j.merges ?? {}, moves: j.moves ?? {} };
  } catch { return empty; }
}
/** The user's overrides, with any key from an older grouping carried over to the key its tasks have now (see Regroup). */
export function loadOverrides(ctx: Ctx): Overrides {
  return remapOverrides(readOverrides(ctx), keyRemap(ctx).map).ov;
}
function saveOverrides(ctx: Ctx, o: Overrides) {
  const empty = !Object.keys(o.names).length && !Object.keys(o.merges).length && !Object.keys(o.moves).length;
  if (empty) ctx.db.run('DELETE FROM settings WHERE key = ?', [GROUPS_KEY]);
  else setSetting(ctx.db, GROUPS_KEY, JSON.stringify(o));
}
const resolve = (key: string, ov: Overrides): string => {
  const seen = new Set<string>();
  while (ov.merges[key] && !seen.has(key)) { seen.add(key); key = ov.merges[key]; }
  return key;
};
/** The group a task belongs to after the user's moves and merges. */
export function groupKeyOf(t: { id?: number; course: string | null; title: string }, ov: Overrides): string {
  const moved = t.id != null ? ov.moves[String(t.id)] : undefined;
  return resolve(moved ?? baseGroupKey(t), ov);
}

// ---------------------------------------------------------------- regroup
export const SNAPSHOT_KEY = 'rate_group_snapshot';
interface TaskKeyRow { id: number; course: string | null; title: string }
const readSnapshot = (ctx: Ctx): Record<string, string> | null => {
  const raw = getSetting(ctx.db, SNAPSHOT_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as Record<string, string>; } catch { return null; }
};
const v1Key = (t: { course: string | null; title: string }) => `${(t.course ?? '').trim().toLowerCase()}|${stemV1(t.title).key}`;
const liveTasks = (ctx: Ctx) => ctx.db.all<TaskKeyRow>('SELECT id, course, title FROM tasks WHERE deleted_at IS NULL ORDER BY id');

/**
 * Old automatic group key -> its key now, found from the tasks that were in that group (the saved snapshot of the last
 * regroup, or the first-release stems when there is none). Only keys whose tasks all land in one group are mapped.
 */
export function keyRemap(ctx: Ctx): { map: Map<string, string>; ambiguous: Set<string>; changedTasks: { id: number; title: string; from: string; to: string }[] } {
  const snap = readSnapshot(ctx);
  const seen = new Map<string, Set<string>>();
  const changedTasks: { id: number; title: string; from: string; to: string }[] = [];
  for (const t of liveTasks(ctx)) {
    const now = baseGroupKey(t);
    const was = snap ? snap[String(t.id)] : v1Key(t);
    if (!was || was === now) continue;
    changedTasks.push({ id: t.id, title: t.title, from: was, to: now });
    if (!seen.has(was)) seen.set(was, new Set());
    seen.get(was)!.add(now);
  }
  const map = new Map<string, string>(), ambiguous = new Set<string>();
  for (const [k, to] of seen) { if (to.size === 1) map.set(k, [...to][0]); else ambiguous.add(k); }
  return { map, ambiguous, changedTasks };
}

/** Rewrites the keys in overrides through `map`. A name already given to the new key wins over an older one. */
export function remapOverrides(ov: Overrides, map: Map<string, string>): { ov: Overrides; moved: number } {
  if (!map.size) return { ov, moved: 0 };
  let moved = 0;
  const k = (x: string) => { const y = map.get(x); if (y && y !== x) { moved++; return y; } return x; };
  const names: Record<string, string> = {}, merges: Record<string, string> = {}, moves: Record<string, string> = {};
  for (const [key, v] of Object.entries(ov.names)) { const n = k(key); if (!(n in names)) names[n] = v; }
  for (const [key, v] of Object.entries(ov.merges)) { const a = k(key), b = k(v); if (a !== b) merges[a] = b; }
  for (const [id, v] of Object.entries(ov.moves)) moves[id] = k(v);
  return { ov: { names, merges, moves }, moved };
}

export interface RegroupReport {
  /** tasks whose automatic group is different from the last time */
  changedTasks: { id: number; title: string; from: string; to: string }[];
  groupsBefore: number;
  groupsAfter: number;
  /** saved renames, merges, moves and learned-multiplier settings carried over to the new keys */
  overridesCarried: number;
  /** old groups that split into several (their saved settings were left as they were) */
  unresolved: string[];
  /** true when nothing changed */
  unchanged: boolean;
}

/** What Regroup would do, without doing it. */
export function regroupPreview(ctx: Ctx): RegroupReport {
  const r = keyRemap(ctx);
  const tasks = liveTasks(ctx);
  const snap = readSnapshot(ctx);
  const before = new Set(tasks.map((t) => (snap ? snap[String(t.id)] : v1Key(t)) ?? baseGroupKey(t)));
  const after = new Set(tasks.map(baseGroupKey));
  const raw = readOverrides(ctx);
  const carried = remapOverrides(raw, r.map).moved + readOff(ctx).filter((x) => r.map.has(x)).length + Object.keys(readResets(ctx)).filter((x) => r.map.has(x)).length;
  const used = new Set([...Object.keys(raw.names), ...Object.keys(raw.merges), ...Object.values(raw.merges), ...Object.values(raw.moves), ...readOff(ctx), ...Object.keys(readResets(ctx))]);
  return { changedTasks: r.changedTasks, groupsBefore: before.size, groupsAfter: after.size, overridesCarried: carried, unresolved: [...r.ambiguous].filter((k) => used.has(k)), unchanged: !r.changedTasks.length && !carried };
}

/**
 * Recompute the automatic groups from the current titles. The user's renames, merges, splits and moves are kept (their keys
 * follow the tasks to the new groups). Saved rates are never touched: their match text stays exactly as saved.
 * Callers wrap this in recordChange.
 */
export function regroup(ctx: Ctx): RegroupReport {
  const report = regroupPreview(ctx);
  const r = keyRemap(ctx);
  if (r.map.size) {
    saveOverrides(ctx, remapOverrides(readOverrides(ctx), r.map).ov);
    const off = [...new Set(readOff(ctx).map((x) => r.map.get(x) ?? x))];
    if (off.length) setSetting(ctx.db, MULT_OFF_KEY, JSON.stringify(off));
    const resets = Object.fromEntries(Object.entries(readResets(ctx)).map(([x, v]) => [r.map.get(x) ?? x, v]));
    if (Object.keys(resets).length) setSetting(ctx.db, MULT_RESET_KEY, JSON.stringify(resets));
  }
  setSetting(ctx.db, SNAPSHOT_KEY, JSON.stringify(Object.fromEntries(liveTasks(ctx).map((t) => [String(t.id), baseGroupKey(t)]))));
  return report;
}

/** How many tasks would change group on a Regroup (for the banner on the screen). */
export const regroupPending = (ctx: Ctx): number => keyRemap(ctx).changedTasks.length;

// ---------------------------------------------------------------- the groups
export type GroupMode = 'unit' | 'flat' | 'none';
export interface RateGroup {
  key: string;
  course: string | null;
  name: string;
  autoName: string;
  renamed: boolean;
  tasks: Task[];
  unit: string | null;
  /** how the group is estimated: per unit (size x rate), a flat time per assignment, or no rate at all */
  mode: GroupMode;
  /** user rules (indexes into the user list) that belong to this group */
  ruleIdx: number[];
  /** a saved rule with no task to attach to (it matches nothing yet) */
  orphan: boolean;
}

const trimName = (s: string) => s.trim().slice(0, 100);

/** Every non-deleted task (open and done, all terms) in its group, plus a card for each saved rule that matches no task. */
export function buildGroups(ctx: Ctx): RateGroup[] {
  const ov = loadOverrides(ctx);
  const tasks = ctx.db.all<Task>('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY course, id');
  const by = new Map<string, RateGroup>();
  for (const t of tasks) {
    const key = groupKeyOf(t, ov);
    let g = by.get(key);
    if (!g) {
      const stem = stemOf(t.title);
      const moved = ov.moves[String(t.id)];
      const auto = moved && moved.includes('|~') ? t.title : stem.display;
      g = { key, course: t.course, name: ov.names[key] ?? auto, autoName: auto, renamed: !!ov.names[key], tasks: [], unit: null, mode: 'unit', ruleIdx: [], orphan: false };
      by.set(key, g);
    }
    g.tasks.push(t);
  }
  const groups = [...by.values()];
  for (const g of groups) {
    const counts = new Map<string, number>();
    for (const t of g.tasks) if (t.size_unit) counts.set(t.size_unit, (counts.get(t.size_unit) ?? 0) + 1);
    g.unit = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  // which saved rule belongs to which group: the group holding most of the tasks the rule's course + title text catches
  const { user } = loadRates(ctx);
  user.forEach((r, i) => {
    let best: RateGroup | undefined;
    let bestN = 0;
    if (r.title_match) {
      for (const g of groups) {
        const n = g.tasks.filter((t) => (!r.course || r.course.toLowerCase() === (t.course ?? '').toLowerCase()) && t.title.toLowerCase().includes(r.title_match!.toLowerCase())).length;
        if (n > bestN) { best = g; bestN = n; }
      }
    }
    if (best) {
      best.ruleIdx.push(i);
      if (isSizeRule(r) && !best.unit) best.unit = r.unit;
      else if (!isSizeRule(r) && best.mode === 'unit') best.mode = isNoRateRule(r) ? 'none' : 'flat'; // the first (newest) flat or no-rate rule decides
      return;
    }
    const key = `|rule:${i}`;
    groups.push({ key, course: r.course ?? null, name: r.title_match ? `“${r.title_match}”` : 'All titles', autoName: r.title_match ?? 'All titles', renamed: false, tasks: [], unit: isSizeRule(r) ? r.unit : null, mode: isNoRateRule(r) ? 'none' : isFlatRule(r) ? 'flat' : 'unit', ruleIdx: [i], orphan: true });
  });
  const rank = (g: RateGroup) => (g.course ?? '￿').toLowerCase();
  return groups.sort((a, b) => rank(a).localeCompare(rank(b)) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export function findGroup(ctx: Ctx, key: string): RateGroup {
  const g = buildGroups(ctx).find((x) => x.key === key);
  if (!g) throw new Error('That group no longer exists. Reload the Rates screen.');
  return g;
}

// ---------------------------------------------------------------- numbers for a group
export interface GroupStats {
  rateInUse: { minutes: number; source: 'Your rate' | 'Built-in default' | 'Learned'; ruleNumber: number; ruleText: string } | null;
  actual: { minutesPerUnit: number | null; n: number; enough: boolean };
  /** measured minutes per finished timed task in the group (for a flat rate) */
  average: { minutesPerTask: number | null; n: number; enough: boolean };
  openCount: number;
  openEstimatedMinutes: number;
  openWithoutEstimate: number;
  multiplier: { value: number | null; samples: number; enough: boolean; disabled: boolean; resetAt: string | null };
}

export function groupStats(ctx: Ctx, g: RateGroup): GroupStats {
  const { user, all } = loadRates(ctx);
  const learned = loadLearnedRates(ctx, all);
  let rateInUse: GroupStats['rateInUse'] = null;
  const flatI = g.ruleIdx.find((i) => !isSizeRule(user[i]));
  if (g.mode === 'flat' && flatI != null) {
    const fr = user[flatI];
    rateInUse = { minutes: fr.minutes_per_unit, source: 'Your rate', ruleNumber: flatI + 1, ruleText: describeRule(fr) };
  } else if (g.mode === 'none') rateInUse = null;
  else if (g.unit) {
    const sample: SizedTask = { course: g.course, title: g.tasks.find((t) => t.size_unit === g.unit)?.title ?? g.tasks[0]?.title ?? (user[g.ruleIdx[0]]?.title_match ?? ''), size_unit: g.unit, size_amount: 1 };
    const i = matchRateIndex(sample, all);
    if (i >= 0) {
      const rule = all[i];
      const l = learned.get(rateKey(rule));
      rateInUse = { minutes: l ? l.minutesPerUnit : rule.minutes_per_unit, source: l ? 'Learned' : i < user.length ? 'Your rate' : 'Built-in default', ruleNumber: i + 1, ruleText: describeRule(rule) };
    }
  }
  const done = g.tasks.filter((t) => t.status === 'done' && g.unit && t.size_unit === g.unit && (t.size_amount ?? 0) > 0 && (t.actual_minutes ?? 0) > 0);
  const amt = done.reduce((s, t) => s + t.size_amount!, 0);
  const act = done.reduce((s, t) => s + t.actual_minutes!, 0);
  const actual = { minutesPerUnit: done.length >= MIN_RATE_SAMPLES && amt > 0 ? Math.round((act / amt) * 1000) / 1000 : null, n: done.length, enough: done.length >= MIN_RATE_SAMPLES };
  const timed = g.tasks.filter((t) => t.status === 'done' && (t.actual_minutes ?? 0) > 0);
  const avg = { minutesPerTask: timed.length >= MIN_RATE_SAMPLES ? Math.round((timed.reduce((x, t) => x + t.actual_minutes!, 0) / timed.length) * 10) / 10 : null, n: timed.length, enough: timed.length >= MIN_RATE_SAMPLES };
  const open = g.tasks.filter((t) => t.status !== 'done');
  let total = 0, none = 0;
  for (const t of open) { const e = effectiveEstimate(t, all, learned); if (e.minutes == null) none++; else total += e.minutes; }
  const m = groupMultiplierTable(ctx).get(`${g.key}|${g.unit ?? ''}`);
  const off = loadOff(ctx);
  return { rateInUse, actual, average: avg, openCount: open.length, openEstimatedMinutes: total, openWithoutEstimate: none,
    multiplier: { value: m && m.samples >= MIN_RATE_SAMPLES ? m.multiplier : null, samples: m?.samples ?? 0, enough: (m?.samples ?? 0) >= MIN_RATE_SAMPLES, disabled: off.has(g.key), resetAt: loadResets(ctx)[g.key] ?? null } };
}

// ---------------------------------------------------------------- learned multiplier per group
const readOff = (ctx: Ctx): string[] => { try { return JSON.parse(getSetting(ctx.db, MULT_OFF_KEY) ?? '[]') as string[]; } catch { return []; } };
const readResets = (ctx: Ctx): Record<string, string> => { try { return JSON.parse(getSetting(ctx.db, MULT_RESET_KEY) ?? '{}') as Record<string, string>; } catch { return {}; } };
const loadOff = (ctx: Ctx): Set<string> => { const m = keyRemap(ctx).map; return new Set(readOff(ctx).map((k) => m.get(k) ?? k)); };
const loadResets = (ctx: Ctx): Record<string, string> => { const m = keyRemap(ctx).map; return Object.fromEntries(Object.entries(readResets(ctx)).map(([k, v]) => [m.get(k) ?? k, v])); };

interface GRow { id: number; course: string | null; title: string; type: string; size_unit: string | null; estimated_minutes: number; actual_minutes: number; completed_at: string | null }
/** `${group key}|${unit}` -> actual / estimated over finished timed tasks. Learned (multiplied) estimates and size-based ones are excluded, as before. */
export function groupMultiplierTable(ctx: Ctx): Map<string, { multiplier: number; samples: number }> {
  const ov = loadOverrides(ctx);
  const resets = loadResets(ctx);
  const rows = ctx.db.all<GRow>(
    `SELECT id, course, title, type, size_unit, estimated_minutes, actual_minutes, completed_at FROM tasks
      WHERE status = 'done' AND deleted_at IS NULL AND estimated_minutes > 0 AND actual_minutes > 0
        AND (estimate_source IS NULL OR estimate_source IN ('manual','imported'))`);
  const acc = new Map<string, { est: number; act: number; n: number }>();
  for (const r of rows) {
    const gk = groupKeyOf(r, ov);
    if (resets[gk] && (!r.completed_at || r.completed_at <= resets[gk])) continue;
    const k = `${gk}|${r.size_unit ?? ''}`; // course + stem + unit
    const a = acc.get(k) ?? { est: 0, act: 0, n: 0 };
    a.est += r.estimated_minutes; a.act += r.actual_minutes; a.n++;
    acc.set(k, a);
  }
  return new Map([...acc].map(([k, a]) => [k, { multiplier: Math.round((a.act / a.est) * 1000) / 1000, samples: a.n }]));
}

// ---------------------------------------------------------------- editing (callers wrap these in recordChange)
const cleanName = (n: string) => { const t = trimName(n); if (!t) throw new Error('A group needs a name.'); return t; };

export function renameGroup(ctx: Ctx, key: string, name: string): void {
  const g = findGroup(ctx, key);
  if (g.orphan) throw new Error('This rate has no tasks yet, so there is nothing to rename.');
  const ov = loadOverrides(ctx);
  const n = cleanName(name);
  if (n === g.autoName) delete ov.names[key]; else ov.names[key] = n;
  saveOverrides(ctx, ov);
}

export function mergeGroups(ctx: Ctx, from: string, into: string): void {
  if (from === into) throw new Error('Choose a different group to merge into.');
  const a = findGroup(ctx, from), b = findGroup(ctx, into);
  if (a.orphan || b.orphan) throw new Error('Only groups with tasks can be merged.');
  const ov = loadOverrides(ctx);
  // a group already merged into `from` follows it
  for (const [k, v] of Object.entries(ov.merges)) if (v === from) ov.merges[k] = into;
  for (const [id, k] of Object.entries(ov.moves)) if (k === from) ov.moves[id] = into;
  ov.merges[from] = into;
  delete ov.names[from];
  saveOverrides(ctx, ov);
}

export function moveTask(ctx: Ctx, taskId: number, to: string): void {
  if (!getTask(ctx, taskId)) throw new Error(`No task #${taskId}.`);
  const target = findGroup(ctx, to);
  if (target.orphan) throw new Error('Choose a group that has tasks.');
  const ov = loadOverrides(ctx);
  ov.moves[String(taskId)] = target.key;
  saveOverrides(ctx, ov);
}

/** Take one task out of its group into a group of its own (named after its title; rename it as you like). */
export function splitTask(ctx: Ctx, taskId: number): string {
  const t = getTask(ctx, taskId);
  if (!t) throw new Error(`No task #${taskId}.`);
  const ov = loadOverrides(ctx);
  const key = `${(t.course ?? '').trim().toLowerCase()}|~${taskId}`;
  ov.moves[String(taskId)] = key;
  ov.names[key] = trimName(t.title);
  saveOverrides(ctx, ov);
  return key;
}

const checkMinutes = (m: number) => {
  if (!Number.isFinite(m) || m <= 0 || m > 10000) throw new Error('Minutes per unit must be a number above 0 (decimals are fine, e.g. 0.3).');
};

/** Save the group's rate as a rule of the user's: unit, minutes per unit (decimals), and the text a title must contain. */
export function setGroupRate(ctx: Ctx, key: string, input: { unit: string; minutes: number; match?: string }): RateRule {
  const g = findGroup(ctx, key);
  const unit = parseUnit(input.unit);
  checkMinutes(input.minutes);
  const match = (input.match ?? '').trim() || g.autoName.toLowerCase();
  if (match.length > 100) throw new Error('The match text is too long (100 characters at most).');
  const rule: RateRule = { unit, minutes_per_unit: input.minutes, ...(g.course ? { course: g.course } : {}), title_match: match };
  const { user } = loadRates(ctx);
  const mine = g.ruleIdx.filter((i) => user[i].unit === unit);
  const next = user.filter((_, i) => !mine.includes(i) || i === mine[0]);
  const at = mine.length ? next.findIndex((r) => r === user[mine[0]]) : -1;
  if (at >= 0) next[at] = rule; else next.unshift(rule);
  persistUser(ctx, next);
  return rule;
}

/**
 * Choose how a group is estimated. 'unit' removes the group's flat / no-rate rule; its per-unit rule is kept as it was.
 * 'flat' saves a flat number of minutes per task (course + title text, no unit); 'none' saves a no-rate rule. A per-unit rule the group
 * already has is kept, so switching back loses nothing but the flat number. Renames, merges and multiplier switches are group settings and are not touched.
 */
export function setGroupMode(ctx: Ctx, key: string, input: { mode: GroupMode; minutes?: number; match?: string }): { mode: GroupMode; rule: RateRule | null } {
  const g = findGroup(ctx, key);
  const { user } = loadRates(ctx);
  const dropIdx = new Set(g.ruleIdx.filter((i) => !isSizeRule(user[i])));
  const keep = user.filter((_, i) => !dropIdx.has(i));
  if (input.mode === 'unit') { persistUser(ctx, keep); return { mode: 'unit', rule: null }; }
  const own = g.ruleIdx.map((i) => user[i]).find((r) => isSizeRule(r));
  const match = (input.match ?? '').trim() || [...dropIdx].map((i) => user[i].title_match).find(Boolean) || own?.title_match || g.autoName.toLowerCase();
  if (match.length > 100) throw new Error('The match text is too long (100 characters at most).');
  const base = { ...(g.course ? { course: g.course } : {}), title_match: match };
  let rule: RateRule;
  if (input.mode === 'flat') {
    const m = input.minutes ?? [...dropIdx].map((i) => user[i]).find(isFlatRule)?.minutes_per_unit;
    if (m == null) throw new Error('Enter how many minutes each task in this group takes.');
    if (!Number.isFinite(m) || m <= 0 || m > 10000) throw new Error('Minutes per assignment must be a number above 0.');
    rule = { unit: FLAT_UNIT, minutes_per_unit: m, ...base };
  } else rule = { unit: NONE_UNIT, minutes_per_unit: 0, ...base };
  persistUser(ctx, [rule, ...keep]);
  return { mode: input.mode, rule };
}

export function resetGroupRate(ctx: Ctx, key: string): number {
  const g = findGroup(ctx, key);
  const { user } = loadRates(ctx);
  const drop = new Set(g.ruleIdx);
  persistUser(ctx, user.filter((_, i) => !drop.has(i)));
  return drop.size;
}
function persistUser(ctx: Ctx, rules: RateRule[]) {
  if (rules.length) setSetting(ctx.db, 'size_rates', JSON.stringify(rules)); else ctx.db.run("DELETE FROM settings WHERE key = 'size_rates'");
}

/** Tasks a title match would catch (same course, title contains the text), with the group each is in. */
export function matchPreview(ctx: Ctx, course: string | null, match: string): { id: number; title: string; status: string; group: string }[] {
  const m = match.trim().toLowerCase();
  if (!m) return [];
  const groups = buildGroups(ctx);
  const out: { id: number; title: string; status: string; group: string }[] = [];
  for (const g of groups) for (const t of g.tasks) {
    if (course && (t.course ?? '').toLowerCase() !== course.toLowerCase()) continue;
    if (t.title.toLowerCase().includes(m)) out.push({ id: t.id, title: t.title, status: t.status, group: g.name });
  }
  return out.slice(0, 200);
}

// ---- global defaults ----
export function setDefaultRate(ctx: Ctx, index: number, minutes: number): void {
  checkMinutes(minutes);
  const { rules } = loadDefaults(ctx);
  if (!Number.isInteger(index) || index < 0 || index >= rules.length) throw new Error('No such built-in rate.');
  rules[index] = { ...rules[index], minutes_per_unit: minutes };
  setSetting(ctx.db, DEFAULTS_KEY, JSON.stringify(rules));
}
export function resetDefaults(ctx: Ctx): void {
  ctx.db.run('DELETE FROM settings WHERE key IN (?, ?)', [DEFAULTS_KEY, POINTS_MIN_KEY]);
}
export function setPointsMin(ctx: Ctx, minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error('The shortest points-based estimate must be a whole number of minutes from 1 to 240.');
  if (minutes === MIN_POINTS_MINUTES) ctx.db.run('DELETE FROM settings WHERE key = ?', [POINTS_MIN_KEY]);
  else setSetting(ctx.db, POINTS_MIN_KEY, String(minutes));
}

// ---- multiplier switches ----
export function setMultiplierEnabled(ctx: Ctx, key: string, enabled: boolean): void {
  findGroup(ctx, key);
  const off = loadOff(ctx);
  if (enabled) off.delete(key); else off.add(key);
  if (off.size) setSetting(ctx.db, MULT_OFF_KEY, JSON.stringify([...off].sort())); else ctx.db.run('DELETE FROM settings WHERE key = ?', [MULT_OFF_KEY]);
}
/** Forget the history so far: only tasks finished after this moment count toward the group's multiplier. */
export function resetMultiplier(ctx: Ctx, key: string): void {
  findGroup(ctx, key);
  const r = loadResets(ctx);
  r[key] = new Date(ctx.clock.now().getTime()).toISOString();
  setSetting(ctx.db, MULT_RESET_KEY, JSON.stringify(r));
}

// ---------------------------------------------------------------- "apply to these tasks"
export interface ApplyRow { taskId: number; title: string; before: number | null; beforeSource: string | null; after: number; formula: string; wasManual: boolean }
export interface ApplyPreview { rows: ApplyRow[]; keptManual: number; fingerprint: string }

/**
 * Which open tasks of the group would get their SAVED estimate set from size: they have a size and a rate, and their saved estimate is none or
 * a stale size-based one. A manual estimate is left alone unless `replaceManual`. Nothing is written.
 */
export function previewApply(ctx: Ctx, key: string, replaceManual = false): ApplyPreview {
  const g = findGroup(ctx, key);
  const { all } = loadRates(ctx);
  const learned = loadLearnedRates(ctx, all);
  const rows: ApplyRow[] = [];
  let keptManual = 0;
  for (const t of g.tasks) {
    if (t.status === 'done') continue;
    const est = sizeEstimate(t, all, learned);
    if (!est) continue;
    const manual = t.estimated_minutes != null && t.estimate_source !== 'size';
    if (manual && !replaceManual) { if (t.estimated_minutes !== est.minutes) keptManual++; continue; }
    if (t.estimated_minutes === est.minutes && t.estimate_source === 'size') continue;
    if (manual && t.estimated_minutes === est.minutes) continue;
    rows.push({ taskId: t.id, title: t.title, before: t.estimated_minutes, beforeSource: t.estimate_source ?? (t.estimated_minutes != null ? 'manual' : null), after: est.minutes, formula: est.formula, wasManual: manual });
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([key, replaceManual, rows.map((r) => [r.taskId, r.before, r.after])])).digest('hex').slice(0, 16);
  return { rows, keptManual, fingerprint };
}

/** Write exactly the previewed estimates. Refuses if the preview no longer matches (rates or tasks changed since it was shown). */
export function applyToTasks(ctx: Ctx, key: string, opts: { replaceManual: boolean; fingerprint: string; confirm: boolean }): ApplyPreview {
  const p = previewApply(ctx, key, opts.replaceManual);
  if (p.fingerprint !== opts.fingerprint) throw new Error('The tasks or rates changed since you looked at this list. Nothing was changed. Review the list again.');
  if (p.rows.length > 3 && !opts.confirm) throw new Error(`${p.rows.length} tasks would change. Confirm to continue; nothing was changed.`);
  for (const r of p.rows) refreshSizeEstimate(ctx, r.taskId, true);
  return p;
}
