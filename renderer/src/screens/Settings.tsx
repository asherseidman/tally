import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errText, fmtMinutes, useApp } from '../ctx';
import { ReconnectButton } from '../ui';
import { PhoneCapture } from '../components/Inbox';
import { accelFromEvent } from '../../../src/app/accelerator';
import type { TrayInfo, ArchivedTerm, BackupsView, GoogleStatus, RecentNotice, SettingItem, SettingsView, TermRow } from '../../../src/app/types';

type Tab = 'general' | 'scheduling' | 'priority' | 'notifications' | 'phone' | 'terms' | 'google' | 'backups';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' }, { id: 'scheduling', label: 'Scheduling' }, { id: 'priority', label: 'Priority' }, { id: 'notifications', label: 'Notifications' }, { id: 'phone', label: 'Phone' },
  { id: 'terms', label: 'Terms' }, { id: 'google', label: 'Google' }, { id: 'backups', label: 'Backups' },
];

export function Settings() {
  const { version } = useApp();
  const [tab, setTab] = useState<Tab>(() => { const w = window as unknown as { __settingsTab?: Tab }; const t = w.__settingsTab; w.__settingsTab = undefined; return t ?? 'general'; });
  // a banner or notification can send us straight to the Google tab while Settings is already open
  useEffect(() => { const f = () => { const w = window as unknown as { __settingsTab?: Tab }; if (w.__settingsTab) { setTab(w.__settingsTab); w.__settingsTab = undefined; } }; window.addEventListener('planner:settings-tab', f); return () => window.removeEventListener('planner:settings-tab', f); }, []);
  const [s, setS] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.settings().then((v) => { setS(v); setError(null); }).catch((e) => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load, version]);

  return (
    <div className="settings">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Settings</h2>
        <div role="tablist" aria-label="Settings sections" className="seg">
          {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'primary' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
      </div>
      {error && <div className="note error" role="alert">{error}</div>}
      {!s && !error && <p className="muted">Loading…</p>}
      {s && tab === 'general' && <General s={s} onChange={setS} />}
      {s && tab === 'scheduling' && <Items title="Scheduling" intro="How the scheduler places work. These are the same settings as `config set` in the terminal." items={s.scheduling} advanced={s.advanced} onChange={setS} />}
      {s && tab === 'priority' && (
        <>
          <Items title="Priority (High grade impact, due soon, quick wins)" intro={s.formula} items={s.priority} onChange={setS} />
        </>
      )}
      {s && tab === 'notifications' && <Notifications s={s} onChange={setS} />}
      {tab === 'phone' && <PhoneCapture />}
      {tab === 'terms' && <Terms />}
      {s && tab === 'google' && <Google s={s} />}
      {s && tab === 'backups' && <Backups s={s} onChange={setS} />}
    </div>
  );
}

function useSave(onChange: (s: SettingsView) => void) {
  const { toast, changed } = useApp();
  return async (key: string, value: string, label: string): Promise<string | null> => {
    try { onChange(await api.setSetting(key, value)); toast(`Saved ${label}.`); changed(); return null; }
    catch (e) { return errText(e); }
  };
}

function General({ s, onChange }: { s: SettingsView; onChange: (s: SettingsView) => void }) {
  const save = useSave(onChange);
  const [tz, setTz] = useState(s.general.timezone);
  const [due, setDue] = useState(s.general.defaultDueTime);
  const [tzErr, setTzErr] = useState<string | null>(null);
  const [dueErr, setDueErr] = useState<string | null>(null);
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return (
    <section className="panelbox" aria-label="General">
      <h3>General</h3>
      <div className="setrow">
        <label htmlFor="set-tz">Time zone</label>
        <div>
          <input id="set-tz" list="tzlist" value={tz} onChange={(e) => setTz(e.target.value)} size={28} />
          <datalist id="tzlist">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          <button disabled={tz === s.general.timezone} onClick={async () => setTzErr(await save('timezone', tz, 'time zone'))}>Save</button>
          {tzErr && <div className="note error" role="alert">{tzErr}</div>}
          <p className="hint">An IANA name such as America/Detroit. Stored times are UTC, so nothing is lost; your availability windows and “9:00” style times are wall-clock times in this zone, so they move with it.</p>
        </div>
      </div>
      <div className="setrow">
        <label htmlFor="set-due">Default due time</label>
        <div>
          <input id="set-due" value={due} onChange={(e) => setDue(e.target.value)} size={8} placeholder="23:59" />
          <button disabled={due === s.general.defaultDueTime} onClick={async () => setDueErr(await save('default_due_time', due, 'default due time'))}>Save</button>
          {dueErr && <div className="note error" role="alert">{dueErr}</div>}
          <p className="hint">Used when a due date has no time (those show a * ). It does not change tasks you already have.</p>
        </div>
      </div>
      <Appearance s={s} onChange={onChange} />
      <Shortcut s={s} onChange={onChange} />
      <MenuBarIcon s={s} onChange={onChange} />
      <ClaudeConnector s={s} onChange={onChange} />
      <p className="hint">Closing the window hides it to the menu-bar icon, so the shortcut, timer and notifications keep working. To quit completely, use the icon's menu, “Quit Tally” (or Cmd+Q).</p>
      <p className="hint">Database: {s.dbFile}{s.demo ? ' (demo)' : ''}</p>
    </section>
  );
}

function ClaudeConnector({ s, onChange }: { s: SettingsView; onChange: (s: SettingsView) => void }) {
  const { toast, changed } = useApp();
  const [err, setErr] = useState<string | null>(null);
  async function undo(id: number) {
    try { onChange(await api.undoChange(id)); setErr(null); toast(`Undid change #${id}.`); changed(); } catch (e) { setErr(errText(e)); }
  }
  const { writes, deletes, schedule, changes, calls } = s.claude;
  const state = (i: { value: string }) => (i.value === 'true' ? 'on' : 'off');
  return (
    <div aria-label="Claude connector" data-section="claude">
      <h4>Claude connector</h4>
      <p className="hint">A separate local program that Claude starts (see docs/MCP.md). It holds no keys and never talks to Google. Reading is always allowed; these three switches are all <strong>off</strong> until you turn them on.</p>
      <ItemRow item={writes} onChange={onChange} />
      <ItemRow item={deletes} onChange={onChange} />
      <ItemRow item={schedule} onChange={onChange} />
      <p className="hint">Right now: change tasks <strong>{state(writes)}</strong> · delete tasks <strong>{state(deletes)}</strong> · apply schedules <strong>{state(schedule)}</strong> (always with your approval on the Schedule screen).</p>
      {err && <div className="note error" role="alert">{err}</div>}
      <h5>Recent changes</h5>
      {changes.length === 0 && <p className="muted">Nothing yet.</p>}
      {changes.length > 0 && (
        <ul className="changelog" data-testid="changelog">
          {changes.map((c) => (
            <li key={c.id}>
              <span className="muted">#{c.id} · {new Date(c.at).toLocaleString()} · {c.actor}</span> {c.summary}
              {c.undone ? <em className="muted"> (undone)</em> : <button onClick={() => void undo(c.id)}>Undo</button>}
            </li>
          ))}
        </ul>
      )}
      <h5>What Claude did (last {calls.length ? calls.length : 50} calls)</h5>
      {calls.length === 0 && <p className="muted">No calls yet.</p>}
      {calls.length > 0 && (
        <ul className="calllog" data-testid="calllog">
          {calls.map((c) => (
            <li key={c.id} className={c.ok ? '' : 'bad'}>
              <span className="muted">{new Date(c.at).toLocaleTimeString()}</span> <code>{c.tool}</code> <span className={c.ok ? 'okmark' : 'badmark'}>{c.ok ? 'ok' : 'refused / failed'}</span> <span className="muted">{c.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Items({ title, intro, items, advanced, onChange }: { title: string; intro: string; items: SettingItem[]; advanced?: SettingItem[]; onChange: (s: SettingsView) => void }) {
  return (
    <section className="panelbox" aria-label={title}>
      <h3>{title}</h3>
      <p className="hint">{intro}</p>
      {items.map((i) => <ItemRow key={i.key} item={i} onChange={onChange} />)}
      {advanced && advanced.length > 0 && <details><summary>Advanced ({advanced.length})</summary>{advanced.map((i) => <ItemRow key={i.key} item={i} onChange={onChange} />)}</details>}
    </section>
  );
}

function ItemRow({ item, onChange }: { item: SettingItem; onChange: (s: SettingsView) => void }) {
  const { toast, changed } = useApp();
  const [val, setVal] = useState(item.value);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setVal(item.value), [item.value]);
  async function save(v: string) {
    try { onChange(await api.setSetting(item.key, v)); setErr(null); toast(`Saved ${item.label}.`); changed(); }
    catch (e) { setErr(errText(e)); }
  }
  async function reset() {
    try { onChange(await api.resetSetting(item.key)); setErr(null); toast(`${item.label} is back to its default.`); changed(); }
    catch (e) { setErr(errText(e)); }
  }
  const id = `set-${item.key}`;
  return (
    <div className="setrow" data-key={item.key}>
      <label htmlFor={id}>{item.label}{item.unit ? <span className="muted"> ({item.unit})</span> : null}</label>
      <div>
        {item.kind === 'choice' ? (
          <select id={id} value={val} onChange={(e) => { setVal(e.target.value); void save(e.target.value); }}>{item.options!.map((o) => <option key={o}>{o}</option>)}</select>
        ) : item.kind === 'bool' ? (
          <input id={id} type="checkbox" checked={val === 'true'} onChange={(e) => { const v = String(e.target.checked); setVal(v); void save(v); }} />
        ) : (
          <>
            <input id={id} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && val !== item.value && void save(val)} size={8} inputMode="decimal" />
            <button disabled={val === item.value} onClick={() => save(val)}>Save</button>
          </>
        )}
        {item.custom ? <button className="link" onClick={reset} title={`Default: ${item.default}`}>Reset to default ({item.default})</button> : <span className="muted"> default</span>}
        {err && <div className="note error" role="alert">{err}</div>}
        <p className="hint">{item.help}</p>
      </div>
    </div>
  );
}

function Terms() {
  const { toast, changed, version, info } = useApp();
  const [rows, setRows] = useState<TermRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [makeCurrent, setMakeCurrent] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [browse, setBrowse] = useState<ArchivedTerm | null>(null);
  const load = useCallback(() => api.terms().then(setRows).catch((e) => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load, version]);
  const run = (p: Promise<TermRow[]>, msg: string) => p.then((r) => { setRows(r); setError(null); toast(msg); changed(); }).catch((e) => setError(errText(e)));

  if (browse) return <ArchivedBrowser data={browse} onBack={() => setBrowse(null)} />;
  const live = rows.filter((r) => !r.archived);
  const archived = rows.filter((r) => r.archived);
  return (
    <section className="panelbox" aria-label="Terms">
      <h3>Terms</h3>
      <p className="hint">A term groups a semester's tasks. Archiving hides a term from views, search and the scheduler without deleting anything.{info.demo ? '' : ''}</p>
      {error && <div className="note error" role="alert">{error}</div>}
      <table className="terms"><thead><tr><th>Term</th><th>Dates</th><th>Tasks</th><th /></tr></thead>
        <tbody>
          {live.map((t) => (
            <tr key={t.id} data-term={t.name}>
              <td><strong>{t.name}</strong> {t.current && <span className="chip">current</span>}</td>
              <td className="muted">{t.start} to {t.end}</td>
              <td className="muted">{t.open} open · {t.done} done</td>
              <td className="acts">
                {!t.current && <button onClick={() => run(api.switchTerm(t.name), `${t.name} is now the current term.`)}>Make current</button>}
                {confirmArchive === t.name ? (
                  <>
                    <span className="muted">Hide “{t.name}”? Nothing is deleted.</span>
                    <button className="primary" onClick={() => { setConfirmArchive(null); void run(api.archiveTerm(t.name), `Archived ${t.name}.`); }}>Yes, archive</button>
                    <button onClick={() => setConfirmArchive(null)}>Cancel</button>
                  </>
                ) : <button onClick={() => setConfirmArchive(t.name)}>Archive</button>}
              </td>
            </tr>
          ))}
          {live.length === 0 && <tr><td colSpan={4} className="muted">No terms yet.</td></tr>}
        </tbody>
      </table>

      <form className="newterm" onSubmit={(e) => { e.preventDefault(); void run(api.createTerm(name, start, end, makeCurrent), `Created ${name}.`).then(() => { setName(''); setStart(''); setEnd(''); }); }}>
        <h4>New term</h4>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Winter 2027" aria-label="Term name" size={22} />
        <label>Starts <input type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start date" /></label>
        <label>Ends <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End date" /></label>
        <label className="toggle"><input type="checkbox" checked={makeCurrent} onChange={(e) => setMakeCurrent(e.target.checked)} /> Make it current</label>
        <button type="submit" className="primary" disabled={!name.trim() || !start || !end}>Create term</button>
      </form>

      <h4>Archived terms</h4>
      {archived.length === 0 ? <p className="muted">None. Archived terms appear here; you can browse them (read-only) or bring them back.</p> : (
        <table className="terms" aria-label="Archived terms"><tbody>
          {archived.map((t) => (
            <tr key={t.id} data-term={t.name}>
              <td><strong>{t.name}</strong> <span className="chip">archived</span></td>
              <td className="muted">{t.start} to {t.end}</td>
              <td className="muted">{t.open} open · {t.done} done</td>
              <td className="acts">
                <button onClick={() => api.archivedTerm(t.id).then(setBrowse).catch((e) => setError(errText(e)))}>Browse</button>
                <button onClick={() => run(api.unarchiveTerm(t.name), `Unarchived ${t.name}.`)}>Unarchive</button>
              </td>
            </tr>
          ))}
        </tbody></table>
      )}
    </section>
  );
}

function ArchivedBrowser({ data, onBack }: { data: ArchivedTerm; onBack: () => void }) {
  const open = data.tasks.filter((t) => t.status !== 'done');
  const done = data.tasks.filter((t) => t.status === 'done');
  const group = (title: string, ts: typeof data.tasks) => ts.length > 0 && (
    <section><h4>{title} ({ts.length})</h4>
      <ul className="rows">{ts.map((t) => (
        <li key={t.id} className="row readonly">
          <span className="grow">{t.title}</span>
          {t.course && <span className="chip">{t.course}</span>}
          <span className="muted rowdue">{t.due ? `${t.dueText}${t.timeAssumed ? ' *' : ''}` : ''}</span>
          <span className="muted">{[t.type, t.gradeWeight != null ? `${t.gradeWeight}%` : null, t.estimate ? fmtMinutes(t.estimate) : null].filter(Boolean).join(' · ')}</span>
        </li>
      ))}</ul>
    </section>
  );
  return (
    <section className="panelbox" aria-label={`Archived term ${data.term.name}`} data-testid="archived-browser">
      <div className="toolbar"><button onClick={onBack}>← Back to terms</button><h3 style={{ margin: 0 }}>{data.term.name}</h3><span className="chip">archived · read-only</span><span className="muted">{data.term.start} to {data.term.end}</span></div>
      <p className="hint">You are looking at a snapshot. Nothing here can be changed; unarchive the term to work with it again.</p>
      {data.tasks.length === 0 && <p className="muted">This term has no tasks.</p>}
      {group('Open', open)}
      {group('Done', done)}
    </section>
  );
}

function Google({ s }: { s: SettingsView }) {
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const { version } = useApp();
  useEffect(() => { api.googleStatus().then(setG).catch((e) => setError(errText(e))); }, [version]);
  const run = async (what: string, p: Promise<GoogleStatus>) => { setBusy(what); setError(null); try { setG(await p); } catch (e) { setError(errText(e)); } finally { setBusy(null); } };
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const needs = !!g?.needsReconnect;
  async function setStatus(v: string) { try { await api.setSetting('google_publish_status', v); setG(await api.googleStatus()); } catch (e) { setError(errText(e)); } }
  return (
    <section className="panelbox" aria-label="Google">
      <h3>Google Calendar</h3>
      <p className="hint">The app reads free/busy times from your calendars and writes ONLY to the “Planner Blocks” calendar it creates. The sign-in is stored in your OS keychain, never in a file.</p>
      {error && <div className="note error" role="alert">{error}</div>}
      {g && (
        <div className={`note ${g.connected && !g.problem ? 'ok' : g.problem ? 'error' : ''}`} data-testid="google-status" role={g.problem ? 'alert' : undefined}>
          <strong>{g.problem ? (g.problem.kind === 'client' ? 'Sign-in problem' : 'Sign-in expired') : g.connected ? 'Connected' : 'Not connected'}</strong>: {g.message}
          {g.clientFile && <div className="hint">Client file: {g.clientFile} ({g.clientFileFound ? 'found' : 'missing'})</div>}
        </div>
      )}
      {g && !g.demo && (
        <div className="hint" data-testid="google-age">
          {g.tokenAge ? <>This sign-in was made {when(g.tokenAge.connectedAt)} (<strong>{g.tokenAge.days < 1 ? 'less than a day' : `${g.tokenAge.days} day${g.tokenAge.days === 1 ? '' : 's'}`} old</strong>).</> : <>The age of this sign-in is not known (it was made before Tally kept track). Reconnect once and it will be tracked.</>}
          {g.testingNote && (
            <div className={`note ${g.testingNote.close ? 'warnbox' : ''}`} data-testid="google-testing-note" role="status">
              {g.testingNote.daysLeft <= 0
                ? <>Your Google project is in <strong>Testing</strong> mode and this sign-in has reached Google’s 7-day limit: it can stop working at any moment.</>
                : <>Your Google project is in <strong>Testing</strong> mode, so Google expires this sign-in after 7 days: about <strong>{when(g.testingNote.expiresAt)}</strong> ({g.testingNote.daysLeft} day{g.testingNote.daysLeft === 1 ? '' : 's'} left).{g.testingNote.close ? ' That is close.' : ''}</>}{' '}
              Moving the project to “In production” ends the weekly expiry: see docs/GOOGLE_PRODUCTION.md.
            </div>
          )}
        </div>
      )}
      <div className="toolbar">
        {needs ? <ReconnectButton onDone={() => api.googleStatus().then(setG)} testId="google-reconnect" /> : (
          <button className="primary" disabled={!!busy || !g || g.demo || !g.clientFileFound} onClick={() => run('connect', api.googleConnect())} data-testid="google-connect">{busy === 'connect' ? 'Waiting for Google sign-in in your browser…' : g?.connected ? 'Reconnect' : 'Connect'}</button>
        )}
        <button disabled={!!busy || !g || g.demo} onClick={() => run('check', api.googleCheck())}>{busy === 'check' ? 'Checking…' : 'Check connection'}</button>
        {confirmOff ? (
          <>
            <span className="muted">Remove the saved sign-in?</span>
            <button className="primary" onClick={() => { setConfirmOff(false); void run('off', api.googleDisconnect()); }}>Yes, disconnect</button>
            <button onClick={() => setConfirmOff(false)}>Cancel</button>
          </>
        ) : <button disabled={!!busy || !g || g.demo || !g.connected} onClick={() => setConfirmOff(true)}>Disconnect</button>}
      </div>
      {g && !g.demo && (
        <div className="setrow" data-key="google_publish_status">
          <label htmlFor="set-google-publish">My Google Cloud project is</label>
          <div>
            <select id="set-google-publish" value={g.publish?.status ?? 'unknown'} onChange={(e) => void setStatus(e.target.value)}>
              <option value="unknown">Not sure</option>
              <option value="testing">In testing (sign-ins expire after 7 days)</option>
              <option value="production">In production (no weekly expiry)</option>
            </select>
            <p className="hint">{g.publish?.source === 'detected' ? 'Detected from how the sign-in behaved. ' : ''}Only used to show the 7-day countdown above. After you publish the project (docs/GOOGLE_PRODUCTION.md), choose “In production” and Reconnect once.</p>
          </div>
        </div>
      )}
      <p className="hint">Class calendars: {s.calendars.classIds.length ? s.calendars.classIds.join(', ') : '(not set)'} · Busy calendars: {s.calendars.busyIds ? s.calendars.busyIds.join(', ') : 'all except Planner Blocks'}. Change them with <code>config set class_calendars</code> / <code>busy_calendars</code> in the terminal.</p>
    </section>
  );
}

function Backups({ s, onChange }: { s: SettingsView; onChange: (s: SettingsView) => void }) {
  const { toast, changed, version } = useApp();
  const [b, setB] = useState<BackupsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState(s.backupFolder);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const load = useCallback(() => api.backups().then(setB).catch((e) => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => setFolder(s.backupFolder), [s.backupFolder]);

  async function now() { setBusy(true); setError(null); try { setB(await api.backupNow()); toast('Backup saved and verified.'); } catch (e) { setError(errText(e)); } finally { setBusy(false); } }
  async function saveFolder() { try { onChange(await api.setSetting('backup_folder', folder)); setError(null); toast('Backup folder saved.'); changed(); } catch (e) { setError(errText(e)); } }
  async function resetFolder() { try { onChange(await api.resetSetting('backup_folder')); setError(null); toast('Backup folder is back to the default.'); changed(); } catch (e) { setError(errText(e)); } }
  async function restore() {
    if (!restoring) return;
    setBusy(true); setRestoreError(null);
    try {
      const r = await api.restoreBackup(restoring, typed);
      setRestoring(null); setTyped(''); toast(r.message); changed();
    } catch (e) { setRestoreError(errText(e)); }
    finally { setBusy(false); }
  }
  const age = (h: number) => (h < 1 ? 'just now' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`);
  return (
    <section className="panelbox" aria-label="Backups">
      <h3>Backups</h3>
      <p className="hint">A verified backup is made automatically once a day (the newest 14 are kept), before any database upgrade, and right after an import. Point the folder at a cloud-synced folder so a lost laptop does not lose your tasks.</p>
      {error && <div className="note error" role="alert">{error}</div>}
      <div className="setrow">
        <label htmlFor="bk-folder">Backup folder</label>
        <div>
          <input id="bk-folder" value={folder} onChange={(e) => setFolder(e.target.value)} size={60} />
          <button disabled={folder === s.backupFolder} onClick={saveFolder}>Save</button>
          {!s.backupFolderIsDefault && <button className="link" onClick={resetFolder}>Reset to default</button>}
          <p className="hint">{s.backupFolderIsDefault ? 'This is the default folder (next to the database). ' : ''}It is created if it does not exist.</p>
        </div>
      </div>
      <div className="toolbar"><button className="primary" onClick={now} disabled={busy}>{busy && !restoring ? 'Backing up…' : 'Back up now'}</button><span className="muted">{b ? (b.backups.length ? `${b.backups.length} backup(s); newest ${age(b.backups[0].ageHours)}` : 'No backups yet.') : ''}</span></div>
      {b && b.backups.length > 0 && (
        <table className="terms" aria-label="Backups"><thead><tr><th>Backup</th><th>Taken</th><th>Size</th><th /></tr></thead><tbody>
          {b.backups.map((x) => (
            <tr key={x.name} data-backup={x.name}>
              <td><code>{x.name}</code></td>
              <td className="muted">{new Date(x.takenAt).toLocaleString()} ({age(x.ageHours)})</td>
              <td className="muted">{x.bytes >= 1_048_576 ? `${(x.bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(x.bytes / 1024))} KB`}</td>
              <td className="acts"><button onClick={() => { setRestoring(x.name); setTyped(''); setRestoreError(null); }}>Restore…</button></td>
            </tr>
          ))}
        </tbody></table>
      )}

      {restoring && (
        <div className="modal-back" role="presentation" onKeyDown={(e) => e.key === 'Escape' && !busy && setRestoring(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rs-title">
            <h3 id="rs-title">Restore from backup?</h3>
            <p>This replaces ALL current data with <code>{restoring}</code>. Anything you added or changed since that backup will be gone from the app.</p>
            <p className="hint">Your current data is saved first as a <code>pre-restore-…</code> file in the same folder, and the backup is integrity-checked before anything changes.</p>
            <label>Type <strong>restore</strong> to confirm <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type restore to confirm" autoFocus /></label>
            {restoreError && <div className="note error" role="alert">{restoreError}</div>}
            <div className="modal-actions">
              <button onClick={() => setRestoring(null)} disabled={busy}>Cancel</button>
              <button className="primary" onClick={restore} disabled={busy || typed !== 'restore'}>{busy ? 'Restoring…' : 'Restore'}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Shortcut({ s, onChange }: { s: SettingsView; onChange: (s: SettingsView) => void }) {
  const { toast } = useApp();
  const [text, setText] = useState(s.general.quickAddShortcut);
  const [recording, setRecording] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(s.general.quickAddShortcut), [s.general.quickAddShortcut]);
  useEffect(() => {
    if (!recording) return;
    const isMac = /Mac/i.test(navigator.platform);
    const key = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation(); // keep the app's own shortcuts (Cmd+K ...) from firing while recording
      if (e.key === 'Escape') { setRecording(false); return; }
      const a = accelFromEvent(e, isMac);
      if (a) { setText(a); setRecording(false); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [recording]);
  async function save(v: string) {
    try {
      const next = await api.setSetting('quick_add_shortcut', v);
      onChange(next); setErr(null);
      const now = next.general.quickAddShortcut; // the normalized form, e.g. "ctrl+alt+k" -> "Control+Alt+K"
      toast(now ? `Quick-add shortcut is now ${now}.` : 'Quick-add shortcut turned off.');
    } catch (e) { setErr(errText(e)); }
  }
  async function reset() {
    try { onChange(await api.resetSetting('quick_add_shortcut')); setErr(null); toast('Quick-add shortcut is back to its default.'); } catch (e) { setErr(errText(e)); }
  }
  const g = s.general;
  return (
    <div className="setrow" data-key="quick_add_shortcut">
      <label htmlFor="set-qs">Quick-add shortcut</label>
      <div>
        <input id="set-qs" value={recording ? 'Press the shortcut…' : text} readOnly={recording} onChange={(e) => setText(e.target.value)} size={28} placeholder="(off)" />
        <button onClick={() => setRecording(!recording)} aria-pressed={recording}>{recording ? 'Cancel' : 'Record'}</button>
        <button disabled={text === g.quickAddShortcut} onClick={() => save(text)}>Save</button>
        {g.quickAddShortcut !== '' && <button className="link" onClick={() => save('')}>Turn off</button>}
        {g.quickAddShortcut !== g.quickAddShortcutDefault && <button className="link" onClick={reset}>Reset to default ({g.quickAddShortcutDefault})</button>}
        {err && <div className="note error" role="alert">{err}</div>}
        {g.quickAddShortcut && g.quickAddShortcutActive === false && <div className="note error" role="alert">This shortcut is not active: another app or the system is using it. Pick a different one.</div>}
        <p className="hint">Opens a small quick-add window from any app. Click Record, then press the keys (it needs Command/Control/Alt). {g.quickAddShortcut ? (g.quickAddShortcutActive ? 'Active now.' : '') : 'Currently off.'}</p>
      </div>
    </div>
  );
}

const OUTCOME: Record<RecentNotice['outcome'], string> = {
  pending: 'waiting for the system to report…',
  shown: 'the system reported it shown',
  failed: 'the system reported a FAILURE',
  unsupported: 'this system does not support desktop notifications',
  'no-event': 'the system never reported it shown (it was probably dropped)',
  error: 'showing it raised an ERROR',
  'app-only': 'in-app banners only (the system was not asked)',
};
const eventText = (r: RecentNotice) => (r.events.length ? r.events.map((e) => `${e.event}${e.detail ? ` (${e.detail})` : ''} +${e.ms} ms`).join(', ') : 'none');

function Diagnostics({ r }: { r: RecentNotice }) {
  return (
    <ul className="diag" data-testid="notify-diag" data-outcome={r.outcome}>
      <li>Notifications supported by this system: <strong>{r.supported ? 'yes' : 'no'}</strong></li>
      <li>show() called: <strong>{r.showCalled ? 'yes' : 'no'}</strong></li>
      <li>Events reported by the system: <strong>{eventText(r)}</strong></li>
      {r.error && <li>Error: <strong>{r.error}</strong></li>}
      <li>Result: <strong>{r.reason ?? OUTCOME[r.outcome]}</strong></li>
      <li>In-app banner: <strong>{r.banner ? 'shown (fallback)' : 'not needed'}</strong></li>
    </ul>
  );
}

function Notifications({ s, onChange }: { s: SettingsView; onChange: (s: SettingsView) => void }) {
  const { version } = useApp();
  const [recent, setRecent] = useState<RecentNotice[]>([]);
  const [last, setLast] = useState<RecentNotice | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.recentNotifications().then((r) => { setRecent(r); setLast((cur) => (cur ? r.find((x) => x.id === cur.id) ?? cur : cur)); }).catch((e) => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => { const t = setInterval(() => void load(), 3000); return () => clearInterval(t); }, [load]);
  async function test() {
    setBusy(true); setError(null); setMsg(null);
    try { const r = await api.testNotification(); setLast(r); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  async function check() {
    setBusy(true); setError(null);
    try { const r = await api.checkNotifications(); setMsg(r.length ? `Announced ${r.length} notification${r.length === 1 ? '' : 's'}.` : 'Nothing new to announce right now.'); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return (
    <section className="panelbox" aria-label="Notifications">
      <h3>Notifications</h3>
      <p className="hint">Desktop notifications while the app is running. Each kind has its own switch. Nothing is announced twice, and never for a done task. The Due soon window comes from the Priority tab.</p>
      {s.notifications.map((i) => <ItemRow key={i.key} item={i} onChange={onChange} />)}
      <div className="note" data-testid="notify-explain">
        <strong>Why you may not see macOS notifications yet.</strong> While the app runs unpackaged (<code>npm run dev</code>) it is just “Electron” to macOS, which does not list it under System Settings, Notifications, so macOS can drop its notifications without any error. The <strong>packaged app</strong> has its own name and identity and registers with macOS, so it appears there and its notifications are delivered. Until then, when macOS does not deliver a notification the app shows an <strong>in-app banner</strong> instead (choose “app” above to use banners only).
      </div>
      <div className="toolbar" style={{ marginTop: 10 }}>
        <button className="primary" onClick={test} disabled={busy}>Send test notification</button>
        <button onClick={check} disabled={busy} title="Runs the same check the app runs every 30 seconds">Check now</button>
        {msg && <span role="status" data-testid="notify-msg" className="muted">{msg}</span>}
      </div>
      {error && <div className="note error" role="alert">{error}</div>}
      {last && <><h4>What happened to the test</h4><Diagnostics r={last} /></>}
      <h4>Sent in this session</h4>
      {recent.length === 0 ? <p className="muted">Nothing yet.</p> : (
        <ul className="rows" data-testid="notify-recent">
          {recent.map((n) => <li key={n.id} className="row readonly"><span className="muted" style={{ minWidth: 80 }}>{time(n.at)}</span><span className="chip">{n.kind}</span><span className="grow"><strong>{n.title}</strong><br /><span className="muted">{n.body}</span><br /><span className="muted">{n.reason ?? OUTCOME[n.outcome]}{n.banner ? ' · in-app banner shown' : ''}</span></span></li>)}
        </ul>
      )}
    </section>
  );
}

function MenuBarIcon({ s, onChange }: { s: SettingsView; onChange: (s: SettingsView) => void }) {
  const { toast } = useApp();
  const [info, setInfo] = useState<TrayInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api.trayInfo().then(setInfo).catch((e) => setErr(errText(e))), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 4000); return () => clearInterval(t); }, [load]);
  async function setMode(v: string) {
    try { onChange(await api.setSetting('tray_text', v)); setErr(null); toast('Menu bar text saved.'); void load(); } catch (e) { setErr(errText(e)); }
  }
  return (
    <div className="setrow" data-key="tray_text">
      <label htmlFor="set-tray">Menu bar icon</label>
      <div data-testid="tray-info">
        <label className="muted">Text next to the icon:{' '}
          <select id="set-tray" value={s.general.trayText} onChange={(e) => void setMode(e.target.value)}>
            <option value="full">task and time</option><option value="elapsed">time only (narrow)</option><option value="none">none (icon only)</option>
          </select>
        </label>
        {err && <div className="note error" role="alert">{err}</div>}
        {info && !info.created && <div className="note" role="status" data-testid="tray-missing">The menu-bar icon was not created in this run. See planner-debug.log in the app data folder.</div>}
        {info?.created && (
          <ul className="diag">
            <li>Icon image: <strong>{info.imageEmpty ? 'EMPTY' : `valid, ${info.size?.width}×${info.size?.height} pt @${info.scaleFactors?.join('/')}x, ${info.visiblePixels} visible pixels${info.template ? ', template' : ''}`}</strong></li>
            <li>Text shown: <strong>{info.title ? `“${info.title}”` : '(none)'}</strong></li>
            <li>macOS placed it at: <strong>{info.placed ? `x ${Math.round(info.bounds!.x)}, y ${Math.round(info.bounds!.y)}, ${Math.round(info.bounds!.width)}×${Math.round(info.bounds!.height)} (screen ${info.screenWidth} wide)` : 'nowhere yet (empty rectangle)'}</strong></li>
          </ul>
        )}
        {info?.created && info.likelyHidden && (
          <div className="note warnbox" role="status" data-testid="tray-hidden-warning">
            <strong>The icon is probably hidden.</strong> Menu-bar icons fill from the right, and this one was placed in the middle of the bar ({Math.round(info.bounds!.x)} of {info.screenWidth}), which on a MacBook with a notch is under the notch or among the app menus. macOS shows it nowhere. Make room by quitting or hiding a few other menu-bar icons (System Settings, Menu Bar, “Allow in the Menu Bar”), or choose “time only” or “none” above to make it narrower. Either way the <strong>Dock icon</strong> shows the running minutes as a badge and has the same menu (right-click it).
          </div>
        )}
        <p className="hint">The menu-bar icon shows the running timer, with Start/Stop, Quick add, Open Tally and Quit. If it cannot be seen, the Dock icon is the fallback.</p>
      </div>
    </div>
  );
}

function Appearance({ s, onChange }: { s: SettingsView; onChange: (s: SettingsView) => void }) {
  const { toast } = useApp();
  const [err, setErr] = useState<string | null>(null);
  async function set(v: string) {
    try { onChange(await api.setSetting('theme', v)); setErr(null); toast(v === 'system' ? 'Appearance follows the system.' : `Appearance: ${v}.`); } catch (e) { setErr(errText(e)); }
  }
  return (
    <div className="setrow" data-key="theme">
      <label htmlFor="set-theme">Appearance</label>
      <div>
        <select id="set-theme" value={s.general.theme} onChange={(e) => void set(e.target.value)}>
          <option value="system">Match the system</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
        {err && <div className="note error" role="alert">{err}</div>}
        <p className="hint">Light and dark themes in Michigan Blue and Maize. “Match the system” follows macOS (System Settings, Appearance).</p>
      </div>
    </div>
  );
}
