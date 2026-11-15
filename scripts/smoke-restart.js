// Second launch of the app on the same demo database (npm run smoke:ui). Checks that what the first launch saved is still there:
// the drag order of unlisted tasks and the task moved onto a list.
(async () => {
  const get = async (list) => (await window.planner.invoke('tasks.list', { list })).value.map((t) => t.title);
  const none = (await get('none')).filter((t) => t.startsWith('SMOKE u'));
  const inList = (await get('SMOKE list')).filter((t) => t.startsWith('SMOKE u'));
  // the color scheme chosen in the first launch (violet) is still applied after a restart, in the stylesheet and in the saved setting
  const waitFor = async (fn) => { for (let i = 0; i < 60 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); return fn(); };
  const bar = () => getComputedStyle(document.documentElement).getPropertyValue('--bar-bg').trim().toUpperCase();
  await waitFor(() => document.getElementById('tally-scheme'));
  const ap = (await window.planner.invoke('appearance.get')).value;
  const steps0 = [{ name: 'the color scheme survived a restart', ok: ap.value === 'violet' && !!document.getElementById('tally-scheme') && ap.css.toLowerCase().includes('--bar-bg:' + bar().toLowerCase()), info: ap.value + ' ' + bar() }];
  const steps = [
    { name: 'unlisted order survived a restart', ok: none.join() === 'SMOKE u3,SMOKE u1', info: none },
    { name: 'the task dragged onto a list is still there after a restart', ok: inList.join() === 'SMOKE u2', info: inList },
  ];
  return JSON.stringify({ steps: [...steps0, ...steps], errors: [] });
})()
