import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../api';
import { ReconnectButton } from '../ui';
import { DateTime } from 'luxon';
import { PinEditor, RefusalNote, placePin, type Refusal } from '../components/PinEditor';
import type { AppInfo, BusyResult, DryRunResult, Target, WeekView, WindowRow } from '../../../src/app/types';
import { ROWS, ROW_MIN, GRID_START, nowTop, label12, rowAt, rowStart, rangeFromRows, isFreeRow, placement, moveCursor, modeFor, type Cursor } from '../gridMath';

const ROW_PX = 22;
interface UndoItem { target: Target; before: WindowRow[]; label: string }
interface Drag { day: number; from: number; to: number; mode: 'paint' | 'erase' }
/** Dragging a Tally block to pin it somewhere else (move), or its bottom edge to change its length (resize). Snaps to 15 minutes. */
interface BlockDrag { mode: 'move' | 'resize'; taskId: number; pinId?: number; title: string; startMs: number; endMs: number; day: number; x0: number; y0: number; dMin: number; dDay: number; moved: boolean }
interface BlockRef { taskId: number; pinId?: number; title: string; startMs: number; endMs: number }
const SNAP = 15;

const fmtDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// the Monday of the week containing a date, as a cache key
const weekKey = (date: string) => { const d = new Date(`${date}T12:00:00Z`); return addDays(date, -((d.getUTCDay() + 6) % 7)); };

export function Availability({ info }: { info: AppInfo }) {
  const [anchor, setAnchor] = useState(info.today);
  const [week, setWeek] = useState<WeekView | null>(null);
  const [busy, setBusy] = useState<BusyResult | null>(null);
  const [proposed, setProposed] = useState<DryRunResult | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [undo, setUndo] = useState<UndoItem[]>([]);
  const [cursor, setCursor] = useState<Cursor>({ day: 0, row: 6 });
  const [sel, setSel] = useState<{ day: number; anchorRow: number; row: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [bdrag, setBdrag] = useState<BlockDrag | null>(null);
  const [refusal, setRefusal] = useState<(Refusal & { target: BlockRef }) | null>(null);
  const [menu, setMenu] = useState<BlockRef | null>(null);
  const [editing, setEditing] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  // the current time, so today's column can show a "now" line (refreshed every minute)
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const busyCache = useRef(new Map<string, BusyResult>()); // per week; Google is slow, so a visited week is not asked again

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const loadWeek = useCallback(async (date: string) => {
    try {
      setWeek(await api.week(date));
    } catch (e) { fail(e); }
  }, []);

  useEffect(() => {
    void loadWeek(anchor);
    const key = weekKey(anchor);
    const cached = busyCache.current.get(key);
    setBusy(cached ?? null);
    if (!cached) {
      let live = true;
      api.busy(anchor).then((r) => { if (!r.error) busyCache.current.set(key, r); if (live) setBusy(r); }).catch((e) => { if (live) setBusy({ busy: {}, error: e.message }); });
      return () => { live = false; };
    }
  }, [anchor, loadWeek]);

  const today = info.today;
  const days = week?.days ?? [];
  const freeHours = useMemo(() => days.reduce((s, d) => s + d.free.reduce((x, f) => x + (f.end - f.start), 0), 0) / 60, [days]);

  async function apply(day: number, from: number, to: number, mode: 'paint' | 'erase') {
    if (!week) return;
    const d = week.days[day];
    const target: Target = repeat ? { weekday: d.weekdayNumber } : { date: d.date };
    const range = rangeFromRows(from, to);
    try {
      const res = await (mode === 'paint' ? api.paint : api.erase)(target, range);
      setUndo((u) => [...u, { target, before: res.before, label: `${mode === 'paint' ? 'Painted' : 'Erased'} ${d.weekday} ${range.start}-${range.end}${repeat ? ' (every week)' : ''}` }]);
      setStatus(`${mode === 'paint' ? 'Painted' : 'Erased'} ${d.weekday} ${label12(rowStart(Math.min(from, to)))} to ${label12(rowStart(Math.max(from, to) + 1))}${repeat ? ', every week' : ''}${res.materialized ? '. This date now has its own windows.' : ''}`);
      setProposed(null);
      await loadWeek(anchor);
    } catch (e) { fail(e); }
  }

  async function doUndo() {
    const last = undo[undo.length - 1];
    if (!last) return;
    try {
      await api.restore(last.target, last.before);
      setUndo((u) => u.slice(0, -1));
      setStatus(`Undid: ${last.label}`);
      setProposed(null);
      await loadWeek(anchor);
    } catch (e) { fail(e); }
  }

  /* pointer drag */
  const colRow = (e: PointerEvent<HTMLDivElement>) => rowAt(e.clientY - e.currentTarget.getBoundingClientRect().top, ROW_PX);
  const onDown = (day: number) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !week) return;
    const row = colRow(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ day, from: row, to: row, mode: modeFor(isFreeRow(week.days[day].free, row)) });
    setCursor({ day, row });
    setSel(null);
    gridRef.current?.focus({ preventScroll: true });
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (drag) setDrag({ ...drag, to: colRow(e) }); };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    void apply(d.day, d.from, d.to, d.mode);
  };

  /* dragging a Tally block: move it (pin it there) or resize it from its bottom edge */
  const tz = info.tz;
  const startBlockDrag = (mode: 'move' | 'resize', day: number, b: BlockRef) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    setRefusal(null);
    setBdrag({ mode, ...b, day, x0: e.clientX, y0: e.clientY, dMin: 0, dDay: 0, moved: false });
  };
  const colAt = (x: number) => {
    const cols = [...(gridRef.current?.querySelectorAll<HTMLElement>('.col') ?? [])];
    const i = cols.findIndex((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });
    return i;
  };
  const dropped = (d: BlockDrag) => {
    const shift = d.dMin * 60_000;
    if (d.mode === 'resize') return { start: d.startMs, end: d.endMs + shift };
    const day = d.dDay * 86_400_000;
    const move = (ms: number) => DateTime.fromMillis(ms, { zone: tz }).plus({ days: d.dDay }).toMillis() + shift;
    return day === 0 ? { start: d.startMs + shift, end: d.endMs + shift } : { start: move(d.startMs), end: move(d.endMs) };
  };
  useEffect(() => {
    if (!bdrag) return;
    const move = (e: globalThis.PointerEvent) => {
      const dy = e.clientY - bdrag.y0;
      const dMin = Math.round((dy / ROW_PX) * ROW_MIN / SNAP) * SNAP;
      const ci = colAt(e.clientX);
      const dDay = bdrag.mode === 'move' && ci >= 0 ? ci - bdrag.day : 0;
      const moved = bdrag.moved || Math.abs(dy) > 4 || Math.abs(e.clientX - bdrag.x0) > 6;
      if (dMin !== bdrag.dMin || dDay !== bdrag.dDay || moved !== bdrag.moved) setBdrag({ ...bdrag, dMin, dDay, moved });
    };
    const up = () => {
      const d = bdrag;
      setBdrag(null);
      if (!d.moved || (d.dMin === 0 && d.dDay === 0)) { setMenu({ taskId: d.taskId, pinId: d.pinId, title: d.title, startMs: d.startMs, endMs: d.endMs }); setEditing(false); return; }
      const n = dropped(d);
      void pinAt({ taskId: d.taskId, pinId: d.pinId, title: d.title, startMs: d.startMs, endMs: d.endMs }, n.start, n.end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', () => setBdrag(null), { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [bdrag]); // eslint-disable-line react-hooks/exhaustive-deps

  const when = (a: number, b: number) => `${DateTime.fromMillis(a, { zone: tz }).toFormat('ccc LLL d, h:mm a')}–${DateTime.fromMillis(b, { zone: tz }).toFormat('h:mm a')}`;
  async function pinAt(target: BlockRef, start: number, end: number) {
    setError(null); setRefusal(null);
    try {
      const r = await placePin(target, new Date(start).toISOString(), new Date(end).toISOString());
      if (!r.ok) { setRefusal({ ...r, target }); setStatus(`Not pinned: ${r.message}`); return; }
      setMenu(null);
      setStatus(`📌 Pinned “${target.title}” at ${when(Date.parse(r.pin.start), Date.parse(r.pin.end))}. Every Schedule and Replan keeps it there; Apply writes it at this time.`);
      await loadWeek(anchor);
      if (proposed) await reschedule();
    } catch (e) { fail(e); }
  }
  async function unpin(b: BlockRef, automatic: boolean) {
    if (!b.pinId) return;
    try {
      await api.pinUnpin(b.pinId);
      setMenu(null);
      await loadWeek(anchor);
      if (automatic) { await reschedule(); setStatus(`“${b.title}” is back to automatic: the dry run shows where the planner puts it now. Apply to update your calendar.`); }
      else setStatus(`Unpinned “${b.title}”. It stays on your calendar where it is until the next Apply, which may move it.`);
    } catch (e) { fail(e); }
  }
  /** the ghost of a block being dragged, in the column it would land in */
  const ghost = (di: number) => {
    if (!bdrag || !bdrag.moved || di !== bdrag.day + bdrag.dDay) return null;
    const n = dropped(bdrag);
    const day = days[di];
    const m = (ms: number) => { const t = DateTime.fromMillis(ms, { zone: tz }); return t.toISODate() === day.date ? t.hour * 60 + t.minute : t.toISODate()! < day.date ? 0 : 1440; };
    const p = placement({ start: m(n.start), end: Math.max(m(n.start) + 5, m(n.end)) }, ROW_PX);
    return p && <div className="ev ghost" style={p} aria-hidden="true"><span>📌 {DateTime.fromMillis(n.start, { zone: tz }).toFormat('h:mm a')}–{DateTime.fromMillis(n.end, { zone: tz }).toFormat('h:mm a')}</span></div>;
  };
  /** where a refused block could go instead, drawn on the grid */
  const suggestionsIn = (date: string) => (refusal?.suggestions ?? []).flatMap((sg, i) => {
    const a = DateTime.fromISO(sg.start, { zone: tz }), b = DateTime.fromISO(sg.end, { zone: tz });
    if (a.toISODate() !== date) return [];
    const p = placement({ start: a.hour * 60 + a.minute, end: b.toISODate() === date ? b.hour * 60 + b.minute : 1440 }, ROW_PX);
    return p ? [<button key={`s${i}`} className="ev suggest" style={p} title={`It fits here: ${sg.label}`} onClick={() => void pinAt(refusal!.target, Date.parse(sg.start), Date.parse(sg.end))}><span>fits here</span></button>] : [];
  });
  const blockProps = (di: number, b: BlockRef, extra: string) => ({
    tabIndex: 0, role: 'button' as const,
    'aria-label': `${b.pinId ? 'Pinned block' : 'Block'}: ${b.title}, ${when(b.startMs, b.endMs)}. Drag to pin it at another time; drag the bottom edge to change its length; Enter for options.`,
    title: `${b.pinId ? '📌 Pinned: ' : ''}${b.title}\nDrag to pin it at another time; drag the bottom edge to resize.`,
    className: `ev ${extra} ${b.pinId ? 'pinned' : ''} ${bdrag && bdrag.taskId === b.taskId && bdrag.startMs === b.startMs && bdrag.moved ? 'dragging' : ''}`,
    onPointerDown: startBlockDrag('move', di, b),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setMenu(b); setEditing(false); } },
  });

  /* keyboard */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!week) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); void doUndo(); return; }
    if (e.key === 'PageUp' || e.key === '[') { e.preventDefault(); setAnchor(addDays(week.start, -7)); return; }
    if (e.key === 'PageDown' || e.key === ']') { e.preventDefault(); setAnchor(addDays(week.start, 7)); return; }
    if (e.key === 't') { e.preventDefault(); setAnchor(today); return; }
    if (e.key === 'Escape') { setSel(null); return; }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = moveCursor(cursor, e.key);
      if (e.shiftKey && next.day === cursor.day) setSel({ day: cursor.day, anchorRow: sel?.day === cursor.day ? sel.anchorRow : cursor.row, row: next.row });
      else setSel(null);
      setCursor(next);
      const d = week.days[next.day];
      setStatus(`${d.weekday} ${label12(rowStart(next.row))}, ${isFreeRow(d.free, next.row) ? 'free' : 'not free'}`);
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const s = sel ?? { day: cursor.day, anchorRow: cursor.row, row: cursor.row };
      const mode = modeFor(isFreeRow(week.days[s.day].free, s.anchorRow));
      setSel(null);
      void apply(s.day, s.anchorRow, s.row, mode);
    }
  }

  async function reschedule() {
    setRescheduling(true);
    setError(null);
    try {
      setProposed(await api.dryRun(14));
      setStatus('Proposed blocks shown on the grid. Nothing was written.');
    } catch (e) { fail(e); }
    setRescheduling(false);
  }

  const inDrag = (day: number, row: number) => drag && drag.day === day && row >= Math.min(drag.from, drag.to) && row <= Math.max(drag.from, drag.to);
  const inSel = (day: number, row: number) => sel && sel.day === day && row >= Math.min(sel.anchorRow, sel.row) && row <= Math.max(sel.anchorRow, sel.row);

  return (
    <section className="avail" aria-label="Availability">
      <div className="toolbar">
        <button onClick={() => week && setAnchor(addDays(week.start, -7))} aria-label="Previous week">‹ Prev</button>
        <button onClick={() => setAnchor(today)}>Today</button>
        <button onClick={() => week && setAnchor(addDays(week.start, 7))} aria-label="Next week">Next ›</button>
        <strong className="range">{week ? `${fmtDay(week.start)} – ${fmtDay(addDays(week.start, 6))}, ${week.start.slice(0, 4)}` : '…'}</strong>
        <span className="muted">{freeHours.toFixed(1)} h free</span>
        <span className="spacer" />
        <label className="toggle" title="Edit the weekly template instead of just these dates">
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repeat weekly
        </label>
        <button onClick={doUndo} disabled={!undo.length} title="Undo (Ctrl/Cmd+Z)">Undo{undo.length ? ` (${undo.length})` : ''}</button>
        <button onClick={() => week && api.copyWeek(week.start, addDays(week.start, 7)).then((r) => { setStatus(`Copied ${r.days} day(s) to next week.`); }).catch(fail)} disabled={!week} title="Copy this week's windows onto next week">Copy to next week</button>
        <button className="primary" onClick={reschedule} disabled={rescheduling}>{rescheduling ? 'Working…' : 'Reschedule (dry run)'}</button>
        {proposed && <button onClick={() => setProposed(null)}>Hide proposed</button>}
      </div>

      {repeat && <div className="note">Repeat weekly is ON: painting and erasing edit the <b>weekly template</b> (every such weekday). Days marked “this date only” keep their own windows and won't change.</div>}
      {error && <div className="note error" role="alert">{error} <button onClick={() => setError(null)}>Dismiss</button></div>}
      {busy === null && <div className="note" role="status">Loading Google Calendar busy times… (the first load can take several seconds)</div>}
      {busy?.error && <div className="note" role="status">Google busy times are not shown: {busy.error} {busy.errorCode === 'google_reconnect' && <ReconnectButton testId="availability-reconnect" />}</div>}

      <div className="legend" aria-hidden>
        <span><i className="sw free" /> Free (you chose)</span>
        <span><i className="sw busy" /> Busy (Google, read-only)</span>
        <span><i className="sw block" /> Tally blocks (written)</span>
        <span><i className="sw prop" /> Proposed (dry run)</span>
        <span><i className="sw tent" /> Tentative (never written)</span>
        <span>📌 Pinned (you placed it; the planner keeps it)</span>
        <span><i className="sw now" /> Now</span>
      </div>

      <div className="gridwrap">
        <div
          className="grid" ref={gridRef} role="grid" tabIndex={0} aria-label="Weekly availability. Arrow keys move, shift+arrows select, space paints or erases, Ctrl+Z undoes, Page Up and Page Down change week."
          aria-activedescendant={`cell-${cursor.day}-${cursor.row}`} onKeyDown={onKeyDown}
        >
          <div className="corner" />
          {days.map((d) => (
            <div key={d.date} className={`dayhead ${d.date === today ? 'today' : ''}`}>
              <div><b>{d.weekday}</b> {fmtDay(d.date)}{d.date === today && <span className="today-tag">Today</span>}</div>
              <div className="src">
                {d.source === 'date' ? (
                  <>
                    this date only{' '}
                    <button className="link" onClick={() => api.clearDate(d.date).then((r) => { setUndo((u) => [...u, { target: { date: d.date }, before: r.before, label: `Reset ${d.weekday} to the weekly template` }]); setProposed(null); return loadWeek(anchor); }).catch(fail)}>reset</button>
                  </>
                ) : d.source === 'template' ? 'weekly template' : 'nothing set'}
              </div>
            </div>
          ))}

          <div className="times">
            {Array.from({ length: ROWS }, (_, r) => (
              <div key={r} className="timelabel" style={{ height: ROW_PX }}>{r % 2 === 0 ? label12(rowStart(r)) : ''}</div>
            ))}
          </div>

          {days.map((d, di) => (
            <div key={d.date} className={`col ${d.date === today ? 'today' : ''}`} style={{ height: ROWS * ROW_PX }} onPointerDown={onDown(di)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)} role="presentation">
              {Array.from({ length: ROWS }, (_, r) => (
                <div
                  key={r} id={`cell-${di}-${r}`} role="gridcell" aria-selected={!!inSel(di, r)} aria-label={`${d.weekday} ${label12(rowStart(r))}, ${isFreeRow(d.free, r) ? 'free' : 'not free'}`}
                  className={`cell ${isFreeRow(d.free, r) ? 'free' : ''} ${r % 2 === 0 ? 'hour' : ''} ${cursor.day === di && cursor.row === r ? 'cursor' : ''} ${inDrag(di, r) ? `drag-${drag!.mode}` : ''} ${inSel(di, r) ? 'sel' : ''}`}
                  style={{ height: ROW_PX }}
                />
              ))}
              {d.date === today && nowTop(nowMs, info.tz, ROW_PX) != null && <div className="nowline" style={{ top: nowTop(nowMs, info.tz, ROW_PX)! }} aria-hidden="true" title="Now"><span>now</span></div>}
              {(busy?.busy[d.date] ?? []).map((b, i) => { const p = placement(b, ROW_PX); return p && <div key={`b${i}`} className="ev busy" style={p} title={`${b.label}: busy`}><span>{b.label}</span></div>; })}
              {d.blocks.map((b, i) => {
                const p = placement(b, ROW_PX);
                const ref: BlockRef = { taskId: b.taskId, pinId: b.pinId, title: b.label, startMs: Date.parse(b.startIso), endMs: Date.parse(b.endIso) };
                return p && (
                  <div key={`k${i}`} {...blockProps(di, ref, 'block')} style={p} data-task={b.taskId} data-pin={b.pinId ?? ''}>
                    <span>{b.pinId ? <b className="pinmark" aria-hidden="true">📌 </b> : null}{b.label}</span>
                    <i className="grip" aria-hidden="true" onPointerDown={startBlockDrag('resize', di, ref)} />
                  </div>
                );
              })}
              {proposed?.blocks.flatMap((b, bi) => b.spans.filter((s) => s.date === d.date).map((s, si) => {
                const p = placement(s, ROW_PX);
                if (!p) return null;
                if (b.tentative) return <div key={`p${bi}-${si}`} className="ev tent" style={p} title={`Tentative: ${b.title}`}><span>{b.title}</span></div>;
                const ref: BlockRef = { taskId: b.taskId, pinId: b.pinId, title: b.title, startMs: Date.parse(b.start), endMs: Date.parse(b.end) };
                return (
                  <div key={`p${bi}-${si}`} {...blockProps(di, ref, 'prop')} style={p} data-task={b.taskId}>
                    <span>{b.pinned ? <b className="pinmark" aria-hidden="true">📌 </b> : null}{b.title}</span>
                    <i className="grip" aria-hidden="true" onPointerDown={startBlockDrag('resize', di, ref)} />
                  </div>
                );
              }))}
              {ghost(di)}
              {suggestionsIn(d.date)}
            </div>
          ))}
        </div>
      </div>

      <div className="status" role="status" aria-live="polite">{status}</div>
      {refusal && <RefusalNote r={refusal} onPick={(sg) => void pinAt(refusal.target, Date.parse(sg.start), Date.parse(sg.end))} onClose={() => setRefusal(null)} />}
      {menu && (
        <div className="note block-menu" role="dialog" aria-label={`Options for ${menu.title}`} data-testid="block-menu">
          <strong>{menu.pinId ? '📌 ' : ''}{menu.title}</strong> <span className="muted">{when(menu.startMs, menu.endMs)}{menu.pinId ? ' · pinned' : ''}</span>
          <div className="toolbar">
            {!menu.pinId && <button className="primary" onClick={() => void pinAt(menu, menu.startMs, menu.endMs)}>📌 Pin it here</button>}
            <button onClick={() => setEditing(true)}>{menu.pinId ? 'Move…' : 'Pin at another time…'}</button>
            {menu.pinId && <button onClick={() => void unpin(menu, false)}>Unpin</button>}
            {menu.pinId && <button onClick={() => void unpin(menu, true)}>Move back to automatic</button>}
            <button className="link" onClick={() => setMenu(null)}>Close</button>
          </div>
          {editing && <PinEditor tz={tz} taskId={menu.taskId} pinId={menu.pinId} start={new Date(menu.startMs).toISOString()} end={new Date(menu.endMs).toISOString()} onCancel={() => setEditing(false)} onDone={(msg) => { setMenu(null); setStatus(`📌 ${msg}`); void loadWeek(anchor).then(() => (proposed ? reschedule() : undefined)); }} />}
        </div>
      )}

      {proposed && (
        <div className="proposal">
          <h3>Proposed plan (dry run, nothing written)</h3>
          <p>{proposed.blocks.filter((b) => !b.tentative).length} block(s){proposed.blocks.some((b) => b.tentative) ? `, ${proposed.blocks.filter((b) => b.tentative).length} tentative (waiting on blockers; never written to Google)` : ''} through {fmtDay(proposed.horizonEnd.slice(0, 10))}.</p>
          {proposed.problems.length ? (
            <>
              <h4>Does not fit</h4>
              <ul>{proposed.problems.map((p, i) => <li key={i}>{p.tentative ? '(tentative) ' : ''}<b>{p.title}</b>: {p.shortMinutes} min short. {p.reason}</li>)}</ul>
            </>
          ) : <p>Everything fits.</p>}
        </div>
      )}
      <p className="hint">Drag a Tally block (written ■ or proposed ◇) to another time to <b>pin</b> it there (📌), or drag its bottom edge to change its length; click a block (or Tab to it and press Enter) to pin it where it is, unpin it, or move it back to automatic. Drag on empty time to paint free time; drag on free time to erase it. Keyboard: arrows move, Shift+arrows select, Space paints or erases, Ctrl/Cmd+Z undoes, [ and ] change week.</p>
    </section>
  );
}
