import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { appDataDir } from '../paths';
import type { SecretStore } from './secretStore';
import { GOOGLE_SCOPES, ReconnectRequiredError, type AccessTokenProvider } from './googleCalendar';
import { classifyCode, type ProblemKind } from './googleHealth';

export const REFRESH_TOKEN_KEY = 'google-refresh-token';

export const defaultClientFile = () => process.env.PLANNER_GOOGLE_CLIENT ?? join(appDataDir(), 'google-client.json');

/** Reads the "Desktop app" OAuth client JSON downloaded from Google Cloud Console. */
export function readClientFile(path: string): { clientId: string; clientSecret: string } {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Can't read the Google OAuth client file at ${path} (${(e as Error).message}). Download it from Google Cloud Console (Google Auth platform > Clients) and save it as google-client.json there.`);
  }
  const c = raw?.installed;
  if (!c?.client_id) throw new Error(`${path} is not a "Desktop app" client (expected an "installed" section). Create the client with Application type: Desktop app.`);
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export function parseCallbackUrl(reqUrl: string, expectedState: string): { code: string } {
  const q = new URL(reqUrl, 'http://127.0.0.1').searchParams;
  if (q.get('state') !== expectedState) throw new Error('Sign-in response had the wrong state value (possible forged request); ignoring it.');
  if (q.get('error')) throw new Error(`Google sign-in was not completed: ${q.get('error')}`);
  const code = q.get('code');
  if (!code) throw new Error('Google sign-in response had no code.');
  return { code };
}

type TokenClient = Pick<OAuth2Client, 'setCredentials' | 'getAccessToken'>;

/** What the app wants to know about the sign-in: why it stopped working, and when it worked. */
export interface HealthHooks {
  problem(code: string, kind: ProblemKind): void;
  working(): void;
}

/** Google's reason from a failed token request (the error body's `error`, or the code on the error). */
export function googleErrorCode(e: any): string | undefined {
  const raw = e?.response?.data?.error ?? e?.code;
  const code = typeof raw === 'string' ? raw : typeof raw?.status === 'string' ? raw.status : undefined;
  if (code && classifyCode(code)) return code.toLowerCase();
  const m = /(invalid_grant|invalid_token|invalid_client|unauthorized_client)/i.exec(String(e?.message ?? ''));
  return m ? m[1].toLowerCase() : code;
}

/** Turns the stored refresh token into short-lived access tokens; maps expiry/revocation to a reconnect error. */
export class OAuthTokenProvider implements AccessTokenProvider {
  constructor(
    private client: TokenClient,
    private store: SecretStore,
    private key = REFRESH_TOKEN_KEY,
    private health?: HealthHooks,
  ) {}

  async getAccessToken(): Promise<string> {
    const refresh = await this.store.get(this.key);
    if (!refresh) throw new ReconnectRequiredError('not connected yet', 'not_connected');
    this.client.setCredentials({ refresh_token: refresh });
    try {
      const r = await this.client.getAccessToken();
      if (!r.token) throw new Error('Google returned no access token');
      this.health?.working();
      return r.token;
    } catch (e: any) {
      const code = googleErrorCode(e);
      const kind = classifyCode(code);
      if (code && kind === 'reconnect') {
        // the saved sign-in is dead: forget it, remember why, and ask for a fresh one
        await this.store.delete(this.key);
        this.health?.problem(code, 'reconnect');
        throw new ReconnectRequiredError(code, code, 'reconnect');
      }
      if (code && kind === 'client') {
        // the sign-in may be fine; the app's client is not. Keep the token and say what is wrong.
        this.health?.problem(code, 'client');
        throw new ReconnectRequiredError(code, code, 'client');
      }
      throw e;
    }
  }
}

export function makeOAuthClient(clientFile = defaultClientFile()): OAuth2Client {
  const { clientId, clientSecret } = readClientFile(clientFile);
  return new OAuth2Client({ clientId, clientSecret });
}

/**
 * Interactive sign-in for a desktop app: system browser + loopback redirect + PKCE (Google's
 * recommended flow; embedded browsers are not allowed). Stores only the refresh token, in the keychain.
 */
export async function connectInteractive(store: SecretStore, clientFile = defaultClientFile(), log: (s: string) => void = console.log, onConnected?: () => void): Promise<void> {
  const client = makeOAuthClient(clientFile);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString('hex');

  const server = createServer();
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out after 5 minutes waiting for Google sign-in.')), 5 * 60_000);
    server.on('request', (req, res) => {
      if (!req.url || req.url === '/favicon.ico') return void res.end();
      try {
        const { code } = parseCallbackUrl(req.url, state);
        res.end('<html><body style="font-family:sans-serif"><h3>Connected. You can close this tab and return to the terminal.</h3></body></html>');
        clearTimeout(timer);
        resolve(code);
      } catch (e) {
        res.statusCode = 400;
        res.end(`<html><body style="font-family:sans-serif"><h3>${(e as Error).message}</h3></body></html>`);
        clearTimeout(timer);
        reject(e);
      }
    });
  });

  log('Opening your browser to sign in with Google. If it does not open, visit:\n' + url + '\n');
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  try {
    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and try again.');
    await store.set(REFRESH_TOKEN_KEY, tokens.refresh_token);
    onConnected?.(); // the app notes when this sign-in was made (its age matters for the 7-day Testing-mode limit)
  } finally {
    server.close();
  }
}
