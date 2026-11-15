import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers';
import { createTerm } from '../src/core/terms';
import { addTask } from '../src/core/tasks';
import { dispatch, processConnectorJobs, type ApiDeps } from '../src/app/api';
import { requestJob, requestPreview, getJob } from '../src/core/connectorJobs';
import { createCalendar, noGoogleHandle } from '../src/schedule/calendarFactory';
import { NoGoogleCalendar, NOT_SET_UP_MESSAGE } from '../src/schedule/noCalendar';
import { validateClientJson, installClientFile, clientFileInfo, removeClientFile, idTail, MAX_CLIENT_FILE_BYTES } from '../src/schedule/clientFile';
import { buildGoogleStatus } from '../src/app/googleStatus';
import { setSetting } from '../src/db/repo';

const SECRET = 'FAKE-secret-do-not-use-0123456789';
const goodJson = (id = '1234567890-abcdefgh1234.apps.googleusercontent.com') => JSON.stringify({ installed: { client_id: id, project_id: 'p', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', client_secret: SECRET, redirect_uris: ['http://localhost'] } });
const tmp = () => mkdtempSync(join(tmpdir(), 'tally-client-'));

describe('validating a Google client file', () => {
  it('accepts a Desktop-app client and returns only the client id', () => {
    const r = validateClientJson(goodJson());
    expect(r).toEqual({ ok: true, clientId: '1234567890-abcdefgh1234.apps.googleusercontent.com' });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  it('shows only the end of the client id', () => { expect(idTail('1234567890-abcdefgh1234.apps.googleusercontent.com')).toBe('…1234'); });
  it.each([
    ['not json', 'hello', /not valid JSON/],
    ['a web client', JSON.stringify({ web: { client_id: 'x', client_secret: 'y', redirect_uris: ['https://a.example/cb'] } }), /Web application.*Desktop app/],
    ['no installed section', JSON.stringify({ other: {} }), /no “installed” section/],
    ['no client_id', JSON.stringify({ installed: { client_secret: SECRET, redirect_uris: ['http://localhost'] } }), /no client_id/],
    ['no client_secret', JSON.stringify({ installed: { client_id: 'x', redirect_uris: ['http://localhost'] } }), /no client_secret/],
    ['no redirect', JSON.stringify({ installed: { client_id: 'x', client_secret: SECRET } }), /no localhost redirect/],
    ['a non-loopback redirect', JSON.stringify({ installed: { client_id: 'x', client_secret: SECRET, redirect_uris: ['https://evil.example/cb'] } }), /no localhost redirect/],
    ['an array', '[]', /no “installed” section/],
  ])('refuses %s in plain words and never repeats the secret', (_n, text, re) => {
    const r = validateClientJson(text);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toMatch(re); expect(r.error).not.toContain(SECRET); }
  });
  it('refuses an oversized file', () => { expect(validateClientJson(' '.repeat(MAX_CLIENT_FILE_BYTES + 1)).ok).toBe(false); });
  it('accepts 127.0.0.1 and localhost redirects with a port', () => {
    for (const u of ['http://127.0.0.1', 'http://localhost:8080/cb', 'http://[::1]']) expect(validateClientJson(JSON.stringify({ installed: { client_id: 'x', client_secret: 'y', redirect_uris: [u] } })).ok, u).toBe(true);
  });
});

describe('saving, replacing and removing the client file', () => {
  it('writes the chosen file to the target with mode 600, and reports only the end of the id', () => {
    const dir = tmp();
    try {
      const picked = join(dir, 'client_secret_x.json'); writeFileSync(picked, goodJson());
      const target = join(dir, 'app', 'google-client.json');
      const r = installClientFile(target, picked);
      expect(r).toMatchObject({ tail: '…1234', replaced: false, sameClient: false });
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(readFileSync(target, 'utf8')).toBe(goodJson());
      expect(readdirSync(join(dir, 'app'))).toEqual(['google-client.json']); // no temp file left behind
      expect(clientFileInfo(target)).toEqual({ found: true, valid: true, idTail: '…1234' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('a bad file writes nothing, and an existing client is left exactly as it was', () => {
    const dir = tmp();
    try {
      const target = join(dir, 'google-client.json');
      const bad = join(dir, 'bad.json'); writeFileSync(bad, '{"web":{}}');
      expect(() => installClientFile(target, bad)).toThrow(/Desktop app/);
      expect(existsSync(target)).toBe(false);
      const good = join(dir, 'good.json'); writeFileSync(good, goodJson());
      installClientFile(target, good);
      const before = readFileSync(target, 'utf8');
      expect(() => installClientFile(target, bad)).toThrow(/Desktop app/);
      expect(readFileSync(target, 'utf8')).toBe(before);
      expect(() => installClientFile(target, join(dir, 'missing.json'))).toThrow(/could not read/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('replacing says whether it is the same client or a different one', () => {
    const dir = tmp();
    try {
      const target = join(dir, 'google-client.json');
      const a = join(dir, 'a.json'); writeFileSync(a, goodJson());
      const b = join(dir, 'b.json'); writeFileSync(b, goodJson('999-zzzz9999.apps.googleusercontent.com'));
      installClientFile(target, a);
      expect(installClientFile(target, a)).toMatchObject({ replaced: true, sameClient: true });
      expect(installClientFile(target, b)).toMatchObject({ replaced: true, sameClient: false, tail: '…9999' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('an unusable saved file is reported as found but not valid; remove deletes it (and is harmless when there is none)', () => {
    const dir = tmp();
    try {
      const target = join(dir, 'google-client.json');
      expect(clientFileInfo(target)).toEqual({ found: false, valid: false, idTail: null });
      expect(removeClientFile(target)).toBe(false);
      writeFileSync(target, 'garbage');
      expect(clientFileInfo(target)).toEqual({ found: true, valid: false, idTail: null });
      expect(removeClientFile(target)).toBe(true);
      expect(existsSync(target)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the status line', () => {
  const db = () => makeCtx('2026-11-09T14:00:00Z').db;
  const now = new Date('2026-11-09T14:00:00Z');
  it('says Google is not set up (and that Tally works without it) when there is no client file', () => {
    const s = buildGoogleStatus(db(), now, { demo: false, clientFile: '/x/google-client.json', clientFileFound: false, tokenSaved: false });
    expect(s.message).toMatch(/not set up.*works without it/);
    expect(s.connected).toBe(false);
    expect(s.problem ?? null).toBeNull();
    expect(s.needsReconnect ?? false).toBe(false);
  });
  it('shows the end of the client id and never anything secret', () => {
    const s = buildGoogleStatus(db(), now, { demo: false, clientFile: '/x/google-client.json', clientFileFound: true, clientFileValid: true, clientIdTail: '…1234', tokenSaved: false });
    expect(s.clientIdTail).toBe('…1234');
    expect(JSON.stringify(s)).not.toMatch(/secret/i);
  });
  it('an unusable file says so', () => {
    const s = buildGoogleStatus(db(), now, { demo: false, clientFile: '/x/g.json', clientFileFound: true, clientFileValid: false, tokenSaved: false });
    expect(s.message).toMatch(/not a usable Desktop-app client/);
  });
});

describe('with no client file, nothing needs Google and nothing errors', () => {
  function app(): ApiDeps {
    const ctx = makeCtx('2026-11-09T14:00:00Z');
    createTerm(ctx, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
    return { ctx, dbFile: ':memory:', demo: false, backupFolder: '/nonexistent', calendar: () => noGoogleHandle() };
  }
  const ok = async (d: ApiDeps, ch: string, args?: unknown) => { const r = await dispatch(d, ch, args); if (!r.ok) throw new Error(`${ch}: ${r.error}`); return r.value as any; };
  async function seed(d: ApiDeps) {
    for (let wd = 1; wd <= 7; wd++) await ok(d, 'availability.paint', { target: { weekday: wd }, range: { start: '09:00', end: '21:00' } });
    addTask(d.ctx, { title: 'Read chapter 4', due: 'friday 5pm', est: 90 });
  }

  it('createCalendar returns the empty stand-in (no network, no keychain) when the client file is missing', () => {
    const dir = tmp();
    try {
      const h = createCalendar('America/Detroit', false, undefined, undefined, join(dir, 'google-client.json'));
      expect(h.unavailable).toBe(true);
      expect(h.calendar).toBeInstanceOf(NoGoogleCalendar);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('the stand-in reads as an empty calendar and refuses writes in plain words', async () => {
    const c = new NoGoogleCalendar();
    expect(await c.listCalendars()).toEqual([]);
    expect(await c.freeBusy(['a', 'b'], 0, 1)).toEqual({ a: [], b: [] });
    expect(await c.findPlannerCalendarId()).toBeUndefined();
    await expect(c.createPlannerEvent({ summary: 's', description: '', startMs: 0, endMs: 1, timeZone: 'UTC' })).rejects.toThrow(/not set up/);
    await expect(c.ensurePlannerCalendar()).rejects.toThrow(NOT_SET_UP_MESSAGE);
  });
  it('the Schedule preview works from the free windows, says so, and is not an error', async () => {
    const d = app(); await seed(d);
    const p = await ok(d, 'schedule.preview', { days: 7, replan: false });
    expect(p.calendarOff).toBe(true);
    expect(p.blocks.length).toBeGreaterThan(0);
    expect(p.doesNotFit ?? []).toHaveLength(0);
  });
  it('a saved class/busy calendar setting does not make the scheduler fail without Google', async () => {
    const d = app(); await seed(d);
    setSetting(d.ctx.db, 'class_calendars', JSON.stringify(['someone@example.com']));
    setSetting(d.ctx.db, 'busy_calendars', JSON.stringify(['someone@example.com']));
    const p = await ok(d, 'schedule.preview', { days: 7, replan: false });
    expect(p.blocks.length).toBeGreaterThan(0);
  });
  it('Apply is refused with a plain message (not a reconnect prompt) and writes nothing', async () => {
    const d = app(); await seed(d);
    const p = await ok(d, 'schedule.preview', { days: 7, replan: false });
    const r = await dispatch(d, 'schedule.apply', { days: 7, replan: false, confirm: true, fingerprint: p.fingerprint });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toMatch(/not set up/); expect(r.code).toBeUndefined(); }
    expect(d.ctx.db.all('SELECT * FROM scheduled_blocks')).toHaveLength(0);
  });
  it('the Availability grid loads with no busy time and no error', async () => {
    const d = app(); await seed(d);
    expect(await ok(d, 'calendar.busy', { date: '2026-11-09' })).toEqual({ busy: expect.any(Object) });
    const r = await ok(d, 'calendar.busy', { date: '2026-11-09' });
    expect(r.error).toBeUndefined();
    expect(Object.values(r.busy).flat()).toHaveLength(0);
  });
  it('week view with a dry-run overlay works too', async () => {
    const d = app(); await seed(d);
    const r = await ok(d, 'schedule.dryRun', { days: 7 });
    expect(r.blocks.length).toBeGreaterThan(0);
  });
  it('connector jobs (preview, free time with Google, conflicts) are answered, not failed, and there is no sign-in problem or reconnect', async () => {
    const d = app(); await seed(d);
    const a = requestPreview(d.ctx, { days: 7, replan: false });
    const b = requestJob(d.ctx, 'freetime', { startDate: '2026-11-09', days: 3 });
    const c = requestJob(d.ctx, 'conflicts', { days: 7 });
    await processConnectorJobs(d);
    for (const id of [a, b, c]) { const j = getJob(d.ctx, id)!; expect(j.status, `${j.kind}: ${j.error}`).toBe('ready'); }
    expect(getJob(d.ctx, b)!.result.days.length).toBe(3);
    expect(d.ctx.db.all("SELECT * FROM settings WHERE key = 'google_auth_problem'")).toHaveLength(0);
  });
});
