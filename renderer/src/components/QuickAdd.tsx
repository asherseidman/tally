import { forwardRef, useEffect, useState } from 'react';
import type { QuickPreview } from '../../../src/app/types';
import { api } from '../api';
import { errText, useApp } from '../ctx';

/** Live preview of what the typed text will become. The main process parses it, so it is exactly what Add will do. */
export function useQuickPreview(title: string, due = ''): QuickPreview | null {
  const [preview, setPreview] = useState<QuickPreview | null>(null);
  useEffect(() => {
    if (!title.trim()) { setPreview(null); return; }
    let stale = false;
    const h = setTimeout(() => { api.parseQuick(title, due).then((p) => { if (!stale) setPreview(p); }).catch(() => { if (!stale) setPreview(null); }); }, 80);
    return () => { stale = true; clearTimeout(h); };
  }, [title, due]);
  return preview;
}

export function PreviewLine({ preview }: { preview: QuickPreview }) {
  return (
    <div className="quickpreview muted" aria-live="polite" data-testid="quick-preview">
      {preview.explicitDue ? 'Using the due field; the title is kept as typed.'
        : preview.due ? <>Title “<b>{preview.title}</b>” · Due <b>{preview.dueText}</b>{preview.timeAssumed ? ' (time assumed)' : ''}</>
        : 'No due date found in the title.'}
    </div>
  );
}

/** Quick-add: a title and (optionally) a due date in plain words. Ctrl/Cmd+K focuses it from anywhere in the window. */
export const QuickAdd = forwardRef<HTMLInputElement, { lists: string[]; defaultList?: string }>(function QuickAdd({ lists, defaultList }, ref) {
  const { changed, toast } = useApp();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [list, setList] = useState(defaultList ?? '');
  const [course, setCourse] = useState('');
  const [est, setEst] = useState('');
  const [sizeAmount, setSizeAmount] = useState('');
  const [sizeUnit, setSizeUnit] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useQuickPreview(title, due);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const t = await api.addTask({ title: title.trim(), parseTitle: true, due: due.trim() || undefined, list: (defaultList ?? list) || undefined, course: course.trim() || undefined, est: est ? Number(est) : undefined, size: sizeAmount.trim() && sizeUnit ? { amount: Number(sizeAmount), unit: sizeUnit } : undefined });
      setTitle(''); setDue(''); setEst(''); setSizeAmount(''); setSizeUnit(''); setError(null);
      toast(`Added #${t.id} ${t.title}${t.due ? ` (due ${t.dueText}${t.timeAssumed ? ', time assumed' : ''})` : ''}`);
      changed();
    } catch (err) { setError(errText(err)); }
  }

  return (
    <form className="quickadd" onSubmit={submit} aria-label="Quick add">
      <input ref={ref} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task…  (Ctrl/Cmd+K)" aria-label="Task title" className="grow" />
      <input value={due} onChange={(e) => setDue(e.target.value)} placeholder="due: fri 5pm" aria-label="Due date" size={14} />
      {more && (
        <>
          {!defaultList && <select value={list} onChange={(e) => setList(e.target.value)} aria-label="List"><option value="">(no list)</option>{lists.map((l) => <option key={l}>{l}</option>)}</select>}
          <input value={course} onChange={(e) => setCourse(e.target.value)} placeholder="course" aria-label="Course" size={10} />
          <input value={est} onChange={(e) => setEst(e.target.value.replace(/\D/g, ''))} placeholder="min" aria-label="Estimate in minutes" size={4} />
          <input value={sizeAmount} onChange={(e) => setSizeAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="size" aria-label="Size amount" size={5} inputMode="decimal" />
          <select value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value)} aria-label="Size unit"><option value="">(unit)</option>{['pages', 'video_minutes', 'problems', 'items', 'points'].map((u) => <option key={u}>{u}</option>)}</select>
        </>
      )}
      <button type="button" onClick={() => setMore(!more)} aria-expanded={more}>{more ? 'Less' : 'More'}</button>
      <button className="primary" type="submit">Add</button>
      {preview && <PreviewLine preview={preview} />}
      {error && <div className="note error" role="alert">{error}</div>}
    </form>
  );
});
