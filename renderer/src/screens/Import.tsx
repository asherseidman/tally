import { useRef, useState } from 'react';
import { api } from '../api';
import { errText, fmtMinutes, useApp } from '../ctx';
import { courseClass } from '../ui';
import type { ImportApplied, ImportEntry, ImportReview } from '../../../src/app/types';

const FIELDS: { id: string; label: string; hint: string }[] = [
  { id: 'title', label: 'Title', hint: 'new title' },
  { id: 'type', label: 'Type', hint: 'homework, project, exam, quiz, reading, attendance, other' },
  { id: 'due', label: 'Due', hint: 'fri 5pm, 2026-10-01T17:00, or none' },
  { id: 'weight', label: 'Weight %', hint: '0-100, or none' },
  { id: 'est', label: 'Estimate (min)', hint: 'whole minutes, or none' },
  { id: 'notes', label: 'Notes', hint: 'text, or none' },
];

/** Import: choose or drop a JSON file (or paste it), review the diff, edit or uncheck items, then confirm. Nothing is written before the confirm. */
export function Import({ goTo }: { goTo: (s: 'lists' | 'today') => void }) {
  const { changed, toast, info } = useApp();
  const [r, setR] = useState<ImportReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<ImportApplied | null>(null);
  const [paste, setPaste] = useState('');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function startFrom(text: string, name: string) {
    setError(null); setDone(null); setBusy(true);
    try { if (r) void api.importClose(r.id).catch(() => {}); setR(await api.importReview(text, name)); }
    catch (e) { setR(null); setError(errText(e)); }
    finally { setBusy(false); }
  }
  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > 5_000_000) return setError(`${file.name} is larger than 5 MB; an import file should be much smaller.`);
    await startFrom(await file.text(), file.name);
  }
  const run = (p: Promise<ImportReview>) => p.then((x) => { setR(x); setError(null); }).catch((e) => setError(errText(e)));

  async function confirm() {
    if (!r) return;
    setBusy(true);
    try {
      const res = await api.importApply(r.id);
      setDone(res); setR(null); setConfirming(false); toast(res.message); changed();
    } catch (e) { setError(errText(e)); setConfirming(false); }
    finally { setBusy(false); }
  }
  function cancel() { if (r) void api.importClose(r.id).catch(() => {}); setR(null); setError(null); setConfirming(false); }

  if (done) {
    return (
      <div className="import">
        <h2>Import finished</h2>
        <div className="note ok" role="status" data-testid="import-done"><strong>{done.message}</strong></div>
        {done.keptLocalEdits.length > 0 && <p>Kept your own edits on: {done.keptLocalEdits.map((k) => `#${k.taskId} (${k.fields.join(', ')})`).join('; ')}.</p>}
        {done.backup && <p className="hint">Backup after import saved and verified: {done.backup}</p>}
        {done.backupError && <div className="note error" role="alert">{done.backupError}</div>}
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="primary" onClick={() => goTo('today')}>Go to Today</button>
          <button onClick={() => goTo('lists')}>Go to Lists</button>
          <button onClick={() => setDone(null)}>Import another file</button>
        </div>
      </div>
    );
  }

  if (!r) {
    return (
      <div className="import">
        <h2>Import</h2>
        <p className="hint">Import a JSON file that Claude produced from a syllabus. You review every item before anything is written. Format: <code>docs/IMPORT_FORMAT.md</code> in the project folder.{info.demo ? ' (Demo database.)' : ''}</p>
        <div
          className={`drop ${over ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void pick(e.dataTransfer.files[0]); }}
        >
          <p>Drop a .json file here, or</p>
          <input ref={fileRef} type="file" accept=".json,application/json" aria-label="Choose import file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        <details>
          <summary>Or paste the JSON</summary>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={8} className="paste" aria-label="Pasted import JSON" placeholder='{ "term": { ... }, "items": [ ... ] }' />
          <div><button disabled={!paste.trim() || busy} onClick={() => startFrom(paste, 'pasted text')}>Review pasted JSON</button></div>
        </details>
        {busy && <p className="note" role="status">Reading…</p>}
        {error && <div className="note error" role="alert"><pre className="msg">{error}</pre></div>}
      </div>
    );
  }

  const section = (title: string, es: ImportEntry[]) => es.length > 0 && (
    <section className="rsec" aria-label={title}>
      <h3>{title} ({es.length})</h3>
      <ul className="rows">{es.map((e) => <Entry key={e.num} e={e} id={r.id} run={run} tz={r.tz} />)}</ul>
    </section>
  );
  const nothing = r.entries.length === 0;

  return (
    <div className="import">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Review import</h2>
        <span className="muted">{r.fileName} · {r.term}{r.termIsNew ? ' (new term)' : ''} · times in {r.tz}, * = time assumed ({r.defaultTime})</span>
        <span className="spacer" />
        <button onClick={cancel}>Cancel</button>
        <button className="primary" disabled={busy || r.willAdd + r.willUpdate === 0} onClick={() => setConfirming(true)}>Import {r.willAdd + r.willUpdate} item{r.willAdd + r.willUpdate === 1 ? '' : 's'}…</button>
      </div>
      {r.note && <div className="note">{r.note}</div>}
      {error && <div className="note error" role="alert"><pre className="msg">{error}</pre></div>}
      <p className="summary" data-testid="import-summary"><strong>{r.willAdd}</strong> to add · <strong>{r.willUpdate}</strong> to update · {r.unchanged.length} unchanged · {r.missing.length} in the database but missing from the file (left untouched)</p>
      {nothing && <p className="muted">Nothing new or changed in this file.</p>}
      {section('NEW', r.entries.filter((e) => e.kind === 'new'))}
      {section('CHANGED', r.entries.filter((e) => e.kind === 'changed'))}
      {r.unchanged.length > 0 && <details><summary>Unchanged ({r.unchanged.length})</summary><ul>{r.unchanged.map((t, i) => <li key={i}>{t}</li>)}</ul></details>}
      {r.missing.length > 0 && <details><summary>In the database but missing from the file ({r.missing.length}): left untouched</summary><ul>{r.missing.map((m, i) => <li key={i}>{m.title} {m.dueText && <span className="muted">[{m.dueText}]</span>}</li>)}</ul></details>}

      {confirming && (
        <div className="modal-back" role="presentation" onKeyDown={(e) => e.key === 'Escape' && !busy && setConfirming(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="imp-title">
            <h3 id="imp-title">Write this import to {info.demo ? 'the demo database' : 'your database'}?</h3>
            <p>Add <strong>{r.willAdd}</strong> and update <strong>{r.willUpdate}</strong> task{r.willAdd + r.willUpdate === 1 ? '' : 's'}{r.termIsNew ? <>, and create the term “{r.term}”</> : ''}. Fields you edited yourself are never overwritten. A verified backup is taken right after.</p>
            <div className="modal-actions">
              <button onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button className="primary" onClick={confirm} disabled={busy} autoFocus>{busy ? 'Importing…' : 'Import'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Entry({ e, id, run, tz }: { e: ImportEntry; id: string; run: (p: Promise<ImportReview>) => void; tz: string }) {
  const [editing, setEditing] = useState(false);
  const [field, setField] = useState('title');
  const [value, setValue] = useState('');
  const hint = FIELDS.find((f) => f.id === field)?.hint;
  return (
    <li className={`row import-row ${e.included ? '' : 'excluded'} ${e.lowConfidence ? 'low' : ''}`} data-num={e.num}>
      <div className="irow">
        <input className="check" type="checkbox" checked={e.included} aria-label={`Include "${e.title}"`} onChange={() => run(api.importToggle(id, e.num, !e.included))} />
        <span className="muted rowdue">{e.dueText ?? '(no date)'}</span>
        <span className={`chip ${courseClass(e.course)}`}>{e.course}</span>
        <span className="grow">{e.parentTitle ? <span className="muted">{e.parentTitle} › </span> : null}<strong>{e.title}</strong></span>
        <span className="muted">{[e.type, e.weight != null ? `${e.weight}%` : null, e.estimate ? fmtMinutes(e.estimate) : null, e.size ? `size ${e.size}` : null, e.optional ? 'optional' : null, e.deadlineOnly ? 'deadline only' : null, e.availableFrom ? `from ${e.availableFrom}` : null].filter(Boolean).join(', ')}</span>
        {e.lowConfidence && <span className="chip warn">LOW CONFIDENCE</span>}
        <button className="link" onClick={() => setEditing(!editing)} aria-expanded={editing}>{editing ? 'Close' : 'Edit'}</button>
      </div>
      {e.after.length > 0 && <div className="sub muted">after: {e.after.join(', ')}</div>}
      {e.lowConfidence && e.quote && <div className="sub muted">“{e.quote}”</div>}
      {e.changes.map((c) => (
        <div key={c.field} className="sub change">{c.field}: <span className="from">{c.from}</span> → <strong>{c.to}</strong>{c.conflict && <span className="conflict"> (you edited this: will NOT be overwritten)</span>}</div>
      ))}
      {editing && (
        <form className="sub editform" onSubmit={(ev) => { ev.preventDefault(); run(api.importEdit(id, e.num, field, value)); setValue(''); }}>
          <select value={field} onChange={(x) => setField(x.target.value)} aria-label="Field to edit">{FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
          <input value={value} onChange={(x) => setValue(x.target.value)} placeholder={hint} aria-label="New value" size={34} />
          <button type="submit">Apply edit</button>
          <span className="hint">Shown in {tz}.</span>
        </form>
      )}
    </li>
  );
}
