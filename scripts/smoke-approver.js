// Runs INSIDE the demo app's window (npm run smoke:mcp). It plays the part of the person at the Schedule screen:
// it watches for a request from the connector, approves the first one and rejects the second (through the same channels the
// Approve and Reject buttons use), and notes when the running timer shows up in the window (the connector started it).
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const inv = async (ch, args) => window.planner.invoke(ch, args);
  const out = { decisions: [], timerSeenAt: null, errors: [], claudeBannerIds: [], claudeBannerText: null };
  const deadline = Date.now() + 170000;
  let decided = 0;
  const waitingSince = {};
  while (Date.now() < deadline && (decided < 2 || out.timerSeenAt === null || out.claudeBannerIds.length < 2)) {
    if (out.timerSeenAt === null && document.querySelector('.timerbar')) out.timerSeenAt = Date.now();
    try {
      const bs = await inv('banners.list');
      if (bs.ok) for (const b of bs.value) if (b.kind === 'claude' && /Claude proposed a schedule/.test(b.title) && !out.claudeBannerIds.includes(b.id)) { out.claudeBannerIds.push(b.id); out.claudeBannerText ??= b.title + ': ' + b.body; }
      const st = await inv('pending.get');
      const seenFor = st.ok && st.value.pending ? (waitingSince[st.value.pending.id] ??= Date.now()) : 0;
      // a person decides after seeing the notification: wait for its banner (at most 15 s)
      const noticed = out.claudeBannerIds.length >= decided + 1 || (seenFor && Date.now() - seenFor > 15000);
      if (st.ok && st.value.pending && st.value.pending.status === 'pending' && decided < 2 && noticed) {
        const id = st.value.pending.id;
        if (decided === 0) {
          const r = await inv('pending.approve', { id, confirm: true });
          out.decisions.push({ action: 'approve', id, ok: r.ok, message: r.ok ? r.value.message : r.error });
        } else {
          const r = await inv('pending.reject', { id });
          out.decisions.push({ action: 'reject', id, ok: r.ok });
        }
        decided++;
      }
    } catch (e) { out.errors.push(String(e.message || e)); }
    await wait(250);
  }
  return JSON.stringify(out);
})()
