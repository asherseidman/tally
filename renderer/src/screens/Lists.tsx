import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errText, fmtMinutes, useApp } from '../ctx';
import { QuickAdd } from '../components/QuickAdd';
import { Icon, courseClass, shortDate } from '../ui';
import type { ListInfo, TaskDto } from '../../../src/app/types';

const NONE = '__none__';

/** Move the item at `from` to the slot of `to` (drag-and-drop order). */
export const reorder = <T,>(xs: T[], from: number, to: number): T[] => {
  const out = [...xs];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
};

export function Lists({ quickRef }: { quickRef: React.RefObject<HTMLInputElement | null> }) {
  const { version, toast, changed, openTask } = useApp();
  const [lists, setLists] = useState<ListInfo[]>([]);
  const [sel, setSel] = useState<string>(NONE);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [dragList, setDragList] = useState<number | null>(null);
  const [dragTask, setDragTask] = useState<number | null>(null); // index within the visible rows
  const [dragTaskId, setDragTaskId] = useState<number | null>(null); // the task being dragged (can be dropped on the sidebar)
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(errText(e));

  const load = useCallback(() => {
    api.lists().then(setLists).catch(fail);
    api.tasks({ list: sel === NONE ? 'none' : sel, status: showDone ? 'all' : 'open' }).then((t) => { setTasks(t); setError(null); }).catch(fail);
  }, [sel, showDone]);
  useEffect(load, [load, version]);

  const current = lists.find((l) => l.name === sel);

  /** drop a dragged task on a sidebar entry: move it to that list ('' = no list) */
  function dropTaskOn(listName: string) {
    const id = dragTaskId;
    setDragTaskId(null); setDragTask(null); setDropOn(null);
    if (id == null) return;
    const t = tasks.find((x) => x.id === id);
    const target = listName === '' ? null : listName;
    if (t && (t.listName ?? null) === target) return; // already there
    api.moveTask(id, listName).then(() => { toast(`Moved “${t?.title ?? `#${id}`}” to ${target ?? 'No list'}.`); changed(); }).catch(fail);
  }
  // reordering saves under the open list's key, or the "no list" key
  const orderListId = current ? current.id : null;

  return (
    <div className="lists">
      <aside className="sidebar" aria-label="Lists">
        <h2>Lists</h2>
        <ul>
          <li
            className={dropOn === NONE ? 'dropping' : ''}
            onDragOver={(e) => { if (dragTaskId != null) { e.preventDefault(); setDropOn(NONE); } }} onDragLeave={() => setDropOn(null)}
            onDrop={(e) => { e.preventDefault(); dropTaskOn(''); }}
          ><button className={`listbtn ${sel === NONE ? 'active' : ''}`} onClick={() => setSel(NONE)}>No list</button></li>
          {lists.map((l, i) => (
            <li
              key={l.id} draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', l.name); setDragList(i); }}
              onDragOver={(e) => { e.preventDefault(); if (dragTaskId != null) setDropOn(l.name); }} onDragLeave={() => setDropOn(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragTaskId != null) { dropTaskOn(l.name); return; }
                if (dragList != null && dragList !== i) api.reorderLists(reorder(lists, dragList, i).map((x) => x.id)).then(setLists).catch(fail);
                setDragList(null);
              }}
              className={`draggable ${dropOn === l.name ? 'dropping' : ''}`}
            >
              {renaming === l.name ? (
                <form onSubmit={(e) => { e.preventDefault(); api.renameList(l.name, renameTo).then((r) => { setLists(r); if (sel === l.name) setSel(renameTo.trim()); setRenaming(null); changed(); }).catch(fail); }}>
                  <input autoFocus value={renameTo} onChange={(e) => setRenameTo(e.target.value)} aria-label="New list name" onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
                </form>
              ) : (
                <button className={`listbtn ${sel === l.name ? 'active' : ''}`} onClick={() => setSel(l.name)} title="Drag to reorder">
                  <span aria-hidden>⋮⋮ </span>{l.name} <span className="count">{l.open}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
        <form className="newlist" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) api.createList(newName.trim()).then((r) => { setLists(r); setSel(newName.trim()); setNewName(''); }).catch(fail); }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New list…" aria-label="New list name" />
          <button type="submit">Add</button>
        </form>
      </aside>

      <section className="listmain">
        <div className="listhead">
          <h2>{sel === NONE ? 'Tasks with no list' : sel}</h2>
          <span className="spacer" />
          <label className="toggle"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done</label>
          {current && (
            confirmDel === current.name ? (
              <>
                <span className="muted">Delete “{current.name}”? Its tasks are kept.</span>
                <button onClick={() => api.deleteList(current.name).then((r) => { setLists(r.lists); setSel(NONE); setConfirmDel(null); toast(`Deleted list; ${r.tasksUnlinked} task(s) kept without a list.`); changed(); }).catch(fail)}>Yes, delete</button>
                <button onClick={() => setConfirmDel(null)}>Cancel</button>
              </>
            ) : (
              <>
                <button onClick={() => { setRenaming(current.name); setRenameTo(current.name); }}>Rename</button>
                <button onClick={() => setConfirmDel(current.name)}>Delete list</button>
              </>
            )
          )}
        </div>
        <QuickAdd ref={quickRef} lists={lists.map((l) => l.name)} defaultList={sel === NONE ? undefined : sel} />
        {error && <div className="note error" role="alert">{error}</div>}
        {tasks.length === 0 ? <p className="muted">Nothing here yet.</p> : (
          <ul className="rows">
            {tasks.map((t, i) => (
              <li
                key={t.id} className={`row draggable ${t.status === 'done' ? 'done' : ''}`} draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.title); setDragTask(i); setDragTaskId(t.id); }}
                onDragEnd={() => { setDragTask(null); setDragTaskId(null); setDropOn(null); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragTask != null && dragTask !== i) {
                    const next = reorder(tasks, dragTask, i);
                    setTasks(next);
                    api.reorderTasks(orderListId, next.map((x) => x.id)).catch(fail);
                  }
                  setDragTask(null); setDragTaskId(null);
                }}
              >
                <input className="check" type="checkbox" aria-label={`Mark "${t.title}" done`} checked={t.status === 'done'} onChange={() => (t.status === 'done' ? api.undone(t.id) : api.done(t.id)).then(changed).catch(fail)} />
                <button className="link-title" onClick={() => openTask(t.id)}>{t.title}</button>
                {t.course && <span className={`chip ${courseClass(t.course)}`}>{t.course}</span>}
                <span className="rowdue">{t.due ? `${shortDate(t.dueText)}${t.timeAssumed ? ' *' : ''}` : ''}</span>
                <span className="meta">{t.estimate != null ? <>{Icon.hourglass(13)}{fmtMinutes(t.estimate)}</> : null}</span>
              </li>
            ))}
          </ul>
        )}
        {tasks.length > 0 && <p className="hint">Drag a row to reorder it, or drop it on a list in the sidebar to move it there.</p>}
      </section>
    </div>
  );
}
