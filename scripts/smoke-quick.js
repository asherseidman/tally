// Runs INSIDE the small quick-add window (npm run smoke:ui, demo database only), after the main process showed it the way the
// global shortcut does. Types a task with a date, checks the live preview, adds it, and checks it was stored.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what, ms = 6000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await wait(50); } };
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const inv = async (ch, args) => { const r = await window.planner.invoke(ch, args); if (!r.ok) throw new Error(ch + ': ' + r.error); return r.value; };
  const out = { steps: [] };
  const step = async (name, fn) => { try { out.steps.push({ name, ok: true, info: await fn() }); } catch (e) { out.steps.push({ name, ok: false, error: String(e.message || e) }); } };
  const input = () => document.querySelector('input[aria-label=Task]');
  const preview = () => document.querySelector('[data-testid=quick-preview]')?.textContent ?? '';

  await until(() => input(), 'the quick-add box');
  await step('the quick-add window is the small one (no main-window navigation)', async () => {
    if (document.querySelector('nav')) throw new Error('main window UI is showing');
    if (document.activeElement !== input()) throw new Error('the box is not focused');
    return 'focused box, ' + window.innerWidth + 'x' + window.innerHeight;
  });
  await step('live preview parses the date out of the title', async () => {
    setValue(input(), 'SMOKE quick window homework due friday 5pm');
    await until(() => /Due Fri/.test(preview()) && /5:00 PM/.test(preview()), () => 'preview, got: ' + preview());
    if (!/SMOKE quick window homework/.test(preview())) throw new Error(preview());
    return preview();
  });
  await step('"due diligence" is just text', async () => {
    setValue(input(), 'SMOKE due diligence notes');
    await until(() => /No due date found/.test(preview()), 'no-date preview');
    return preview();
  });
  await step('showing the window again starts with a clean box', async () => {
    window.dispatchEvent(new Event('focus'));
    await until(() => input().value === '', 'the box to clear');
    return 'cleared on focus';
  });
  await step('Enter adds the task with the parsed due date', async () => {
    setValue(input(), 'SMOKE quick window homework due friday 5pm');
    await until(() => /Due Fri/.test(preview()), 'preview');
    document.querySelector('form.quickwin').requestSubmit();
    const done = (await until(() => document.querySelector('[data-testid=quick-done]'), 'the added note')).textContent;
    const t = (await inv('tasks.list', { text: 'SMOKE quick window homework' }))[0];
    if (!t || t.title !== 'SMOKE quick window homework' || t.timeAssumed) throw new Error('stored ' + JSON.stringify(t && [t.title, t.timeAssumed]));
    return done + '  stored due: ' + t.dueText;
  });
  await wait(1300); // the window closes itself shortly after an add
  return JSON.stringify(out);
})()
