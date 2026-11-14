import { describe, it, expect } from 'vitest';
import { makeCtx } from './helpers';
import { addTask, completeTask, deleteTask, undoDelete } from '../src/core/tasks';
import { addDependency, removeDependency, openBlockers, allBlockers, dependents, openBlockerMap, wouldCycle } from '../src/core/dependencies';

const mk = (n = 4) => {
  const ctx = makeCtx();
  const ids = Array.from({ length: n }, (_, i) => addTask(ctx, { title: `T${i + 1}`, due: 'tomorrow 5pm', est: 30 }).id);
  return { ctx, ids };
};

describe('dependencies', () => {
  it('adds "A is blocked by B", lists both directions, and ignores duplicates', () => {
    const { ctx, ids: [a, b] } = mk();
    addDependency(ctx, a, b);
    addDependency(ctx, a, b);
    expect(openBlockers(ctx, a).map((t) => t.id)).toEqual([b]);
    expect(dependents(ctx, b).map((t) => t.id)).toEqual([a]);
    expect(ctx.db.get<any>('SELECT COUNT(*) c FROM dependencies').c).toBe(1);
  });
  it('removes a dependency', () => {
    const { ctx, ids: [a, b] } = mk();
    addDependency(ctx, a, b);
    expect(removeDependency(ctx, a, b)).toBe(true);
    expect(removeDependency(ctx, a, b)).toBe(false);
    expect(openBlockers(ctx, a)).toEqual([]);
  });
  it('refuses self-blocking and unknown tasks', () => {
    const { ctx, ids: [a] } = mk();
    expect(() => addDependency(ctx, a, a)).toThrow(/itself/);
    expect(() => addDependency(ctx, a, 999)).toThrow(/No task #999/);
    expect(() => addDependency(ctx, 999, a)).toThrow(/No task #999/);
  });
  it('detects direct and indirect cycles and says which tasks', () => {
    const { ctx, ids: [a, b, c, d] } = mk();
    addDependency(ctx, b, a); // b waits on a
    expect(() => addDependency(ctx, a, b)).toThrow(/cycle.*#2 "T2".*#1 "T1"/);
    addDependency(ctx, c, b);
    addDependency(ctx, d, c); // a <- b <- c <- d
    expect(() => addDependency(ctx, a, d)).toThrow(/cycle/); // a waiting on d closes the loop
    expect(wouldCycle(ctx.db, a, d)).toBe(true);
    expect(wouldCycle(ctx.db, d, a)).toBe(false); // a diamond / shortcut is fine
    addDependency(ctx, d, a);
    expect(ctx.db.get<any>('SELECT COUNT(*) c FROM dependencies').c).toBe(4);
  });
  it('completing a blocker releases its dependents automatically; undoing it blocks them again', () => {
    const { ctx, ids: [a, b] } = mk();
    addDependency(ctx, a, b);
    completeTask(ctx, b);
    expect(openBlockers(ctx, a)).toEqual([]);
    expect(allBlockers(ctx, a)[0]).toMatchObject({ id: b, open: false });
  });
  it('a deleted blocker no longer blocks; restoring it does', () => {
    const { ctx, ids: [a, b] } = mk();
    addDependency(ctx, a, b);
    deleteTask(ctx, b);
    expect(openBlockers(ctx, a)).toEqual([]);
    undoDelete(ctx, b);
    expect(openBlockers(ctx, a).map((t) => t.id)).toEqual([b]);
  });
  it('a task waiting on several blockers stays blocked until the last one is done', () => {
    const { ctx, ids: [a, b, c] } = mk();
    addDependency(ctx, a, b);
    addDependency(ctx, a, c);
    completeTask(ctx, b);
    expect(openBlockerMap(ctx).get(a)!.map((t) => t.id)).toEqual([c]);
    completeTask(ctx, c);
    expect(openBlockerMap(ctx).has(a)).toBe(false);
  });
});
