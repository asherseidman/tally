/**
 * The seam between Tally and Apple Reminders. Everything the app needs from Reminders is these two calls, on ONE named list:
 * read its open reminders, and mark one completed. The real implementation (jxaReminders.ts) talks to the Reminders app through
 * Apple events; tests use FakeReminders and never touch the real app.
 */
export interface ReminderItem {
  /** Reminders' own stable id for the reminder (never reused) */
  id: string;
  title: string;
  notes: string | null;
  /** the reminder's own due date, when it has one (UTC ISO, a real time of day) */
  dueUtc: string | null;
  /** or an all-day due date (YYYY-MM-DD on the Mac's calendar) */
  dueDay: string | null;
  /** when it was created, UTC ISO (oldest first is the order imported) */
  createdUtc: string | null;
}

export type FetchResult =
  | { status: 'ok'; items: ReminderItem[]; /** open reminders in the list before any cap */ total: number }
  | { status: 'denied'; message: string }
  | { status: 'missing_list'; message: string }
  | { status: 'error'; message: string };

export type CompleteResult =
  | { status: 'ok' }
  /** the reminder is no longer in the list (deleted or completed on the phone): nothing left to do */
  | { status: 'gone' }
  | { status: 'denied' | 'error'; message: string };

export interface RemindersSource {
  /** open (not completed) reminders of the list with exactly this name; never any other list */
  fetch(list: string, limit: number): Promise<FetchResult>;
  /** mark ONE reminder of that list completed (never deletes it) */
  complete(list: string, id: string): Promise<CompleteResult>;
}

export const DENIED_MESSAGE =
  'macOS has not allowed Tally to control Reminders. Open System Settings > Privacy & Security > Automation, switch on Reminders under Tally, then press Retry.';
