import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { CompleteResult, FetchResult, ReminderItem, RemindersSource } from './reminders';
import { DENIED_MESSAGE } from './reminders';

/**
 * A pretend Reminders app for tests and the demo self-test: lists of open reminders held in memory (or in a JSON file, so a
 * relaunched app sees the same state). It can be told to deny permission, lose the list, or fail to complete. It never touches
 * the real Reminders app.
 */
export class FakeReminders implements RemindersSource {
  lists = new Map<string, ReminderItem[]>();
  completed: string[] = [];
  deny = false;
  failComplete = false;
  fetchCalls = 0;
  completeCalls: string[] = [];
  constructor(private file?: string) { this.load(); }

  add(list: string, ...items: Partial<ReminderItem>[]): void {
    this.load();
    const cur = this.lists.get(list) ?? [];
    for (const i of items) cur.push({ id: i.id ?? `fake-${cur.length + this.completed.length + 1}-${Math.random().toString(36).slice(2, 8)}`, title: i.title ?? '', notes: i.notes ?? null, dueUtc: i.dueUtc ?? null, dueDay: i.dueDay ?? null, createdUtc: i.createdUtc ?? null });
    this.lists.set(list, cur);
    this.save();
  }
  private load() {
    if (!this.file || !existsSync(this.file)) return;
    const j = JSON.parse(readFileSync(this.file, 'utf8')) as { lists: Record<string, ReminderItem[]>; completed: string[] };
    this.lists = new Map(Object.entries(j.lists));
    this.completed = j.completed;
  }
  private save() {
    if (this.file) writeFileSync(this.file, JSON.stringify({ lists: Object.fromEntries(this.lists), completed: this.completed }));
  }

  async fetch(list: string, limit: number): Promise<FetchResult> {
    this.fetchCalls++;
    this.load();
    if (this.deny) return { status: 'denied', message: DENIED_MESSAGE };
    const items = this.lists.get(list);
    if (!items) return { status: 'missing_list', message: `There is no Reminders list named “${list}”.` };
    const open = items.filter((i) => !this.completed.includes(i.id));
    return { status: 'ok', items: open.slice(0, limit), total: open.length };
  }
  async complete(list: string, id: string): Promise<CompleteResult> {
    this.completeCalls.push(`${list}:${id}`);
    this.load();
    if (this.deny) return { status: 'denied', message: DENIED_MESSAGE };
    if (this.failComplete) return { status: 'error', message: 'pretend failure' };
    const items = this.lists.get(list);
    if (!items?.some((i) => i.id === id)) return { status: 'gone' };
    if (!this.completed.includes(id)) this.completed.push(id);
    this.save();
    return { status: 'ok' };
  }
}
