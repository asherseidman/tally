import { useState } from 'react';
import { api } from './api';
import { errText, useApp } from './ctx';
/** Small shared visual pieces: the Tally mark, icons (decorative, hidden from screen readers), and the course-chip color. */

/** Four upright strokes crossed by a fifth: the tally mark. Maize on the blue top bar. */
export function TallyMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="24" height="24" rx="6" fill="var(--bar-accent, #FFCB05)" />
      <g stroke="#00274C" strokeWidth="2.2" strokeLinecap="round">
        <path d="M6 5.5v13M10 5.5v13M14 5.5v13M18 5.5v13" />
        <path d="M3.8 15.5 20.2 8.5" />
      </g>
    </svg>
  );
}

const icon = (d: string, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={d} /></svg>
);
export const Icon = {
  clock: (s?: number) => icon('M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 4.5V8l2.5 1.5', s),
  hourglass: (s?: number) => icon('M4.5 1.5h7M4.5 14.5h7M5 1.5c0 3.5 6 3.5 6 6.5s-6 3-6 6.5M11 1.5c0 3.5-6 3.5-6 6.5s6 3 6 6.5', s),
  /** a pie slice: a share of the grade */
  weight: (s?: number) => icon('M8 1.5v6.5h6.5A6.5 6.5 0 1 1 8 1.5ZM10 1.8A6.5 6.5 0 0 1 14.2 6H10V1.8Z', s),
  play: (s?: number) => <svg width={s ?? 12} height={s ?? 12} viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 1.8v8.4L10 6 3 1.8Z" fill="currentColor" /></svg>,
  stop: (s?: number) => <svg width={s ?? 12} height={s ?? 12} viewBox="0 0 12 12" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="currentColor" /></svg>,
  soon: (s?: number) => icon('M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13ZM8 4.5V8h3', s),
  star: (s?: number) => icon('m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.8Z', s),
  bolt: (s?: number) => icon('M9 1.5 3.5 9H8l-1 5.5L12.5 7H8l1-5.5Z', s),
  lock: (s?: number) => icon('M4 7.5h8v6.5H4V7.5ZM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5', s),
  check: (s?: number) => icon('m3.5 8.5 3 3 6-7', s),
};

/** The same course always gets the same of 8 chip colors (each pair passes WCAG AA in both themes). The course name is always shown too. */
export function courseClass(course: string | null | undefined): string {
  if (!course) return '';
  let h = 0;
  for (const ch of course.trim().toUpperCase().replace(/\s+\d.*$/, '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; // by subject, so CHEM 130 and CHEM 210 match
  return `c${h % 8}`;
}

/** Drop the year from a display date when it is the current year ("Sat Nov 14 2026 5:00 PM" -> "Sat Nov 14 5:00 PM"). Display only. */
export const shortDate = (text: string, now = new Date()) => text.replace(new RegExp(`\\s${now.getFullYear()}\\b`), '');

/** One-click Reconnect: opens the Google sign-in in the browser, waits for it, and tells the caller when it worked. */
export function ReconnectButton({ label = 'Reconnect', onDone, testId = 'reconnect' }: { label?: string; onDone?: () => void; testId?: string }) {
  const { toast, changed } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true); setErr(null);
    try {
      const s = await api.googleConnect();
      if (s.connected) { toast('Reconnected to Google.'); changed(); onDone?.(); } else setErr(s.message);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <span className="reconnect">
      <button className="primary" data-testid={testId} disabled={busy} onClick={go}>{busy ? 'Waiting for Google sign-in in your browser…' : label}</button>
      {err && <span className="note error" role="alert">{err}</span>}
    </span>
  );
}
