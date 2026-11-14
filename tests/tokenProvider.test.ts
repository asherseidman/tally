import { describe, it, expect } from 'vitest';
import { MemorySecretStore, CachedSecretStore } from '../src/schedule/secretStore';
import { OAuthTokenProvider, parseCallbackUrl, readClientFile } from '../src/schedule/auth';
import { ReconnectRequiredError } from '../src/schedule/googleCalendar';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('secret store', () => {
  it('stores, reads and deletes a secret', async () => {
    const s = new MemorySecretStore();
    expect(await s.get('k')).toBeUndefined();
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
    await s.delete('k');
    expect(await s.get('k')).toBeUndefined();
  });
});

describe('CachedSecretStore (one Keychain read per launch, not one per API call)', () => {
  it('reads the underlying store once, however many times it is asked', async () => {
    const inner = new MemorySecretStore();
    await inner.set('google-refresh-token', 'abc');
    let reads = 0;
    const counting = { get: async (k: string) => { reads++; return inner.get(k); }, set: (k: string, v: string) => inner.set(k, v), delete: (k: string) => inner.delete(k) };
    const s = new CachedSecretStore(counting);
    for (let i = 0; i < 20; i++) expect(await s.get('google-refresh-token')).toBe('abc');
    expect(reads).toBe(1);
  });
  it('remembers "nothing stored" too, and writes/deletes go through and update what it remembers', async () => {
    const inner = new MemorySecretStore();
    const s = new CachedSecretStore(inner);
    expect(await s.get('k')).toBeUndefined();
    expect(await s.get('k')).toBeUndefined();
    expect(s.reads).toBe(1);
    await s.set('k', 'v');
    expect(await inner.get('k')).toBe('v');
    expect(await s.get('k')).toBe('v');
    await s.delete('k');
    expect(await inner.get('k')).toBeUndefined();
    expect(await s.get('k')).toBeUndefined();
    expect(s.reads).toBe(1);
  });
  it('a token provider on top of it reads the Keychain once across many access-token requests', async () => {
    const inner = new MemorySecretStore();
    await inner.set('google-refresh-token', 'r');
    const cached = new CachedSecretStore(inner);
    const client = { setCredentials() {}, getAccessToken: async () => ({ token: 't' }) };
    const p = new OAuthTokenProvider(client as never, cached);
    for (let i = 0; i < 5; i++) expect(await p.getAccessToken()).toBe('t');
    expect(cached.reads).toBe(1);
  });
});

describe('OAuthTokenProvider', () => {
  const fakeClient = (impl: any) => ({ setCredentials() {}, ...impl });
  it('says "not connected" when there is no refresh token', async () => {
    const p = new OAuthTokenProvider(fakeClient({}) as any, new MemorySecretStore());
    await expect(p.getAccessToken()).rejects.toThrow(/calendar connect/);
  });
  it('returns an access token using the stored refresh token', async () => {
    const store = new MemorySecretStore();
    await store.set('google-refresh-token', 'r1');
    let creds: any;
    const client = fakeClient({ setCredentials: (c: any) => (creds = c), getAccessToken: async () => ({ token: 'access!' }) });
    expect(await new OAuthTokenProvider(client as any, store).getAccessToken()).toBe('access!');
    expect(creds).toEqual({ refresh_token: 'r1' });
  });
  it('maps invalid_grant (expired 7-day Testing token or revoked access) to a reconnect error and keeps nothing stale', async () => {
    const store = new MemorySecretStore();
    await store.set('google-refresh-token', 'r1');
    const err: any = new Error('invalid_grant');
    err.response = { data: { error: 'invalid_grant' } };
    const client = fakeClient({ getAccessToken: async () => { throw err; } });
    const p = new OAuthTokenProvider(client as any, store);
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(ReconnectRequiredError);
    await expect(p.getAccessToken()).rejects.toThrow(/expired or was revoked/);
    expect(await store.get('google-refresh-token')).toBeUndefined();
  });
  it('other failures (offline) are NOT treated as needing reconnect and keep the token', async () => {
    const store = new MemorySecretStore();
    await store.set('google-refresh-token', 'r1');
    const client = fakeClient({ getAccessToken: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
    await expect(new OAuthTokenProvider(client as any, store).getAccessToken()).rejects.toThrow(/ENOTFOUND/);
    expect(await store.get('google-refresh-token')).toBe('r1');
  });
});

describe('oauth loopback callback', () => {
  it('extracts the code when state matches', () => {
    expect(parseCallbackUrl('/?code=abc&state=xyz', 'xyz')).toEqual({ code: 'abc' });
  });
  it('rejects a wrong state (CSRF) and provider errors', () => {
    expect(() => parseCallbackUrl('/?code=abc&state=nope', 'xyz')).toThrow(/state/i);
    expect(() => parseCallbackUrl('/?error=access_denied&state=xyz', 'xyz')).toThrow(/access_denied/);
    expect(() => parseCallbackUrl('/?state=xyz', 'xyz')).toThrow(/code/i);
  });
});

describe('client file', () => {
  it('reads a Desktop-app client JSON', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'gc-')), 'c.json');
    writeFileSync(f, JSON.stringify({ installed: { client_id: 'id', client_secret: 's', redirect_uris: ['http://localhost'] } }));
    expect(readClientFile(f)).toEqual({ clientId: 'id', clientSecret: 's' });
  });
  it('explains what is wrong with a missing or wrong-type file', () => {
    expect(() => readClientFile('/nonexistent/c.json')).toThrow(/google-client\.json/);
    const f = join(mkdtempSync(join(tmpdir(), 'gc-')), 'c.json');
    writeFileSync(f, JSON.stringify({ web: { client_id: 'id' } }));
    expect(() => readClientFile(f)).toThrow(/Desktop app/);
  });
});
