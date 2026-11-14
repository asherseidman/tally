import type { Ctx } from './ctx';
import { getSetting } from '../db/repo';

export const SIZE_UNITS = ['pages', 'video_minutes', 'problems', 'items', 'points'] as const;
export type SizeUnit = (typeof SIZE_UNITS)[number];

const ALIASES: Record<string, SizeUnit> = {
  page: 'pages', pages: 'pages', pg: 'pages', pp: 'pages',
  video: 'video_minutes', videos: 'video_minutes', video_minutes: 'video_minutes', video_min: 'video_minutes', min: 'video_minutes', minutes: 'video_minutes',
  problem: 'problems', problems: 'problems', q: 'problems', questions: 'problems',
  item: 'items', items: 'items',
  point: 'points', points: 'points', pt: 'points', pts: 'points',
};
export const parseUnit = (s: string): SizeUnit => {
  const u = ALIASES[s.trim().toLowerCase().replace(/\s+/g, '_')];
  if (!u) throw new Error(`Unknown size unit "${s}". Use one of: ${SIZE_UNITS.join(', ')}.`);
  return u;
};

/** "12 pages", "12pages", "12" + "pages" -> {amount, unit}. */
export function parseSize(amountText: string, unitText?: string): { amount: number; unit: SizeUnit } {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z_ ]*)$/i.exec(`${amountText}${unitText ? ` ${unitText}` : ''}`.trim());
  if (!m) throw new Error(`"${amountText}${unitText ? ' ' + unitText : ''}" is not a size like "12 pages".`);
  const amount = Number(m[1]);
  if (!(amount > 0)) throw new Error('A size must be greater than 0.');
  if (!m[2].trim()) throw new Error(`Say what the ${amount} is: pages, video_minutes, problems, items or points (e.g. --size ${amount} pages).`);
  return { amount, unit: parseUnit(m[2]) };
}

/** One rate. Rules are tried in order; the first whose unit matches (and course / title_match, when given) wins. */
export const FLAT_UNIT = 'assignment' as const; // a flat number of minutes for every task the rule matches (no size needed)
export const NONE_UNIT = 'none' as const; // "no rate": matching tasks never get a flat or size-based estimate
export type RuleUnit = SizeUnit | typeof FLAT_UNIT | typeof NONE_UNIT;
export const isFlatRule = (r: { unit: string }) => r.unit === FLAT_UNIT;
export const isNoRateRule = (r: { unit: string }) => r.unit === NONE_UNIT;
/** a per-unit rule (the only kind that looks at a task's size) */
export const isSizeRule = (r: { unit: string }) => r.unit !== FLAT_UNIT && r.unit !== NONE_UNIT;

export interface RateRule {
  /** a size unit (per unit), 'assignment' (flat minutes per task: minutes_per_unit is the whole task) or 'none' (no rate; minutes_per_unit is 0) */
  unit: RuleUnit;
  /** minutes of work per unit (video_minutes: minutes of work per minute of video; points: minutes per point, e.g. 0.3). Decimals are fine. */
  minutes_per_unit: number;
  course?: string;
  /** case-insensitive substring of the task title */
  title_match?: string;
}

/** My guesses; editable with: config set size_rates <json>. User rules are tried before these. */
export const DEFAULT_RATES: RateRule[] = [
  { unit: 'problems', title_match: 'webwork', minutes_per_unit: 6 },
  { unit: 'problems', course: 'MATH 214', minutes_per_unit: 15 },
  { unit: 'pages', minutes_per_unit: 3 },
  { unit: 'video_minutes', minutes_per_unit: 1.25 },
  { unit: 'items', minutes_per_unit: 30 },
  // zyBooks-style assignments: about 100 points = about 30 minutes. Set a per-course / per-title rate with `rates set` or `config set size_rates`.
  { unit: 'points', minutes_per_unit: 0.3 },
];

export interface SizedTask {
  course: string | null;
  title: string;
  size_unit: string | null;
  size_amount: number | null;
}

/** The rule list plus the one number that is not a rule: the shortest points-based estimate. Passed around as `rules` so callers need no new argument. */
export type RateList = RateRule[] & { pointsMin?: number };
export const POINTS_MIN_KEY = 'points_min_minutes';
export const DEFAULTS_KEY = 'rate_defaults';

function parseRules(raw: string, key: string): RateRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Setting "${key}" is not valid JSON. Fix it with: config set ${key} <json>`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${key} must be a JSON list of {unit, minutes_per_unit, course?, title_match?}.`);
  return parsed.map((r, i) => {
    if (r && r.unit === NONE_UNIT) return { unit: NONE_UNIT, minutes_per_unit: 0, ...(r.course ? { course: String(r.course) } : {}), ...(r.title_match ? { title_match: String(r.title_match) } : {}) };
    if (!r || !([...SIZE_UNITS, FLAT_UNIT] as readonly string[]).includes(r.unit) || !(Number(r.minutes_per_unit) > 0)) {
      throw new Error(`${key}[${i}] needs a unit (${SIZE_UNITS.join('/')}, assignment or none) and a positive minutes_per_unit.`);
    }
    return { unit: r.unit, minutes_per_unit: Number(r.minutes_per_unit), ...(r.course ? { course: String(r.course) } : {}), ...(r.title_match ? { title_match: String(r.title_match) } : {}) };
  });
}

/** The built-in rates, unless the user edited them in the Rates screen (setting rate_defaults replaces the whole list; order is kept). */
export function loadDefaults(ctx: Ctx): { rules: RateRule[]; edited: boolean } {
  const raw = getSetting(ctx.db, DEFAULTS_KEY);
  if (!raw) return { rules: DEFAULT_RATES.map((r) => ({ ...r })), edited: false };
  return { rules: parseRules(raw, DEFAULTS_KEY), edited: true };
}

export function loadPointsMin(ctx: Ctx): number {
  const n = Number(getSetting(ctx.db, POINTS_MIN_KEY));
  return Number.isInteger(n) && n >= 1 && n <= 240 ? n : MIN_POINTS_MINUTES;
}

export function loadRates(ctx: Ctx): { user: RateRule[]; defaults: RateRule[]; all: RateList } {
  const raw = getSetting(ctx.db, 'size_rates');
  const user = raw ? parseRules(raw, 'size_rates') : [];
  const defaults = loadDefaults(ctx).rules;
  const all: RateList = [...user, ...defaults];
  all.pointsMin = loadPointsMin(ctx);
  return { user, defaults, all };
}

export function matchRateIndex(t: SizedTask, rules: RateRule[]): number {
  return rules.findIndex((r) => isSizeRule(r) && ruleMatches(t, r));
}
/** Index of the first flat or no-rate rule that catches the task (course and title text only; the size is not looked at). Flat beats per-unit. */
export function flatRuleIndex(t: { course: string | null; title: string }, rules: RateRule[]): number {
  return rules.findIndex((r) => !isSizeRule(r) && textMatches(t, r));
}
const textMatches = (t: { course: string | null; title: string }, r: RateRule): boolean =>
  (!r.course || r.course.toLowerCase() === (t.course ?? '').toLowerCase()) && (!r.title_match || t.title.toLowerCase().includes(r.title_match.toLowerCase()));
export const ruleMatches = (t: SizedTask, r: RateRule): boolean =>
  (isSizeRule(r) ? r.unit === t.size_unit : true) && (!r.course || r.course.toLowerCase() === (t.course ?? '').toLowerCase()) && (!r.title_match || t.title.toLowerCase().includes(r.title_match.toLowerCase()));

export function matchRate(t: SizedTask, rules: RateRule[]): RateRule | undefined {
  return rules.find(
    (r) =>
      r.unit === t.size_unit &&
      (!r.course || r.course.toLowerCase() === (t.course ?? '').toLowerCase()) &&
      (!r.title_match || t.title.toLowerCase().includes(r.title_match.toLowerCase())),
  );
}

/** Identity of a rate for learning: tasks that share a rule share a learned rate. */
export const rateKey = (r: RateRule) => `${r.course ?? '*'}|${r.unit}|${r.title_match ?? '*'}`;

export const MIN_RATE_SAMPLES = 3;

export interface LearnedRate {
  minutesPerUnit: number;
  samples: number;
}

/**
 * Actual minutes per unit for each rate rule, from DONE tasks that have a size and tracked time. A rate only
 * applies once it has MIN_RATE_SAMPLES samples. The per-type multiplier is never applied on top of these.
 */
export function loadLearnedRates(ctx: Ctx, rules: RateRule[]): Map<string, LearnedRate> {
  const rows = ctx.db.all<SizedTask & { actual_minutes: number }>(
    `SELECT course, title, size_unit, size_amount, actual_minutes FROM tasks
      WHERE status = 'done' AND deleted_at IS NULL AND size_amount > 0 AND size_unit IS NOT NULL AND actual_minutes > 0`,
  );
  const acc = new Map<string, { act: number; amt: number; n: number }>();
  for (const r of rows) {
    const rule = matchRate(r, rules);
    if (!rule) continue;
    const a = acc.get(rateKey(rule)) ?? { act: 0, amt: 0, n: 0 };
    a.act += r.actual_minutes;
    a.amt += r.size_amount!;
    a.n++;
    acc.set(rateKey(rule), a);
  }
  const out = new Map<string, LearnedRate>();
  for (const [k, a] of acc) if (a.n >= MIN_RATE_SAMPLES) out.set(k, { minutesPerUnit: Math.round((a.act / a.amt) * 1000) / 1000, samples: a.n });
  return out;
}

export interface SizeEstimate {
  /** a flat per-assignment estimate (no size involved) */
  flat?: boolean;
  minutes: number;
  rate: number;
  learned: boolean;
  samples: number;
  formula: string;
}

const UNIT_LABEL: Record<SizeUnit, string> = { pages: 'pages', video_minutes: 'video min', problems: 'problems', items: 'items', points: 'points' };

/** Size-based estimates are whole minutes. Points-based work never goes below this (a 10-point exercise is not a 3-minute task). */
export const MIN_POINTS_MINUTES = 5;
/** "Flat 60 min per EECS 183 Labs" */
export const flatText = (r: RateRule, t?: { course: string | null }) => `Flat ${Math.round(r.minutes_per_unit * 1000) / 1000} min per ${[r.course ?? t?.course, r.title_match].filter(Boolean).join(' ') || 'assignment'}`;
const trim = (n: number) => String(Math.round(n * 1000) / 1000);

/** amount x rate, or undefined when the task has no size amount or no rate applies. */
export function sizeEstimate(t: SizedTask, rules: RateRule[], learned: Map<string, LearnedRate>): SizeEstimate | undefined {
  // flat (per assignment) beats per unit; a "no rate" rule that comes first stops both
  const fi = flatRuleIndex(t, rules);
  if (fi >= 0) {
    const fr = rules[fi];
    if (isNoRateRule(fr)) return undefined;
    const minutes = Math.max(1, Math.round(fr.minutes_per_unit));
    return { flat: true, minutes, rate: fr.minutes_per_unit, learned: false, samples: 0, formula: `${flatText(fr, t)} = ${minutes} min` };
  }
  if (!t.size_unit || !t.size_amount) return undefined;
  const rule = matchRate(t, rules);
  if (!rule) return undefined;
  const l = learned.get(rateKey(rule));
  const rate = l ? l.minutesPerUnit : rule.minutes_per_unit;
  const minutes = Math.max(t.size_unit === 'points' ? (rules as RateList).pointsMin ?? MIN_POINTS_MINUTES : 1, Math.round(t.size_amount * rate));
  const unit = UNIT_LABEL[t.size_unit as SizeUnit];
  const how = l ? `learned rate from ${l.samples} finished tasks` : 'default rate';
  const rateText = t.size_unit === 'video_minutes' ? `${trim(rate)}` : `${trim(rate)} min`;
  return { minutes, rate, learned: !!l, samples: l?.samples ?? 0, formula: `${trim(t.size_amount)} ${unit} x ${rateText} = ${minutes} min (${how})` };
}

export interface EffectiveEstimate {
  minutes: number | null;
  source: 'manual' | 'size' | null;
  size?: SizeEstimate;
  formula?: string;
}

/**
 * Estimate order: manual (or imported) estimate > size-based > none. A manual estimate is never replaced
 * silently; `size` is still returned alongside it so callers can show the difference.
 */
export function effectiveEstimate(
  t: SizedTask & { estimated_minutes: number | null; estimate_source: string | null },
  rules: RateRule[],
  learned: Map<string, LearnedRate>,
): EffectiveEstimate {
  const size = sizeEstimate(t, rules, learned);
  if (t.estimated_minutes != null && t.estimate_source !== 'size') return { minutes: t.estimated_minutes, source: 'manual', size };
  if (size) return { minutes: size.minutes, source: 'size', size, formula: size.formula };
  return { minutes: null, source: null };
}

/**
 * Keep the stored estimate of size-sourced tasks in step with their size and rates (a learned rate can change
 * it). Tasks with a manual estimate are never touched.
 */
export function syncSizeEstimates(ctx: Ctx): number {
  const { all } = loadRates(ctx);
  const learned = loadLearnedRates(ctx, all);
  const rows = ctx.db.all<SizedTask & { id: number; estimated_minutes: number | null; estimate_source: string | null }>(
    "SELECT id, course, title, size_unit, size_amount, estimated_minutes, estimate_source FROM tasks WHERE (estimate_source = 'size' OR estimated_minutes IS NULL) AND deleted_at IS NULL AND status <> 'done'",
  );
  let n = 0;
  for (const r of rows) {
    const e = sizeEstimate(r, all, learned);
    if (e) {
      if (r.estimate_source === 'size' && r.estimated_minutes === e.minutes) continue;
      ctx.db.run("UPDATE tasks SET estimated_minutes = ?, estimate_source = 'size' WHERE id = ?", [e.minutes, r.id]);
    } else if (r.estimate_source === 'size') ctx.db.run('UPDATE tasks SET estimated_minutes = NULL, estimate_source = NULL WHERE id = ?', [r.id]);
    else continue;
    n++;
  }
  return n;
}

// ---- editing the user's own rate rules (the same JSON `config set size_rates` stores) ----
const saveUser = (ctx: Ctx, rules: RateRule[]) => {
  if (rules.length) ctx.db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['size_rates', JSON.stringify(rules)]);
  else ctx.db.run("DELETE FROM settings WHERE key = 'size_rates'");
};

/** Add or replace the user rule for this unit + course + title pattern. Decimals are allowed (0.3 minutes per point). */
export function setRate(ctx: Ctx, rule: { unit: string; minutes_per_unit: number; course?: string; title_match?: string; per_assignment?: boolean }): RateRule {
  const unit: RuleUnit = rule.per_assignment ? FLAT_UNIT : parseUnit(rule.unit);
  if (!Number.isFinite(rule.minutes_per_unit) || rule.minutes_per_unit <= 0 || rule.minutes_per_unit > 10000) throw new Error('Minutes per unit must be a number above 0 (decimals are fine, e.g. 0.3).');
  const clean: RateRule = { unit, minutes_per_unit: rule.minutes_per_unit, ...(rule.course?.trim() ? { course: rule.course.trim() } : {}), ...(rule.title_match?.trim() ? { title_match: rule.title_match.trim() } : {}) };
  const same = (r: RateRule) => r.unit === clean.unit && (r.course ?? '').toLowerCase() === (clean.course ?? '').toLowerCase() && (r.title_match ?? '').toLowerCase() === (clean.title_match ?? '').toLowerCase();
  const user = loadRates(ctx).user;
  const i = user.findIndex(same);
  if (i >= 0) user[i] = clean; else user.unshift(clean); // newest first: it is tried before older rules
  saveUser(ctx, user);
  return clean;
}

/** Remove the n-th (1-based) user rule. */
export function removeRate(ctx: Ctx, n: number): RateRule {
  const user = loadRates(ctx).user;
  if (!Number.isInteger(n) || n < 1 || n > user.length) throw new Error(`There is no rule ${n}. You have ${user.length}.`);
  const [gone] = user.splice(n - 1, 1);
  saveUser(ctx, user);
  return gone;
}

export const describeRule = (r: RateRule) => isNoRateRule(r) ? `${r.course ?? 'any course'} · ${r.title_match ? `titles containing “${r.title_match}”` : 'any title'} · no rate (no flat or size-based estimate)`
  : isFlatRule(r) ? `${r.course ?? 'any course'} · ${r.title_match ? `titles containing “${r.title_match}”` : 'any title'} · flat: ${Math.round(r.minutes_per_unit * 1000) / 1000} min per assignment`
  : `${r.course ?? 'any course'} · ${r.title_match ? `titles containing “${r.title_match}”` : 'any title'} · ${r.unit}: ${Math.round(r.minutes_per_unit * 1000) / 1000} min per ${r.unit === 'video_minutes' ? 'video minute' : r.unit.replace(/s$/, '')}`;

/** One plain line saying which rule produced a task's estimate ("why this estimate"). */
export function explainEstimate(
  t: SizedTask & { estimated_minutes: number | null; estimate_source: string | null },
  rules: RateRule[],
  userCount: number,
  learned: Map<string, LearnedRate>,
): string | null {
  const e = effectiveEstimate(t, rules, learned);
  const fi = flatRuleIndex(t, rules);
  if (fi >= 0) {
    const fr = rules[fi];
    const who = fi < userCount ? 'your rate' : 'built-in rate';
    if (isNoRateRule(fr)) return `${e.source === 'manual' ? 'Your manual estimate is used. ' : ''}This group has no rate (rule ${fi + 1} of ${rules.length}, ${who}), so no flat or size-based estimate is made.`;
    const flat = `${flatText(fr, t)}. Rule ${fi + 1} of ${rules.length} (${who}); a flat rate is tried before per-unit rates.`;
    return e.source === 'manual' ? `Your manual estimate is used. It would be: ${flat}` : flat;
  }
  if (!t.size_unit || !t.size_amount) return e.source === 'manual' ? 'A manual estimate (no size is set, so no rate was used).' : null;
  const i = matchRateIndex(t, rules);
  if (i < 0) return `No rate matches ${t.size_unit} here. Add one on the Rates screen.`;
  const rule = rules[i];
  const l = learned.get(rateKey(rule));
  const who = i < userCount ? 'your rate' : 'built-in rate';
  const rule1 = `Rule ${i + 1} of ${rules.length} (${who}${l ? `, replaced by the learned rate ${l.minutesPerUnit} from ${l.samples} finished tasks` : ''}): ${describeRule(rule)}. Rules are tried in this order; the first that matches wins.`;
  return e.source === 'manual' ? `Your manual estimate is used. ${rule1} It would give ${e.size!.minutes} min.` : rule1;
}

/** A rule as plain data for the connector and other read-only views. */
export function ruleView(r: RateRule, number: number) {
  const kind = isNoRateRule(r) ? 'no_rate' : isFlatRule(r) ? 'per_assignment' : 'per_unit';
  return {
    number, kind, unit: isSizeRule(r) ? r.unit : null,
    minutesPerUnit: kind === 'per_unit' ? r.minutes_per_unit : null, minutesPerAssignment: kind === 'per_assignment' ? r.minutes_per_unit : null,
    course: r.course ?? null, titleContains: r.title_match ?? null, text: describeRule(r),
  };
}
