import { describe, it, expect } from 'vitest';
import { makeCtx } from './helpers';
import { createTerm, useTerm, archiveTerm, unarchiveTerm, listTerms, currentTerm } from '../src/core/terms';
import { addTask, listTasks } from '../src/core/tasks';
import { createList } from '../src/core/lists';

const T = (n: string, s = '2026-08-31', e = '2026-12-11') => ({ name: n, start_date: s, end_date: e });

describe('terms', () => {
  it('first term becomes current; later ones do not unless asked', () => {
    const ctx = makeCtx();
    createTerm(ctx, T('A'));
    createTerm(ctx, T('B', '2027-01-11', '2027-04-26'));
    expect(currentTerm(ctx)?.name).toBe('A');
    createTerm(ctx, T('C', '2027-05-01', '2027-08-01'), { makeCurrent: true });
    expect(currentTerm(ctx)?.name).toBe('C');
    expect(listTerms(ctx).filter((t) => t.is_current)).toHaveLength(1);
  });
  it('rejects duplicate names and bad dates', () => {
    const ctx = makeCtx();
    createTerm(ctx, T('A'));
    expect(() => createTerm(ctx, T('a'))).toThrow(/exists/);
    expect(() => createTerm(ctx, T('X', '2026-12-01', '2026-01-01'))).toThrow();
  });
  it('switching the current term changes default views', () => {
    const ctx = makeCtx();
    createTerm(ctx, T('A'));
    createTerm(ctx, T('B', '2027-01-11', '2027-04-26'));
    addTask(ctx, { title: 'a1', course: 'X' });
    useTerm(ctx, 'B');
    addTask(ctx, { title: 'b1', course: 'X' });
    addTask(ctx, { title: 'personal' });
    expect(listTasks(ctx, {}).map((t) => t.title).sort()).toEqual(['b1', 'personal']);
    expect(listTasks(ctx, { scope: { term: 'A' } }).map((t) => t.title).sort()).toEqual(['a1', 'personal']);
    expect(listTasks(ctx, { scope: { allTerms: true } })).toHaveLength(3);
  });
  it('archiving hides tasks from default views/search but keeps data; unarchive restores', () => {
    const ctx = makeCtx();
    createTerm(ctx, T('A'));
    createTerm(ctx, T('B', '2027-01-11', '2027-04-26'));
    addTask(ctx, { title: 'old homework', course: 'X' });
    useTerm(ctx, 'B');
    archiveTerm(ctx, 'A');
    expect(listTasks(ctx, { text: 'old' })).toHaveLength(0);
    expect(listTasks(ctx, { scope: { allTerms: true }, text: 'old' })).toHaveLength(1);
    expect(ctx.db.get<any>("SELECT COUNT(*) c FROM tasks WHERE title = 'old homework'").c).toBe(1);
    expect(listTerms(ctx).find((t) => t.name === 'A')?.archived_at).not.toBeNull();
    unarchiveTerm(ctx, 'A');
    useTerm(ctx, 'A');
    expect(listTasks(ctx, { text: 'old' })).toHaveLength(1);
  });
  it('archiving the current term clears current; archived term cannot be made current', () => {
    const ctx = makeCtx();
    createTerm(ctx, T('A'));
    archiveTerm(ctx, 'A');
    expect(currentTerm(ctx)).toBeUndefined();
    expect(() => useTerm(ctx, 'A')).toThrow(/archived/);
  });
  it('with no current term, only term-less tasks show by default and course tasks need a term', () => {
    const ctx = makeCtx();
    addTask(ctx, { title: 'personal' });
    expect(() => addTask(ctx, { title: 'x', course: 'MATH' })).toThrow(/term/i);
    expect(listTasks(ctx, {})).toHaveLength(1);
  });
  it('unknown term name errors helpfully', () => {
    const ctx = makeCtx();
    createTerm(ctx, T('A'));
    expect(() => useTerm(ctx, 'Nope')).toThrow(/Nope/);
    expect(() => listTasks(ctx, { scope: { term: 'Nope' } })).toThrow(/Nope/);
  });
  it('a list tied to a term puts new tasks in that term', () => {
    const ctx = makeCtx();
    createTerm(ctx, T('A'));
    createTerm(ctx, T('B', '2027-01-11', '2027-04-26'));
    createList(ctx, 'Clubs-B', { term: 'B' });
    const t = addTask(ctx, { title: 'club thing', list: 'Clubs-B' });
    expect(ctx.db.get<any>('SELECT name FROM terms WHERE id = ?', [t.term_id]).name).toBe('B');
  });
});
