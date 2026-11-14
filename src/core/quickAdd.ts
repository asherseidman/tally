import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { Clock } from '../clock';
import { parseNaturalDue } from './naturalDate';
import { assertTimezone } from '../time';

export interface QuickParse {
  /** the title with the date phrase (and a leading "due"/"by"/"on"/"at") removed */
  title: string;
  /** UTC ISO due, or null when no date was found */
  dueUtc: string | null;
  timeAssumed: boolean;
  /** the phrase that was understood as the date, for display; null when none */
  phrase: string | null;
}

// "2 hours of work" is a duration, not a due date, and chrono would read it as "2 hours from now".
const DURATION = /\b(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i;
const KEYWORD = /(?:^|\s)(?:due\s+(?:on\s+|by\s+)?|by\s+|before\s+|on\s+|at\s+)$/i;

/**
 * Pull a due date out of free text ("written homework due friday 5pm" -> title "written homework", due Fri 5 PM).
 * The date must be at the END of the text, optionally introduced by "due", "by", "before" or "on". The phrase itself is
 * interpreted by `parseNaturalDue`, the same parser the CLI and the task drawer use, so there is one set of rules.
 * If nothing parses, or stripping would leave an empty title, the text is returned unchanged with no date.
 */
export function parseQuickAdd(text: string, tz: string, clock: Clock, defaultTime: string): QuickParse {
  const original = text.trim();
  const none: QuickParse = { title: original, dueUtc: null, timeAssumed: false, phrase: null };
  if (!original) return none;
  assertTimezone(tz);

  const wall = DateTime.fromJSDate(clock.now(), { zone: tz });
  const ref = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute));
  const hits = chrono.parse(original, { instant: ref, timezone: 0 }, { forwardDate: true });

  // the last match that runs to the end of the text (ignoring trailing punctuation)
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (original.slice(h.index + h.text.length).replace(/[\s.,;!?]+/g, '') !== '') continue;
    if (DURATION.test(h.text)) continue;
    let start = h.index;
    const kw = KEYWORD.exec(original.slice(0, start));
    if (kw) start = kw.index;
    const title = original.slice(0, start).replace(/[\s,;:\-–]+$/, '').trim();
    if (!title) return none;
    try {
      const r = parseNaturalDue(h.text, tz, clock, defaultTime);
      return { title, dueUtc: r.dueUtc, timeAssumed: r.timeAssumed, phrase: h.text };
    } catch {
      return none;
    }
  }
  return none;
}
