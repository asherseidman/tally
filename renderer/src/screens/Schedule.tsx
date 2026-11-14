import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errCode, errText, useApp } from '../ctx';
import { ReconnectButton } from '../ui';
import { PinEditor } from '../components/PinEditor';
import type { PendingState, ProposedBlock, ScheduleApplied, SchedulePreview } from '../../../src/app/types';

const clock = (m: number) => {
  const h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${((h + 11) % 12) + 1}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};
const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
const mins = (b: ProposedBlock) => b.spans.reduce((s, x) => s + (x.end - x.start), 0);
const hm = (m: number) => `${m >= 60 ? `${Math.floor(m / 60)}h` : ''}${m % 60 ? `${m >= 60 ? ' ' : ''}${m % 60}m` : ''}` || '0m';

/**
 * Schedule: preview the plan, then (after a confirm step) write it. The preview never writes. Apply sends the plan's
 * fingerprint, so if anything changed since the preview the main process refuses and nothing is written.
 */
export function Schedule() {
  const { version, changed, toast, openTask, info } = useApp();
  const [days, setDays] = useState(14);
  const [replan, setReplan] = useState(false);
  const [p, setP] = useState<SchedulePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [result, setResult] = useState<ScheduleApplied | null>(null);
  const [showTentative, setShowTentative] = useState(true);
  const seq = useRef(0);
  const pending = usePending(version);
  const [pinEdit, setPinEdit] = useState<string | null>(null);
  async function unpin(pinId: number, title: string, automatic: boolean) {
    try { await api.pinUnpin(pinId); toast(automatic ? `“${title}” is back to automatic: the preview now shows where the planner puts it.` : `Unpinned “${title}”. It stays on your calendar until the next Apply, which may move it.`); changed(); load(); }
    catch (e) { setError(errText(e)); }
  }

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true); setError(null); setErrorCode(undefined);
    api.schedulePreview(days, replan)
      .then((r) => { if (mine === seq.current) setP(r); })
      .catch((e) => { if (mine === seq.current) { setP(null); setError(errText(e)); setErrorCode(errCode(e)); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [days, replan]);
  useEffect(load, [load, version]);

  async function apply() {
    if (!p) return;
    setApplying(true); setApplyError(null);
    try {
      const r = await api.scheduleApply(p.days, p.replan, p.fingerprint);
      setResult(r); setConfirming(false);
      toast(r.message);
      changed();
    } catch (e) {
      setApplyError(errText(e));
      if (errCode(e) === 'google_reconnect') setErrorCode('google_reconnect');
      load(); // show the new plan
    } finally { setApplying(false); }
  }

  const real = p?.blocks.filter((b) => !b.tentative) ?? [];
  const tent = p?.blocks.filter((b) => b.tentative) ?? [];
  const shown = [...real, ...(showTentative ? tent : [])];
  const byDay = new Map<string, ProposedBlock[]>();
  for (const b of shown) {
    const day = b.spans[0]?.date ?? b.start.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), b]);
  }
  const dayKeys = [...byDay.keys()].sort();
  const total = real.reduce((s, b) => s + mins(b), 0);
  const where = p ? (p.simulated ? 'SIMULATED calendar (demo): Google is not contacted.' : `Google Calendar. Writes go ONLY to the “${p.calendarName}” calendar; your other calendars are never changed.`) : '';

  return (
    <div className="schedule">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Schedule</h2>
        <div role="group" aria-label="Mode" className="seg">
          <button aria-pressed={!replan} className={!replan ? 'primary' : ''} onClick={() => setReplan(false)}>Schedule</button>
          <button aria-pressed={replan} className={replan ? 'primary' : ''} onClick={() => setReplan(true)} title="Also re-place blocks you missed (past, task still open)">Replan</button>
        </div>
        <label>Next <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days to schedule">{[7, 14, 21, 28].map((n) => <option key={n} value={n}>{n} days</option>)}</select></label>
        <button onClick={load} disabled={loading}>Refresh preview</button>
        <span className="spacer" />
        <label className="toggle"><input type="checkbox" checked={showTentative} onChange={(e) => setShowTentative(e.target.checked)} /> Show tentative</label>
        <button className="primary" disabled={!p || loading || (p.willWrite === 0 && p.willRemove === 0)} onClick={() => { setApplyError(null); setConfirming(true); }}>
          {replan ? 'Replan…' : 'Apply…'}
        </button>
      </div>
      <PendingApplyCard state={pending.state} reload={pending.load} />
      <p className="hint">{replan ? 'Replan: same as Schedule, and blocks you missed are re-placed. ' : ''}This is a PREVIEW. Nothing is written until you confirm. {where}</p>

      {loading && <p className="note" role="status">Planning… {info.demo ? '' : 'Reading your Google calendars can take several seconds.'}</p>}
      {error && (
        <div className="note error" role="alert" data-testid="schedule-error">
          <pre className="msg">{error}</pre>
          {errorCode === 'google_reconnect' && <ReconnectButton onDone={load} testId="schedule-reconnect" />}
        </div>
      )}

      {result && (
        <div className="note ok" role="status" data-testid="apply-result">
          <strong>{result.message}</strong>
          {result.trimmed.count > 0 && <Lines heading={result.trimmed.heading} lines={result.trimmed.lines} />}
          {result.moved.count > 0 && <Lines heading={result.moved.heading} lines={result.moved.lines} />}
          <button className="link" onClick={() => setResult(null)}>Dismiss</button>
        </div>
      )}

      {p && !loading && (
        <>
          <p className="summary" data-testid="schedule-summary">
            <strong>{p.willWrite}</strong> block{p.willWrite === 1 ? '' : 's'} to write ({hm(total)} of work) · <strong>{p.willRemove}</strong> earlier block{p.willRemove === 1 ? '' : 's'} will be replaced
            {p.missedCount > 0 && <> · <strong>{p.missedCount}</strong> missed{replan ? ' (re-placed)' : ' (use Replan to re-place)'}</>}
            {tent.length > 0 && <> · {tent.length} tentative (never written)</>}
          </p>

          {p.trims.count > 0 && <Attn cls="warn" g={p.trims} />}
          {p.moved.count > 0 && <Attn cls="" g={p.moved} />}
          {p.logged.count > 0 && <Attn cls="" g={p.logged} />}

          {p.problems.length > 0 && (
            <section className="note warnbox" aria-label="Does not fit">
              <h3>DOES NOT FIT (not dropped; free up time or move the due date)</h3>
              <ul>{p.problems.map((x) => (
                <li key={`${x.taskId}${x.tentative}`}>{x.tentative && <span className="chip tent">tentative</span>} <button className="link-title" onClick={() => openTask(x.taskId)}>{x.title}</button>: {x.reason}{x.shortMinutes > 0 ? ` (short by ${hm(x.shortMinutes)})` : ''}</li>
              ))}</ul>
            </section>
          )}

          {(p.pinWarnings ?? []).length > 0 && (
            <section className="note warnbox" aria-label="Pinned blocks that need you" data-testid="pin-warnings">
              <h3>PINNED BLOCKS THAT NEED YOU</h3>
              <ul>{p.pinWarnings!.map((w) => (
                <li key={`${w.pinId}${w.reason}`}>📌 {w.message} {w.reason !== 'busy' && <><button onClick={() => void unpin(w.pinId, w.title, false)}>Unpin</button> <button onClick={() => void unpin(w.pinId, w.title, true)}>Move back to automatic</button></>}</li>
              ))}</ul>
            </section>
          )}

          {dayKeys.length === 0 && <p className="muted">Nothing to schedule in this window.</p>}
          {dayKeys.map((day) => (
            <section key={day} className="sday" aria-label={dayLabel(day)}>
              <h3><span>{dayLabel(day)}</span><span className="muted">{hm(byDay.get(day)!.filter((b) => !b.tentative).reduce((n, b) => n + mins(b), 0))} planned</span></h3>
              <ul className="rows">
                {byDay.get(day)!.sort((a, b) => a.start.localeCompare(b.start)).map((b, i) => (
                  <li key={`${b.taskId}${b.start}${i}`} className={`row sblock ${b.tentative ? 'tent' : ''} ${b.pinned ? 'pinned' : ''}`} data-tentative={b.tentative ? '1' : '0'} data-pinned={b.pinned ? '1' : '0'}>
                    <span className="when">{clock(b.spans[0].start)}–{clock(b.spans[0].end)}</span>
                    {b.pinned && <span className="chip" title="You placed this block by hand. Every Schedule and Replan keeps it here.">📌 pinned</span>}
                    <button className="link-title" onClick={() => openTask(b.taskId)}>{b.title}</button>
                    <span className="muted">{hm(mins(b))}</span>
                    {b.tentative && <span className="chip tent" title="Waiting on a blocker. Never written to Google.">tentative</span>}
                    {!b.tentative && (
                      <span className="pin-actions">
                        <button onClick={() => setPinEdit(pinEdit === `${b.taskId}${b.start}` ? null : `${b.taskId}${b.start}`)}>{b.pinned ? 'Move…' : '📌 Pin…'}</button>
                        {b.pinned && b.pinId && <button onClick={() => void unpin(b.pinId!, b.title, false)}>Unpin</button>}
                        {b.pinned && b.pinId && <button onClick={() => void unpin(b.pinId!, b.title, true)}>Move back to automatic</button>}
                      </span>
                    )}
                    {pinEdit === `${b.taskId}${b.start}` && (
                      <PinEditor tz={info.tz} taskId={b.taskId} pinId={b.pinId} start={b.start} end={b.end} onCancel={() => setPinEdit(null)} onDone={(msg) => { setPinEdit(null); toast(`📌 ${msg}`); changed(); load(); }} />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {p.skipped.length > 0 && (
            <details className="skipped"><summary>Not scheduled ({p.skipped.length})</summary>
              <ul>{p.skipped.map((s) => <li key={s.taskId}><button className="link-title" onClick={() => openTask(s.taskId)}>{s.title}</button>: {s.reason}</li>)}</ul>
            </details>
          )}
        </>
      )}

      {confirming && p && (
        <ApplyConfirm replan={replan} simulated={p.simulated} willRemove={p.willRemove} willWrite={p.willWrite} missedCount={p.missedCount} calendarName={p.calendarName}
          trims={p.trims} applying={applying} error={applyError} onCancel={() => setConfirming(false)} onConfirm={apply} />
      )}
    </div>
  );
}

export function Lines({ heading, lines }: { heading: string; lines: string[] }) {
  return <div className="lines"><div className="lineshead">{heading}</div><pre className="msg">{lines.join('\n')}</pre></div>;
}
function Attn({ g, cls }: { g: { heading: string; lines: string[] }; cls: string }) {
  return <section className={`note ${cls === 'warn' ? 'warnbox' : ''}`}><Lines heading={g.heading} lines={g.lines} /></section>;
}

/** The confirmation every write to the calendar goes through: the Apply button and the approval of a request from Claude both show THIS. */
export function ApplyConfirm(props: {
  replan: boolean; simulated: boolean; willRemove: number; willWrite: number; missedCount: number; calendarName: string;
  trims: { heading: string; lines: string[]; count: number }; applying: boolean; error: string | null; onCancel: () => void; onConfirm: () => void; fromClaude?: boolean;
}) {
  const { replan, simulated, willRemove, willWrite, missedCount, calendarName, trims, applying, error, onCancel, onConfirm, fromClaude } = props;
  return (
    <div className="modal-back" role="presentation" onKeyDown={(e) => e.key === 'Escape' && !applying && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 id="confirm-title">{replan ? 'Replan' : 'Apply'}: write to {simulated ? 'the simulated calendar' : 'Google Calendar'}?</h3>
        {fromClaude && <p className="hint"><strong>Claude asked for this.</strong> It has not written anything; only your click below does.</p>}
        <p>This will <strong>remove {willRemove}</strong> earlier block{willRemove === 1 ? '' : 's'}{missedCount > 0 && replan ? ` (including ${missedCount} missed)` : ''} and <strong>write {willWrite}</strong> new block{willWrite === 1 ? '' : 's'} on the “{calendarName}” calendar.</p>
        <p className="hint">{simulated ? 'Demo mode: nothing leaves this computer.' : 'Only that calendar is changed. Tentative blocks are not written. Past blocks stay as history.'}</p>
        {trims.count > 0 && <Lines heading={trims.heading} lines={trims.lines} />}
        {error && <div className="note error" role="alert"><pre className="msg">{error}</pre></div>}
        <div className="modal-actions">
          <button onClick={onCancel} disabled={applying}>Cancel</button>
          <button className="primary" onClick={onConfirm} disabled={applying} autoFocus>{applying ? 'Writing…' : simulated ? 'Write to simulated calendar' : 'Write to Google Calendar'}</button>
        </div>
      </div>
    </div>
  );
}

const leftText = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${s} s`;
};

/** A schedule apply that Claude asked for. Nothing has been written; Approve (after the usual confirmation) is the only thing that writes. */
function PendingApplyCard({ state, reload }: { state: PendingState; reload: () => void }) {
  const { toast, changed } = useApp();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const pend = state.pending;
  async function approve() {
    if (!pend) return;
    setBusy(true); setErr(null);
    try { const r = await api.pendingApprove(pend.id); setConfirming(false); toast(r.message); changed(); reload(); }
    catch (e) { setErr(errText(e)); reload(); }
    finally { setBusy(false); }
  }
  async function reject() {
    if (!pend) return;
    try { await api.pendingReject(pend.id); toast('Rejected. Nothing was written.'); reload(); } catch (e) { setErr(errText(e)); reload(); }
  }
  if (!pend) {
    const l = state.last;
    if (!l || dismissed === l.id) return null;
    return (
      <div className="note" role="status" data-testid="pending-last">
        <strong>Last request from Claude to apply a schedule: {l.status}.</strong> {l.message}
        <button className="link" onClick={() => setDismissed(l.id)}>Dismiss</button>
      </div>
    );
  }
  return (
    <section className="note warnbox pending-apply" role="region" aria-label="Claude wants to apply a schedule" data-testid="pending-apply">
      <h3 style={{ margin: 0 }}>Claude asked to apply a schedule</h3>
      <p>Nothing has been written. If you approve, this will <strong>remove {pend.willRemove}</strong> earlier block{pend.willRemove === 1 ? '' : 's'} and <strong>write {pend.willWrite}</strong> new block{pend.willWrite === 1 ? '' : 's'} on the “{pend.calendarName}” calendar{pend.simulated ? ' (simulated: demo mode)' : ''}. {pend.replan ? 'Replan mode. ' : ''}Plan for the next {pend.days} days, previewed {new Date(pend.previewedAt).toLocaleTimeString()}.</p>
      {pend.trims.count > 0 && <Lines heading={pend.trims.heading} lines={pend.trims.lines} />}
      {pend.moved.count > 0 && <Lines heading={pend.moved.heading} lines={pend.moved.lines} />}
      <p className="hint">Expires in {leftText(pend.expiresAt, now)}. If your tasks or availability change first, it is refused and nothing is written.</p>
      {err && !confirming && <div className="note error" role="alert"><pre className="msg">{err}</pre></div>}
      <div className="modal-actions">
        <button onClick={reject} disabled={busy}>Reject</button>
        <button className="primary" onClick={() => { setErr(null); setConfirming(true); }} disabled={busy}>Approve…</button>
      </div>
      {confirming && (
        <ApplyConfirm replan={pend.replan} simulated={pend.simulated} willRemove={pend.willRemove} willWrite={pend.willWrite} missedCount={pend.missedCount} calendarName={pend.calendarName}
          trims={pend.trims} applying={busy} error={err} onCancel={() => setConfirming(false)} onConfirm={approve} fromClaude />
      )}
    </section>
  );
}

/** Polls for a request from Claude (it is filed by another program, so the window has to look). */
function usePending(version: number) {
  const [state, setState] = useState<PendingState>({ pending: null, last: null });
  const load = useCallback(() => api.pendingGet().then((s) => setState((cur) => (JSON.stringify(cur) === JSON.stringify(s) ? cur : s))).catch(() => {}), []);
  useEffect(() => { void load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, [load, version]);
  return { state, load };
}
