import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { errText } from './ctx';
import { PreviewLine, useQuickPreview } from './components/QuickAdd';
import { TallyMark } from './ui';

/**
 * The small window opened by the global shortcut (and the menu-bar entry). One box: type the task and, if you like, its due
 * date ("written homework due friday 5pm"). Enter adds it, Esc closes. It uses the same parser and preview as quick-add
 * in the main window, because both call the same function in the main process.
 */
export function QuickWindow() {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const preview = useQuickPreview(title);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.appInfo().then((i) => setDemo(i.demo)).catch(() => {});
    // every time the window is shown again, start with a clean box
    const fresh = () => { if (closing.current) clearTimeout(closing.current); closing.current = null; setTitle(''); setError(null); setDone(null); setBusy(false); setTimeout(() => input.current?.focus(), 0); };
    window.addEventListener('focus', fresh);
    input.current?.focus();
    return () => window.removeEventListener('focus', fresh);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const t = await api.addTask({ title: title.trim(), parseTitle: true });
      setError(null);
      setDone(`Added #${t.id} “${t.title}”${t.due ? ` · due ${t.dueText}${t.timeAssumed ? ' (time assumed)' : ''}` : ''}`);
      closing.current = setTimeout(() => void api.hideQuick(), 900);
    } catch (err) { setError(errText(err)); setBusy(false); }
  }

  return (
    <form className="quickwin" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') void api.hideQuick(); }} aria-label="Quick add">
      <div className="qw-head"><span className="mark"><TallyMark size={20} /></span><strong>Quick add</strong>{demo && <span className="chip warn">DEMO</span>}<span className="muted">Enter to add · Esc to close</span></div>
      <input ref={input} value={title} onChange={(e) => { setTitle(e.target.value); setDone(null); setBusy(false); }} placeholder="e.g. written homework due friday 5pm" aria-label="Task" autoFocus disabled={!!done} />
      {preview && !done && <PreviewLine preview={preview} />}
      {done && <div className="note ok" role="status" data-testid="quick-done">{done}</div>}
      {error && <div className="note error" role="alert">{error}</div>}
      <button type="submit" className="primary" disabled={!title.trim() || busy || !!done}>Add</button>
    </form>
  );
}
