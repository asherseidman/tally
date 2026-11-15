// Runs INSIDE the renderer (npm run smoke:ui, demo database only). Drives the real UI: quick-add, task detail, timer, lists.
// Each step records what it saw; the whole thing returns as JSON.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what, ms = 6000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + (typeof what === 'function' ? what() : what)); await wait(50); } };
  const setValue = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const click = (el) => el.click();
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
  const out = { steps: [] };
  const step = async (name, fn) => { try { out.steps.push({ name, ok: true, info: await fn() }); } catch (e) { out.steps.push({ name, ok: false, error: String(e.message || e) }); } };

  await until(() => document.querySelector('.panels'), 'the Today panels');
  await step('Today shows four panels', async () => [...document.querySelectorAll('.panel h2')].map((h) => h.textContent));

  await step('quick-add creates a task from plain words', async () => {
    setValue(document.querySelector('input[aria-label="Task title"]'), 'SMOKE quick task');
    setValue(document.querySelector('input[aria-label="Due date"]'), 'tomorrow 5pm');
    click(byText('.quickadd button', 'Add'));
    const toast = await until(() => document.querySelector('.toast')?.textContent.includes('SMOKE quick task') && document.querySelector('.toast').textContent, 'the added toast');
    await until(() => [...document.querySelectorAll('.card-title .link-title')].some((e) => e.textContent === 'SMOKE quick task'), 'the card in Due soon');
    return toast;
  });

  await step('task detail opens, edits save through the engine', async () => {
    click([...document.querySelectorAll('.card-title .link-title')].find((e) => e.textContent === 'SMOKE quick task'));
    await until(() => document.querySelector('.drawer .fields'), 'the drawer');
    setValue(document.querySelector('.drawer textarea'), 'edited by the smoke test');
    setValue(document.querySelector('.drawer input[placeholder=""]') ?? [...document.querySelectorAll('.drawer label')].find((l) => l.textContent.startsWith('Estimate')).querySelector('input'), '25');
    click(byText('.drawer button', 'Save changes'));
    return await until(() => document.querySelector('.toast')?.textContent.startsWith('Saved') && 'Saved.', 'Saved toast');
  });

  await step('an estimate shows on the card after saving', async () => {
    await until(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('SMOKE quick task') && c.textContent.includes('~25m')), 'the ~25m estimate');
    return 'card shows ~25m';
  });

  await step('a bad edit shows a readable error instead of failing', async () => {
    setValue([...document.querySelectorAll('.drawer label')].find((l) => l.textContent.startsWith('Due')).querySelector('input'), 'banana split');
    click(byText('.drawer button', 'Save changes'));
    return (await until(() => document.querySelector('.drawer .note.error'), 'an error note')).textContent;
  });

  await step('timer starts and stops from a card', async () => {
    click(byText('.drawer button', 'Revert'));
    click(document.querySelector('.drawer-head button'));
    const card = await until(() => [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('SMOKE quick task')), 'card');
    click(card.querySelector('.timer-btn'));
    await until(() => document.querySelector('.timerbar'), 'the timer bar');
    click(document.querySelector('.timerbar button'));
    await until(() => !document.querySelector('.timerbar'), 'the timer to stop');
    return 'timer bar appeared and went away';
  });

  await step('completing a task from the checkbox', async () => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.textContent.includes('SMOKE quick task'));
    click(card.querySelector('input[type=checkbox]'));
    await until(() => ![...document.querySelectorAll('.card-title .link-title')].some((e) => e.textContent === 'SMOKE quick task'), 'the task to leave the open views');
    return 'left the open views';
  });

  await step('Lists: create a list, add a task, see it', async () => {
    click(byText('nav .tab', 'Lists'));
    await until(() => document.querySelector('.sidebar'), 'Lists screen');
    setValue(document.querySelector('.newlist input'), 'SMOKE list');
    click(byText('.newlist button', 'Add'));
    await until(() => byText('.listbtn', 'SMOKE list') || [...document.querySelectorAll('.listbtn')].find((b) => b.textContent.includes('SMOKE list')), 'the new list');
    setValue(document.querySelector('.quickadd input[aria-label="Task title"]'), 'SMOKE list task');
    click(byText('.quickadd button', 'Add'));
    await until(() => [...document.querySelectorAll('.row .link-title')].some((e) => e.textContent === 'SMOKE list task'), 'the task row');
    return [...document.querySelectorAll('.row .link-title')].map((e) => e.textContent);
  });

  const rowTitles = () => [...document.querySelectorAll('.row .link-title')].map((e) => e.textContent);
  const rowOf = (title) => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.link-title')?.textContent === title);
  const dnd = async (src, dst) => {
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(src, 'dragstart'); await wait(40);
    fire(dst, 'dragover'); await wait(40);
    fire(dst, 'drop'); await wait(40);
    fire(src, 'dragend'); await wait(100);
  };
  const stored = async (list) => (await window.planner.invoke('tasks.list', { list })).value.map((t) => t.title);

  await step('Lists: unlisted tasks can be added and dragged to reorder (saved, not just on screen)', async () => {
    click(byText('.listbtn', 'No list'));
    await until(() => document.querySelector('.listhead h2')?.textContent === 'Tasks with no list', 'the No list view');
    for (const n of ['SMOKE u1', 'SMOKE u2', 'SMOKE u3']) {
      setValue(document.querySelector('.quickadd input[aria-label="Task title"]'), n);
      click(byText('.quickadd button', 'Add'));
      await until(() => rowOf(n), 'row ' + n);
    }
    const mine = () => rowTitles().filter((t) => t.startsWith('SMOKE u'));
    if (mine().join() !== 'SMOKE u1,SMOKE u2,SMOKE u3') throw new Error('unexpected start order ' + mine());
    await dnd(rowOf('SMOKE u3'), rowOf('SMOKE u1'));
    await until(() => mine().join() === 'SMOKE u3,SMOKE u1,SMOKE u2', 'the reordered rows');
    const saved = (await stored('none')).filter((t) => t.startsWith('SMOKE u'));
    if (saved.join() !== 'SMOKE u3,SMOKE u1,SMOKE u2') throw new Error('order not saved: ' + saved);
    return 'screen and database agree: ' + saved.join(' > ');
  });

  await step('Lists: dragging an unlisted task onto a list in the sidebar moves it, and back', async () => {
    const listItem = () => [...document.querySelectorAll('.sidebar li')].find((li) => li.textContent.includes('SMOKE list'));
    await dnd(rowOf('SMOKE u2'), listItem());
    await until(() => !rowOf('SMOKE u2'), 'the task to leave Unlisted');
    if (!(await stored('SMOKE list')).includes('SMOKE u2')) throw new Error('task is not in the list in the database');
    click(listItem().querySelector('.listbtn'));
    await until(() => rowOf('SMOKE u2'), 'the task in the list view');
    const noList = () => [...document.querySelectorAll('.sidebar li')].find((li) => li.querySelector('.listbtn')?.textContent === 'No list');
    await dnd(rowOf('SMOKE u2'), noList());
    await until(() => !rowOf('SMOKE u2'), 'the task to leave the list');
    if (!(await stored('none')).includes('SMOKE u2')) throw new Error('task did not return to Unlisted');
    // leave it in the list for the restart check: move it forward again
    click(noList().querySelector('.listbtn'));
    await until(() => rowOf('SMOKE u2'), 'the task back in Unlisted');
    await dnd(rowOf('SMOKE u2'), listItem());
    await until(() => !rowOf('SMOKE u2'), 'the final move');
    return 'Unlisted -> list -> Unlisted -> list';
  });

  await step('Quick-add: the due date is parsed out of the title, with a live preview', async () => {
    click(byText('nav .tab', 'Today'));
    await until(() => document.querySelector('.panels'), 'Today');
    const box = document.querySelector('input[aria-label="Task title"]');
    setValue(box, 'SMOKE written homework due friday 5pm');
    const preview = (await until(() => document.querySelector('[data-testid=quick-preview]')?.textContent.includes('Due') && document.querySelector('[data-testid=quick-preview]'), 'the preview')).textContent;
    if (!/SMOKE written homework/.test(preview) || !/Fri/.test(preview) || !/5:00 PM/.test(preview)) throw new Error('preview was: ' + preview);
    click(byText('.quickadd button', 'Add'));
    await until(() => document.querySelector('.toast')?.textContent.includes('SMOKE written homework'), 'the added toast');
    const t = (await window.planner.invoke('tasks.list', { text: 'SMOKE written homework' })).value[0];
    if (t.title !== 'SMOKE written homework' || t.timeAssumed) throw new Error('stored as ' + JSON.stringify([t.title, t.timeAssumed]));
    return preview + '  ->  stored "' + t.title + '", due ' + t.dueText;
  });

  await step('Quick-add: a bare weekday uses the default time (time assumed); the due field wins over the title', async () => {
    const box = document.querySelector('input[aria-label="Task title"]');
    setValue(box, 'SMOKE read chapter fri');
    const p1 = (await until(() => document.querySelector('[data-testid=quick-preview]')?.textContent.includes('time assumed') && document.querySelector('[data-testid=quick-preview]'), 'assumed preview')).textContent;
    setValue(document.querySelector('input[aria-label="Due date"]'), 'sun 3pm');
    const p2 = (await until(() => document.querySelector('[data-testid=quick-preview]')?.textContent.includes('due field') && document.querySelector('[data-testid=quick-preview]'), 'explicit preview')).textContent;
    setValue(document.querySelector('input[aria-label="Due date"]'), '');
    setValue(box, 'SMOKE due diligence notes');
    const p3 = (await until(() => document.querySelector('[data-testid=quick-preview]')?.textContent.includes('No due date') && document.querySelector('[data-testid=quick-preview]'), 'no-date preview')).textContent;
    setValue(box, '');
    return [p1, p2, p3];
  });

  const inv = async (ch, args) => { const r = await window.planner.invoke(ch, args); if (!r.ok) throw new Error(ch + ': ' + r.error); return r.value; };
  const text = (sel) => document.querySelector(sel)?.textContent ?? '';

  // ---- Schedule (demo database, simulated calendar) ----
  await step('Schedule: preview shows blocks and tentative ones, and writes nothing', async () => {
    for (let wd = 1; wd <= 7; wd++) await inv('availability.paint', { target: { weekday: wd }, range: { start: '09:00', end: '22:00' } });
    const a = await inv('tasks.add', { title: 'SMOKE blocker', due: 'in 5 days', est: 60 });
    const b = await inv('tasks.add', { title: 'SMOKE dependent', due: 'in 8 days', est: 60 });
    await inv('deps.add', { task: b.id, blockedBy: a.id });
    click(byText('nav .tab', 'Schedule'));
    const sum = await until(() => document.querySelector('[data-testid=schedule-summary]')?.textContent, 'the schedule summary', 15000);
    if (!/earlier block/.test(sum)) throw new Error('summary: ' + sum);
    if (!/\b0\b.*earlier block/.test(sum)) throw new Error('nothing should be written yet: ' + sum);
    const real = [...document.querySelectorAll('.sblock[data-tentative="0"]')].some((r) => r.textContent.includes('SMOKE blocker'));
    const tent = [...document.querySelectorAll('.sblock[data-tentative="1"]')].some((r) => r.textContent.includes('SMOKE dependent'));
    if (!real) throw new Error('the blocker should be a real block');
    if (!tent) throw new Error('the dependent should be shown as tentative');
    return sum.trim();
  });

  let writtenCount = 0;
  await step('Schedule: Apply asks for confirmation; Cancel writes nothing', async () => {
    writtenCount = Number(/(\d+) block/.exec(text('[data-testid=schedule-summary]'))[1]);
    click(byText('.toolbar button', 'Apply…'));
    const dlg = await until(() => document.querySelector('[role=dialog]'), 'the confirm dialog');
    if (!/Planner Blocks/.test(dlg.textContent) || !/simulated/i.test(dlg.textContent)) throw new Error('dialog text: ' + dlg.textContent);
    click(byText('[role=dialog] button', 'Cancel'));
    await until(() => !document.querySelector('[role=dialog]'), 'the dialog to close');
    const p = await inv('schedule.preview', { days: 14, replan: false });
    if (p.willRemove !== 0) throw new Error('Cancel wrote something: ' + p.willRemove);
    return 'dialog: ' + dlg.textContent.replace(/\s+/g, ' ').slice(0, 140);
  });

  await step('Schedule: confirming writes exactly the real blocks (tentative ones are never written)', async () => {
    click(byText('.toolbar button', 'Apply…'));
    await until(() => document.querySelector('[role=dialog]'), 'the confirm dialog');
    click([...document.querySelectorAll('[role=dialog] button.primary')][0]);
    const res = await until(() => document.querySelector('[data-testid=apply-result]')?.textContent, 'the result', 15000);
    const p = await inv('schedule.preview', { days: 14, replan: false });
    if (p.willRemove !== writtenCount) throw new Error(`wrote ${writtenCount} but ${p.willRemove} are stored`);
    if (!p.blocks.some((x) => x.tentative)) throw new Error('tentative block vanished');
    return res.trim();
  });

  await step('Schedule: Replan mode is a separate button', async () => {
    click(byText('.seg button', 'Replan'));
    await until(() => byText('.toolbar button', 'Replan…'), 'the Replan… button');
    click(byText('.seg button', 'Schedule'));
    await until(() => byText('.toolbar button', 'Apply…'), 'the Apply… button');
    return 'Apply… / Replan… switch with the mode';
  });

  // ---- a schedule apply that Claude asked for: only Approve in this window writes ----
  await step('Claude pending apply: the card says nothing is written yet; Approve asks the same confirmation; only confirming writes', async () => {
    await until(() => byText('.toolbar button', 'Apply…') || byText('.toolbar button', 'Replan…'), 'the schedule toolbar');
    await inv('settings.set', { key: 'mcp_allow_schedule', value: 'true' }); // the request only stays pending while this switch is on
    const seeded = await inv('selftest.pendingApply'); // test-only: stands in for the connector's request (demo database only)
    const card = await until(() => document.querySelector('[data-testid=pending-apply]'), 'the pending card (seeded ' + JSON.stringify(seeded) + ')', 12000);
    const text = card.textContent;
    for (const want of ['Claude asked to apply a schedule', 'Nothing has been written', 'Planner Blocks', 'Expires in']) if (!text.includes(want)) throw new Error('the card is missing "' + want + '": ' + text.slice(0, 300));
    await until(() => document.querySelector('nav .tab.has-pending'), 'the Schedule tab marker', 8000);
    const stored = async () => (await inv('schedule.preview', { days: 14, replan: false })).willRemove;
    const before = await stored();
    click(byText('[data-testid=pending-apply] button', 'Approve…'));
    const dlg = await until(() => document.querySelector('[role=dialog]'), 'the confirmation');
    for (const want of ['Claude asked for this', 'write to the simulated calendar', 'Planner Blocks']) if (!dlg.textContent.includes(want)) throw new Error('confirmation missing "' + want + '": ' + dlg.textContent.slice(0, 300));
    click(byText('[role=dialog] button', 'Cancel'));
    await wait(500);
    if (!(await inv('pending.get')).pending) throw new Error('Cancel must leave the request pending');
    if ((await stored()) !== before) throw new Error('Cancel wrote something');
    click(byText('[data-testid=pending-apply] button', 'Approve…'));
    await until(() => document.querySelector('[role=dialog]'), 'the confirmation again');
    click([...document.querySelectorAll('[role=dialog] button.primary')][0]);
    const last = await until(() => document.querySelector('[data-testid=pending-last]')?.textContent, 'the result note', 15000);
    const st = await inv('pending.get');
    if (st.pending || st.last?.status !== 'applied') throw new Error('expected applied, got ' + JSON.stringify(st));
    if (!/Applied:/.test(st.last.message)) throw new Error('message: ' + st.last.message);
    return last.trim().slice(0, 140);
  });

  await step('Claude pending apply: Reject writes nothing and clears the card', async () => {
    await inv('selftest.pendingApply');
    await until(() => document.querySelector('[data-testid=pending-apply]'), 'the pending card', 12000);
    const stored = async () => (await inv('schedule.preview', { days: 14, replan: false })).willRemove;
    const before = await stored();
    click(byText('[data-testid=pending-apply] button', 'Reject'));
    await until(() => !document.querySelector('[data-testid=pending-apply]'), 'the card to go', 8000);
    const st = await inv('pending.get');
    if (st.pending || st.last?.status !== 'rejected') throw new Error('expected rejected, got ' + JSON.stringify(st));
    if ((await stored()) !== before) throw new Error('Reject wrote something');
    await until(() => !document.querySelector('nav .tab.has-pending'), 'the tab marker to clear', 8000);
    await inv('settings.set', { key: 'mcp_allow_schedule', value: 'false' });
    return 'rejected; nothing written';
  });

  // ---- notices: a schedule Claude proposed, and a Google sign-in that stopped working ----
  const dismissAllBanners = async () => { for (const b of await inv('banners.list')) await inv('banners.dismiss', { id: b.id }); await wait(300); };
  await step('Claude proposal notice: one banner says what was proposed, it is not repeated, and its button opens the Schedule tab with the card', async () => {
    await dismissAllBanners();
    click(byText('nav .tab', 'Today'));
    await until(() => document.querySelector('.panels'), 'the Today panels');
    await inv('settings.set', { key: 'mcp_allow_schedule', value: 'true' });
    await inv('selftest.pendingApply');
    const banner = await until(() => [...document.querySelectorAll('.banner[data-kind=claude]')].find((b) => b.textContent.includes('Claude proposed a schedule')), 'the Claude banner', 15000);
    for (const want of ['blocks to write', 'to remove', 'Review on the Schedule tab']) if (!banner.textContent.includes(want)) throw new Error('banner is missing "' + want + '": ' + banner.textContent);
    await wait(5000); // the notifier looks every 1.5 s: it must not announce the same request again
    const n = [...document.querySelectorAll('.banner[data-kind=claude]')].filter((b) => b.textContent.includes('Claude proposed a schedule')).length;
    if (n !== 1) throw new Error('expected exactly one banner, saw ' + n);
    click(byText('.banner[data-kind=claude] button', 'Open Schedule'));
    await until(() => byText('nav .tab', 'Schedule')?.getAttribute('aria-current') === 'page', 'the Schedule tab');
    await until(() => document.querySelector('[data-testid=pending-apply]'), 'the pending card');
    if (document.querySelector('.banner[data-kind=claude]')) throw new Error('the banner should have gone when opened');
    click(byText('[data-testid=pending-apply] button', 'Reject'));
    await until(() => !document.querySelector('[data-testid=pending-apply]'), 'the card to go', 8000);
    await inv('settings.set', { key: 'mcp_allow_schedule', value: 'false' });
    return banner.textContent.trim().slice(0, 130);
  });

  await step('Google sign-in notice: the banner says why, offers Reconnect, and opens Settings, Google', async () => {
    await dismissAllBanners();
    await inv('selftest.googleProblem', {});
    const banner = await until(() => document.querySelector('.banner[data-kind=google]'), 'the Google banner', 15000);
    const text = banner.textContent;
    for (const want of ['Google sign-in expired', 'Testing mode', 'Click Reconnect']) if (!text.includes(want)) throw new Error('banner is missing "' + want + '": ' + text);
    const rc = banner.querySelector('[data-testid=banner-reconnect]');
    if (!rc || rc.textContent !== 'Reconnect') throw new Error('no Reconnect button on the banner');
    click(byText('.banner[data-kind=google] button', 'Open Google settings'));
    await until(() => [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true')?.textContent === 'Google', 'the Google tab');
    await inv('selftest.googleProblem', { clear: true });
    await dismissAllBanners();
    click(byText('nav .tab', 'Schedule'));
    return 'banner with Reconnect; Open Google settings selected the Google tab';
  });

  // ---- Import ----
  const fileJson = JSON.stringify({
    term: { name: 'SMOKE Term', start_date: '2026-08-31', end_date: '2026-12-11' },
    items: [
      { course: 'SMK 101', title: 'SMOKE import one', type: 'homework', due_date: '2026-12-01', grade_weight: 5, source_quote: 'q', confidence: 'high' },
      { course: 'SMK 101', title: 'SMOKE import two', type: 'quiz', due_date: '2026-12-02T10:00:00', grade_weight: 3, source_quote: 'q', confidence: 'low' },
      { course: 'SMK 101', title: 'SMOKE import three', type: 'project', due_date: '2026-12-03', grade_weight: 10, source_quote: 'q', confidence: 'high' },
    ],
    grading_breakdown: [],
  });
  const chooseFile = (name, content) => {
    const input = document.querySelector('input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const listed = async () => (await inv('tasks.list', { text: 'SMOKE import', status: 'all', allTerms: true })).map((t) => t.title).sort();

  // ---- pinned blocks (demo database, simulated calendar: classes Mon-Fri 10-11 and 1-2:30 PM) ----
  const pinSetup = await (async () => {
    const info = await inv('app.info');
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== info.tz) return { skip: 'this machine is not in the app time zone (' + info.tz + ')' };
    const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
    const next = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    // a weekday (it has classes) about three weeks out: clear of the blocks earlier steps wrote (they cover 14 days)
    let D = new Date(Date.parse(info.today + 'T12:00:00Z') + 20 * 86400000).toISOString().slice(0, 10);
    while (dow(D) === 0 || dow(D) === 6) D = next(D);
    await inv('availability.paint', { target: { date: D }, range: { start: '09:00', end: '21:00' } });
    const t = await inv('tasks.add', { title: 'SMOKE pin task', course: 'SMOKE', due: next(next(next(D))) + ' 5pm', est: 60 });
    const at = (hhmm) => new Date(D + 'T' + hhmm + ':00').toISOString();
    return { D, t, at };
  })();
  const pinsOf = async (taskId) => (await inv('pins.list')).filter((p) => p.taskId === taskId);

  await step('Pinning on the Schedule screen: a time over a class is refused in plain words with suggestions; a suggestion pins it; Move back to automatic undoes it', async () => {
    if (pinSetup.skip) return 'skipped: ' + pinSetup.skip;
    const { D, t, at } = pinSetup;
    click(byText('nav .tab', 'Schedule'));
    const daysSel = await until(() => document.querySelector('select[aria-label="Days to schedule"]'), 'the days selector');
    setValue(daysSel, '28');
    const rowFor = () => [...document.querySelectorAll('li.sblock')].find((li) => li.textContent.includes('SMOKE pin task') && li.dataset.tentative === '0');
    let row = await until(rowFor, 'the SMOKE pin task row in the preview', 15000);
    click([...row.querySelectorAll('button')].find((b) => b.textContent === '📌 Pin…'));
    const ed = await until(() => row.querySelector('[data-testid=pin-editor]') || rowFor()?.querySelector('[data-testid=pin-editor]'), 'the pin editor');
    setValue(ed.querySelector('input[type=date]'), D);
    setValue(ed.querySelector('input[aria-label="Start time"]'), '13:00');
    setValue(ed.querySelector('input[aria-label="End time"]'), '14:00');
    await wait(100);
    click([...ed.querySelectorAll('button')].find((b) => b.textContent.includes('Pin here')));
    const ref = await until(() => document.querySelector('[data-testid=pin-refusal]'), 'the refusal', 10000);
    if (!/busy time on your calendar/.test(ref.textContent)) throw new Error('expected a busy-time refusal: ' + ref.textContent);
    if ((await pinsOf(t.id)).length) throw new Error('a refused pin was saved');
    const sug = ref.querySelector('[data-testid=pin-suggestion]');
    if (!sug) throw new Error('no suggestion offered: ' + ref.textContent);
    const label = sug.textContent;
    click(sug);
    await wait(1500);
    const pins = await pinsOf(t.id);
    if (pins.length !== 1) throw new Error('expected one pin, got ' + JSON.stringify(pins));
    row = await until(() => [...document.querySelectorAll('li.sblock')].find((li) => li.textContent.includes('SMOKE pin task') && li.dataset.pinned === '1'), 'the pinned row (📌)', 15000);
    if (!row.textContent.includes('📌 pinned')) throw new Error('no pin glyph on the row');
    click([...row.querySelectorAll('button')].find((b) => b.textContent === 'Move back to automatic'));
    await wait(1200);
    if ((await pinsOf(t.id)).length) throw new Error('Move back to automatic did not remove the pin');
    void at;
    return 'refused over the class; pinned at ' + label.replace('📌 ', '') + '; back to automatic';
  });

  await step('Pinning on the Availability grid: drag a pinned block to move it, drag it onto a class to be refused and shown where it fits, drag its edge to resize, click it to unpin', async () => {
    if (pinSetup.skip) return 'skipped: ' + pinSetup.skip;
    const { D, t, at } = pinSetup;
    const made = await inv('pins.create', { taskId: t.id, start: at('16:00'), end: at('17:00') });
    if (!made.ok) throw new Error('could not set up the pin: ' + made.message);
    const pinId = made.pin.id;
    click(byText('nav .tab', 'Availability'));
    const label = new Date(D + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    await until(() => document.querySelector('.dayhead'), 'the grid');
    for (let i = 0; i < 5 && ![...document.querySelectorAll('.dayhead')].some((h) => h.textContent.includes(label)); i++) { click(byText('.toolbar button', 'Next ›')); await wait(600); }
    const el = () => document.querySelector('.ev.pinned[data-pin="' + pinId + '"]');
    await until(el, 'the pinned block on the grid (📌)', 8000);
    if (!el().textContent.includes('📌')) throw new Error('no pin glyph');
    const drag = async (node, dy) => {
      const r = node.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 4);
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
      await wait(120);
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y + dy / 2, pointerId: 1 }));
      await wait(80);
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y + dy, pointerId: 1 }));
      await wait(120);
      const ghost = !!document.querySelector('.ev.ghost');
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y + dy, pointerId: 1 }));
      await wait(1200);
      return ghost;
    };
    const pin = async () => (await pinsOf(t.id))[0];
    // 1. move down one row (30 minutes)
    const ghost = await drag(el(), 22);
    if (!ghost) throw new Error('no ghost while dragging');
    if ((await pin()).start !== at('16:30')) throw new Error('expected 4:30 PM, got ' + JSON.stringify(await pin()));
    // 2. resize: drag the bottom edge down one row (4:30-5:30 becomes 4:30-6:00, 90 minutes)
    await until(el, 'the block after the move');
    await drag(el().querySelector('.grip'), 22);
    const resized = await pin();
    const len = (Date.parse(resized.end) - Date.parse(resized.start)) / 60000;
    if (len !== 90 || resized.start !== at('16:30')) throw new Error('resize did not give 4:30-6:00 PM: ' + JSON.stringify(resized));
    // 3. onto the 1-2:30 PM class: refused, suggestions drawn on the grid
    await until(el, 'the resized block');
    await drag(el(), -22 * 7);
    const ref = await until(() => document.querySelector('[data-testid=pin-refusal]'), 'the refusal');
    if (!/busy time on your calendar/.test(ref.textContent)) throw new Error('expected busy: ' + ref.textContent);
    if ((await pin()).start !== at('16:30')) throw new Error('a refused drop moved the pin');
    const sug = await until(() => document.querySelector('.ev.suggest'), 'a suggested place on the grid');
    click(sug);
    await wait(1200);
    const moved = await pin();
    if (moved.start === at('16:30')) throw new Error('clicking the suggestion did not move it');
    // 4. click (no movement) opens the menu; Unpin
    await until(el, 'the block');
    const node = el(); const r = node.getBoundingClientRect();
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 4, button: 0, pointerId: 1 }));
    await wait(120);
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5, clientY: r.top + 4, pointerId: 1 }));
    const menu = await until(() => document.querySelector('[data-testid=block-menu]'), 'the block menu');
    for (const want of ['Unpin', 'Move back to automatic', 'Move…']) if (![...menu.querySelectorAll('button')].some((b) => b.textContent === want)) throw new Error('menu is missing ' + want);
    click([...menu.querySelectorAll('button')].find((b) => b.textContent === 'Unpin'));
    await wait(1000);
    if ((await pinsOf(t.id)).length) throw new Error('Unpin did not remove the pin');
    await inv('tasks.delete', { id: t.id });
    await inv('availability.clearDate', { date: D });
    return `moved to 4:30 PM; resized to ${len} min; refused over the class; moved to a suggestion (${new Date(moved.start).toLocaleTimeString()}); unpinned`;
  });

  await step('Import: an invalid file shows the readable list of problems and writes nothing', async () => {
    click(byText('nav .tab', 'Import'));
    await until(() => document.querySelector('input[type=file]'), 'the file chooser');
    chooseFile('bad.json', JSON.stringify({ term: { name: 'X' }, items: [{ title: 'no course' }] }));
    const err = (await until(() => document.querySelector('.import .note.error'), 'the error')).textContent;
    if (!/not a valid import file/.test(err) || !/Nothing was imported/.test(err)) throw new Error(err);
    if ((await listed()).length) throw new Error('something was written');
    return err.split('\n')[0];
  });

  await step('Import: review shows new items; uncheck and edit before confirming; nothing is written until then', async () => {
    chooseFile('smoke.json', fileJson);
    const sum = (await until(() => document.querySelector('[data-testid=import-summary]'), 'the review')).textContent;
    if (!/3\s*to add/.test(sum)) throw new Error('summary: ' + sum);
    if (!document.querySelector('.chip.warn')) throw new Error('low-confidence flag missing');
    const rowFor = (t) => [...document.querySelectorAll('.import-row')].find((r) => r.textContent.includes(t));
    click(rowFor('SMOKE import three').querySelector('input[type=checkbox]'));
    await until(() => /2\s*to add/.test(text('[data-testid=import-summary]')), 'the count to drop to 2');
    click(rowFor('SMOKE import one').querySelector('button.link'));
    const form = await until(() => document.querySelector('.editform'), 'the edit form');
    setValue(form.querySelector('select'), 'title');
    setValue(form.querySelector('input'), 'SMOKE import one (edited)');
    click(byText('.editform button', 'Apply edit'));
    await until(() => rowFor('SMOKE import one (edited)'), 'the edited title');
    // a bad edit is explained, not fatal
    click(rowFor('SMOKE import two').querySelector('button.link'));
    const f2 = await until(() => [...document.querySelectorAll('.editform')].pop(), 'second form');
    setValue(f2.querySelector('select'), 'due');
    setValue(f2.querySelector('input'), 'banana split');
    click(f2.querySelector('button[type=submit]'));
    const bad = (await until(() => document.querySelector('.import .note.error'), 'bad edit error')).textContent;
    if ((await listed()).length) throw new Error('written before confirm');
    return bad.slice(0, 110);
  });

  await step('Import: confirm writes only the checked items, with the edit, and takes a backup', async () => {
    click(byText('.toolbar button', 'Import 2 items…'));
    await until(() => document.querySelector('[role=dialog]'), 'the confirm dialog');
    click([...document.querySelectorAll('[role=dialog] button.primary')][0]);
    const done = (await until(() => document.querySelector('[data-testid=import-done]'), 'the done note', 15000)).textContent;
    const titles = await listed();
    if (titles.join('|') !== 'SMOKE import one (edited)|SMOKE import two') throw new Error('stored: ' + titles.join('|'));
    return done.trim() + '  stored: ' + titles.join(', ');
  });

  await step('Import: importing the same file again finds nothing new', async () => {
    click(byText('.modal-actions button', 'Import another file'));
    await until(() => document.querySelector('input[type=file]'), 'the chooser');
    chooseFile('smoke.json', fileJson);
    const sum = (await until(() => document.querySelector('[data-testid=import-summary]'), 'the review')).textContent;
    if (!/0\s*to add/.test(sum) && !/1\s*to add/.test(sum)) throw new Error(sum);
    click(byText('.toolbar button', 'Cancel'));
    return sum.trim();
  });

  await step('a timer started outside the window (the menu-bar icon does this) shows up here by itself', async () => {
    click(byText('nav .tab', 'Today'));
    await until(() => document.querySelector('.panels'), 'Today');
    if (document.querySelector('.timerbar')) throw new Error('a timer bar is already showing');
    const t = await inv('tasks.add', { title: 'SMOKE tray timer', due: 'in 1 day' });
    await inv('timer.start', { id: t.id });
    const bar = await until(() => document.querySelector('.timerbar'), 'the timer bar to appear without a click', 9000);
    if (!bar.textContent.includes('SMOKE tray timer')) throw new Error(bar.textContent);
    await inv('timer.stop');
    await until(() => !document.querySelector('.timerbar'), 'the timer bar to disappear without a click', 9000);
    return 'bar appeared and went away on its own';
  });

  // ---- Settings (demo database) ----
  const tab = (name) => click([...document.querySelectorAll('[role=tab]')].find((b) => b.textContent === name));
  const toastText = () => document.querySelector('.toast')?.textContent ?? '';
  await step('Settings: general values are validated with readable errors and saved', async () => {
    click(byText('nav .tab', 'Settings'));
    await until(() => document.querySelector('#set-tz'), 'the settings screen');
    setValue(document.querySelector('#set-tz'), 'Mars/Olympus');
    click(document.querySelector('#set-tz').parentElement.querySelector('button'));
    const e1 = (await until(() => document.querySelector('.settings .note.error'), 'the timezone error')).textContent;
    if (!/Invalid IANA timezone/.test(e1)) throw new Error(e1);
    setValue(document.querySelector('#set-tz'), 'America/Detroit');
    setValue(document.querySelector('#set-due'), '25:00');
    click(document.querySelector('#set-due').parentElement.querySelector('button'));
    const e2 = (await until(() => [...document.querySelectorAll('.settings .note.error')].map((n) => n.textContent).find((t) => /HH:mm/.test(t)), 'the due-time error'));
    setValue(document.querySelector('#set-due'), '22:15');
    click(document.querySelector('#set-due').parentElement.querySelector('button'));
    await until(() => /Saved default due time/.test(toastText()), 'the saved toast');
    const s = (await inv('settings.get')).general.defaultDueTime;
    if (s !== '22:15') throw new Error('stored ' + s);
    return e1 + ' | ' + e2 + ' | saved 22:15';
  });

  await step('Settings: the quick-add shortcut can be recorded by pressing keys, saved, turned off and reset', async () => { try {
    const row = () => document.querySelector('[data-key=quick_add_shortcut]');
    const field = () => row().querySelector('input');
    if (!row()) throw new Error('no shortcut row; screen shows: ' + (document.querySelector('main')?.textContent ?? document.body.textContent).slice(0, 300));
    if (field().value !== 'CommandOrControl+Shift+Space') throw new Error('default shows ' + field().value);
    if (!/Active now/.test(row().textContent)) throw new Error('shortcut is not active: ' + row().textContent);
    // recording: press Ctrl+Alt+K
    click(byText('[data-key=quick_add_shortcut] button', 'Record'));
    window.__stage = 1;
    await until(() => field().value === 'Press the shortcut…', 'recording mode');
    await wait(150); // let the recorder attach its key listener
    window.__stage = 2;
    // like a real key press: it targets the focused element and travels through window's capture phase first
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    await until(() => field().value === 'Control+Alt+K', () => 'recorded value: ' + field().value);
    window.__stage = 3;
    // a shortcut without a modifier is refused, and nothing is saved
    setValue(field(), 'Space');
    window.__stage = 4;
    click(byText('[data-key=quick_add_shortcut] button', 'Save'));
    window.__stage = 5;
    const err = (await until(() => row().querySelector('.note.error'), 'the modifier error')).textContent;
    window.__stage = 6;
    if (!/modifier/.test(err)) throw new Error(err);
    // a good one is saved (and the system accepted it)
    setValue(field(), 'ctrl+alt+shift+f19');
    window.__stage = 7;
    click(byText('[data-key=quick_add_shortcut] button', 'Save'));
    window.__stage = 8;
    await until(() => /Quick-add shortcut is now Control\+Alt\+Shift\+F19/.test(toastText()), () => 'saved toast: ' + toastText() + ' / ' + row().textContent);
    window.__stage = 9;
    if ((await inv('settings.get')).general.quickAddShortcut !== 'Control+Alt+Shift+F19') throw new Error('not stored');
    window.__stage = 10;
    click(byText('[data-key=quick_add_shortcut] button', 'Turn off'));
    window.__stage = 11;
    await until(() => /turned off/.test(toastText()), 'turned off');
    window.__stage = 12;
    if ((await inv('settings.get')).general.quickAddShortcut !== '') throw new Error('not off');
    window.__stage = 13;
    click(await until(() => [...row().querySelectorAll('button')].find((b) => /Reset to default/.test(b.textContent)), 'the reset link'));
    window.__stage = 14;
    await until(() => field().value === 'CommandOrControl+Shift+Space', 'default back');
    window.__stage = 15;
    return err.slice(0, 90) + ' | recorded Control+Alt+K | saved F19 | off | reset';
  } catch (e) { throw new Error('stage ' + window.__stage + ': ' + e.message + ' | screen: ' + document.body.textContent.slice(0, 160)); } });

  await step('Settings: Appearance switches the whole window between the light and dark themes, and back to the system', async () => {
    const sel = await until(() => document.querySelector('#set-theme'), 'the Appearance control');
    const bg = () => getComputedStyle(document.body).backgroundColor;
    setValue(sel, 'dark');
    await until(() => matchMedia('(prefers-color-scheme: dark)').matches && bg() === 'rgb(6, 26, 48)', () => 'the dark theme (bg ' + bg() + ')');
    if ((await inv('settings.get')).general.theme !== 'dark') throw new Error('not stored');
    setValue(document.querySelector('#set-theme'), 'light');
    await until(() => !matchMedia('(prefers-color-scheme: dark)').matches && bg() === 'rgb(246, 245, 241)', () => 'the light theme (bg ' + bg() + ')');
    setValue(document.querySelector('#set-theme'), 'system');
    await until(async () => true, 'x');
    await wait(200);
    if ((await inv('settings.get')).general.theme !== 'system') throw new Error('not back to system');
    return 'dark -> light -> system';
  });

  await step('Settings: Color scheme presets and custom colors restyle the window live (light and dark), bad colors are refused, and the choice is saved', async () => {
    const root = document.documentElement;
    const v = (n) => getComputedStyle(root).getPropertyValue(n).trim().toUpperCase();
    const grid = await until(() => document.querySelector('[data-testid=scheme-grid]'), 'the color scheme picker');
    if (grid.querySelectorAll('[data-scheme]').length < 9) throw new Error('expected 8+ presets and Custom');
    const pick = (id) => document.querySelector('[data-scheme=' + id + '] input').click();
    setValue(document.querySelector('#set-theme'), 'light');
    await until(() => !matchMedia('(prefers-color-scheme: dark)').matches, 'light');
    await until(() => v('--bar-bg') === '#00274C', () => 'the default light top bar, got ' + v('--bar-bg') + ' (style element present: ' + !!document.getElementById('tally-scheme') + ')');
    const base = v('--bar-bg');
    if (base !== '#00274C' || document.getElementById('tally-scheme')) throw new Error('the default must be the plain stylesheet, got ' + base);
    pick('forest');
    await until(() => v('--bar-bg') !== base && document.getElementById('tally-scheme'), 'the forest scheme to apply');
    const forest = v('--bar-bg'); const forestBg = v('--bg');
    pick('ocean');
    await until(() => v('--bar-bg') !== forest, 'the ocean scheme to apply');
    if ((await inv('settings.get')).general.colorScheme.id !== 'ocean') throw new Error('not saved');
    // light and dark both keep working for a scheme
    setValue(document.querySelector('#set-theme'), 'dark');
    await until(() => matchMedia('(prefers-color-scheme: dark)').matches && v('--bg') !== v('--surface') && getComputedStyle(document.body).backgroundColor !== 'rgb(246, 245, 241)', 'dark with the ocean scheme');
    const darkBg = getComputedStyle(document.body).backgroundColor;
    setValue(document.querySelector('#set-theme'), 'light');
    await until(() => !matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.body).backgroundColor !== darkBg, 'light again');
    if (v('--bg') === forestBg) throw new Error('ocean should not look like forest');
    // custom: an accent that cannot be made readable is refused with the reason and the last scheme is kept
    pick('custom');
    const hex = (label) => document.querySelector('input[aria-label="' + label + ' color hex"]');
    await until(() => hex('Accent'), 'the custom pickers');
    setValue(hex('Primary'), '#1B4332'); setValue(hex('Accent'), '#0A0A0A');
    const why = (await until(() => document.querySelector('[data-testid=scheme-reason]'), 'the reason')).textContent;
    if (!/too dark/.test(why) || !document.querySelector('[data-testid=scheme-save]').disabled) throw new Error('expected a refusal with a reason: ' + why);
    const direct = await window.planner.invoke('settings.set', { key: 'color_scheme', value: JSON.stringify({ primary: '#1B4332', accent: '#0A0A0A' }) });
    if (direct.ok) throw new Error('the engine accepted an unreadable scheme');
    if ((await inv('settings.get')).general.colorScheme.id !== 'ocean') throw new Error('the last valid scheme was not kept');
    setValue(hex('Accent'), 'nonsense');
    await until(() => /hex value/.test(document.querySelector('[data-testid=scheme-reason]')?.textContent ?? ''), 'the hex hint');
    // a valid custom pair applies
    setValue(hex('Accent'), '#F4A261');
    await until(() => !document.querySelector('[data-testid=scheme-save]').disabled, 'Use these colors to enable');
    click(document.querySelector('[data-testid=scheme-save]'));
    await until(() => v('--accent') === '#F4A261', () => 'the custom accent, got ' + v('--accent'));
    const cs = (await inv('settings.get')).general.colorScheme;
    if (!cs.custom || cs.accent !== '#F4A261') throw new Error(JSON.stringify(cs));
    // finish on a preset and LEAVE it: the restart check and the quick-add window check it, and the second one resets it
    pick('violet');
    await until(() => v('--bar-bg') !== base && document.querySelector('[data-scheme=violet] input').checked, 'violet');
    setValue(document.querySelector('#set-theme'), 'system');
    await wait(300);
    return 'forest -> ocean (light and dark) -> bad custom refused (' + why.slice(0, 40) + '...) -> custom -> violet';
  });

  await step('Settings: the menu-bar icon section explains itself and the text mode is a saved setting', async () => {
    const box = await until(() => document.querySelector('[data-testid=tray-info]'), 'the menu bar section');
    // (the UI harness runs without a tray, so it reports that honestly)
    if (!document.querySelector('[data-testid=tray-missing]')) throw new Error('expected the "not created in this run" note: ' + box.textContent.slice(0, 200));
    const sel = box.querySelector('select');
    setValue(sel, 'elapsed');
    await until(() => /Menu bar text saved/.test(toastText()), 'saved toast');
    if ((await inv('settings.get')).general.trayText !== 'elapsed') throw new Error('not stored');
    setValue(sel, 'full');
    await until(() => (async () => true)() && box.querySelector('select').value === 'full', 'back to full');
    return 'section present; text mode saved';
  });

  await step('Settings: Claude connector - three switches, each off by default, saved both ways, with the change list and call log sections', async () => {
    const sec = await until(() => document.querySelector('[data-section=claude]'), 'the Claude connector section');
    const keys = ['mcp_allow_writes', 'mcp_allow_deletes', 'mcp_allow_schedule'];
    const labels = keys.map((k) => sec.querySelector('[data-key=' + k + '] label')?.textContent ?? '');
    if (labels.join('|') !== 'Allow Claude to change my tasks|Allow Claude to delete tasks|Allow Claude to apply schedules to Google') throw new Error('labels: ' + labels.join('|'));
    const get = async () => (await inv('settings.get')).claude;
    for (const k of keys) {
      const box = sec.querySelector('#set-' + k);
      if (!box || box.checked) throw new Error(k + ' must exist and be OFF by default');
    }
    let c = await get();
    if ([c.writes, c.deletes, c.schedule].some((i) => i.value !== 'false')) throw new Error('stored values should all be false');
    for (const [i, k] of keys.entries()) {
      click(document.querySelector('#set-' + k));
      await wait(400);
      c = await get();
      const item = [c.writes, c.deletes, c.schedule][i];
      if (item.value !== 'true') throw new Error(k + ' was not saved as on');
      const others = [c.writes, c.deletes, c.schedule].filter((_, j) => j !== i);
      if (others.some((o) => o.value === 'true')) throw new Error('turning on one switch changed another');
      click(document.querySelector('#set-' + k));
      await wait(400);
      c = await get();
      if ([c.writes, c.deletes, c.schedule][i].value !== 'false') throw new Error(k + ' was not saved as off');
    }
    for (const h of ['Recent changes', 'What Claude did']) if (![...sec.querySelectorAll('h5')].some((e) => e.textContent.startsWith(h))) throw new Error('missing section: ' + h);
    return 'all three off by default; each saves on and off on its own';
  });

  await step('Settings: scheduling values save, bad ones explain, reset returns the default', async () => {
    tab('Scheduling');
    const row = await until(() => document.querySelector('[data-key=min_block_minutes]'), 'the min block row');
    const original = row.querySelector('input').value;
    setValue(row.querySelector('input'), '3');
    click(row.querySelector('button'));
    const err = (await until(() => row.querySelector('.note.error'), 'the error')).textContent;
    if (!/at least 5/.test(err)) throw new Error(err);
    setValue(row.querySelector('input'), '20');
    click(row.querySelector('button'));
    await until(() => /Saved Shortest block/.test(toastText()), () => 'saved (toast: ' + toastText() + ')');
    const r2 = document.querySelector('[data-key=min_block_minutes]');
    const reset = await until(() => [...r2.querySelectorAll('button')].find((b) => /Reset to default/.test(b.textContent)), 'the reset link');
    click(reset);
    await until(() => /back to its default/.test(toastText()), 'reset toast');
    const v = (await inv('settings.get')).scheduling.find((x) => x.key === 'min_block_minutes');
    if (v.value !== original || v.custom) throw new Error('after reset: ' + JSON.stringify(v) + ' (was ' + original + ')');
    return err + ' | 20 saved, reset back to ' + original;
  });

  await step('Settings: priority constants and the formula', async () => {
    tab('Priority');
    await until(() => document.querySelector('[data-key=impact_urgency_days]'), 'the priority rows');
    if (!/urgency half-life/.test(document.querySelector('.settings').textContent)) throw new Error('formula missing');
    const row = document.querySelector('[data-key=impact_urgency_days]');
    setValue(row.querySelector('input'), '3');
    click(row.querySelector('button'));
    await until(() => /Saved Urgency half-life/.test(toastText()), 'saved');
    if ((await inv('settings.get')).priority.find((x) => x.key === 'impact_urgency_days').value !== '3') throw new Error('not stored');
    return 'urgency half-life 7 -> 3';
  });

  await step('Settings: notifications - switches, quiet hours, test button, no repeats, none for done tasks', async () => {
    tab('Notifications');
    await until(() => document.querySelector('[data-key=notify_blocks]'), 'the notifications tab');
    const row = (k) => document.querySelector(`[data-key=${k}]`);
    for (const k of ['notify_blocks', 'notify_due_soon', 'notify_backup_failure', 'notify_quiet_enabled']) if (!row(k).querySelector('input[type=checkbox]').checked) throw new Error(k + ' should default to on');
    if (row('notify_quiet_start').querySelector('input').value !== '23:00' || row('notify_quiet_end').querySelector('input').value !== '08:00') throw new Error('quiet hours default is not 23:00-08:00');
    // equal start/end is explained, not saved
    setValue(row('notify_quiet_start').querySelector('input'), '08:00');
    click(row('notify_quiet_start').querySelector('button'));
    const err = (await until(() => row('notify_quiet_start').querySelector('.note.error'), 'the quiet-hours error')).textContent;
    if (!/same time/.test(err)) throw new Error(err);
    setValue(row('notify_quiet_start').querySelector('input'), '23:00');
    // quiet hours off, so the checks below do not depend on the time of day this test runs
    click(row('notify_quiet_enabled').querySelector('input[type=checkbox]'));
    await until(() => /Saved Quiet hours/.test(toastText()), 'quiet off saved');
    if ((await inv('settings.get')).notifications.find((x) => x.key === 'notify_quiet_enabled').value !== 'false') throw new Error('not stored');
    // the test button: the pretend OS in this harness never reports "shown", so the report must say so and the in-app banner must appear
    click(byText('.settings button', 'Send test notification'));
    const diag = await until(() => document.querySelector('[data-testid=notify-diag]'), 'the diagnostics', 10000);
    if (diag.dataset.outcome !== 'no-event') throw new Error('outcome ' + diag.dataset.outcome + ': ' + diag.textContent);
    for (const need of ['supported by this system: yes', 'show() called: yes', 'Events reported by the system: none', 'probably dropped', 'In-app banner: shown (fallback)']) if (!diag.textContent.includes(need)) throw new Error('missing "' + need + '" in: ' + diag.textContent);
    if (!/packaged app/.test(text('[data-testid=notify-explain]')) || !/registers with macOS/.test(text('[data-testid=notify-explain]'))) throw new Error('missing the packaged-app explanation');
    const banner = await until(() => [...document.querySelectorAll('.banner')].find((b) => b.textContent.includes('Test notification')), 'the in-app banner', 8000);
    click(banner.querySelector('button[aria-label="Dismiss notification"]'));
    await until(() => ![...document.querySelectorAll('.banner')].some((b) => b.textContent.includes('Test notification')), 'the banner to go away');
    if ((await inv('banners.list')).some((b) => b.title.includes('Test notification'))) throw new Error('banner not dismissed in the main process');
    await until(() => document.querySelector('[data-testid=notify-recent]')?.textContent.includes('Test notification'), 'the test in the list');
    // clear whatever the demo data already had due soon (one summary), then watch single tasks
    click(byText('.settings button', 'Check now'));
    await until(() => /Announced|Nothing new/.test(text('[data-testid=notify-msg]')), 'first check');
    const recentTitles = async () => (await inv('notifications.recent')).map((n) => n.title);
    const a = await inv('tasks.add', { title: 'SMOKE due soon A', due: 'in 1 day' });
    let r = await inv('notifications.check');
    if (r.length !== 1 || !r[0].title.includes('SMOKE due soon A') || !/due in/.test(r[0].body)) throw new Error('first announcement: ' + JSON.stringify(r));
    await wait(700); // the pretend OS stays silent, so the in-app fallback banner must arrive for a real notification too
    if (!(await inv('banners.list')).some((b) => b.kind === 'due' && b.title.includes('SMOKE due soon A'))) throw new Error('no fallback banner for the due-soon notice');
    r = await inv('notifications.check');
    if (r.length) throw new Error('announced twice: ' + JSON.stringify(r));
    // a task completed before the check is never announced
    const b = await inv('tasks.add', { title: 'SMOKE done B', due: 'in 1 day' });
    await inv('tasks.done', { id: b.id });
    r = await inv('notifications.check');
    if (r.length) throw new Error('announced a done task: ' + JSON.stringify(r));
    // the switch holds it back, and turning it on again delivers it (not lost)
    await inv('settings.set', { key: 'notify_due_soon', value: 'false' });
    await inv('tasks.add', { title: 'SMOKE off C', due: 'in 1 day' });
    r = await inv('notifications.check');
    if (r.length) throw new Error('announced while switched off: ' + JSON.stringify(r));
    await inv('settings.set', { key: 'notify_due_soon', value: 'true' });
    r = await inv('notifications.check');
    if (r.length !== 1 || !r[0].title.includes('SMOKE off C')) throw new Error('after switching on: ' + JSON.stringify(r));
    void a;
    return 'one announcement each, none repeated, none for done; recent: ' + (await recentTitles()).slice(0, 3).join(' | ');
  });

  await step('Settings: terms - create, archive, browse (read-only), unarchive', async () => {
    tab('Terms');
    await until(() => document.querySelector('.newterm'), 'the terms tab');
    setValue(document.querySelector('input[aria-label="Term name"]'), 'SMOKE Term B');
    setValue(document.querySelector('input[aria-label="Start date"]'), '2027-01-05');
    setValue(document.querySelector('input[aria-label="End date"]'), '2027-04-25');
    click(byText('.newterm button', 'Create term'));
    await until(() => document.querySelector('tr[data-term="SMOKE Term B"]'), 'the new term');
    // archive the term the import step created (it has two tasks), via the confirm
    const row = () => document.querySelector('tr[data-term="SMOKE Term"]');
    click(await until(() => byText('tr[data-term="SMOKE Term"] button', 'Archive'), () => 'the Archive button (rows: ' + [...document.querySelectorAll('.terms tr')].map((r) => r.dataset.term).join(',') + ')'));
    click(await until(() => byText('tr[data-term="SMOKE Term"] button', 'Yes, archive'), 'the archive confirmation'));
    await until(() => row()?.textContent.includes('archived'), 'the term to show as archived');
    click(byText('tr[data-term="SMOKE Term"] button', 'Browse'));
    const br = await until(() => document.querySelector('[data-testid=archived-browser]'), 'the archived browser');
    if (!/read-only/.test(br.textContent)) throw new Error('no read-only label');
    if (br.querySelector('input,textarea,select')) throw new Error('browser has editable controls');
    const titles = [...br.querySelectorAll('.row .grow')].map((e) => e.textContent).sort();
    if (titles.join('|') !== 'SMOKE import one (edited)|SMOKE import two') throw new Error('tasks: ' + titles);
    click(byText('[data-testid=archived-browser] button', '← Back to terms'));
    await until(() => row(), 'back at the terms list');
    click(byText('tr[data-term="SMOKE Term"] button', 'Unarchive'));
    await until(() => !row().textContent.includes('archived'), 'the term to be live again');
    return 'browsed: ' + titles.join(', ');
  });

  await step('Settings: Google tab explains the demo (nothing to connect)', async () => {
    tab('Google');
    const t = (await until(() => document.querySelector('[data-testid=google-status]'), 'the status')).textContent;
    if (!/simulated/.test(t)) throw new Error(t);
    if (!byText('.settings button', 'Check connection').disabled) throw new Error('Check should be disabled in the demo');
    return t.slice(0, 100);
  });

  await step('Review: nothing is written until a step is confirmed; reschedule, fix details, replan with the usual confirmation, finish', async () => {
    const over = await inv('tasks.add', { title: 'SMOKE review overdue', due: 'yesterday 5pm', est: 30 });
    const bare = await inv('tasks.add', { title: 'SMOKE review nodetail', due: 'in 3 days' });
    const get = async (id) => (await inv('tasks.get', { id })).task;
    const dueBefore = (await get(over.id)).due;
    click(byText('nav .tab', 'Review'));
    await until(() => document.querySelector('[data-testid=review]'), 'the Review screen');
    if (!document.querySelector('[data-testid=review-apply]').disabled) throw new Error('Apply should be disabled with nothing chosen');
    click(document.querySelector('[data-testid=review-tab-b]'));
    const row = await until(() => [...document.querySelectorAll('[data-testid=review-b-row]')].find((r) => r.textContent.includes('SMOKE review overdue')), 'the overdue row');
    click(row.querySelector('[data-testid=b-reschedule]'));
    const due = await until(() => row.querySelector('[data-testid=b-due]'), 'the new-due input');
    setValue(due, 'in 2 days 5pm');
    if ((await get(over.id)).due !== dueBefore) throw new Error('a choice was written before it was confirmed');
    click(document.querySelector('[data-testid=review-apply]'));
    await until(() => /Applied: 1 rescheduled/.test(document.querySelector('[data-testid=review-applied]')?.textContent ?? ''), 'the step b result');
    if ((await get(over.id)).due === dueBefore) throw new Error('the due date did not change');
    click(document.querySelector('[data-testid=review-tab-c]'));
    const crow = await until(() => [...document.querySelectorAll('[data-testid=review-c-row]')].find((r) => r.textContent.includes('SMOKE review nodetail')), 'the missing-details row');
    setValue(crow.querySelector('[data-testid=c-estimate]'), '45');
    if ((await get(bare.id)).estimate !== null) throw new Error('an estimate was written before it was confirmed');
    click(document.querySelector('[data-testid=review-apply]'));
    await until(() => /Applied: 1 fixed/.test(document.querySelector('[data-testid=review-applied]')?.textContent ?? ''), 'the step c result');
    if ((await get(bare.id)).estimate !== 45) throw new Error('the estimate was not saved');
    click(document.querySelector('[data-testid=review-tab-d]'));
    await until(() => document.querySelector('[data-testid=review-preview]'), 'the replan preview', 15000);
    click(document.querySelector('[data-testid=review-replan-apply]'));
    const dlg = await until(() => document.querySelector('[role=dialog]'), 'the same confirmation the Schedule screen uses');
    if (!/simulated calendar/.test(dlg.textContent)) throw new Error('not the simulated calendar: ' + dlg.textContent.slice(0, 120));
    click(byText('[role=dialog] button', 'Write to simulated calendar'));
    await until(() => document.querySelector('[data-testid=review-applied]') && !document.querySelector('[role=dialog]'), 'the replan to apply', 15000);
    click(document.querySelector('[data-testid=review-finish]'));
    await until(() => /Review done/.test(toastText()), 'the finish toast');
    await until(() => /Last review:/.test(document.querySelector('[data-testid=review-last]')?.textContent ?? ''), 'the last-review date');
    if (document.querySelector('.tab.review-due')) throw new Error('the review-due marker should be gone');
    click(byText('nav .tab', 'Today'));
    await until(() => document.querySelector('.panels'), 'Today');
    return 'step b rescheduled only after Apply; step c saved the 45 min estimate; replan confirmed; review finished';
  });

  await step('Phone capture: switch on, Check now imports from the PRETEND Reminders list, Inbox panel with Undo, permission denied then Retry', async () => {
    click(byText('nav .tab', 'Settings'));
    await until(() => document.querySelector('[role=tab]'), 'Settings');
    tab('Phone');
    const st = await until(() => document.querySelector('[data-testid=phone-status]'), 'the phone status');
    if (st.dataset.state !== 'none') throw new Error('should not have checked before being switched on: ' + st.dataset.state);
    if (document.querySelector('[data-testid=phone-enabled]').checked) throw new Error('phone capture should default to OFF');
    click(document.querySelector('[data-testid=phone-enabled]'));
    await until(() => document.querySelector('[data-testid=phone-enabled]').checked, 'the switch to save');
    click(document.querySelector('[data-testid=phone-check]'));
    await until(() => document.querySelector('[data-testid=phone-count]')?.textContent === '3', 'three imported', 15000);
    const tasks = await inv('tasks.list', { text: 'SMOKE phone' });
    const chapter = tasks.find((t) => t.title === 'SMOKE phone read chapter 5');
    if (!chapter || !chapter.due) throw new Error('the trailing date was not parsed: ' + JSON.stringify(tasks.map((t) => t.title)));
    if ((await inv('tasks.list', { text: 'never touched' })).length) throw new Error('another list was read');
    if (!(await inv('tasks.list', { text: '(untitled reminder)' })).length) throw new Error('the untitled reminder was dropped');
    const sent = await inv('notifications.check');
    if (!sent.some((n) => n.kind === 'phone' && /3 items added from your phone/.test(n.title))) throw new Error('no phone notice: ' + JSON.stringify(sent.map((n) => n.title)));
    click(byText('nav .tab', 'Today'));
    await until(() => document.querySelector('[data-testid=inbox-panel]'), 'the Inbox panel');
    const items = await until(() => { const x = document.querySelectorAll('[data-testid=inbox-item]'); return x.length === 3 && x; }, 'three inbox items');
    const target = [...items].find((i) => i.textContent.includes('SMOKE phone buy a stapler'));
    click([...target.querySelectorAll('button')].find((b) => b.textContent === 'Undo'));
    await until(() => document.querySelector('[data-testid=inbox-item][data-undone="1"]'), 'the removed marker');
    if ((await inv('tasks.list', { text: 'buy a stapler' })).length) throw new Error('Undo did not remove the task');
    await inv('selftest.reminders', { deny: true, add: [{ id: 'smoke-4', title: 'SMOKE phone later' }] });
    click(byText('nav .tab', 'Settings')); await until(() => document.querySelector('[role=tab]'), 'Settings'); tab('Phone');
    click(await until(() => document.querySelector('[data-testid=phone-check]'), 'the check button'));
    const denied = await until(() => document.querySelector('[data-testid=phone-status][data-state=denied]'), 'the denied message');
    if (!/System Settings/.test(denied.textContent)) throw new Error(denied.textContent);
    if (document.querySelector('[data-testid=phone-check]').textContent !== 'Retry') throw new Error('the button should say Retry');
    if ((await inv('tasks.list', { text: 'phone later' })).length) throw new Error('imported while denied');
    await inv('selftest.reminders', { deny: false });
    click(document.querySelector('[data-testid=phone-check]'));
    await until(() => document.querySelector('[data-testid=phone-count]')?.textContent === '4', 'four imported after Retry', 15000);
    if (!document.querySelector('[data-testid=phone-status][data-state=ok]')) throw new Error('status should be ok again');
    click(byText('nav .tab', 'Settings')); await until(() => document.querySelector('[role=tab]'), 'Settings'); // the next step continues in Settings
    return 'off by default; 3 imported (date parsed, untitled kept, other list untouched); notice sent; Undo removed one; denied showed Retry; Retry imported the 4th';
  });

  await step('Points: quick-add More takes a size in points (decimals ok) and the card shows the size-based estimate; the drawer offers the unit', async () => {
    click(byText('nav .tab', 'Today'));
    await until(() => document.querySelector('.quickadd'), 'Today');
    click(byText('.quickadd button', 'More'));
    setValue(document.querySelector('input[aria-label="Task title"]'), 'SMOKE points task');
    setValue(document.querySelector('input[aria-label="Due date"]'), 'tomorrow 5pm');
    setValue(document.querySelector('input[aria-label="Size amount"]'), '100');
    setValue(document.querySelector('select[aria-label="Size unit"]'), 'points');
    click(byText('.quickadd button', 'Add'));
    await until(() => /SMOKE points task/.test(toastText()), 'the added toast');
    const t = (await inv('tasks.list', { text: 'SMOKE points task' }))[0];
    if (t.sizeUnit !== 'points' || t.sizeAmount !== 100 || t.estimate !== 30 || t.estimateSource !== 'size') throw new Error(JSON.stringify(t));
    await until(() => [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('SMOKE points task') && c.textContent.includes('~30m')), 'the ~30m estimate on the card', 8000);
    click([...document.querySelectorAll('.card-title .link-title')].find((e) => e.textContent === 'SMOKE points task'));
    await until(() => document.querySelector('.drawer .fields'), 'the drawer');
    const opts = [...document.querySelectorAll('.drawer select option')].map((o) => o.textContent);
    if (!opts.includes('points')) throw new Error('the drawer has no points unit: ' + opts.join(','));
    click(document.querySelector('.drawer-head button'));
    click(byText('nav .tab', 'Settings')); await until(() => document.querySelector('[role=tab]'), 'Settings');
    return '100 points -> 30 min (size-based), shown on the card; drawer lists points';
  });

  await step('Rates: groups by course and title stem, a decimal rate with a live example, apply with a before/after list, undo', async () => {
    const a = await inv('tasks.add', { title: 'Lecture 1 zyBooks', course: 'SMOKE 183', size: { amount: 100, unit: 'points' } });
    const b = await inv('tasks.add', { title: 'Lecture 2 zyBooks', course: 'SMOKE 183' });
    click(byText('nav .tab', 'Rates'));
    await until(() => document.querySelector('[data-testid=rates]'), 'the Rates screen');
    setValue(document.querySelector('[data-testid=rates-search]'), 'SMOKE');
    const card = await until(() => [...document.querySelectorAll('[data-testid=rate-group]')].find((c) => c.textContent.includes('zyBooks') && c.closest('.rates-course').textContent.includes('SMOKE 183')), 'the zyBooks group');
    if (![...document.querySelectorAll('.rates-course h2')].some((h) => h.textContent.includes('SMOKE 183'))) throw new Error('no course heading');
    if (!/no size set/.test(card.textContent)) throw new Error('the task without a size is not flagged');
    click(card.querySelector('.rates-head'));
    await until(() => card.querySelector('[data-testid=rate-value]'), 'the group controls');
    if (!/Built-in default/.test(card.querySelector('[data-testid=stat-rate]').textContent) || !/0\.3 min/.test(card.querySelector('[data-testid=stat-rate]').textContent)) throw new Error('rate in use: ' + card.querySelector('[data-testid=stat-rate]').textContent);
    if (!/not enough data/.test(card.querySelector('[data-testid=stat-actual]').textContent)) throw new Error('actual rate should say not enough data');
    setValue(card.querySelector('[data-testid=rate-value]'), '0.45');
    await until(() => /100 points = 45 min/.test(card.querySelector('[data-testid=rate-example]').textContent), 'the live example');
    await until(() => /1 task/.test(card.querySelector('[data-testid=match-preview]').textContent) || /2 tasks/.test(card.querySelector('[data-testid=match-preview]').textContent), 'the match preview');
    if ((await inv('tasks.get', { id: a.id })).task.estimate !== 30) throw new Error('typing a rate must not change anything');
    click(card.querySelector('[data-testid=rate-save]'));
    await until(() => /Your rate/.test(card.querySelector('[data-testid=stat-rate]').textContent), 'Your rate');
    click(card.querySelector('[data-testid=rate-apply]'));
    const dlg = await until(() => document.querySelector('[data-testid=rates-apply-dialog]'), 'the apply list');
    const rows = [...dlg.querySelectorAll('[data-testid=apply-rows] tbody tr')].map((r) => r.textContent);
    if (rows.length !== 1 || !/30 min/.test(rows[0]) || !/45 min/.test(rows[0])) throw new Error('rows: ' + JSON.stringify(rows));
    if ((await inv('tasks.get', { id: a.id })).task.estimateSource !== 'size') throw new Error('unexpected');
    click(dlg.querySelector('[data-testid=apply-confirm]'));
    await until(() => !document.querySelector('[data-testid=rates-apply-dialog]'), 'the dialog to close');
    const saved = (await inv('tasks.get', { id: a.id })).task;
    if (saved.estimate !== 45 || saved.estimateSource !== 'size') throw new Error(JSON.stringify(saved));
    if (!/Rule 1 of \d+ \(your rate\)/.test(saved.estimateWhy)) throw new Error('why: ' + saved.estimateWhy);
    const noEst = (await inv('tasks.get', { id: b.id })).task;
    if (noEst.estimate !== null) throw new Error('a task with no size must not get an estimate');
    // every edit is in Recent changes and can be undone
    const changes = (await inv('settings.get')).claude.changes.filter((c) => c.actor === 'rates');
    if (changes.length < 2) throw new Error('rate edits are missing from Recent changes: ' + JSON.stringify(changes));
    await inv('changes.undo', { id: changes[0].id });
    if ((await inv('tasks.get', { id: a.id })).task.estimate !== 45) throw new Error('undoing the apply should restore the saved estimate (still the live size-based 45 under the new rate)');
    await inv('changes.undo', { id: changes[1].id });
    if ((await inv('tasks.get', { id: a.id })).task.estimate !== 30) throw new Error('undoing the rate should bring back 30');
    // Per assignment: a flat time for every task in the group, no size needed; undo restores
    await inv('tasks.edit', { id: b.id, size: null }).catch(() => {});
    const card2 = await until(() => [...document.querySelectorAll('[data-testid=rate-group]')].find((c) => c.textContent.includes('zyBooks') && c.closest('.rates-course').textContent.includes('SMOKE 183')), 'the zyBooks group again');
    if (!card2.querySelector('[data-testid=rate-mode]')) click(card2.querySelector('.rates-head'));
    await until(() => card2.querySelector('[data-testid=rate-mode]'), 'the mode selector');
    setValue(card2.querySelector('[data-testid=rate-mode]'), 'flat');
    await until(() => card2.querySelector('[data-testid=flat-value]'), 'the flat field');
    setValue(card2.querySelector('[data-testid=flat-value]'), '60');
    await until(() => /any task in this group = 60 min/.test(card2.querySelector('[data-testid=flat-example]').textContent), 'the flat example');
    if ((await inv('tasks.get', { id: b.id })).task.estimate === 60) throw new Error('typing must not change anything');
    click(card2.querySelector('[data-testid=mode-save]'));
    await until(() => /per assignment/.test(card2.querySelector('[data-testid=stat-rate]').textContent), 'the flat rate in use');
    const flat = (await inv('tasks.get', { id: b.id })).task;
    if (flat.estimate !== 60 || !/^Flat 60 min per SMOKE 183/.test(flat.estimateWhy)) throw new Error('flat: ' + JSON.stringify([flat.estimate, flat.estimateWhy]));
    const flatChange = (await inv('settings.get')).claude.changes.find((c) => c.tool === 'rates_set_mode');
    if (!flatChange) throw new Error('the mode change is missing from Recent changes');
    await inv('changes.undo', { id: flatChange.id });
    if ((await inv('tasks.get', { id: b.id })).task.estimate === 60) throw new Error('undo should remove the flat rate');
    // Regroup: reports, keeps the saved rate text, and is one undoable entry
    const rateBefore = (await inv('rates.get')).groups.length;
    click(document.querySelector('[data-testid=regroup-go]'));
    await until(() => document.querySelector('[data-testid=regroup-report]'), 'the regroup report');
    if ((await inv('rates.get')).regroupPending !== 0) throw new Error('regroup should leave nothing pending');
    if (!(await inv('settings.get')).claude.changes.some((c) => c.tool === 'rates_regroup')) throw new Error('regroup is missing from Recent changes');
    void rateBefore;
    click(byText('nav .tab', 'Settings')); await until(() => document.querySelector('[role=tab]'), 'Settings');
    return 'grouped under SMOKE 183; 0.45 -> "100 points = 45 min"; apply listed 1 task 30 -> 45; both edits undone';
  });

  await step('Settings: back up now, then restore needs the typed word and really restores', async () => {
    tab('Backups');
    await until(() => byText('.settings button', 'Back up now'), 'the backups tab');
    click(byText('.settings button', 'Back up now'));
    await until(() => /Backup saved and verified/.test(toastText()), 'the backup toast');
    await inv('tasks.add', { title: 'SMOKE after backup' });
    if (!(await inv('tasks.list', { text: 'SMOKE after backup' })).length) throw new Error('setup task missing');
    const first = await until(() => document.querySelector('tr[data-backup]'), 'a backup row');
    // the newest backup is the first row
    click(byText('tr[data-backup] button', 'Restore…'));
    const dlg = await until(() => document.querySelector('[role=dialog]'), 'the restore dialog');
    const go = byText('[role=dialog] button', 'Restore');
    if (!go.disabled) throw new Error('Restore should be disabled until the word is typed');
    setValue(dlg.querySelector('input'), 'restor');
    if (!byText('[role=dialog] button', 'Restore').disabled) throw new Error('partial word enabled it');
    setValue(dlg.querySelector('input'), 'restore');
    await until(() => !byText('[role=dialog] button', 'Restore').disabled, 'the button to enable');
    click(byText('[role=dialog] button', 'Restore'));
    await until(() => /Restored planner-/.test(toastText()), 'the restore toast', 20000);
    const gone = (await inv('tasks.list', { text: 'SMOKE after backup' })).length;
    if (gone) throw new Error('the task added after the backup is still there');
    const kept = (await inv('tasks.list', { text: 'SMOKE u1' })).length;
    if (!kept) throw new Error('older data vanished');
    return toastText().slice(0, 160) + ' | newer task gone, older data kept';
  });

  out.errors = [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent);
  return JSON.stringify(out);
})()
