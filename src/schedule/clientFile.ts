import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * The Google OAuth client file (google-client.json). Tally ships WITHOUT one: the user creates their own free "Desktop app"
 * client in Google Cloud and chooses its JSON here. The secret in it is read only by the sign-in code; nothing in this module
 * ever returns, logs or displays it. Only the END of the client ID is shown.
 */

export const MAX_CLIENT_FILE_BYTES = 50_000;

export type ClientCheck = { ok: true; clientId: string } | { ok: false; error: string };

const isLoopback = (uri: unknown) => typeof uri === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(uri.trim());

/** Is this the JSON of a Desktop-app OAuth client (installed type, client_id, client_secret, a loopback redirect)? Never returns the secret. */
export function validateClientJson(text: string): ClientCheck {
  if (text.length > MAX_CLIENT_FILE_BYTES) return { ok: false, error: 'That file is too large to be a Google client file.' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'That file is not valid JSON. Choose the file you downloaded from Google Cloud (it is named like client_secret_….json).' }; }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  if (o.web && !o.installed) return { ok: false, error: 'That is a “Web application” client. Tally needs a “Desktop app” client: create a new client in Google Cloud with Application type: Desktop app, and download its JSON.' };
  const c = o.installed;
  if (!c || typeof c !== 'object') return { ok: false, error: 'That does not look like a Google client file: it has no “installed” section. Create the client with Application type: Desktop app and download its JSON.' };
  if (typeof c.client_id !== 'string' || !c.client_id.trim()) return { ok: false, error: 'The file has no client_id. Download the client’s JSON again from Google Cloud.' };
  if (typeof c.client_secret !== 'string' || !c.client_secret.trim()) return { ok: false, error: 'The file has no client_secret. Download the client’s JSON again from Google Cloud.' };
  if (!Array.isArray(c.redirect_uris) || !c.redirect_uris.some(isLoopback)) return { ok: false, error: 'The file has no localhost redirect, which a Desktop app client always has. It may be a different kind of client; create one with Application type: Desktop app.' };
  return { ok: true, clientId: c.client_id.trim() };
}

/** "…1234": the last characters of a client ID (a client ID is not secret, but only its end is ever shown). */
export const idTail = (clientId: string) => `…${clientId.replace(/\.apps\.googleusercontent\.com$/i, '').slice(-4)}`;

export interface ClientInfo { found: boolean; valid: boolean; idTail: string | null }

/** What is at `path`, without exposing anything secret. */
export function clientFileInfo(path: string): ClientInfo {
  if (!existsSync(path)) return { found: false, valid: false, idTail: null };
  try {
    if (statSync(path).size > MAX_CLIENT_FILE_BYTES) return { found: true, valid: false, idTail: null };
    const v = validateClientJson(readFileSync(path, 'utf8'));
    return v.ok ? { found: true, valid: true, idTail: idTail(v.clientId) } : { found: true, valid: false, idTail: null };
  } catch { return { found: true, valid: false, idTail: null }; }
}

/** The full client ID of the file at `path`, or undefined (used only to tell whether a replacement is a different client). */
export function currentClientId(path: string): string | undefined {
  try { const v = validateClientJson(readFileSync(path, 'utf8')); return v.ok ? v.clientId : undefined; } catch { return undefined; }
}

export interface InstallResult { clientId: string; tail: string; replaced: boolean; sameClient: boolean }

/**
 * Validates the chosen file and, only if it is good, writes it to `target` (mode 600, through a temp file and a rename, so a
 * failure never leaves a half-written client file). A bad file throws a plain-words error and nothing is written.
 */
export function installClientFile(target: string, pickedPath: string): InstallResult {
  let size: number;
  try { size = statSync(pickedPath).size; } catch { throw new Error('Tally could not read that file.'); }
  if (size > MAX_CLIENT_FILE_BYTES) throw new Error('That file is too large to be a Google client file.');
  let text: string;
  try { text = readFileSync(pickedPath, 'utf8'); } catch { throw new Error('Tally could not read that file.'); }
  const v = validateClientJson(text);
  if (!v.ok) throw new Error(v.error);
  const replaced = existsSync(target);
  const before = replaced ? currentClientId(target) : undefined;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw new Error(`Tally could not save the client file (${(e as NodeJS.ErrnoException).code ?? 'write error'}).`);
  }
  chmodSync(target, 0o600);
  return { clientId: v.clientId, tail: idTail(v.clientId), replaced, sameClient: before === v.clientId };
}

/** Deletes the saved client file. Nothing to do (and no error) if there is none. */
export function removeClientFile(path: string): boolean {
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
