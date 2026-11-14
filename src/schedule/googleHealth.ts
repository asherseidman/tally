import type { Db } from '../db/index';
import { getSetting, setSetting } from '../db/repo';

/**
 * What the app knows about the health of the Google sign-in, kept as plain settings in the database (never a secret: the refresh
 * token itself stays in the Keychain). It lets the app say WHY a sign-in stopped working, show how old it is, and warn before a
 * Testing-mode token (which Google expires after 7 days) runs out. Pure: no Google, no Electron.
 */
export const TESTING_LIMIT_DAYS = 7;
/** a token older than this that still works cannot be a Testing-mode token */
const PRODUCTION_PROOF_DAYS = 8.5;
/** a token this old when Google rejects it is almost certainly the 7-day Testing-mode limit */
const TESTING_WINDOW_DAYS = [6, 8.5] as const;
const CLOSE_DAYS = 2;
const DAY = 86_400_000;

const CONNECTED_AT = 'google_connected_at';
const PROBLEM = 'google_auth_problem';
const PUBLISH = 'google_publish_status';
const PUBLISH_SRC = 'google_publish_source';

export type PublishStatus = 'testing' | 'production' | 'unknown';
export type ProblemKind = 'reconnect' | 'client';
export interface Problem {
  at: string;
  kind: ProblemKind;
  /** Google's error code: invalid_grant, invalid_token, invalid_client, unauthorized_client, http_401 */
  code: string;
  /** how old the saved sign-in was when Google rejected it, if known */
  tokenAgeDays: number | null;
  /** the age (or the project status) says this is the 7-day Testing-mode limit */
  testingLikely: boolean;
}

/** Which Google error codes mean "sign in again" and which mean "the app's client setup is wrong" (signing in again will not help). */
export function classifyCode(code: string | undefined): ProblemKind | null {
  switch ((code ?? '').toLowerCase()) {
    case 'invalid_grant': case 'invalid_token': case 'http_401': case 'unauthorized': return 'reconnect';
    case 'invalid_client': case 'unauthorized_client': return 'client';
    default: return null;
  }
}

export function recordConnected(db: Db, now: Date): void {
  setSetting(db, CONNECTED_AT, now.toISOString());
  db.run('DELETE FROM settings WHERE key = ?', [PROBLEM]);
}

/** The sign-in was removed on purpose: forget its age and any recorded problem. */
export function forgetConnection(db: Db): void {
  db.run('DELETE FROM settings WHERE key IN (?, ?)', [CONNECTED_AT, PROBLEM]);
}

export const connectedAt = (db: Db): string | null => getSetting(db, CONNECTED_AT) ?? null;

export function tokenAgeDays(db: Db, now: Date): number | null {
  const at = connectedAt(db);
  if (!at) return null;
  const ms = now.getTime() - Date.parse(at);
  return Number.isFinite(ms) ? Math.max(0, ms / DAY) : null;
}

export function publishStatus(db: Db): { status: PublishStatus; source: 'you' | 'detected' | null } {
  const v = getSetting(db, PUBLISH);
  if (v !== 'testing' && v !== 'production') return { status: 'unknown', source: null };
  return { status: v, source: getSetting(db, PUBLISH_SRC) === 'detected' ? 'detected' : 'you' };
}

export function setPublishStatus(db: Db, status: PublishStatus, source: 'you' | 'detected'): void {
  if (status === 'unknown') { db.run('DELETE FROM settings WHERE key IN (?, ?)', [PUBLISH, PUBLISH_SRC]); return; }
  setSetting(db, PUBLISH, status);
  setSetting(db, PUBLISH_SRC, source);
}

/** Google rejected the saved sign-in (or the client). Remember why, and learn from the token's age whether the project is in Testing mode. */
export function recordProblem(db: Db, now: Date, code: string, kind: ProblemKind): Problem {
  const age = tokenAgeDays(db, now);
  const status = publishStatus(db).status;
  const inWindow = age !== null && age >= TESTING_WINDOW_DAYS[0] && age <= TESTING_WINDOW_DAYS[1];
  const testingLikely = kind === 'reconnect' && code !== 'http_401' && (status === 'testing' || (status !== 'production' && inWindow));
  if (kind === 'reconnect' && inWindow && status === 'unknown') setPublishStatus(db, 'testing', 'detected');
  const p: Problem = { at: now.toISOString(), kind, code, tokenAgeDays: age === null ? null : Math.round(age * 10) / 10, testingLikely };
  setSetting(db, PROBLEM, JSON.stringify(p));
  return p;
}

export function currentProblem(db: Db): Problem | null {
  try {
    const p = JSON.parse(getSetting(db, PROBLEM) ?? 'null');
    return p && typeof p.at === 'string' && (p.kind === 'reconnect' || p.kind === 'client') ? (p as Problem) : null;
  } catch { return null; }
}

/** A saved sign-in just worked. If it is clearly older than the Testing limit, the project is not in Testing mode (any more). */
export function recordWorking(db: Db, now: Date): void {
  const age = tokenAgeDays(db, now);
  if (age !== null && age > PRODUCTION_PROOF_DAYS && publishStatus(db).status !== 'production') setPublishStatus(db, 'production', 'detected');
}

export interface TestingNote { expiresAt: string; daysLeft: number; close: boolean }
/** Only when the app can tell the project is in Testing mode (you said so, or a token expired at about 7 days). */
export function testingNote(db: Db, now: Date): TestingNote | null {
  if (publishStatus(db).status !== 'testing') return null;
  const at = connectedAt(db);
  if (!at) return null;
  const expires = Date.parse(at) + TESTING_LIMIT_DAYS * DAY;
  const daysLeft = (expires - now.getTime()) / DAY;
  return { expiresAt: new Date(expires).toISOString(), daysLeft: Math.round(daysLeft * 10) / 10, close: daysLeft <= CLOSE_DAYS };
}

/** The message for a rejected sign-in, in plain words and specific to what is known. `cli` adds the command-line way to reconnect. */
export function problemMessage(p: { kind: ProblemKind | 'none'; code: string; tokenAgeDays: number | null; testingLikely: boolean }, cli = false): string {
  const how = cli ? ' Reconnect with: npm run plan -- calendar connect' : ' Click Reconnect to sign in again.';
  if (p.kind === 'none') return `Not connected to Google yet.${cli ? ' Connect with: npm run plan -- calendar connect' : ' Click Connect to sign in.'}`;
  if (p.kind === 'client') {
    return `Google does not recognise this app's OAuth client (${p.code}). Signing in again will not fix that: check that google-client.json is the current “Desktop app” client of your Google Cloud project and has not been deleted or rotated (see the README).`;
  }
  if (p.code === 'http_401') return `Google refused the saved sign-in (HTTP 401).${how}`;
  if (p.testingLikely) {
    const age = p.tokenAgeDays !== null ? `It was ${Math.round(p.tokenAgeDays * 10) / 10} days old, and Google` : 'Google';
    return `Your Google sign-in expired. ${age} expires sign-ins after 7 days while the Google Cloud project is in Testing mode (docs/GOOGLE_PRODUCTION.md shows how to stop this repeating every week).${how}`;
  }
  return `Google no longer accepts the saved sign-in (${p.code}). That happens when access was removed at myaccount.google.com/permissions, the sign-in went unused for 6 months, a newer sign-in pushed it out (Google keeps at most 100 per account per client), or a Testing-mode sign-in passed 7 days.${how}`;
}
