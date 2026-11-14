import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errText, useApp } from '../ctx';
import type { TaskDetail, TaskDto } from '../../../src/app/types';

const TYPES = ['homework', 'project', 'exam', 'quiz', 'reading', 'attendance', 'other'];
const UNITS = ['pages', 'video_minutes', 'problems', 'items', 'points'];

interface Form {
  title: string; notes: string; due: string; course: string; type: string; list: string; est: string;
  sizeAmount: string; sizeUnit: string; weight: string; availableFrom: string; repeat: string; optional: boolean; deadlineOnly: boolean;
}
const toForm = (t: TaskDto): Form => ({
  title: t.title, notes: t.notes ?? '', due: '', course: t.course ?? '', type: t.type, list: t.listName ?? '',
  est: t.estimateSource === 'manual' && t.estimate != null ? String(t.estimate) : '', sizeAmount: t.sizeAmount != null ? String(t.sizeAmount) : '', sizeUnit: t.sizeUnit ?? '',
  weight: t.gradeWeight != null ? String(t.gradeWeight) : '', availableFrom: t.availableFrom ?? '', repeat: '', optional: t.optional, deadlineOnly: t.deadlineOnly,
});

/** Everything about one task: edit every field, mark done, delete, log time, dependencies. All changes go through the same rules as the CLI. */
export function TaskDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { changed, toast, version } = useApp();
  const [d, setD] = useState<TaskDetail | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<TaskDto[]>([]);

  const apply = (det: TaskDetail, resetForm = true) => { setD(det); if (resetForm) setF(toForm(det.task)); };
  const load = useCallback(() => api.task(id).then((det) => apply(det)).catch((e) => setError(errText(e))), [id]);
  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => {
    if (!search.trim()) { setFound([]); return; }
    const h = setTimeout(() => api.tasks({ text: search.trim(), status: 'open', limit: 8 }).then((r) => setFound(r.filter((x) => x.id !== id))).catch(() => {}), 200);
    return () => clearTimeout(h);
  }, [search, id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  if (!d || !f) return <aside className="drawer" role="dialog" aria-label="Task details">{error ? <div className="note error">{error}</div> : 'Loading…'}</aside>;
  const t = d.task;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const orig = toForm(t);

  async function save() {
    const patch: Record<string, unknown> = {};
    if (f!.title !== orig.title) patch.title = f!.title;
    if (f!.notes !== orig.notes) patch.notes = f!.notes.trim() === '' ? null : f!.notes;
    if (f!.due.trim() !== '') patch.due = f!.due.trim();
    if (f!.course !== orig.course) patch.course = f!.course.trim() === '' ? 'none' : f!.course.trim();
    if (f!.type !== orig.type) patch.type = f!.type;
    if (f!.list !== orig.list) patch.list = f!.list === '' ? 'none' : f!.list;
    if (f!.est !== orig.est) patch.est = f!.est.trim() === '' ? null : Number(f!.est);
    if (f!.sizeAmount !== orig.sizeAmount || f!.sizeUnit !== orig.sizeUnit) patch.size = f!.sizeAmount.trim() === '' || !f!.sizeUnit ? null : { amount: Number(f!.sizeAmount), unit: f!.sizeUnit };
    if (f!.weight !== orig.weight) patch.weight = f!.weight.trim() === '' ? null : Number(f!.weight);
    if (f!.availableFrom !== orig.availableFrom) patch.availableFrom = f!.availableFrom.trim() === '' ? 'none' : f!.availableFrom.trim();
    if (f!.repeat.trim() !== '') patch.repeat = f!.repeat.trim();
    if (f!.optional !== orig.optional) patch.optional = f!.optional;
    if (f!.deadlineOnly !== orig.deadlineOnly) patch.deadlineOnly = f!.deadlineOnly;
    if (!Object.keys(patch).length) return toast('Nothing changed.');
    try {
      apply(await api.editTask(id, patch));
      setError(null);
      toast('Saved.');
      changed();
    } catch (e) { setError(errText(e)); }
  }

  const run = (p: Promise<unknown>, msg?: string) => p.then(() => { if (msg) toast(msg); changed(); }).catch((e) => setError(errText(e)));

  return (
    <aside className="drawer" role="dialog" aria-label="Task details">
      <div className="drawer-head">
        <h2>#{t.id} {t.deleted ? '(deleted) ' : ''}{t.status === 'done' ? '✓ ' : ''}{t.title}</h2>
        <button onClick={onClose} aria-label="Close details">✕</button>
      </div>
      {error && <div className="note error" role="alert">{error}</div>}

      <div className="actions">
        {t.deleted ? <button onClick={() => run(api.undelete(id), 'Restored.')}>Restore</button> : (
          <>
            <button className="primary" onClick={() => run(t.status === 'done' ? api.undone(id) : api.done(id), t.status === 'done' ? 'Reopened.' : 'Marked done.')}>{t.status === 'done' ? 'Reopen' : 'Mark done'}</button>
            <button onClick={() => run(api.timerStart(id), 'Timer started.')}>Start timer</button>
            <button onClick={() => api.deleteTask(id).then(() => { onClose(); changed(); toast(`Deleted "${t.title}".`, { label: 'Undo', run: () => api.undelete(id).then(() => changed()).catch((e) => toast(errText(e))) }); }).catch((e) => setError(errText(e)))}>Delete</button>
          </>
        )}
      </div>

      <form className="fields" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>Title<input value={f.title} onChange={(e) => set('title', e.target.value)} /></label>
        <label>Due<input value={f.due} onChange={(e) => set('due', e.target.value)} placeholder={t.due ? `${t.dueText}${t.timeAssumed ? ' (time assumed)' : ''}. Type to change, "none" to clear` : 'e.g. fri 5pm, nov 20'} /></label>
        <div className="two">
          <label>Course<input value={f.course} onChange={(e) => set('course', e.target.value)} /></label>
          <label>Type<select value={f.type} onChange={(e) => set('type', e.target.value)}>{TYPES.map((x) => <option key={x}>{x}</option>)}</select></label>
        </div>
        <div className="two">
          <label>List<select value={f.list} onChange={(e) => set('list', e.target.value)}><option value="">(none)</option>{d.lists.map((l) => <option key={l}>{l}</option>)}</select></label>
          <label>Grade weight %<input value={f.weight} onChange={(e) => set('weight', e.target.value)} inputMode="decimal" /></label>
        </div>
        <div className="two">
          <label>Estimate (minutes)<input value={f.est} onChange={(e) => set('est', e.target.value.replace(/\D/g, ''))} placeholder={t.estimateSource === 'size' ? `${t.estimate} (from size)` : ''} /></label>
          <label>Logged so far<input value={`${t.actualMinutes} min`} readOnly /></label>
        </div>
        {t.estimateNote && <div className="hint">{t.estimateNote}</div>}
        {t.estimateWhy && <div className="hint" data-testid="estimate-why"><strong>Why this estimate:</strong> {t.estimateWhy} <button className="link" onClick={() => window.dispatchEvent(new CustomEvent('planner:open-screen', { detail: 'rates' }))}>Open Rates</button></div>}
        <div className="two">
          <label>Size<input value={f.sizeAmount} onChange={(e) => set('sizeAmount', e.target.value)} inputMode="decimal" placeholder="amount" /></label>
          <label>Unit<select value={f.sizeUnit} onChange={(e) => set('sizeUnit', e.target.value)}><option value="">(none)</option>{UNITS.map((x) => <option key={x}>{x}</option>)}</select></label>
        </div>
        <div className="two">
          <label>Available from<input value={f.availableFrom} onChange={(e) => set('availableFrom', e.target.value)} placeholder="YYYY-MM-DD" /></label>
          <label>Repeat<input value={f.repeat} onChange={(e) => set('repeat', e.target.value)} placeholder={t.repeat ?? 'daily, weekly, mon,wed, none'} /></label>
        </div>
        <div className="checks">
          <label><input type="checkbox" checked={f.optional} onChange={(e) => set('optional', e.target.checked)} /> Optional (not scheduled by default)</label>
          <label><input type="checkbox" checked={f.deadlineOnly} onChange={(e) => set('deadlineOnly', e.target.checked)} /> Deadline only (shown, never scheduled)</label>
        </div>
        <label>Notes<textarea rows={4} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
        <div className="actions"><button className="primary" type="submit">Save changes</button><button type="button" onClick={() => setF(toForm(t))}>Revert</button></div>
      </form>

      <section className="sect">
        <h3>Log work</h3>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); if (minutes) run(api.logWork(id, Number(minutes)).then((r) => { setMinutes(''); toast(`Logged. Total ${r.total} min.`); }).catch((er) => setError(errText(er)))); }}>
          <input value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} placeholder="minutes" size={6} aria-label="Minutes of work to log" />
          <button type="submit">Log</button>
          <span className="muted">The scheduler plans only the remaining estimate.</span>
        </form>
        {d.sessions.length > 0 && <ul className="small">{d.sessions.slice(0, 5).map((s, i) => <li key={i}>{new Date(s.startedAt).toLocaleString()} {s.endedAt ? `→ ${Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60000)} min` : '(still running)'}</li>)}</ul>}
      </section>

      <section className="sect">
        <h3>Dependencies</h3>
        {d.blockers.length === 0 ? <p className="muted">Not blocked by anything.</p> : (
          <ul className="small">{d.blockers.map((b) => (
            <li key={b.id}>Blocked by <button className="link" onClick={() => openOther(b.id)}>#{b.id} {b.title}</button> {b.open ? '' : '(done)'}
              <button className="link" onClick={() => api.removeDep(id, b.id).then((x) => { apply(x, false); changed(); }).catch((e) => setError(errText(e)))}> remove</button></li>
          ))}</ul>
        )}
        {d.blocks.length > 0 && <ul className="small">{d.blocks.map((b) => <li key={b.id}>Blocks #{b.id} {b.title}</li>)}</ul>}
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a task this one waits on…" aria-label="Search for a blocking task" />
        {found.length > 0 && (
          <ul className="results">{found.map((x) => (
            <li key={x.id}><button onClick={() => api.addDep(id, x.id).then((r) => { apply(r, false); setSearch(''); changed(); }).catch((e) => setError(errText(e)))}>#{x.id} {x.course ? `${x.course}: ` : ''}{x.title}</button></li>
          ))}</ul>
        )}
      </section>

      {(d.parent || d.steps.length > 0) && (
        <section className="sect">
          <h3>Plan</h3>
          {d.parent && <p className="small">Step of #{d.parent.id} {d.parent.title}</p>}
          {d.steps.length > 0 && <ul className="small">{d.steps.map((s) => <li key={s.id}>{s.done ? '✓ ' : ''}#{s.id} {s.title}</li>)}</ul>}
        </section>
      )}

      <section className="sect small muted">
        <div>{t.termName ? `Term: ${t.termName} · ` : ''}source: {t.source}{t.confidence ? ` (${t.confidence} confidence)` : ''} · created {new Date(t.createdAt).toLocaleDateString()}</div>
        {t.sourceQuote && <blockquote>“{t.sourceQuote}”</blockquote>}
      </section>
    </aside>
  );
}

// opens another task in the same drawer (set by App through a window event, so this component stays self-contained)
function openOther(id: number) { window.dispatchEvent(new CustomEvent('planner:open-task', { detail: id })); }
