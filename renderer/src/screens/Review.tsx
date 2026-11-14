import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { errText, useApp } from '../ctx';
import { ApplyConfirm } from './Schedule';
import type { ReviewData, SchedulePreview, StepA, StepB, StepC, ScheduleApplied } from '../../../src/app/types';

const STEPS = [
  { id: 'a', label: '1. What you finished' }, { id: 'b', label: '2. Overdue and slipped' }, { id: 'c', label: '3. Missing details' }, { id: 'd', label: '4. Replan' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const PROBLEM: Record<string, string> = { no_estimate: 'no estimate', no_size: 'no size', time_assumed: 'due time assumed' };

/**
 * The weekly review. Answers are collected here and NOTHING is written until the step's confirm button is pressed
 * (each step: one button, one recorded change you can undo). The replan step is the Schedule screen's own preview and confirmation.
 */
export function Review({ onDone }: { onDone: () => void }) {
  const { version, toast, changed, openTask } = useApp();
  const [data, setData] = useState<ReviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<StepId>('a');
  const [applied, setApplied] = useState<Partial<Record<StepId, string>>>({});
  const load = useCallback(() => api.reviewGet().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(errText(e))), []);
  useEffect(() => { void load(); }, [load, version]);

  async function finish() {
    try { await api.reviewFinish(); toast('Review done. Next one in a week.'); onDone(); await load(); setStep('a'); setApplied({}); } catch (e) { setErr(errText(e)); }
  }
  if (!data) return err ? <div className="note error" role="alert">{err}</div> : <p className="muted">Loading…</p>;
  const st = data.state;
  return (
    <div className="review" data-testid="review">
      <header className="page-head"><h1>Weekly review</h1>
        <span className="date" data-testid="review-last">{st.lastReviewAt ? `Last review: ${when(st.lastReviewAt)}` : 'No review yet'}{st.due ? ' · due' : ''}</span></header>
      <p className="hint">Looking back since {when(data.since)} ({data.sinceIsLastReview ? 'your last review' : 'a week ago'}). Choose what applies, then press the step’s button. Nothing changes before that.</p>
      {err && <div className="note error" role="alert">{err}</div>}
      <div role="tablist" aria-label="Review steps" className="seg">
        {STEPS.map((s) => <button key={s.id} role="tab" aria-selected={step === s.id} className={step === s.id ? 'primary' : ''} onClick={() => setStep(s.id)} data-testid={`review-tab-${s.id}`}>{s.label}{applied[s.id] ? ' ✓' : ''}</button>)}
      </div>
      {step === 'a' && <StepAView data={data} onApplied={(m) => { setApplied((x) => ({ ...x, a: m })); void load(); changed(); }} next={() => setStep('b')} />}
      {step === 'b' && <StepBView data={data} onApplied={(m) => { setApplied((x) => ({ ...x, b: m })); void load(); changed(); }} next={() => setStep('c')} openTask={openTask} />}
      {step === 'c' && <StepCView data={data} onApplied={(m) => { setApplied((x) => ({ ...x, c: m })); void load(); changed(); }} next={() => setStep('d')} openTask={openTask} />}
      {step === 'd' && <StepDView done={applied.d} onApplied={(m) => { setApplied((x) => ({ ...x, d: m })); void load(); changed(); }} />}
      <div className="review-finish">
        <button className="primary" onClick={() => void finish()} data-testid="review-finish">Finish review</button>
        <span className="hint"> Marks the review done (clears the marker on the Review tab). You can finish at any step; steps you skipped are simply not done.</span>
      </div>
    </div>
  );
}

function useApply(step: 'a' | 'b' | 'c', onApplied: (m: string) => void) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function go(decisions: unknown[]) {
    setBusy(true); setErr(null);
    try { const r = await api.reviewApply(step, decisions); const m = `Applied: ${r.summary}.${r.skipped.length ? ` Skipped: ${r.skipped.join('; ')}.` : ''}`; setMsg(m); toast(m); onApplied(r.summary); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return { busy, err, msg, go };
}

function Footer({ n, busy, err, msg, onApply, next, label }: { n: number; busy: boolean; err: string | null; msg: string | null; onApply: () => void; next: () => void; label: string }) {
  return (
    <div className="review-foot">
      {err && <div className="note error" role="alert">{err}</div>}
      {msg && <div className="note" role="status" data-testid="review-applied">{msg}</div>}
      <button className="primary" disabled={busy || n === 0} onClick={onApply} data-testid="review-apply">{busy ? 'Applying…' : n === 0 ? label : `${label} (${n})`}</button>
      <button onClick={next} data-testid="review-next">Next step</button>
    </div>
  );
}

// ---- (a) what you finished ----
function StepAView({ data, onApplied, next }: { data: ReviewData; onApplied: (m: string) => void; next: () => void }) {
  const { openTask } = useApp();
  const rows = useMemo(() => {
    const m = new Map<number, { taskId: number; title: string; course: string | null; minutes: number; blocks: number; blockId?: number; dueAt?: string; status: string }>();
    for (const b of data.finished.blocks) { const r = m.get(b.taskId) ?? { taskId: b.taskId, title: b.title, course: b.course, minutes: 0, blocks: 0, status: b.taskStatus }; r.minutes += b.minutes; r.blocks++; r.blockId = b.blockId; m.set(b.taskId, r); }
    for (const t of data.finished.dueItems) { const r = m.get(t.taskId) ?? { taskId: t.taskId, title: t.title, course: t.course, minutes: 0, blocks: 0, status: t.status }; r.dueAt = t.due; m.set(t.taskId, r); }
    return [...m.values()];
  }, [data]);
  const [ans, setAns] = useState<Record<number, 'done' | 'partly' | 'not'>>({});
  const [mins, setMins] = useState<Record<number, string>>({});
  const { busy, err, msg, go } = useApply('a', (m) => { onApplied(m); setAns({}); });
  const open = rows.filter((r) => r.status !== 'done');
  const decisions: StepA[] = Object.entries(ans).map(([id, result]) => {
    const r = rows.find((x) => x.taskId === Number(id))!;
    return { taskId: r.taskId, blockId: r.blockId, result, minutes: result === 'partly' && mins[r.taskId] ? Number(mins[r.taskId]) : undefined };
  });
  return (
    <section aria-label="What you finished" data-testid="review-step-a">
      <h2>What you finished</h2>
      <p className="hint">Planned blocks that have passed and things that came due since the last review. Done marks the task done; Partly logs the time you did; Not done changes nothing (the replan in step 4 moves it).</p>
      {rows.length === 0 && <p className="empty">No blocks or due dates in this window.</p>}
      <ul className="cards review-list">
        {rows.map((r) => (
          <li key={r.taskId} data-testid="review-a-row" className="review-row">
            <button className="link-title" onClick={() => openTask(r.taskId)}>{r.title}</button>
            {r.course && <span className="chip">{r.course}</span>}
            <span className="muted"> {r.blocks ? `${r.blocks} block${r.blocks === 1 ? '' : 's'}, ${r.minutes} min planned` : ''}{r.dueAt ? ` · was due ${day(r.dueAt)}` : ''}</span>
            {r.status === 'done' ? <em className="muted"> already done</em> : (
              <span className="choices" role="group" aria-label={`Answer for ${r.title}`}>
                {(['done', 'partly', 'not'] as const).map((k) => (
                  <label key={k}><input type="radio" name={`a-${r.taskId}`} checked={ans[r.taskId] === k} onChange={() => setAns((a) => ({ ...a, [r.taskId]: k }))} data-testid={`a-${k}`} /> {k === 'done' ? 'Done' : k === 'partly' ? 'Partly' : 'Not done'}</label>
                ))}
                {ans[r.taskId] === 'partly' && <label>minutes <input type="number" min={1} max={1440} value={mins[r.taskId] ?? ''} placeholder={r.minutes ? String(Math.max(5, Math.round(r.minutes / 2 / 5) * 5)) : 'min'} onChange={(e) => setMins((m) => ({ ...m, [r.taskId]: e.target.value }))} style={{ width: 70 }} /></label>}
              </span>
            )}
          </li>
        ))}
      </ul>
      <Footer n={decisions.length} busy={busy} err={err} msg={msg} onApply={() => void go(decisions.map((d) => ({ ...d, blockId: d.blockId })))} next={next} label={open.length ? 'Apply these answers' : 'Nothing to apply'} />
    </section>
  );
}

// ---- (b) overdue and slipped ----
type Act = 'reschedule' | 'done' | 'drop' | 'keep';
function StepBView({ data, onApplied, next, openTask }: { data: ReviewData; onApplied: (m: string) => void; next: () => void; openTask: (id: number) => void }) {
  const [act, setAct] = useState<Record<number, Act>>({});
  const [due, setDue] = useState<Record<number, string>>({});
  const { busy, err, msg, go } = useApply('b', (m) => { onApplied(m); setAct({}); setDue({}); });
  const decisions: StepB[] = Object.entries(act).map(([id, action]) => ({ taskId: Number(id), action, due: action === 'reschedule' ? due[Number(id)] : undefined }));
  const missing = decisions.filter((d) => d.action === 'reschedule' && !d.due?.trim()).length;
  return (
    <section aria-label="Overdue and slipped" data-testid="review-step-b">
      <h2>Overdue and slipped</h2>
      <p className="hint">Reschedule due changes the due date. Mark done completes it. Drop removes it (a soft delete; undo it from Settings &gt; General &gt; Recent changes). Keep leaves it as is.</p>
      {data.slipped.length === 0 && <p className="empty">Nothing is overdue or slipped.</p>}
      <ul className="cards review-list">
        {data.slipped.map((t) => (
          <li key={t.taskId} data-testid="review-b-row" className="review-row">
            <button className="link-title" onClick={() => openTask(t.taskId)}>{t.title}</button>
            {t.course && <span className="chip">{t.course}</span>}
            <span className="muted"> {t.detail}</span>
            <span className="choices" role="group" aria-label={`Choice for ${t.title}`}>
              {([['reschedule', 'Reschedule due'], ['done', 'Mark done'], ['drop', 'Drop'], ['keep', 'Keep']] as const).map(([k, l]) => (
                <label key={k}><input type="radio" name={`b-${t.taskId}`} checked={act[t.taskId] === k} onChange={() => setAct((a) => ({ ...a, [t.taskId]: k }))} data-testid={`b-${k}`} /> {l}</label>
              ))}
              {act[t.taskId] === 'reschedule' && <input aria-label={`New due date for ${t.title}`} placeholder="e.g. fri 5pm" value={due[t.taskId] ?? ''} onChange={(e) => setDue((x) => ({ ...x, [t.taskId]: e.target.value }))} data-testid="b-due" style={{ width: 130 }} />}
            </span>
          </li>
        ))}
      </ul>
      <Footer n={decisions.length} busy={busy || missing > 0} err={err ?? (missing ? 'Type a new due date for each task you chose to reschedule.' : null)} msg={msg} onApply={() => void go(decisions)} next={next} label="Apply these choices" />
    </section>
  );
}

// ---- (c) missing details ----
function StepCView({ data, onApplied, next, openTask }: { data: ReviewData; onApplied: (m: string) => void; next: () => void; openTask: (id: number) => void }) {
  const [f, setF] = useState<Record<number, { estimate?: string; size?: string; unit?: string; due?: string }>>({});
  const { busy, err, msg, go } = useApply('c', (m) => { onApplied(m); setF({}); });
  const set = (id: number, k: 'estimate' | 'size' | 'unit' | 'due', v: string) => setF((x) => ({ ...x, [id]: { ...x[id], [k]: v } }));
  const decisions: StepC[] = [];
  for (const t of data.needsInfo) {
    const v = f[t.taskId]; if (!v) continue;
    const d: StepC = { taskId: t.taskId };
    if (v.estimate?.trim()) d.estimate = Number(v.estimate);
    if (v.size?.trim()) { d.sizeAmount = Number(v.size); d.sizeUnit = v.unit || t.sizeUnit || undefined; }
    if (v.due?.trim()) d.due = v.due;
    if (d.estimate != null || d.sizeAmount != null || d.due) decisions.push(d);
  }
  return (
    <section aria-label="Missing details" data-testid="review-step-c">
      <h2>Missing details (next {data.aheadDays} days)</h2>
      <p className="hint">Tasks due soon that the planner cannot plan well yet. Fill in what you know; leave the rest blank.</p>
      {data.needsInfo.length === 0 && <p className="empty">Everything due in the next {data.aheadDays} days has an estimate, a size and a due time.</p>}
      <ul className="cards review-list">
        {data.needsInfo.map((t) => (
          <li key={t.taskId} data-testid="review-c-row" className="review-row">
            <button className="link-title" onClick={() => openTask(t.taskId)}>{t.title}</button>
            {t.course && <span className="chip">{t.course}</span>}
            <span className="muted"> due {day(t.due)}{t.timeAssumed ? '*' : ''} · {t.problems.map((p) => PROBLEM[p]).join(', ')}</span>
            <span className="choices">
              {(t.problems.includes('no_estimate')) && <label>estimate (min) <input type="number" min={1} max={10080} value={f[t.taskId]?.estimate ?? ''} onChange={(e) => set(t.taskId, 'estimate', e.target.value)} data-testid="c-estimate" style={{ width: 80 }} /></label>}
              {(t.problems.includes('no_size') || t.problems.includes('no_estimate')) && (
                <label>size <input type="number" min={0} step="any" value={f[t.taskId]?.size ?? ''} onChange={(e) => set(t.taskId, 'size', e.target.value)} data-testid="c-size" style={{ width: 70 }} />{' '}
                  <select aria-label={`Size unit for ${t.title}`} value={f[t.taskId]?.unit ?? t.sizeUnit ?? ''} onChange={(e) => set(t.taskId, 'unit', e.target.value)} data-testid="c-unit"><option value="">(unit)</option>{['pages', 'video_minutes', 'problems', 'items', 'points'].map((u) => <option key={u}>{u}</option>)}</select></label>
              )}
              {(t.problems.includes('time_assumed')) && <label>due <input placeholder="e.g. fri 5pm" value={f[t.taskId]?.due ?? ''} onChange={(e) => set(t.taskId, 'due', e.target.value)} data-testid="c-due" style={{ width: 130 }} /></label>}
            </span>
          </li>
        ))}
      </ul>
      <Footer n={decisions.length} busy={busy} err={err} msg={msg} onApply={() => void go(decisions)} next={next} label="Save these details" />
    </section>
  );
}

// ---- (d) replan: the Schedule screen's own preview and confirmation ----
function StepDView({ done, onApplied }: { done?: string; onApplied: (m: string) => void }) {
  const { toast, openTask } = useApp();
  const [p, setP] = useState<SchedulePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [result, setResult] = useState<ScheduleApplied | null>(null);
  const load = useCallback(() => { setLoading(true); setErr(null); api.schedulePreview(14, true).then(setP).catch((e) => { setP(null); setErr(errText(e)); }).finally(() => setLoading(false)); }, []);
  useEffect(() => { load(); }, [load]);
  async function apply() {
    if (!p) return;
    setApplying(true); setApplyErr(null);
    try { const r = await api.scheduleApply(p.days, p.replan, p.fingerprint); setResult(r); setConfirming(false); toast(r.message); onApplied(r.message); }
    catch (e) { setApplyErr(errText(e)); load(); } finally { setApplying(false); }
  }
  return (
    <section aria-label="Replan" data-testid="review-step-d">
      <h2>Replan the next 14 days</h2>
      <p className="hint">A preview of a replan (missed blocks removed, your pinned blocks kept). Nothing is written until you press Apply and confirm.</p>
      {err && <div className="note error" role="alert">{err}</div>}
      {loading && <p className="muted">Working out the plan…</p>}
      {p && !loading && (
        <>
          <p data-testid="review-preview"><strong>{p.willWrite}</strong> block{p.willWrite === 1 ? '' : 's'} would be written, <strong>{p.willRemove}</strong> removed{p.missedCount ? ` (${p.missedCount} missed)` : ''}. {p.problems.length ? `${p.problems.length} thing${p.problems.length === 1 ? '' : 's'} would not fit.` : 'Everything fits.'} {p.simulated ? '(Simulated calendar: demo mode.)' : ''}</p>
          {p.problems.length > 0 && <ul>{p.problems.map((x) => <li key={x.taskId}><button className="link-title" onClick={() => openTask(x.taskId)}>{x.title}</button>: {x.reason}</li>)}</ul>}
          <button className="primary" onClick={() => setConfirming(true)} disabled={!!result} data-testid="review-replan-apply">{result ? 'Applied' : 'Apply…'}</button>
          <button onClick={load}>Refresh preview</button>
        </>
      )}
      {(done || result) && <div className="note" role="status" data-testid="review-applied">{result?.message ?? done}</div>}
      {confirming && p && <ApplyConfirm replan={p.replan} simulated={p.simulated} willRemove={p.willRemove} willWrite={p.willWrite} missedCount={p.missedCount} calendarName={p.calendarName} trims={p.trims} applying={applying} error={applyErr} onCancel={() => setConfirming(false)} onConfirm={() => void apply()} />}
    </section>
  );
}
