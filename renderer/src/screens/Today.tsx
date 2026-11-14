import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errText, useApp } from '../ctx';
import { QuickAdd } from '../components/QuickAdd';
import { TaskCard } from '../components/TaskCard';
import { InboxPanel } from '../components/Inbox';
import { Icon } from '../ui';
import type { ListInfo, ViewItemDto, ViewsResult } from '../../../src/app/types';

const elapsed = (iso: string, now: number) => {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function Today({ quickRef }: { quickRef: React.RefObject<HTMLInputElement | null> }) {
  const { version, toast, changed } = useApp();
  const [views, setViews] = useState<ViewsResult | null>(null);
  const [lists, setLists] = useState<ListInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);

  const load = useCallback(() => {
    Promise.all([api.views(), api.lists()]).then(([v, l]) => { if (alive.current) { setViews(v); setLists(l); setError(null); } }).catch((e) => setError(errText(e)));
  }, []);
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, [load, version]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const setTimers = (timers: ViewsResult['timers']) => setViews((v) => (v ? { ...v, timers } : v));
  const panel = (title: string, sub: string, items: ViewItemDto[], empty: string, icon: React.ReactNode) => (
    <section className="panel" aria-label={title}>
      <div className="panel-head">
        <span className="icon">{icon}</span>
        <h2>{title} <span className={`count ${items.length ? '' : 'zero'}`} aria-label={`${items.length} task${items.length === 1 ? '' : 's'}`}>{items.length}</span></h2>
      </div>
      <p className="sub">{sub}</p>
      {items.length === 0 ? <p className="empty">{Icon.check(14)}{empty}</p> : (
        <ul className="cards">{items.map((i) => <TaskCard key={i.task.id} task={i.task} reason={i.reason} timers={views!.timers} onTimer={setTimers} />)}</ul>
      )}
    </section>
  );
  const today = new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="today-screen">
      <header className="page-head"><h1>Today</h1><span className="date">{today}</span></header>
      <QuickAdd ref={quickRef} lists={lists.map((l) => l.name)} />
      {error && <div className="note error" role="alert">{error}</div>}
      {views?.timers.map((t) => (
        <div key={t.sessionId} className="timerbar" role="status">
          <span className="live" aria-hidden="true" /><span className="label">Timing</span><span className="what">{t.title}</span><span className="clock">{elapsed(t.startedAt, now)}</span>
          <button onClick={() => api.timerStop().then((r) => { setTimers(r.timers); toast(`Logged ${r.stopped[0]?.minutes ?? 0} min (total ${r.stopped[0]?.total ?? 0})`); changed(); }).catch((e) => toast(errText(e)))}>Stop</button>
        </div>
      ))}
      <InboxPanel />
      {!views ? <p className="muted">Loading…</p> : (
        <div className="panels">
          {panel('Due soon', `Next ${views.dueSoonHours} hours, plus anything overdue`, views.dueSoon, 'Nothing due soon.', Icon.soon(15))}
          {panel('High grade impact', 'Weight × urgency × effort; overdue excluded', views.highImpact, 'No graded work ahead.', Icon.star(15))}
          {panel('Quick wins', `${views.quickWinMinutes} minutes or less, unblocked`, views.quickWins, 'No quick wins right now.', Icon.bolt(15))}
          {panel('Blocked', 'Waiting on other tasks', views.blocked, 'Nothing is blocked.', Icon.lock(15))}
        </div>
      )}
      <p className="hint">* means no time was given, so the default due time is assumed. Click a title for details.</p>
    </div>
  );
}
