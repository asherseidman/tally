import { z } from 'zod';
import type { ApiDeps } from './api';
import { recordChange } from '../core/changeLog';
import {
  buildGroups, findGroup, groupStats, loadOverrides, renameGroup, mergeGroups, moveTask, splitTask, setGroupRate, resetGroupRate, matchPreview, setDefaultRate, resetDefaults,
  setPointsMin, setMultiplierEnabled, resetMultiplier, previewApply, applyToTasks, regroup, regroupPreview, regroupPending, setGroupMode,
} from '../core/rateGroups';
import { isSizeRule, loadRates, loadDefaults, loadPointsMin, describeRule, DEFAULT_RATES, SIZE_UNITS, MIN_POINTS_MINUTES } from '../core/size';
import type { RateGroupDto, RatesView, RatePreviewTask, RateApplyPreview, RegroupReportDto } from './types';

const ACTOR = 'rates';
const key = z.object({ key: z.string().min(1).max(300) });
const minutes = z.number().positive().max(10000);

export function ratesView(d: ApiDeps): RatesView {
  const ctx = d.ctx;
  const { user, defaults, all } = loadRates(ctx);
  const groups: RateGroupDto[] = buildGroups(ctx).map((g) => {
    const s = groupStats(ctx, g);
    const sizeRules = g.ruleIdx.map((i) => ({ i, r: user[i] })).filter((x) => isSizeRule(x.r));
    const own = sizeRules.find((x) => x.r.unit === g.unit) ?? sizeRules[0];
    const flatRule = g.ruleIdx.map((i) => ({ i, r: user[i] })).find((x) => !isSizeRule(x.r));
    return {
      key: g.key, course: g.course, name: g.name, autoName: g.autoName, renamed: g.renamed, orphan: g.orphan, unit: g.unit,
      tasks: g.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, done: t.status === 'done', sizeAmount: t.size_amount, sizeUnit: t.size_unit, estimate: t.estimated_minutes, estimateSource: t.estimate_source, noSize: !t.size_unit || !t.size_amount, actualMinutes: t.actual_minutes ?? 0 })),
      openCount: s.openCount, doneCount: g.tasks.length - s.openCount,
      rule: own ? { unit: own.r.unit, minutes: own.r.minutes_per_unit, match: own.r.title_match ?? '', number: own.i + 1 } : null,
      mode: g.mode, flat: flatRule ? { minutes: flatRule.r.minutes_per_unit, match: flatRule.r.title_match ?? '', number: flatRule.i + 1 } : null, average: s.average,
      suggestedMatch: g.autoName.toLowerCase(),
      rateInUse: s.rateInUse, actual: s.actual, openEstimatedMinutes: s.openEstimatedMinutes, openWithoutEstimate: s.openWithoutEstimate, multiplier: s.multiplier,
    };
  });
  const dd = loadDefaults(ctx);
  return {
    groups, units: [...SIZE_UNITS],
    defaults: dd.rules.map((r, i) => ({ index: i, unit: r.unit, course: r.course ?? null, match: r.title_match ?? null, minutes: r.minutes_per_unit, builtIn: DEFAULT_RATES[i] && sameRule(DEFAULT_RATES[i], r) ? DEFAULT_RATES[i].minutes_per_unit : null, edited: !!DEFAULT_RATES[i] && sameRule(DEFAULT_RATES[i], r) && DEFAULT_RATES[i].minutes_per_unit !== r.minutes_per_unit })),
    defaultsEdited: dd.edited, pointsMin: loadPointsMin(ctx), pointsMinDefault: MIN_POINTS_MINUTES,
    order: all.map((r, i) => ({ number: i + 1, mine: i < user.length, unit: r.unit, course: r.course ?? null, match: r.title_match ?? null, minutes: r.minutes_per_unit, text: describeRule(r) })),
    courses: [...new Set(groups.map((g) => g.course ?? ''))].sort((a, b) => (a || '￿').localeCompare(b || '￿')),
    regroupPending: regroupPending(ctx),
  };
  void defaults;
}
const sameRule = (a: { unit: string; course?: string; title_match?: string }, b: { unit: string; course?: string; title_match?: string }) => a.unit === b.unit && (a.course ?? '') === (b.course ?? '') && (a.title_match ?? '') === (b.title_match ?? '');

/** Every edit is one entry in the shared change history (Recent changes), so it can be undone. */
const record = <T>(d: ApiDeps, tool: string, summary: string, fn: () => T): T => recordChange(d.ctx, { actor: ACTOR, tool, summary: () => summary }, fn).result;

export const ratesHandlers: Record<string, (d: ApiDeps, a: unknown) => unknown> = {
  'rates.get': (d): RatesView => ratesView(d),

  'rates.saveGroup': (d, a): RatesView => {
    const p = key.extend({ unit: z.enum(SIZE_UNITS), minutes, match: z.string().max(100).optional() }).parse(a);
    const g = findGroup(d.ctx, p.key);
    record(d, 'rates_save_group', `Rate for “${g.name}”${g.course ? ` (${g.course})` : ''}: ${p.minutes} min per ${p.unit}`, () => setGroupRate(d.ctx, p.key, { unit: p.unit, minutes: p.minutes, match: p.match }));
    return ratesView(d);
  },
  // Mode: per unit (size x rate), a flat time per assignment, or no rate. Other settings of the group are kept.
  'rates.setMode': (d, a): RatesView => {
    const p = key.extend({ mode: z.enum(['unit', 'flat', 'none']), minutes: minutes.optional(), match: z.string().max(100).optional() }).parse(a);
    const g = findGroup(d.ctx, p.key);
    const what = p.mode === 'flat' ? `flat ${p.minutes ?? ''} min per assignment`.replace('  ', ' ') : p.mode === 'none' ? 'no rate' : 'per unit';
    record(d, 'rates_set_mode', `Rate mode for “${g.name}”${g.course ? ` (${g.course})` : ''}: ${what}`, () => setGroupMode(d.ctx, p.key, { mode: p.mode, minutes: p.minutes, match: p.match }));
    return ratesView(d);
  },
  'rates.resetGroup': (d, a): RatesView => {
    const { key: k } = key.parse(a);
    const g = findGroup(d.ctx, k);
    record(d, 'rates_reset_group', `Reset the rate for “${g.name}” to the built-in default`, () => resetGroupRate(d.ctx, k));
    return ratesView(d);
  },
  'rates.rename': (d, a): RatesView => {
    const p = key.extend({ name: z.string().min(1).max(100) }).parse(a);
    const g = findGroup(d.ctx, p.key);
    record(d, 'rates_rename_group', `Renamed rate group “${g.name}” to “${p.name.trim()}”`, () => renameGroup(d.ctx, p.key, p.name));
    return ratesView(d);
  },
  'rates.merge': (d, a): RatesView => {
    const p = z.object({ from: z.string().min(1), into: z.string().min(1) }).parse(a);
    const f = findGroup(d.ctx, p.from), t = findGroup(d.ctx, p.into);
    record(d, 'rates_merge_groups', `Merged rate group “${f.name}” into “${t.name}”`, () => mergeGroups(d.ctx, p.from, p.into));
    return ratesView(d);
  },
  'rates.split': (d, a): RatesView => {
    const p = z.object({ taskId: z.number().int().positive() }).parse(a);
    record(d, 'rates_split_task', `Split task #${p.taskId} into its own rate group`, () => splitTask(d.ctx, p.taskId));
    return ratesView(d);
  },
  'rates.move': (d, a): RatesView => {
    const p = z.object({ taskId: z.number().int().positive(), to: z.string().min(1) }).parse(a);
    const t = findGroup(d.ctx, p.to);
    record(d, 'rates_move_task', `Moved task #${p.taskId} to rate group “${t.name}”`, () => moveTask(d.ctx, p.taskId, p.to));
    return ratesView(d);
  },
  // Regroup: recompute the automatic groups from the titles. Renames, merges, splits and moves are kept; saved rates are untouched.
  'rates.regroupPreview': (d): RegroupReportDto => regroupPreview(d.ctx),
  'rates.regroup': (d): RatesView & { report: RegroupReportDto } => {
    const r = recordChange(d.ctx, { actor: ACTOR, tool: 'rates_regroup', summary: (x: RegroupReportDto) => `Regrouped rate groups: ${x.changedTasks.length} task${x.changedTasks.length === 1 ? '' : 's'} moved, ${x.overridesCarried} saved setting${x.overridesCarried === 1 ? '' : 's'} carried over` }, () => regroup(d.ctx));
    return { ...ratesView(d), report: r.result };
  },
  'rates.preview': (d, a): RatePreviewTask[] => {
    const p = z.object({ course: z.string().nullable(), match: z.string().max(100) }).parse(a);
    return matchPreview(d.ctx, p.course, p.match);
  },

  'rates.applyPreview': (d, a): RateApplyPreview => {
    const p = key.extend({ replaceManual: z.boolean().default(false) }).parse(a);
    const pv = previewApply(d.ctx, p.key, p.replaceManual);
    return { ...pv, needsConfirm: pv.rows.length > 3 };
  },
  // Writes exactly the previewed estimates, only with confirm, and only if nothing changed since the list was shown.
  'rates.apply': (d, a): RatesView & { changed: number } => {
    const p = key.extend({ replaceManual: z.boolean().default(false), fingerprint: z.string(), confirm: z.boolean() }).parse(a);
    if (!p.confirm) throw new Error('Confirm the list of changes first. Nothing was changed.');
    const g = findGroup(d.ctx, p.key);
    const r = record(d, 'rates_apply_to_tasks', `Set size-based estimates for “${g.name}” tasks${p.replaceManual ? ' (replacing manual ones)' : ''}`, () => applyToTasks(d.ctx, p.key, { replaceManual: p.replaceManual, fingerprint: p.fingerprint, confirm: p.confirm }));
    return { ...ratesView(d), changed: r.rows.length };
  },

  'rates.setDefault': (d, a): RatesView => {
    const p = z.object({ index: z.number().int().min(0), minutes }).parse(a);
    const cur = loadDefaults(d.ctx).rules[p.index];
    record(d, 'rates_set_default', `Built-in rate ${cur ? describeRule(cur).replace(/: .*$/, '') : '#' + p.index}: ${p.minutes} min per unit`, () => setDefaultRate(d.ctx, p.index, p.minutes));
    return ratesView(d);
  },
  'rates.setPointsMin': (d, a): RatesView => {
    const p = z.object({ minutes: z.number().int().min(1).max(240) }).parse(a);
    record(d, 'rates_points_min', `Shortest points-based estimate: ${p.minutes} min`, () => setPointsMin(d.ctx, p.minutes));
    return ratesView(d);
  },
  'rates.resetDefaults': (d): RatesView => {
    record(d, 'rates_reset_defaults', 'Reset the built-in rates and the 5-minute minimum', () => resetDefaults(d.ctx));
    return ratesView(d);
  },

  'rates.multiplier': (d, a): RatesView => {
    const p = key.extend({ enabled: z.boolean() }).parse(a);
    const g = findGroup(d.ctx, p.key);
    record(d, 'rates_multiplier_switch', `Learned multiplier for “${g.name}”: ${p.enabled ? 'on' : 'off'}`, () => setMultiplierEnabled(d.ctx, p.key, p.enabled));
    return ratesView(d);
  },
  'rates.multiplierReset': (d, a): RatesView => {
    const { key: k } = key.parse(a);
    const g = findGroup(d.ctx, k);
    record(d, 'rates_multiplier_reset', `Reset the learned multiplier for “${g.name}” (earlier tasks are forgotten)`, () => resetMultiplier(d.ctx, k));
    return ratesView(d);
  },
};
void loadOverrides;
