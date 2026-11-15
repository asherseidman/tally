// Runs INSIDE the app window (npm run smoke:ui, DEMO database only, client file under /tmp, a pretend file picker; real Google is never contacted).
// Part 1: with NO Google client file, every Google-related screen works without errors. Part 2: the client-file panel.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what, ms = 8000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + (typeof what === 'function' ? what() : what)); await wait(50); } };
  const click = (el) => el.click();
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
  const inv = async (ch, args) => { const r = await window.planner.invoke(ch, args); if (!r.ok) throw new Error(ch + ': ' + r.error); return r.value; };
  const pick = (name) => inv('selftest.chooseFile', { path: '/tmp/planner-smoke-google/' + name });
  const out = { steps: [] };
  const step = async (name, fn) => { try { out.steps.push({ name, ok: true, info: await fn() }); } catch (e) { out.steps.push({ name, ok: false, error: String(e.message || e) }); } };
  const tab = (name) => click([...document.querySelectorAll('[role=tab]')].find((b) => b.textContent === name));
  const nav = (name) => click(byText('nav .tab', name));
  const status = () => document.querySelector('[data-testid=client-status]')?.textContent ?? '';
  await until(() => document.querySelector('.panels'), 'the Today panels');

  await step('no client file: Settings > Google says it is not set up, and offers the setup panel', async () => {
    nav('Settings'); await until(() => document.querySelector('[role=tab]'), 'Settings'); tab('Google');
    await until(() => /not set/.test(status()), () => 'status: ' + status());
    const t = document.querySelector('[data-testid=client-setup]').textContent;
    if (!/works without Google Calendar/.test(t) || !/docs\/GOOGLE_SETUP\.md/.test(t)) throw new Error(t.slice(0, 200));
    if (!byText('.settings button', 'Remove client file').disabled) throw new Error('Remove should be disabled with no client');
    if (document.querySelector('[data-testid=google-reconnect]') || document.querySelector('.banner[data-kind=google]')) throw new Error('a reconnect prompt appeared');
    return status();
  });

  await step('no client file: the Schedule screen plans from the free windows with no error, and Apply is unavailable', async () => {
    nav('Schedule');
    await until(() => document.querySelector('[data-testid=schedule-no-google]'), 'the "not set up" note', 20000);
    if (document.querySelector('[data-testid=schedule-error]')) throw new Error('Schedule showed an error');
    const apply = [...document.querySelectorAll('.toolbar button.primary')].find((b) => /Apply|Replan/.test(b.textContent));
    if (!apply || !apply.disabled) throw new Error('Apply should be disabled');
    if (document.querySelector('[data-testid=google-reconnect]')) throw new Error('a Reconnect button appeared');
    return document.querySelector('[data-testid=schedule-no-google]').textContent.slice(0, 90);
  });

  await step('no client file: the Availability grid loads with no error and no reconnect', async () => {
    nav('Availability');
    await until(() => document.querySelector('[role=grid], .grid, .week'), 'the grid');
    await wait(1500);
    const alerts = [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent);
    if (alerts.length) throw new Error(alerts.join(' | '));
    if (document.querySelector('[data-testid=google-reconnect]')) throw new Error('a Reconnect button appeared');
    return 'no alerts';
  });

  await step('a bad file (a Web client, then not JSON) is refused in plain words and nothing is saved', async () => {
    nav('Settings'); await until(() => document.querySelector('[role=tab]'), 'Settings'); tab('Google');
    await until(() => document.querySelector('[data-testid=client-choose]'), 'the choose button');
    await pick('web.json'); click(document.querySelector('[data-testid=client-choose]'));
    const e1 = (await until(() => document.querySelector('[data-testid=client-error]'), 'the error')).textContent;
    if (!/Web application.*Desktop app/.test(e1)) throw new Error(e1);
    await pick('notjson.json'); click(document.querySelector('[data-testid=client-choose]'));
    await until(() => /not valid JSON/.test(document.querySelector('[data-testid=client-error]')?.textContent ?? ''), 'the JSON error');
    if (!/not set/.test(status())) throw new Error('status changed: ' + status());
    return e1.slice(0, 80);
  });

  await step('a good file is saved: the status shows only the end of the client ID, never the secret', async () => {
    await pick('good.json'); click(document.querySelector('[data-testid=client-choose]'));
    await until(() => /found, ID ends in …1234/.test(status()), () => 'status: ' + status());
    const everything = document.body.textContent + JSON.stringify(await inv('google.status'));
    if (/FAKE-secret/.test(everything)) throw new Error('the secret is visible');
    if (/111111111111/.test(everything)) throw new Error('more than the end of the client ID is visible');
    return status();
  });

  await step('replacing asks first and warns that reconnecting may be needed; Cancel changes nothing', async () => {
    click(document.querySelector('[data-testid=client-choose]'));
    const box = await until(() => document.querySelector('[data-testid=client-replace-confirm]'), 'the confirmation');
    if (!/Signing in again/.test(box.textContent)) throw new Error(box.textContent);
    click(byText('[data-testid=client-replace-confirm] button', 'Cancel'));
    await until(() => !document.querySelector('[data-testid=client-replace-confirm]'), 'the box to close');
    if (!/…1234/.test(status())) throw new Error('changed: ' + status());
    await pick('other.json');
    click(document.querySelector('[data-testid=client-choose]'));
    click(await until(() => byText('[data-testid=client-replace-confirm] button', 'Yes, choose a new file…'), 'the Yes button'));
    await until(() => /…9876/.test(status()), () => 'status: ' + status());
    const note = (await until(() => document.querySelector('[data-testid=client-notice]'), 'the notice')).textContent;
    if (!/different client/.test(note)) throw new Error(note);
    return note;
  });

  await step('Remove client file asks first, then the app is back to working without Google', async () => {
    click(document.querySelector('[data-testid=client-remove]'));
    click(await until(() => byText('[data-testid=client-remove-confirm] button', 'Yes, remove it'), 'the confirmation'));
    await until(() => /not set/.test(status()), () => 'status: ' + status());
    nav('Schedule');
    await until(() => document.querySelector('[data-testid=schedule-no-google]'), 'the note again', 20000);
    return 'removed; Schedule still works';
  });

  out.errors = [];
  return JSON.stringify(out);
})()
