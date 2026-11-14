import type { Db } from '../db/index';
import type { GoogleStatus } from './types';
import { connectedAt, currentProblem, problemMessage, publishStatus, recordWorking, testingNote, tokenAgeDays, type Problem } from '../schedule/googleHealth';

/** The health part of the Google status: what is wrong (specifically), how old the sign-in is, and the Testing-mode countdown when known. */
export function healthExtras(db: Db, now: Date): Pick<GoogleStatus, 'needsReconnect' | 'problem' | 'tokenAge' | 'publish' | 'testingNote'> {
  const p = currentProblem(db);
  const age = tokenAgeDays(db, now);
  const at = connectedAt(db);
  const pub = publishStatus(db);
  return {
    needsReconnect: !!p && p.kind === 'reconnect',
    problem: p ? { ...pick(p), message: problemMessage(p) } : null,
    tokenAge: at && age !== null ? { connectedAt: at, days: Math.round(age * 10) / 10 } : null,
    publish: pub,
    testingNote: testingNote(db, now),
  };
}
const pick = (p: Problem) => ({ at: p.at, kind: p.kind, code: p.code, tokenAgeDays: p.tokenAgeDays, testingLikely: p.testingLikely });

export interface StatusInput {
  demo: boolean;
  clientFile: string;
  clientFileFound: boolean;
  /** a refresh token is saved in the keychain */
  tokenSaved: boolean;
  /** the result of actually asking Google (only for "Check connection") */
  check?: { ok: true } | { ok: false; error: string };
}

/** The status shown in Settings, Google. A rejected sign-in is reported with its specific reason, not as a generic "not connected". */
export function buildGoogleStatus(db: Db, now: Date, i: StatusInput): GoogleStatus {
  const base = { demo: i.demo, clientFile: i.clientFile, clientFileFound: i.clientFileFound };
  if (i.demo) return { demo: true, clientFile: null, clientFileFound: false, connected: false, message: 'Demo database: it uses a simulated calendar, so there is nothing to connect.' };
  if (!i.clientFileFound) return { ...base, connected: false, message: `The Google client file is missing. Save your OAuth client JSON as ${i.clientFile} (see the README).`, ...healthExtras(db, now) };
  const problem = currentProblem(db);
  if (!i.tokenSaved) {
    if (problem) return { ...base, connected: false, message: problemMessage(problem), ...healthExtras(db, now) };
    return { ...base, connected: false, message: 'Not connected. Choose Connect to sign in with Google in your browser.', ...healthExtras(db, now) };
  }
  if (!i.check) return { ...base, connected: true, message: problem ? problemMessage(problem) : 'A Google sign-in is saved in your keychain. Choose “Check connection” to test it.', ...healthExtras(db, now) };
  if (i.check.ok) {
    recordWorking(db, now);
    return { ...base, connected: true, message: 'Connected: Google accepted the saved sign-in.', ...healthExtras(db, now) };
  }
  const p = currentProblem(db);
  return { ...base, connected: false, message: p ? problemMessage(p) : i.check.error, ...healthExtras(db, now) };
}
