import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Ctx, errText } from './ctx';
import type { AppInfo, BannerDto } from '../../src/app/types';
import { TallyMark, ReconnectButton } from './ui';
import { Availability } from './screens/Availability';
import { Review } from './screens/Review';
import { Rates } from './screens/Rates';
import { Today } from './screens/Today';
import { Lists } from './screens/Lists';
import { Schedule } from './screens/Schedule';
import { Import } from './screens/Import';
import { Settings } from './screens/Settings';
import { TaskDrawer } from './components/TaskDrawer';

type Screen = 'today' | 'lists' | 'schedule' | 'review' | 'rates' | 'availability' | 'import' | 'settings';
const SCREENS: { id: Screen; label: string }[] = [{ id: 'today', label: 'Today' }, { id: 'lists', label: 'Lists' }, { id: 'schedule', label: 'Schedule' }, { id: 'review', label: 'Review' }, { id: 'rates', label: 'Rates' }, { id: 'availability', label: 'Availability' }, { id: 'import', label: 'Import' }, { id: 'settings', label: 'Settings' }];

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>('today');
  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [toastMsg, setToastMsg] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null);
  const quickRef = useRef<HTMLInputElement | null>(null);
  /** open a screen from a notification or banner (the Schedule tab with the pending card, or Settings > Google) */
  const openScreen = useCallback((target: 'schedule' | 'settings-google' | 'today' | 'rates') => {
    if (target === 'settings-google') { (window as unknown as { __settingsTab?: string }).__settingsTab = 'google'; window.dispatchEvent(new Event('planner:settings-tab')); setScreen('settings'); }
    else if (target === 'today') setScreen('today');
    else if (target === 'rates') setScreen('rates');
    else setScreen('schedule');
  }, []);
  useEffect(() => { const f = (e: Event) => openScreen((e as CustomEvent<'schedule' | 'settings-google' | 'today' | 'rates'>).detail); window.addEventListener('planner:open-screen', f); return () => window.removeEventListener('planner:open-screen', f); }, [openScreen]);
  const [banners, setBanners] = useState<BannerDto[]>([]);
  const [claudeWaiting, setClaudeWaiting] = useState(false);
  const [reviewDue, setReviewDue] = useState(false);
  useEffect(() => { const f = () => api.reviewState().then((r) => setReviewDue(r.due)).catch(() => {}); f(); const t = setInterval(f, 60_000); return () => clearInterval(t); }, [version]);

  const load = useCallback(() => api.appInfo().then(setInfo).catch((e) => setError(errText(e))), []);
  useEffect(() => { void load(); }, [load, version]);
  // tasks may have been added from the quick-add window or the menu bar while this window was in the background
  useEffect(() => { const f = () => setVersion((v) => v + 1); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, []);
  // the timer can be started or stopped from the menu-bar icon: notice it without the user touching this window
  useEffect(() => {
    let last: string | null = null;
    let alive = true;
    const poll = () => api.timerStatus().then((t) => {
      const sig = t.map((x) => `${x.sessionId}`).join(',');
      if (alive && last !== null && sig !== last) setVersion((v) => v + 1);
      last = sig;
    }).catch(() => {});
    poll();
    const id = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  // in-app banners: the fallback when the system does not deliver a desktop notification
  useEffect(() => {
    let alive = true;
    const poll = () => api.banners().then((b) => { if (alive) setBanners((cur) => (JSON.stringify(cur) === JSON.stringify(b) ? cur : b)); }).catch(() => {});
    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  // a request from Claude to apply a schedule waits for approval on the Schedule screen: mark the tab
  useEffect(() => {
    let alive = true;
    const poll = () => api.pendingGet().then((p) => { if (alive) setClaudeWaiting(!!p.pending); }).catch(() => {});
    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => { if (!toastMsg) return; const t = setTimeout(() => setToastMsg(null), toastMsg.action ? 10000 : 5000); return () => clearTimeout(t); }, [toastMsg]);
  useEffect(() => {
    const open = (e: Event) => setOpenId((e as CustomEvent<number>).detail);
    window.addEventListener('planner:open-task', open);
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // e.g. the Settings shortcut recorder is capturing this key press
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (screen !== 'today' && screen !== 'lists') setScreen('today'); setTimeout(() => quickRef.current?.focus(), 0); }
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('planner:open-task', open); window.removeEventListener('keydown', key); };
  }, [screen]);

  if (error) return <div className="fatal" role="alert"><h1>Something went wrong</h1><p>{error}</p><button onClick={() => { setError(null); void load(); }}>Try again</button></div>;
  if (!info) return <div className="fatal">Opening your planner…</div>;

  const stale = info.lastBackup ? info.lastBackup.ageHours > 36 : true;
  return (
    <Ctx.Provider value={{ info, version, changed: () => setVersion((v) => v + 1), openTask: setOpenId, toast: (msg, action) => setToastMsg({ msg, action }) }}>
      <div className="app">
        {info.demo && <div className="demo-banner" role="note"><span className="tag">DEMO</span>Demo database: nothing here is your real data</div>}
        <header className="topbar">
          <strong className="brand"><TallyMark />Tally</strong>
          <nav aria-label="Screens">
            {SCREENS.map((s) => <button key={s.id} className={`tab${(s.id === 'schedule' && claudeWaiting) || (s.id === 'review' && reviewDue) ? ' has-pending' : ''}${s.id === 'review' && reviewDue ? ' review-due' : ''}`} title={s.id === 'schedule' && claudeWaiting ? 'Claude is waiting for your approval' : s.id === 'review' && reviewDue ? 'Your weekly review is due' : undefined} aria-current={screen === s.id ? 'page' : undefined} onClick={() => setScreen(s.id)}>{s.label}</button>)}
          </nav>
          <span className="spacer" />
          <label className="term">
            <span>Term</span>
            <select
              value={info.currentTermId ?? ''}
              onChange={(e) => {
                const t = info.terms.find((x) => x.id === Number(e.target.value));
                if (t) api.useTerm(t.name).then((i) => { setInfo(i); setVersion((v) => v + 1); }).catch((err) => setError(errText(err)));
              }}
            >
              {info.currentTermId == null && <option value="">(no current term)</option>}
              {info.terms.filter((t) => !t.archived).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <span className={`backup ${stale ? 'warn' : ''}`} title={info.lastBackup ? `${info.lastBackup.name} in ${info.backupFolder}` : `No backup found in ${info.backupFolder}`}>
            <span className="label">{info.lastBackup ? `Last backup ${info.lastBackup.ageHours < 1 ? 'just now' : info.lastBackup.ageHours < 48 ? `${Math.round(info.lastBackup.ageHours)} h ago` : `${Math.round(info.lastBackup.ageHours / 24)} days ago`}` : 'No backup yet'}</span>
          </span>
        </header>
        {banners.length > 0 && (
          <div className="banners" role="region" aria-label="Notifications">
            {banners.map((b) => (
              <div key={b.id} className="banner" data-kind={b.kind} role="status">
                <span className="chip">{b.kind}</span>
                <span className="grow"><strong>{b.title}</strong> <span className="muted">{b.body}</span></span>
                {b.action === 'reconnect' && <ReconnectButton label="Reconnect" testId="banner-reconnect" onDone={() => void api.dismissBanner(b.id).then(() => setBanners((x) => x.filter((y) => y.id !== b.id)))} />}
                {b.target && <button onClick={() => { openScreen(b.target!); void api.dismissBanner(b.id).then(() => setBanners((x) => x.filter((y) => y.id !== b.id))); }}>{b.target === 'schedule' ? 'Open Schedule' : b.target === 'today' ? 'Open Today' : 'Open Google settings'}</button>}
                {b.taskId != null && <button onClick={() => { setOpenId(b.taskId!); void api.dismissBanner(b.id).then(() => setBanners((x) => x.filter((y) => y.id !== b.id))); }}>Open</button>}
                <button onClick={() => void api.dismissBanner(b.id).then(() => setBanners((x) => x.filter((y) => y.id !== b.id)))} aria-label="Dismiss notification">Dismiss</button>
              </div>
            ))}
          </div>
        )}
        <div className="body">
          <main>
            {screen === 'today' && <Today quickRef={quickRef} />}
            {screen === 'lists' && <Lists quickRef={quickRef} />}
            {screen === 'schedule' && <Schedule />}
            {screen === 'rates' && <Rates />}
            {screen === 'review' && <Review onDone={() => { setReviewDue(false); setVersion((v) => v + 1); }} />}
            {screen === 'availability' && <Availability info={info} />}
            {screen === 'import' && <Import goTo={setScreen} />}
            {screen === 'settings' && <Settings />}
          </main>
          {openId != null && <TaskDrawer key={openId} id={openId} onClose={() => setOpenId(null)} />}
        </div>
        {toastMsg && <div className="toast" role="status">{toastMsg.msg}{toastMsg.action && <button onClick={() => { toastMsg.action!.run(); setToastMsg(null); }}>{toastMsg.action.label}</button>}<button className="link" onClick={() => setToastMsg(null)} aria-label="Dismiss">✕</button></div>}
      </div>
    </Ctx.Provider>
  );
}
