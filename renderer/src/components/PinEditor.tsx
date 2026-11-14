import { useState } from 'react';
import { DateTime } from 'luxon';
import { api } from '../api';
import { errText } from '../ctx';
import { ReconnectButton } from '../ui';
import type { PinResult } from '../../../src/app/types';

export type Refusal = Extract<PinResult, { ok: false }>;

/** Pin (or move a pin) and report the outcome. A refusal is data: its message and the suggested free times. */
export async function placePin(target: { taskId: number; pinId?: number }, startIso: string, endIso: string): Promise<PinResult> {
  return target.pinId ? api.pinMove(target.pinId, startIso, endIso) : api.pinCreate(target.taskId, startIso, endIso);
}

/** Why a drop was refused, and buttons for the places it can go instead. */
export function RefusalNote({ r, onPick, onClose }: { r: Refusal; onPick: (s: { start: string; end: string }) => void; onClose?: () => void }) {
  return (
    <div className="note warnbox pin-refusal" role="alert" data-testid="pin-refusal">
      <strong>Can’t pin it there.</strong> {r.message}
      {r.suggestions.length > 0 ? (
        <div className="suggestions">
          <span className="muted">It fits at:</span>
          {r.suggestions.map((s) => <button key={s.start} onClick={() => onPick(s)} data-testid="pin-suggestion">📌 {s.label}</button>)}
        </div>
      ) : <div className="muted">No free time of that length nearby before it is due.</div>}
      {onClose && <button className="link" onClick={onClose}>Dismiss</button>}
    </div>
  );
}

/**
 * Pin a block at a chosen time by typing it (the keyboard way to do what dragging on the Availability grid does). Used on the
 * Schedule screen and from the grid's block menu.
 */
export function PinEditor({ tz, taskId, pinId, start, end, onDone, onCancel }: { tz: string; taskId: number; pinId?: number; start: string; end: string; onDone: (msg: string) => void; onCancel: () => void }) {
  const s0 = DateTime.fromISO(start, { zone: tz });
  const e0 = DateTime.fromISO(end, { zone: tz });
  const [date, setDate] = useState(s0.toISODate()!);
  const [from, setFrom] = useState(s0.toFormat('HH:mm'));
  const [to, setTo] = useState(e0.toFormat('HH:mm'));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [err, setErr] = useState<{ text: string; code?: string } | null>(null);
  async function save(st?: string, en?: string) {
    const a = st ?? DateTime.fromISO(`${date}T${from}`, { zone: tz }).toUTC().toISO()!;
    let b = en ?? DateTime.fromISO(`${date}T${to}`, { zone: tz }).toUTC().toISO()!;
    if (!en && Date.parse(b) <= Date.parse(a)) b = DateTime.fromISO(`${date}T${to}`, { zone: tz }).plus({ days: 1 }).toUTC().toISO()!; // ends after midnight
    setBusy(true); setRefusal(null); setErr(null);
    try {
      const r = await placePin({ taskId, pinId }, a, b);
      if (r.ok) onDone(`Pinned at ${DateTime.fromISO(r.pin.start, { zone: tz }).toFormat('ccc LLL d, h:mm a')}–${DateTime.fromISO(r.pin.end, { zone: tz }).toFormat('h:mm a')}. Every Schedule and Replan keeps it there.`);
      else setRefusal(r);
    } catch (e) { setErr({ text: errText(e), code: (e as { code?: string }).code }); } finally { setBusy(false); }
  }
  return (
    <div className="pin-editor" role="group" aria-label="Pin this block" data-testid="pin-editor">
      <label>Day <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label>From <input type="time" step={300} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Start time" /></label>
      <label>To <input type="time" step={300} value={to} onChange={(e) => setTo(e.target.value)} aria-label="End time" /></label>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Checking…' : pinId ? 'Move pin' : '📌 Pin here'}</button>
      <button onClick={onCancel} disabled={busy}>Cancel</button>
      {err && <div className="note error" role="alert">{err.text} {err.code === 'google_reconnect' && <ReconnectButton />}</div>}
      {refusal && <RefusalNote r={refusal} onPick={(sg) => void save(sg.start, sg.end)} />}
    </div>
  );
}
