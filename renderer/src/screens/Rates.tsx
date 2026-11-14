import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { errText, useApp } from '../ctx';
import type { RateApplyPreview, RateGroupDto, RatePreviewTask, RatesView, RegroupReportDto } from '../../../src/app/types';

const EXAMPLE: Record<string, number> = { pages: 30, video_minutes: 40, problems: 10, items: 3, points: 100 };
const UNIT_WORD: Record<string, string> = { pages: 'pages', video_minutes: 'video min', problems: 'problems', items: 'items', points: 'points' };
const num = (n: number) => String(Math.round(n * 1000) / 1000);
const mins = (m: number) => (m >= 90 ? `${Math.round((m / 60) * 10) / 10} h` : `${Math.round(m)} min`);

/** Live example: "30 pages = 75 min", using the same rounding as the estimates (whole minutes, and the points minimum). */
export const exampleText = (unit: string, rate: number, pointsMin: number) => {
  const amt = EXAMPLE[unit] ?? 10;
  return `${amt} ${UNIT_WORD[unit] ?? unit} = ${Math.max(unit === 'points' ? pointsMin : 1, Math.round(amt * rate))} min`;
};

/**
 * Rates: every time estimate, customizable. Tasks are grouped by course and title stem; each group is one rate rule, one learned multiplier and one
 * "apply to these tasks" action. Nothing here writes to a task until you confirm the list of changes, and every edit is undoable (Settings, Recent changes).
 */
export function Rates() {
  const { version, toast, changed } = useApp();
  const [v, setV] = useState<RatesView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [course, setCourse] = useState('__all');
  const [open, setOpen] = useState<string | null>(null);
  const [report, setReport] = useState<RegroupReportDto | null>(null);
  const load = useCallback(() => api.rates().then((x) => { setV(x); setErr(null); }).catch((e) => setErr(errText(e))), []);
  useEffect(() => { void load(); }, [load, version]);

  const run = async (label: string, fn: () => Promise<RatesView>) => {
    try { setV(await fn()); setErr(null); toast(label); changed(); } catch (e) { setErr(errText(e)); }
  };

  const doRegroup = async () => {
    try { const r = await api.ratesRegroup(); setV(r); setReport(r.report); setErr(null); toast(r.report.unchanged ? 'Groups already up to date.' : 'Regrouped.'); changed(); } catch (e) { setErr(errText(e)); }
  };

  const shown = useMemo(() => {
    if (!v) return [];
    const needle = q.trim().toLowerCase();
    return v.groups.filter((g) => (course === '__all' || (g.course ?? '') === course) && (!needle || g.name.toLowerCase().includes(needle) || (g.course ?? '').toLowerCase().includes(needle) || g.tasks.some((t) => t.title.toLowerCase().includes(needle))));
  }, [v, q, course]);
  const byCourse = useMemo(() => {
    const m = new Map<string, RateGroupDto[]>();
    for (const g of shown) { const k = g.course ?? ''; m.set(k, [...(m.get(k) ?? []), g]); }
    return [...m];
  }, [shown]);

  if (!v) return err ? <div className="note error" role="alert">{err}</div> : <p className="muted">Loading…</p>;
  return (
    <div className="rates" data-testid="rates">
      <header className="page-head"><h1>Rates</h1><span className="date">{v.groups.length} group{v.groups.length === 1 ? '' : 's'}</span></header>
      <p className="hint">Every time estimate comes from a rate: minutes per page, problem, point and so on. Tasks are grouped by course and title (“Lecture 22 zyBooks” and “Lecture 25 zyBooks” are both “zyBooks”). Change a group’s rate, then use <strong>Apply to these tasks</strong> to fill in estimates. Changing a rate never moves your schedule: the Schedule screen still asks before anything is written. Every edit can be undone in Settings, General, Recent changes.</p>
      {err && <div className="note error" role="alert">{err}</div>}
      <div className="row regroup" data-testid="regroup">
        <button onClick={() => void doRegroup()} data-testid="regroup-go" title="Recompute the automatic groups from the task titles. Your renames, merges, splits and moves are kept; saved rates are not touched.">Regroup</button>
        <span className="muted">{v.regroupPending > 0 ? `${v.regroupPending} task${v.regroupPending === 1 ? '' : 's'} would change group.` : 'Groups are up to date.'} Your renames, merges, splits, moves and saved rates are kept.</span>
      </div>
      {report && (
        <div className="note" role="status" data-testid="regroup-report">
          <strong>{report.unchanged ? 'Nothing changed.' : `Regrouped: ${report.groupsBefore} → ${report.groupsAfter} groups.`}</strong>
          {report.changedTasks.length > 0 && <ul>{report.changedTasks.slice(0, 12).map((t) => <li key={t.id}>{t.title}: {t.from.split('|')[1] || t.from} → {t.to.split('|')[1] || t.to}</li>)}{report.changedTasks.length > 12 && <li>…and {report.changedTasks.length - 12} more</li>}</ul>}
          {report.overridesCarried > 0 && <p>{report.overridesCarried} saved rename, merge, move or multiplier setting{report.overridesCarried === 1 ? '' : 's'} carried over to the new groups.</p>}
          {report.unresolved.length > 0 && <p>These old groups split into several, so their saved settings were left as they were: {report.unresolved.join(', ')}.</p>}
          <button onClick={() => setReport(null)}>Dismiss</button> <span className="muted">Undo it in Settings, General, Recent changes.</span>
        </div>
      )}
      <Defaults v={v} run={run} />
      <div className="toolbar rates-filter">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups and tasks…" aria-label="Search rate groups" data-testid="rates-search" />
        <select value={course} onChange={(e) => setCourse(e.target.value)} aria-label="Course filter" data-testid="rates-course">
          <option value="__all">All courses</option>
          {v.courses.map((c) => <option key={c} value={c}>{c || 'No course'}</option>)}
        </select>
        <span className="muted">{shown.length} shown</span>
      </div>
      {v.groups.length === 0 && <p className="empty">No tasks yet. Add tasks (or import a syllabus) and they will appear here in groups.</p>}
      {v.groups.length > 0 && shown.length === 0 && <p className="empty">No group matches “{q}”.</p>}
      {byCourse.map(([c, groups]) => (
        <section key={c || 'none'} className="rates-course" aria-label={c || 'No course'}>
          <h2>{c || 'No course'} <span className="count">{groups.length}</span></h2>
          {groups.map((g) => (
            <GroupCard key={g.key} g={g} v={v} open={open === g.key} onToggle={() => setOpen(open === g.key ? null : g.key)} run={run} />
          ))}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- global defaults
function Defaults({ v, run }: { v: RatesView; run: (label: string, fn: () => Promise<RatesView>) => Promise<void> }) {
  const [vals, setVals] = useState<Record<number, string>>({});
  const [min, setMin] = useState(String(v.pointsMin));
  useEffect(() => { setVals({}); setMin(String(v.pointsMin)); }, [v.defaults, v.pointsMin]);
  const mine = v.order.filter((r) => r.mine);
  return (
    <details className="rates-defaults" data-testid="rates-defaults">
      <summary><strong>Built-in rates and the order rules are tried</strong>{v.defaultsEdited || v.pointsMin !== v.pointsMinDefault ? <span className="chip">edited</span> : null}</summary>
      <p className="hint">A task uses the <strong>first rule that matches</strong> its unit, course and title text, in the order below: your own group rates first, then these built-in ones. A rate a group has measured from finished tasks (Learned) replaces its rule’s number.</p>
      <table className="rates-table">
        <thead><tr><th>Applies to</th><th>Unit</th><th>Minutes per unit</th><th /></tr></thead>
        <tbody>
          {v.defaults.map((d) => (
            <tr key={d.index} data-testid="default-row">
              <td>{d.course ?? 'any course'}{d.match ? ` · titles containing “${d.match}”` : ''}</td>
              <td>{UNIT_WORD[d.unit] ?? d.unit}</td>
              <td><input aria-label={`Built-in rate for ${d.unit}${d.match ? ' ' + d.match : ''}`} inputMode="decimal" value={vals[d.index] ?? num(d.minutes)} onChange={(e) => setVals((x) => ({ ...x, [d.index]: e.target.value.replace(/[^\d.]/g, '') }))} size={6} data-testid="default-rate" /></td>
              <td><button disabled={vals[d.index] === undefined || Number(vals[d.index]) === d.minutes} onClick={() => void run('Saved the built-in rate.', () => api.ratesSetDefault(d.index, Number(vals[d.index])))}>Save</button>{d.builtIn != null && d.edited && <span className="muted"> was {num(d.builtIn)}</span>}</td>
            </tr>
          ))}
          <tr>
            <td>Points-based estimates are never shorter than</td><td>points</td>
            <td><input aria-label="Shortest points-based estimate in minutes" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ''))} size={6} data-testid="points-min" /> min</td>
            <td><button disabled={Number(min) === v.pointsMin || !min} onClick={() => void run('Saved the minimum.', () => api.ratesSetPointsMin(Number(min)))}>Save</button></td>
          </tr>
        </tbody>
      </table>
      <p><button onClick={() => void run('Built-in rates reset.', () => api.ratesResetDefaults())} disabled={!v.defaultsEdited && v.pointsMin === v.pointsMinDefault}>Reset built-in rates</button></p>
      <h4>Order rules are tried ({mine.length} yours, {v.order.length - mine.length} built-in)</h4>
      <ol className="rates-order" data-testid="rates-order">
        {v.order.map((r) => <li key={r.number} className={r.mine ? 'mine' : ''}><span className="chip">{r.mine ? 'yours' : 'built-in'}</span> {r.text}</li>)}
      </ol>
    </details>
  );
}

// ---------------------------------------------------------------- one group
function GroupCard({ g, v, open, onToggle, run }: { g: RateGroupDto; v: RatesView; open: boolean; onToggle: () => void; run: (label: string, fn: () => Promise<RatesView>) => Promise<void> }) {
  const { openTask } = useApp();
  const noSize = g.tasks.filter((t) => t.noSize && !t.done).length;
  const rate = g.rateInUse;
  return (
    <article className={`rates-card ${open ? 'open' : ''}`} data-testid="rate-group" data-key={g.key}>
      <button className="rates-head" onClick={onToggle} aria-expanded={open} title={g.name}>
        <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="gname">{g.name}</span>
        <span className="chips">
          {g.unit && <span className="chip">{UNIT_WORD[g.unit] ?? g.unit}</span>}
          {rate && <span className={`chip src-${rate.source.split(' ')[0].toLowerCase()}`} title={rate.ruleText}>{rate.source}: {num(rate.minutes)} min{g.unit ? ` / ${(UNIT_WORD[g.unit] ?? g.unit).replace(/s$/, '')}` : ''}</span>}
          <span className="muted">{g.openCount} open · {g.doneCount} done</span>
          {noSize > 0 && <span className="chip warn">⚠ {noSize} no size set</span>}
          {g.orphan && <span className="chip">no tasks yet</span>}
        </span>
      </button>
      {open && <GroupBody g={g} v={v} run={run} openTask={openTask} />}
    </article>
  );
}

function GroupBody({ g, v, run, openTask }: { g: RateGroupDto; v: RatesView; run: (label: string, fn: () => Promise<RatesView>) => Promise<void>; openTask: (id: number) => void }) {
  const [unit, setUnit] = useState(g.rule?.unit ?? g.unit ?? 'pages');
  const [rate, setRate] = useState(String(g.rule ? g.rule.minutes : g.rateInUse ? g.rateInUse.minutes : ''));
  const [match, setMatch] = useState(g.rule?.match ?? g.suggestedMatch);
  const [preview, setPreview] = useState<RatePreviewTask[]>([]);
  const [name, setName] = useState(g.name);
  const [mergeInto, setMergeInto] = useState('');
  const [mode, setMode] = useState<'unit' | 'flat' | 'none'>(g.mode);
  const [flatMin, setFlatMin] = useState(g.flat && g.flat.minutes ? String(g.flat.minutes) : '');
  const [applying, setApplying] = useState<RateApplyPreview | null>(null);
  const [replaceManual, setReplaceManual] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setName(g.name); }, [g.name]);
  const flatSig = JSON.stringify([g.mode, g.flat]);
  useEffect(() => { setMode(g.mode); setFlatMin(g.flat && g.flat.minutes ? String(g.flat.minutes) : ''); if (g.flat?.match) setMatch(g.flat.match); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatSig]);
  // after a save or a reset the form shows what is now in force
  const ruleSig = JSON.stringify(g.rule);
  useEffect(() => { setUnit(g.rule?.unit ?? g.unit ?? 'pages'); setRate(String(g.rule ? g.rule.minutes : g.rateInUse ? g.rateInUse.minutes : '')); setMatch(g.rule?.match ?? g.suggestedMatch); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleSig]);
  useEffect(() => {
    const h = setTimeout(() => { api.ratesPreview(g.course, match).then(setPreview).catch(() => setPreview([])); }, 120);
    return () => clearTimeout(h);
  }, [match, g.course, g.tasks.length]);
  const rateNum = Number(rate);
  const valid = rate !== '' && Number.isFinite(rateNum) && rateNum > 0;
  const flatNum = Number(flatMin);
  const flatValid = flatMin !== '' && Number.isFinite(flatNum) && flatNum > 0;
  const flatDirty = mode !== g.mode || (mode === 'flat' && (g.flat?.minutes !== flatNum || g.flat?.match !== match.trim())) || (mode === 'none' && g.flat?.match !== match.trim());
  const dirty = !g.rule || g.rule.unit !== unit || g.rule.minutes !== rateNum || g.rule.match !== match.trim();
  const others = v.groups.filter((x) => x.key !== g.key && !x.orphan);
  const outside = preview.filter((p) => !g.tasks.some((t) => t.id === p.id));

  async function openApply(rm: boolean) {
    try { setApplying(await api.ratesApplyPreview(g.key, rm)); setErr(null); } catch (e) { setErr(errText(e)); }
  }
  async function confirmApply() {
    if (!applying) return;
    try { const r = await api.ratesApply(g.key, replaceManual, applying.fingerprint); setApplying(null); await run(`Set ${r.changed} estimate${r.changed === 1 ? '' : 's'} from the rate.`, async () => r); }
    catch (e) { setErr(errText(e)); }
  }

  return (
    <div className="rates-body">
      {err && <div className="note error" role="alert">{err}</div>}
      <div className="rates-stats">
        <div data-testid="stat-rate"><span className="k">Rate in use</span> {g.mode === 'none' ? <span className="muted">no rate: tasks use their own estimate, or none</span> : g.rateInUse ? <><strong>{num(g.rateInUse.minutes)} min per {g.mode === 'flat' ? 'assignment' : (UNIT_WORD[g.unit ?? ''] ?? g.unit ?? 'unit').replace(/s$/, '')}</strong> <span className={`chip src-${g.rateInUse.source.split(' ')[0].toLowerCase()}`}>{g.rateInUse.source}</span><div className="muted">Rule {g.rateInUse.ruleNumber}: {g.rateInUse.ruleText}</div></> : <span className="muted">none (no size unit on these tasks yet)</span>}</div>
        {g.mode === 'flat' ? (
          <div data-testid="stat-average"><span className="k">Average, from finished timed tasks</span> {g.average.enough && g.average.minutesPerTask != null ? <><strong>{num(g.average.minutesPerTask)} min per task</strong> <span className="muted">from {g.average.n} tasks</span> <button onClick={() => { setMode('flat'); setFlatMin(String(Math.round(g.average.minutesPerTask!))); }} data-testid="use-average">Use average</button></> : <span className="muted">not enough data ({g.average.n} of 3 finished tasks with tracked time)</span>}</div>
        ) : <div data-testid="stat-actual"><span className="k">Actual, from finished timed tasks</span> {g.actual.enough && g.actual.minutesPerUnit != null ? <><strong>{num(g.actual.minutesPerUnit)} min per {(UNIT_WORD[g.unit ?? ''] ?? 'unit').replace(/s$/, '')}</strong> <span className="muted">from {g.actual.n} tasks</span> <button onClick={() => setRate(String(g.actual.minutesPerUnit))} data-testid="use-actual">Use actual rate</button></> : <span className="muted">not enough data ({g.actual.n} of 3 finished tasks with a size and tracked time)</span>}</div>}
        <div data-testid="stat-total"><span className="k">Open tasks</span> <strong>{mins(g.openEstimatedMinutes)}</strong> estimated · {g.openWithoutEstimate} without an estimate</div>
      </div>

      <fieldset className="rates-form">
        <legend>Rate for this group</legend>
        <label>Mode <select value={mode} onChange={(e) => setMode(e.target.value as 'unit' | 'flat' | 'none')} data-testid="rate-mode" aria-label="Rate mode">
          <option value="unit">Per unit (size × rate)</option><option value="flat">Per assignment (flat time)</option><option value="none">No rate</option>
        </select></label>
        {mode === 'flat' && <>
          <label>Minutes per assignment <input value={flatMin} inputMode="decimal" onChange={(e) => setFlatMin(e.target.value.replace(/[^\d.]/g, ''))} size={7} data-testid="flat-value" aria-label="Minutes per assignment" /></label>
          <span className="example" data-testid="flat-example">{flatValid ? `any task in this group = ${Math.max(1, Math.round(flatNum))} min` : 'enter a number of minutes, like 60'}</span>
        </>}
        {mode === 'none' && <span className="example" data-testid="none-example">no flat or size-based estimate: manual estimate, learned estimate or none</span>}
        {mode === 'unit' && <><label>Unit <select value={unit} onChange={(e) => setUnit(e.target.value)} data-testid="rate-unit">{v.units.map((u) => <option key={u} value={u}>{UNIT_WORD[u] ?? u}</option>)}</select></label>
        <label>Minutes per unit <input value={rate} inputMode="decimal" onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ''))} size={7} data-testid="rate-value" aria-label="Minutes per unit" /></label>
        <span className="example" data-testid="rate-example">{valid ? exampleText(unit, rateNum, v.pointsMin) : 'enter a number like 2.5 or 0.3'}</span></>}
        <label className="wide">Title contains <input value={match} onChange={(e) => setMatch(e.target.value)} maxLength={100} data-testid="rate-match" aria-label="Title contains" /></label>
        <div className="preview" data-testid="match-preview">
          {match.trim() === '' ? <span className="muted">Type the text a title must contain.</span> : <>
            <strong>{preview.length}</strong> task{preview.length === 1 ? '' : 's'} in {g.course ?? 'any course'} would be caught
            {outside.length > 0 && <span className="warnText"> ({outside.length} in other groups: {outside.slice(0, 3).map((p) => p.title).join(', ')}{outside.length > 3 ? '…' : ''})</span>}
          </>}
        </div>
        <div className="row">
          {mode !== 'unit' && <button className="primary" disabled={!flatDirty || (mode === 'flat' && !flatValid) || !match.trim()} onClick={() => void run(mode === 'flat' ? 'Saved the flat rate.' : 'Saved: no rate for this group.', () => api.ratesSetMode(g.key, mode, mode === 'flat' ? flatNum : undefined, match.trim()))} data-testid="mode-save">{mode === 'flat' ? 'Save flat rate' : 'Save: no rate'}</button>}
          {mode === 'unit' && g.mode !== 'unit' && <button onClick={() => void run('Back to per unit.', () => api.ratesSetMode(g.key, 'unit'))} data-testid="mode-unit">Use per unit</button>}
          {mode === 'unit' && <button className="primary" disabled={!valid || !dirty || !match.trim()} onClick={() => void run('Saved the rate.', () => api.ratesSaveGroup(g.key, unit, rateNum, match.trim()))} data-testid="rate-save">Save rate</button>}
          <button disabled={!g.rule && !g.flat} onClick={() => void run('Back to the built-in rate.', () => api.ratesResetGroup(g.key))} data-testid="rate-reset">Reset to default</button>
          <button onClick={() => void openApply(replaceManual)} disabled={g.orphan} data-testid="rate-apply">Apply to these tasks…</button>
        </div>
      </fieldset>

      <div className="rates-mult" data-testid="rates-mult">
        <span className="k">Learned timing</span>{' '}
        {g.multiplier.enough && g.multiplier.value != null ? <strong>{num(g.multiplier.value)}× from {g.multiplier.samples} tasks</strong> : <span className="muted">not enough data ({g.multiplier.samples} of 3 finished timed tasks with a manual estimate); the task-type multiplier is used instead, if there is one</span>}
        {g.multiplier.resetAt && <span className="muted"> · counting from {new Date(g.multiplier.resetAt).toLocaleDateString()}</span>}
        <label><input type="checkbox" checked={!g.multiplier.disabled} onChange={(e) => void run('Saved.', () => api.ratesMultiplier(g.key, e.target.checked))} data-testid="mult-toggle" /> use it for this group</label>
        <button onClick={() => void run('Reset: only tasks finished from now on count.', () => api.ratesMultiplierReset(g.key))} data-testid="mult-reset">Reset</button>
        <span className="hint"> Size-based estimates never get a multiplier. Off means no multiplier at all for this group.</span>
      </div>

      <details className="rates-admin">
        <summary>Rename, merge, split and move</summary>
        <div className="row"><label>Name <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-testid="group-name" /></label> <button disabled={!name.trim() || name === g.name || g.orphan} onClick={() => void run('Renamed.', () => api.ratesRename(g.key, name))}>Rename</button></div>
        <div className="row"><label>Merge this group into <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} data-testid="merge-into"><option value="">(choose)</option>{others.map((o) => <option key={o.key} value={o.key}>{o.course ? `${o.course} · ` : ''}{o.name}</option>)}</select></label> <button disabled={!mergeInto || g.orphan} onClick={() => void run('Merged.', () => api.ratesMerge(g.key, mergeInto))} data-testid="merge-go">Merge</button></div>
      </details>

      <ul className="rates-tasks" data-testid="rate-tasks">
        {g.tasks.length === 0 && <li className="empty">No tasks match this saved rate yet. It applies as soon as one does.</li>}
        {g.tasks.map((t) => (
          <li key={t.id} data-testid="rate-task" data-done={t.done ? '1' : undefined}>
            <button className="link-title" onClick={() => openTask(t.id)}>{t.title}</button>
            <span className="muted"> {t.done ? 'done' : 'open'}{t.sizeAmount ? ` · ${num(t.sizeAmount)} ${UNIT_WORD[t.sizeUnit ?? ''] ?? t.sizeUnit}` : ''}{t.estimate != null ? ` · ${t.estimate} min (${t.estimateSource ?? 'manual'})` : ' · no estimate'}{t.done && t.actualMinutes ? ` · took ${t.actualMinutes} min` : ''}</span>
            {t.noSize && !t.done && <span className="chip warn" title="Open the task to give it a size and unit">no size set</span>}
            <span className="task-actions">
              {g.tasks.length > 1 && <button onClick={() => void run('Split out into its own group.', () => api.ratesSplit(t.id))}>Split out</button>}
              <select aria-label={`Move ${t.title} to another group`} value="" onChange={(e) => e.target.value && void run('Moved.', () => api.ratesMove(t.id, e.target.value))}>
                <option value="">Move to…</option>{others.map((o) => <option key={o.key} value={o.key}>{o.course ? `${o.course} · ` : ''}{o.name}</option>)}
              </select>
            </span>
          </li>
        ))}
      </ul>

      {applying && (
        <div className="modal-back" role="presentation" onKeyDown={(e) => e.key === 'Escape' && setApplying(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="apply-title" data-testid="rates-apply-dialog">
            <h3 id="apply-title">Set estimates from size for “{g.name}”?</h3>
            <label className="row"><input type="checkbox" checked={replaceManual} onChange={(e) => { setReplaceManual(e.target.checked); void openApply(e.target.checked); }} data-testid="replace-manual" /> also replace manual estimates</label>
            {applying.rows.length === 0 ? <p>Nothing would change.{applying.keptManual ? ` ${applying.keptManual} task${applying.keptManual === 1 ? ' has' : 's have'} a manual estimate that differs and is kept.` : ''}</p> : (
              <>
                <p><strong>{applying.rows.length}</strong> task{applying.rows.length === 1 ? '' : 's'} will change{applying.keptManual ? `; ${applying.keptManual} manual estimate${applying.keptManual === 1 ? '' : 's'} kept` : ''}.{applying.needsConfirm ? ' That is more than 3, so please read the list.' : ''}</p>
                <table className="rates-table" data-testid="apply-rows"><thead><tr><th>Task</th><th>Before</th><th>After</th></tr></thead><tbody>
                  {applying.rows.map((r) => <tr key={r.taskId} className={r.wasManual ? 'manual' : ''}><td>{r.title}</td><td>{r.before == null ? 'none' : `${r.before} min (${r.beforeSource})`}</td><td><strong>{r.after} min</strong> <span className="muted">{r.formula}</span></td></tr>)}
                </tbody></table>
              </>
            )}
            <div className="modal-actions">
              <button onClick={() => setApplying(null)}>Cancel</button>
              <button className="primary" disabled={applying.rows.length === 0} onClick={() => void confirmApply()} data-testid="apply-confirm">{applying.rows.length > 3 ? `Yes, change ${applying.rows.length} tasks` : 'Apply'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
