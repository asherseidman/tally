import type { Ctx } from './ctx';
import { getSetting, setSetting } from '../db/repo';

/**
 * Manual ordering (drag-to-reorder) is a UI preference, kept as a list of ids in settings rather than a schema column:
 * `order.lists` and `order.tasks.<listId|none>`. Ids that no longer exist are ignored; new ones go after the ordered ones.
 */
export const LIST_ORDER_KEY = 'order.lists';
export const taskOrderKey = (listId: number | null) => `order.tasks.${listId ?? 'none'}`;

export function getOrder(ctx: Ctx, key: string): number[] {
  const raw = getSetting(ctx.db, key);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

export function saveOrder(ctx: Ctx, key: string, ids: number[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('An order cannot list the same item twice.');
  setSetting(ctx.db, key, JSON.stringify(ids));
}

export function applyOrder<T extends { id: number }>(items: T[], order: number[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const first = order.map((id) => byId.get(id)).filter((x): x is T => !!x);
  const seen = new Set(first.map((x) => x.id));
  return [...first, ...items.filter((i) => !seen.has(i.id))];
}
