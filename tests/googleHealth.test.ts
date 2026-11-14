import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { makeCtx } from './helpers';
import type { Ctx } from '../src/core/ctx';
import { MemorySecretStore } from '../src/schedule/secretStore';
import { OAuthTokenProvider, REFRESH_TOKEN_KEY, googleErrorCode, type HealthHooks } from '../src/schedule/auth';
import { GoogleCalendarClient, ReconnectRequiredError } from '../src/schedule/googleCalendar';
import {
  classifyCode, recordConnected, recordProblem, currentProblem, recordWorking, tokenAgeDays, testingNote, publishStatus, setPublishStatus,
  problemMessage, forgetConnection,
} from '../src/schedule/googleHealth';
import { buildGoogleStatus } from '../src/app/googleStatus';
import { dispatch, type ApiDeps } from '../src/app/api';
import { FakeCalendar } from '../src/schedule/fakeCalendar';
import { createTerm } from '../src/core/terms';

const NOW = new Date('2026-11-12T15:00:00Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

// ---- a fake Google token endpoint: answers the refresh request the way Google does
let server: Server;
let tokenUrl: string;
let reply: { status: number; body: unknown } = { status: 200, body: {} };
let requests: string[] = [];
beforeEach(async () => {
  requests = [];
  reply = { status: 200, body: { access_token: 'access-1', expires_in: 3600, token_type: 'Bearer' } };
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url} ${b}`);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  tokenUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const client = () => new OAuth2Client({ clientId: 'id', clientSecret: 'secret', endpoints: { oauth2TokenUrl: tokenUrl } });
let ctx: Ctx;
let store: MemorySecretStore;
let problems: { code: string; kind: string }[];
let working: number;
const hooks = (c: Ctx, now = NOW): HealthHooks => ({
  problem: (code, kind) => { problems.push({ code, kind }); recordProblem(c.db, now, code, kind); },
  working: () => { working++; recordWorking(c.db, now); },
});
beforeEach(async () => {
  ctx = makeCtx();
  problems = []; working = 0;
  store = new MemorySecretStore();
  await store.set(REFRESH_TOKEN_KEY, 'refresh-1');
});
const provider = () => new OAuthTokenProvider(client(), store, undefined, hooks(ctx));
const google = (status: number, error: string, description = '') => { reply = { status, body: { error, error_description: description } }; };

describe('the real token request against a fake token endpoint', () => {
  it('works: returns the access token and tells the app the sign-in is healthy', async () => {
    expect(await provider().getAccessToken()).toBe('access-1');
    expect(working).toBe(1);
    expect(problems).toEqual([]);
    expect(requests[0]).toMatch(/^POST \/token /);
    expect(requests[0]).toContain('grant_type=refresh_token');
    expect(requests[0]).toContain('refresh_token=refresh-1');
  });

  it('invalid_grant: forgets the dead token, records why, throws a reconnect error with the code', async () => {
    google(400, 'invalid_grant', 'Token has been expired or revoked.');
    recordConnected(ctx.db, daysAgo(7.2));
    const e = await provider().getAccessToken().catch((x) => x);
    expect(e).toBeInstanceOf(ReconnectRequiredError);
    expect(e).toMatchObject({ code: 'invalid_grant', kind: 'reconnect' });
    expect(await store.get(REFRESH_TOKEN_KEY)).toBeUndefined();
    expect(problems).toEqual([{ code: 'invalid_grant', kind: 'reconnect' }]);
    expect(currentProblem(ctx.db)).toMatchObject({ code: 'invalid_grant', kind: 'reconnect', tokenAgeDays: 7.2, testingLikely: true });
  });

  it('a 7-day-old token that Google rejects is recognised as the Testing-mode limit, and the project is remembered as Testing', async () => {
    google(400, 'invalid_grant');
    recordConnected(ctx.db, daysAgo(7.1));
    await provider().getAccessToken().catch(() => {});
    expect(publishStatus(ctx.db)).toEqual({ status: 'testing', source: 'detected' });
    const msg = problemMessage(currentProblem(ctx.db)!);
    expect(msg).toMatch(/Your Google sign-in expired/);
    expect(msg).toMatch(/7\.1 days old/);
    expect(msg).toMatch(/Testing mode/);
    expect(msg).toMatch(/GOOGLE_PRODUCTION\.md/);
    expect(msg).toMatch(/Click Reconnect/);
  });

  it('a young token that is rejected is NOT blamed on the 7-day limit; the real possibilities are listed', async () => {
    google(400, 'invalid_grant');
    recordConnected(ctx.db, daysAgo(2));
    await provider().getAccessToken().catch(() => {});
    expect(currentProblem(ctx.db)).toMatchObject({ testingLikely: false, tokenAgeDays: 2 });
    expect(publishStatus(ctx.db).status).toBe('unknown');
    const msg = problemMessage(currentProblem(ctx.db)!);
    expect(msg).toMatch(/invalid_grant/);
    for (const cause of ['myaccount.google.com/permissions', '6 months', 'Testing-mode', '100 per account']) expect(msg).toContain(cause);
    expect(msg).not.toMatch(/^Your Google sign-in expired/);
  });

  it('an unknown token age (signed in before tracking) gets the general message, not a guess', async () => {
    google(400, 'invalid_grant');
    await provider().getAccessToken().catch(() => {});
    expect(currentProblem(ctx.db)).toMatchObject({ tokenAgeDays: null, testingLikely: false });
  });

  it('a project known to be in Production is never blamed on the 7-day limit', async () => {
    google(400, 'invalid_grant');
    recordConnected(ctx.db, daysAgo(7));
    setPublishStatus(ctx.db, 'production', 'you');
    await provider().getAccessToken().catch(() => {});
    expect(currentProblem(ctx.db)!.testingLikely).toBe(false);
    expect(publishStatus(ctx.db).status).toBe('production');
  });

  it('invalid_client is a different problem: the token is kept and signing in again is NOT suggested', async () => {
    google(401, 'invalid_client', 'The OAuth client was not found.');
    const e = await provider().getAccessToken().catch((x) => x);
    expect(e).toMatchObject({ code: 'invalid_client', kind: 'client' });
    expect(await store.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
    const msg = problemMessage(currentProblem(ctx.db)!);
    expect(msg).toMatch(/does not recognise this app's OAuth client/);
    expect(msg).toMatch(/Signing in again will not fix that/);
    expect(msg).toMatch(/google-client\.json/);
    expect(msg).not.toMatch(/Click Reconnect/);
  });

  it('unauthorized_client is also a client problem', async () => {
    google(400, 'unauthorized_client');
    expect(await provider().getAccessToken().catch((x) => x)).toMatchObject({ kind: 'client' });
  });

  it('a server error or an unrelated failure is NOT a sign-in problem: nothing recorded, token kept', async () => {
    reply = { status: 503, body: { error: 'backend_error' } };
    await expect(provider().getAccessToken()).rejects.not.toBeInstanceOf(ReconnectRequiredError);
    expect(problems).toEqual([]);
    expect(currentProblem(ctx.db)).toBeNull();
    expect(await store.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
    await server.close();
    await expect(provider().getAccessToken()).rejects.toBeTruthy(); // endpoint gone: offline
    expect(currentProblem(ctx.db)).toBeNull();
    expect(await store.get(REFRESH_TOKEN_KEY)).toBe('refresh-1');
  });

  it('no saved sign-in at all is "not connected", not a recorded problem', async () => {
    await store.delete(REFRESH_TOKEN_KEY);
    const e = await provider().getAccessToken().catch((x) => x);
    expect(e).toMatchObject({ code: 'not_connected' });
    expect(problems).toEqual([]);
  });

  it('a token that works after being older than the Testing limit proves the project is not in Testing mode', async () => {
    recordConnected(ctx.db, daysAgo(12));
    await provider().getAccessToken();
    expect(publishStatus(ctx.db)).toEqual({ status: 'production', source: 'detected' });
  });

  it('a working young token changes nothing', async () => {
    recordConnected(ctx.db, daysAgo(3));
    await provider().getAccessToken();
    expect(publishStatus(ctx.db).status).toBe('unknown');
  });
});

describe('a 401 from the Calendar API (even with a fresh access token)', () => {
  it('is recorded as a sign-in problem and raised as a reconnect error', async () => {
    const h = hooks(ctx);
    const c = new GoogleCalendarClient({ getAccessToken: async () => 'tok' }, (async () => new Response('{}', { status: 401 })) as typeof fetch, 'UTC', () => h.problem('http_401', 'reconnect'));
    const e = await c.listCalendars().catch((x) => x);
    expect(e).toMatchObject({ code: 'http_401', kind: 'reconnect' });
    expect(currentProblem(ctx.db)).toMatchObject({ code: 'http_401', testingLikely: false });
    expect(problemMessage(currentProblem(ctx.db)!)).toMatch(/HTTP 401.*Click Reconnect/);
  });
});

describe('error codes', () => {
  it('classifies the codes Google uses', () => {
    for (const c of ['invalid_grant', 'invalid_token', 'http_401', 'INVALID_GRANT']) expect(classifyCode(c), c).toBe('reconnect');
    for (const c of ['invalid_client', 'unauthorized_client']) expect(classifyCode(c), c).toBe('client');
    for (const c of ['backend_error', 'ENOTFOUND', undefined, '']) expect(classifyCode(c), String(c)).toBeNull();
  });
  it('finds the code in Google\'s error body, in the error code, or in the message', () => {
    expect(googleErrorCode({ response: { data: { error: 'invalid_grant' } } })).toBe('invalid_grant');
    expect(googleErrorCode({ code: 'invalid_client' })).toBe('invalid_client');
    expect(googleErrorCode({ message: 'Error: invalid_grant (Token has been expired or revoked.)' })).toBe('invalid_grant');
    expect(googleErrorCode(new Error('getaddrinfo ENOTFOUND'))).toBeUndefined();
  });
});

describe('how old the sign-in is, and the 7-day countdown', () => {
  it('knows the age only for a sign-in made since tracking began', () => {
    expect(tokenAgeDays(ctx.db, NOW)).toBeNull();
    recordConnected(ctx.db, daysAgo(3.5));
    expect(tokenAgeDays(ctx.db, NOW)).toBeCloseTo(3.5, 5);
  });

  it('shows the Testing countdown ONLY when the app can tell the project is in Testing mode', () => {
    recordConnected(ctx.db, daysAgo(5));
    expect(testingNote(ctx.db, NOW)).toBeNull(); // unknown status: no claim
    setPublishStatus(ctx.db, 'production', 'you');
    expect(testingNote(ctx.db, NOW)).toBeNull();
    setPublishStatus(ctx.db, 'testing', 'you');
    expect(testingNote(ctx.db, NOW)).toMatchObject({ daysLeft: 2, close: true, expiresAt: new Date(daysAgo(5).getTime() + 7 * DAY).toISOString() });
    setPublishStatus(ctx.db, 'unknown', 'you');
    expect(testingNote(ctx.db, NOW)).toBeNull();
  });

  it('says "close" only within 2 days of the limit', () => {
    setPublishStatus(ctx.db, 'testing', 'you');
    recordConnected(ctx.db, daysAgo(4.9));
    expect(testingNote(ctx.db, NOW)).toMatchObject({ close: false });
    recordConnected(ctx.db, daysAgo(5.1));
    expect(testingNote(ctx.db, NOW)).toMatchObject({ close: true });
    recordConnected(ctx.db, daysAgo(7.5));
    expect(testingNote(ctx.db, NOW)!.daysLeft).toBeLessThan(0);
  });

  it('reconnecting resets the age and clears the problem; disconnecting forgets both', () => {
    recordConnected(ctx.db, daysAgo(7.5));
    recordProblem(ctx.db, NOW, 'invalid_grant', 'reconnect');
    expect(currentProblem(ctx.db)).not.toBeNull();
    recordConnected(ctx.db, NOW);
    expect(currentProblem(ctx.db)).toBeNull();
    expect(tokenAgeDays(ctx.db, NOW)).toBe(0);
    recordProblem(ctx.db, NOW, 'invalid_grant', 'reconnect');
    forgetConnection(ctx.db);
    expect(currentProblem(ctx.db)).toBeNull();
    expect(tokenAgeDays(ctx.db, NOW)).toBeNull();
  });

  it('the command-line message keeps the command, the app message says to click Reconnect', () => {
    const p = { kind: 'reconnect' as const, code: 'invalid_grant', tokenAgeDays: null, testingLikely: false };
    expect(problemMessage(p, true)).toMatch(/npm run plan -- calendar connect/);
    expect(problemMessage(p)).not.toMatch(/npm run/);
    expect(problemMessage({ ...p, kind: 'none' as const })).toMatch(/Click Connect/);
  });
});

describe('the status shown in Settings, Google', () => {
  const base = { demo: false, clientFile: '/x/google-client.json', clientFileFound: true };
  it('a rejected sign-in is reported specifically, with Reconnect, not as a generic "not connected"', () => {
    recordConnected(ctx.db, daysAgo(7.3));
    recordProblem(ctx.db, NOW, 'invalid_grant', 'reconnect');
    const s = buildGoogleStatus(ctx.db, NOW, { ...base, tokenSaved: false });
    expect(s).toMatchObject({ connected: false, needsReconnect: true, problem: { kind: 'reconnect', code: 'invalid_grant', testingLikely: true } });
    expect(s.message).toMatch(/Your Google sign-in expired/);
    expect(s.tokenAge).toMatchObject({ days: 7.3 });
    expect(s.publish).toEqual({ status: 'testing', source: 'detected' });
    expect(s.testingNote).toMatchObject({ close: true });
  });
  it('never connected: plain "Not connected", no Reconnect demanded, age unknown', () => {
    const s = buildGoogleStatus(ctx.db, NOW, { ...base, tokenSaved: false });
    expect(s).toMatchObject({ connected: false, needsReconnect: false, problem: null, tokenAge: null, testingNote: null });
    expect(s.message).toMatch(/Not connected/);
  });
  it('a client problem asks for no Reconnect', () => {
    recordProblem(ctx.db, NOW, 'invalid_client', 'client');
    const s = buildGoogleStatus(ctx.db, NOW, { ...base, tokenSaved: true, check: { ok: false, error: 'x' } });
    expect(s.needsReconnect).toBe(false);
    expect(s.message).toMatch(/Signing in again will not fix/);
  });
  it('a saved sign-in that checks out is Connected, with its age', () => {
    recordConnected(ctx.db, daysAgo(1));
    const s = buildGoogleStatus(ctx.db, NOW, { ...base, tokenSaved: true, check: { ok: true } });
    expect(s).toMatchObject({ connected: true, message: 'Connected: Google accepted the saved sign-in.', needsReconnect: false, tokenAge: { days: 1 } });
  });
  it('demo and a missing client file are unchanged', () => {
    expect(buildGoogleStatus(ctx.db, NOW, { ...base, demo: true, tokenSaved: false }).message).toMatch(/simulated calendar/);
    expect(buildGoogleStatus(ctx.db, NOW, { ...base, clientFileFound: false, tokenSaved: false }).message).toMatch(/client file is missing/);
  });
});

describe('what the window gets from the app when Google says no', () => {
  const app = (calendar: () => never): ApiDeps => {
    const c = makeCtx('2026-11-12T15:00:00Z');
    createTerm(c, { name: 'Fall', start_date: '2026-08-31', end_date: '2026-12-21' });
    return { ctx: c, dbFile: ':memory:', demo: false, backupFolder: '/x', calendar };
  };
  it('an expired sign-in comes back with the code google_reconnect and the specific message (Schedule, Availability)', async () => {
    const d = app(() => { throw new ReconnectRequiredError('invalid_grant', 'invalid_grant', 'reconnect'); });
    recordConnected(d.ctx.db, new Date(d.ctx.clock.now().getTime() - 7.2 * DAY));
    recordProblem(d.ctx.db, d.ctx.clock.now(), 'invalid_grant', 'reconnect');
    for (const ch of ['schedule.preview', 'schedule.dryRun']) {
      const r = (await dispatch(d, ch, { days: 7, replan: false })) as any;
      expect(r.ok, ch).toBe(false);
      expect(r.code, ch).toBe('google_reconnect');
      expect(r.error, ch).toMatch(/Your Google sign-in expired/);
      expect(r.error, ch).not.toMatch(/npm run/); // the app says "click Reconnect", not a terminal command
    }
    const busy = (await dispatch(d, 'calendar.busy', { date: '2026-11-12' })) as any;
    expect(busy.value).toMatchObject({ busy: {}, errorCode: 'google_reconnect' });
    expect(busy.value.error).toMatch(/Click Reconnect/);
  });
  it('a client problem has its own code (no Reconnect button)', async () => {
    const d = app(() => { throw new ReconnectRequiredError('invalid_client', 'invalid_client', 'client'); });
    const r = (await dispatch(d, 'schedule.preview', { days: 7, replan: false })) as any;
    expect(r).toMatchObject({ ok: false, code: 'google_client' });
    expect(r.error).toMatch(/OAuth client/);
  });
  it('"not connected yet" says Connect', async () => {
    const d = app(() => { throw new ReconnectRequiredError('not connected yet', 'not_connected'); });
    const r = (await dispatch(d, 'schedule.preview', { days: 7, replan: false })) as any;
    expect(r).toMatchObject({ ok: false, code: 'google_reconnect' });
    expect(r.error).toMatch(/Not connected to Google yet.*Click Connect/);
  });
  it('even without a recorded problem the error itself is turned into the app message', async () => {
    const d = app(() => { throw new ReconnectRequiredError('invalid_grant'); });
    const r = (await dispatch(d, 'schedule.preview', { days: 7, replan: false })) as any;
    expect(r.code).toBe('google_reconnect');
    expect(r.error).toMatch(/invalid_grant/);
  });
  it('other errors have no code', async () => {
    const d = app(() => { throw new Error('Google Calendar API error 500: backend'); });
    const r = (await dispatch(d, 'schedule.preview', { days: 7, replan: false })) as any;
    expect(r.ok).toBe(false);
    expect(r.code).toBeUndefined();
    expect(r.error).toMatch(/500/);
  });
  it('the project status can be set from Settings, validated', async () => {
    const d = app(() => new FakeCalendar({ calendars: [] }) as never);
    expect(((await dispatch(d, 'settings.set', { key: 'google_publish_status', value: 'testing' })) as any).ok).toBe(true);
    expect(publishStatus(d.ctx.db)).toEqual({ status: 'testing', source: 'you' });
    expect(((await dispatch(d, 'settings.set', { key: 'google_publish_status', value: 'maybe' })) as any).ok).toBe(false);
    await dispatch(d, 'settings.set', { key: 'google_publish_status', value: 'unknown' });
    expect(publishStatus(d.ctx.db).status).toBe('unknown');
  });
});
