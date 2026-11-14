import { describe, it, expect, beforeEach } from 'vitest';
import { makeCtx } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { createTerm } from '../src/core/terms';
import { addTask } from '../src/core/tasks';
import { setSetting, getSetting } from '../src/db/repo';
import { undoChange, listChanges } from '../src/core/changeLog';
import { setRate } from '../src/core/size';
import { stemOf, stemV1, buildGroups, baseGroupKey, regroup, regroupPreview, regroupPending, loadOverrides, mergeGroups, moveTask, renameGroup, splitTask } from '../src/core/rateGroups';
import { dispatch, type ApiDeps } from '../src/app/api';

let ctx: Ctx;
let app: ApiDeps;
const T = (title: string, course = 'SPAN 231') => addTask(ctx, { title, course, due: '2026-12-01 5pm' } as never);
const groupsOf = (...ids: number[]) => new Set(buildGroups(ctx).filter((g) => g.tasks.some((t) => ids.includes(t.id))).map((g) => g.key));

beforeEach(() => {
  ctx = makeCtx('2026-11-14T15:00:00Z');
  createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
  app = { ctx, dbFile: ':memory:', demo: true, backupFolder: '/x', calendar: () => { throw new Error('no calendar'); } };
});

describe('stems: recurring assignments group regardless of subtitle or date', () => {
  it('drops the subtitle after a colon or a spaced dash', () => {
    expect(stemOf('Video Discussion Post 4: Sample Subtitle').key).toBe('video discussion post');
    expect(stemOf('Video Discussion Post 5: Other Sample Subtitle').key).toBe('video discussion post');
    expect(stemOf('Lab 3 - Pointers').key).toBe('lab');
    expect(stemOf('Smith-Jones reading wk 4').key).toBe('smith-jones reading'); // an unspaced hyphen is part of a name
    expect(stemOf('Quiz at 10:30').key).toBe('quiz at'); // a clock time is not a subtitle
  });
  it('drops numbering, parentheticals, and folds accents and case', () => {
    for (const t of ['Journal Entry #6: Sample Subtitle', 'Journal Entry #5: Another Sample Subtitle', 'journal entry No. 3', 'JOURNAL ENTRY Part II', 'Journal Entry Week 9', 'Journal Entry 12 (due Sun Nov 22)'])
      expect(stemOf(t).key).toBe('journal entry');
    expect(stemOf('Online activities (due Sun Nov 15)').key).toBe('online activities');
    expect(stemOf('Online activities (due Sun Nov 22)').key).toBe('online activities');
    expect(stemOf('Reflexión  semanal').key).toBe('reflexion semanal');
    expect(stemOf('REFLEXIÓN semanal 2').key).toBe('reflexion semanal');
    expect(stemOf('Reflexión semanal').display).toBe('Reflexión semanal');
  });
  it('keeps distinctive words', () => {
    expect(stemOf('Final Project Phase Two Part III: Design Lab').key).toBe('final project phase two');
    expect(stemOf('Final Project Presentation').key).toBe('final project presentation');
    expect(stemOf('Final Project Phase Two Part III: Design Lab').key).not.toBe(stemOf('Final Project Presentation').key);
    expect(stemOf('Lecture 22').key).toBe('lecture');
    expect(stemOf(': oops').key).not.toBe('');
  });
  it('first-release stems are still available for finding old keys', () => {
    expect(stemV1('Video Discussion Post 4: Sample Subtitle').key).not.toBe('video discussion post');
  });

  it('Spanish video posts end up in a single group', () => {
    const a = T('Video Discussion Post 4: Sample Subtitle').id, b = T('Video Discussion Post 5: Other Sample Subtitle').id;
    expect(groupsOf(a, b).size).toBe(1);
  });
  it('Spanish journal entries end up in a single group', () => {
    const a = T('Journal Entry #6: Sample Subtitle').id, b = T('Journal Entry #5: Another Sample Subtitle').id;
    expect(groupsOf(a, b).size).toBe(1);
  });
  it('Online activities with different due dates end up in a single group', () => {
    const a = T('Online activities (due Sun Nov 15)').id, b = T('Online activities (due Sun Nov 22)').id;
    expect(groupsOf(a, b).size).toBe(1);
  });
  it('EECS zyBooks lectures end up in a single group', () => {
    const ids = ['Lecture 22 zyBooks', 'Lecture 23 and 24 zyBooks', 'Lecture 25 zyBooks'].map((t) => T(t, 'EECS 183').id);
    expect(groupsOf(...ids).size).toBe(1);
  });
  it('different projects stay apart unless the user merges them', () => {
    const a = T('Final Project Phase Two Part III: Design Lab').id, b = T('Final Project Presentation').id;
    expect(groupsOf(a, b).size).toBe(2);
    mergeGroups(ctx, baseGroupKey(ctx.db.get('SELECT * FROM tasks WHERE id=?', [a]) as never), baseGroupKey(ctx.db.get('SELECT * FROM tasks WHERE id=?', [b]) as never));
    expect(groupsOf(a, b).size).toBe(1);
  });
});

describe('Regroup', () => {
  // Simulate a database whose overrides were saved under the first release's keys.
  const oldKey = (title: string, course = 'SPAN 231') => `${course.toLowerCase()}|${stemV1(title).key}`;

  it('carries renames, merges and moves over to the new groups, and reports what changed', () => {
    const a = T('Video Discussion Post 4: Sample Subtitle'), b = T('Video Discussion Post 5: Other Sample Subtitle');
    const j = T('Journal Entry #6: Sample Subtitle');
    const x = T('Oral exam practice');
    // old groups: each video post was its own group (the subtitle made the stems differ)
    expect(oldKey(a.title)).not.toBe(oldKey(b.title));
    setSetting(ctx.db, 'rate_groups', JSON.stringify({
      names: { [oldKey(a.title)]: 'Video posts (mine)' },
      merges: { [oldKey(j.title)]: oldKey(x.title) },
      moves: {},
    }));
    // before regroup, overrides already win in the live view
    const pending = regroupPending(ctx);
    expect(pending).toBeGreaterThan(0);
    const pv = regroupPreview(ctx);
    expect(pv.changedTasks.map((t) => t.id).sort()).toEqual([a.id, b.id, j.id].sort());
    expect(pv.groupsAfter).toBeLessThan(pv.groupsBefore + 1);
    // preview wrote nothing
    expect(getSetting(ctx.db, 'rate_group_snapshot') ?? null).toBeNull();

    const rep = regroup(ctx);
    expect(rep.changedTasks.length).toBe(3);
    expect(rep.overridesCarried).toBeGreaterThanOrEqual(2);
    const ov = loadOverrides(ctx);
    expect(ov.names[baseGroupKey(a)]).toBe('Video posts (mine)');
    expect(ov.merges[baseGroupKey(j)]).toBe(baseGroupKey(x));
    const g = buildGroups(ctx).find((q) => q.tasks.some((t) => t.id === a.id))!;
    expect(g.name).toBe('Video posts (mine)');
    expect(g.tasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(groupsOf(j.id, x.id).size).toBe(1); // the merge still holds
    // done: a second regroup changes nothing
    expect(regroupPending(ctx)).toBe(0);
    expect(regroup(ctx).unchanged).toBe(true);
  });

  it('keeps splits and moves on top of the automatic groups', () => {
    const a = T('Journal Entry #6: Sample Subtitle'), b = T('Journal Entry #5: Another Sample Subtitle'), c = T('Oral exam practice');
    splitTask(ctx, a.id);
    moveTask(ctx, b.id, baseGroupKey(c));
    regroup(ctx);
    expect(groupsOf(a.id).size).toBe(1);
    expect([...groupsOf(a.id)][0]).toMatch(/~/);
    expect([...groupsOf(b.id)][0]).toBe(baseGroupKey(c));
    renameGroup(ctx, baseGroupKey(c), 'Oral practice');
    regroup(ctx);
    expect(buildGroups(ctx).find((g) => g.tasks.some((t) => t.id === c.id))!.name).toBe('Oral practice');
  });

  it('never changes a saved rate\'s match text', () => {
    T('Video Discussion Post 4: Sample Subtitle');
    setRate(ctx, { unit: 'video_minutes', minutes_per_unit: 1.5, course: 'SPAN 231', title_match: 'Video Discussion Post 4' });
    const before = getSetting(ctx.db, 'size_rates');
    regroup(ctx);
    expect(getSetting(ctx.db, 'size_rates')).toBe(before);
  });

  it('is one entry in the change log, and undo puts the old state back', () => {
    const a = T('Video Discussion Post 4: Sample Subtitle');
    T('Video Discussion Post 5: Other Sample Subtitle');
    setSetting(ctx.db, 'rate_groups', JSON.stringify({ names: { [oldKey(a.title)]: 'Mine' }, merges: {}, moves: {} }));
    const raw = getSetting(ctx.db, 'rate_groups');
    return dispatch(app, 'rates.regroup', undefined).then((r) => {
      expect(r.ok).toBe(true);
      const rows = listChanges(ctx).filter((c) => c.tool === 'rates_regroup');
      expect(rows.length).toBe(1);
      expect(getSetting(ctx.db, 'rate_groups')).not.toBe(raw);
      undoChange(ctx, rows[0].id);
      expect(getSetting(ctx.db, 'rate_groups')).toBe(raw);
      expect(getSetting(ctx.db, 'rate_group_snapshot') ?? null).toBeNull();
    });
  });

  it('is reachable from the app API and reports the pending count in the view', async () => {
    T('Video Discussion Post 4: Sample Subtitle');
    const v = await dispatch(app, 'rates.get', undefined);
    expect(v.ok && (v.value as { regroupPending: number }).regroupPending).toBeGreaterThan(0);
    const r = await dispatch(app, 'rates.regroupPreview', undefined);
    expect(r.ok).toBe(true);
    const g = await dispatch(app, 'rates.regroup', undefined);
    expect(g.ok && (g.value as { regroupPending: number }).regroupPending).toBe(0);
  });

  it('needs no schema change', () => {
    expect(ctx.db.get<{ user_version: number }>('PRAGMA user_version')!.user_version).toBe(8);
  });
});
