import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errText, useApp } from '../ctx';
import type { InboxView } from '../../../src/app/types';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never');

/** Today's Inbox panel: the most recent items that arrived from your phone, each with Undo. Shown once phone capture is on or has ever brought something. */
export function InboxPanel() {
  const { version, toast, changed, openTask } = useApp();
  const [v, setV] = useState<InboxView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.inbox().then((x) => { setV(x); }).catch(() => {}), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 20_000); return () => clearInterval(t); }, [load, version]);
  if (!v || (!v.enabled && v.recent.length === 0)) return null;
  async function undo(id: string) {
    try { setV(await api.inboxUndo(id)); setErr(null); toast('Removed the task that came from your phone.'); changed(); } catch (e) { setErr(errText(e)); }
  }
  return (
    <section className="panel inbox-panel" aria-label="Inbox" data-testid="inbox-panel">
      <div className="panel-head"><h2>Inbox <span className={`count ${v.recent.length ? '' : 'zero'}`}>{v.recent.length}</span></h2></div>
      <p className="sub">From your phone (Reminders list “{v.list}”). {v.state && v.state !== 'ok' ? <strong>{v.message}</strong> : <>Last checked {when(v.lastCheck)}.</>}</p>
      {err && <div className="note error" role="alert">{err}</div>}
      {v.recent.length === 0 ? <p className="empty">Nothing from your phone yet.</p> : (
        <ul className="cards">
          {v.recent.map((i) => (
            <li key={i.reminderId} className="inbox-row" data-testid="inbox-item" data-undone={i.undone ? '1' : undefined}>
              <button className="linklike" onClick={() => openTask(i.taskId)} disabled={i.undone}>{i.taskTitle ?? i.title}</button>
              <span className="muted"> {i.dueText ? `due ${i.dueText}` : 'no date'} · {when(i.importedAt)}</span>
              {i.stillOpenOnPhone && <span className="muted"> · not yet marked completed in Reminders</span>}
              {i.undone ? <em className="muted"> (removed)</em> : i.canUndo && <button onClick={() => void undo(i.reminderId)}>Undo</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Settings > Phone: the whole control surface for phone capture. */
export function PhoneCapture() {
  const { version, toast, changed } = useApp();
  const [v, setV] = useState<InboxView | null>(null);
  const [list, setList] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.inbox().then((x) => { setV(x); setList(x.list); setErr(null); }).catch((e) => setErr(errText(e))), []);
  useEffect(() => { void load(); }, [load, version]);
  if (!v) return err ? <div className="note error" role="alert">{err}</div> : <p className="muted">Loading…</p>;

  const set = async (key: string, value: string, label: string) => {
    try { await api.setSetting(key, value); toast(`Saved ${label}.`); setErr(null); await load(); } catch (e) { setErr(errText(e)); }
  };
  const check = async () => {
    setBusy(true);
    try {
      const r = await api.inboxCheck();
      setV(r); setList(r.list); setErr(null);
      if (r.pass.imported) { toast(`Added ${r.pass.imported} task${r.pass.imported === 1 ? '' : 's'} from your phone.`); changed(); }
      else if (r.state === 'ok') toast('Checked: nothing new.');
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const bad = v.state === 'denied' || v.state === 'missing_list' || v.state === 'error';
  const label = v.state === null ? 'Not checked yet' : v.state === 'ok' ? 'Working' : v.state === 'denied' ? 'Permission needed' : v.state === 'missing_list' ? 'List not found' : 'Problem';
  return (
    <div className="settings-card" data-section="phone" aria-label="Phone capture">
      <h3>Phone capture (Apple Reminders)</h3>
      <p className="hint">Add reminders on your iPhone to a list named “{v.list}” (typed or with Siri). While Tally is open it turns each open reminder in that list into a task, then marks the reminder completed. It never reads or changes any other list. See docs/PHONE_CAPTURE.md.</p>
      {err && <div className="note error" role="alert">{err}</div>}
      <label className="row"><input type="checkbox" checked={v.enabled} onChange={(e) => void set('phone_inbox_enabled', String(e.target.checked), 'phone capture')} data-testid="phone-enabled" /> <span>Bring in reminders from my phone</span></label>
      <div className="row">
        <label htmlFor="phone-list">Reminders list name</label>
        <input id="phone-list" value={list} onChange={(e) => setList(e.target.value)} maxLength={100} data-testid="phone-list" />
        <button onClick={() => void set('phone_inbox_list', list, 'the list name')} disabled={list.trim() === v.list}>Save</button>
      </div>
      <label className="row"><input type="checkbox" checked={v.notify} onChange={(e) => void set('notify_phone_inbox', String(e.target.checked), 'the notification switch')} data-testid="phone-notify" /> <span>Notify me when items arrive (not during quiet hours)</span></label>
      <div className={`note ${bad ? 'error' : ''}`} role="status" data-testid="phone-status" data-state={v.state ?? 'none'}>
        <strong>Permission / status: {label}.</strong> {v.message ?? 'Turn the switch on, then press Check now. macOS will ask once whether Tally may control Reminders.'}
      </div>
      <p className="hint">Last check: {when(v.lastCheck)} · Imported so far: <strong data-testid="phone-count">{v.imported}</strong></p>
      <div className="row">
        <button className="primary" onClick={() => void check()} disabled={busy} data-testid="phone-check">{busy ? 'Checking…' : v.state === 'denied' || v.state === 'missing_list' ? 'Retry' : 'Check now'}</button>
        {v.canOpenPane && <button onClick={() => void api.inboxOpenPrivacy().catch((e) => setErr(errText(e)))} data-testid="phone-open-pane">Open macOS Automation settings</button>}
      </div>
    </div>
  );
}
