// Runs INSIDE the window before a screenshot (scripts/ui-shots.mjs, demo database only): opens the screen to capture.
(async (screen) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what, ms = 12000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await wait(60); } };
  const inv = async (ch, args) => { const r = await window.planner.invoke(ch, args); if (!r.ok) throw new Error(ch + ': ' + r.error); return r.value; };
  const setValue = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const tab = (name) => [...document.querySelectorAll('nav .tab')].find((b) => b.textContent.trim() === name).click();
  const paintWeek = async () => { for (let wd = 1; wd <= 7; wd++) await inv('availability.paint', { target: { weekday: wd }, range: { start: wd >= 6 ? '10:00' : '09:00', end: wd >= 6 ? '18:00' : '21:00' } }); };
  await until(() => document.querySelector('.panels'), 'Today');
  await wait(400);

  if (screen === 'lists' || screen === 'task') {
    tab('Lists');
    await until(() => document.querySelector('.sidebar'), 'Lists');
    const personal = await until(() => [...document.querySelectorAll('.listbtn')].find((b) => b.textContent.includes('Personal')), 'the Personal list');
    personal.click();
    await until(() => document.querySelector('.row .link-title'), 'task rows');
    if (screen === 'task') {
      document.querySelector('.row .link-title').click();
      await until(() => document.querySelector('.drawer .fields'), 'the drawer');
    }
  } else if (screen === 'schedule') {
    await paintWeek();
    tab('Schedule');
    await until(() => document.querySelector('[data-testid=schedule-summary]'), 'the schedule preview', 20000);
  } else if (screen === 'availability') {
    await paintWeek();
    tab('Availability');
    await until(() => document.querySelector('.grid .col'), 'the grid');
    await wait(500);
    [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.startsWith('Reschedule')).click();
    await until(() => document.querySelector('.proposal') || document.querySelector('.ev.prop'), 'the proposal', 20000);
  } else if (screen === 'import') {
    tab('Import');
    await until(() => document.querySelector('input[type=file]'), 'the chooser');
    const doc = { term: { name: 'Winter 2027', start_date: '2027-01-05', end_date: '2027-04-25' }, items: [
      { course: 'MATH 115', title: 'Homework 1', type: 'homework', due_date: '2027-01-14', grade_weight: 2, source_quote: 'HW due Thursdays', confidence: 'high', estimated_minutes: 90 },
      { course: 'MATH 115', title: 'Quiz 1', type: 'quiz', due_date: '2027-01-21T10:00:00', grade_weight: 5, source_quote: 'Quiz 1 in lecture', confidence: 'high' },
      { course: 'MATH 115', title: 'Midterm Exam', type: 'exam', due_date: '2027-02-18T19:00:00', grade_weight: 25, source_quote: 'Midterm: Feb 18 (syllabus) / Feb 20 (schedule)', confidence: 'low', notes: 'Syllabus and schedule disagree.' },
      { course: 'HIST 210', title: 'Response paper 1', type: 'homework', due_date: '2027-01-28', grade_weight: 10, source_quote: 'paper due Jan 28', confidence: 'high' },
    ], grading_breakdown: [] };
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(doc)], 'math-115-syllabus.json', { type: 'application/json' }));
    const input = document.querySelector('input[type=file]');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => document.querySelector('[data-testid=import-summary]'), 'the review');
    const row = [...document.querySelectorAll('.import-row')].find((r) => r.textContent.includes('Quiz 1'));
    row.querySelector('button.link').click();
  } else if (screen === 'rates') {
    tab('Rates');
    await until(() => document.querySelector('[data-testid=rate-group]'), 'the rate groups');
    const cards = [...document.querySelectorAll('[data-testid=rate-group]')];
    const zy = cards.find((c) => /zyBooks|reading|Reading/.test(c.textContent)) ?? cards[0];
    zy.querySelector('.rates-head').click();
    await until(() => zy.querySelector('[data-testid=rate-value]'), 'the group controls');
  } else if (screen === 'settings') {
    tab('Settings');
    await until(() => document.querySelector('#set-tz'), 'Settings');
  } else if (screen === 'banner') {
    await inv('notifications.test');
    await until(() => document.querySelector('.banner'), 'the banner', 10000);
  }
  await wait(700);
  return 'ready';
})
