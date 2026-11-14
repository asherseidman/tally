// Second launch of the app on the same demo database (npm run smoke:ui). Checks that what the first launch saved is still there:
// the drag order of unlisted tasks and the task moved onto a list.
(async () => {
  const get = async (list) => (await window.planner.invoke('tasks.list', { list })).value.map((t) => t.title);
  const none = (await get('none')).filter((t) => t.startsWith('SMOKE u'));
  const inList = (await get('SMOKE list')).filter((t) => t.startsWith('SMOKE u'));
  const steps = [
    { name: 'unlisted order survived a restart', ok: none.join() === 'SMOKE u3,SMOKE u1', info: none },
    { name: 'the task dragged onto a list is still there after a restart', ok: inList.join() === 'SMOKE u2', info: inList },
  ];
  return JSON.stringify({ steps, errors: [] });
})()
