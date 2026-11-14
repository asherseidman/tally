import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { appDataDir } from '../paths';

/**
 * Which database the connector is allowed to open. There is deliberately NO default: the client's config must name the
 * file (TALLY_MCP_DB) AND say what it believes that file is (TALLY_MCP_EXPECT = real | demo | test). If the two disagree
 * (the real path with "demo", the demo path with "real", or a real/demo path with "test") the server refuses to start,
 * so a copy-paste mix-up can never silently point Claude at the wrong data.
 */
export type TargetKind = 'real' | 'demo' | 'test';
export interface Target { dbFile: string; kind: TargetKind; label: string }

export const realDbFile = (): string => join(appDataDir(), 'planner.db');
export const demoDbFile = (): string => join(appDataDir(), 'demo.db');

export function resolveTarget(env: Record<string, string | undefined>): Target {
  const raw = env.TALLY_MCP_DB?.trim();
  const expect = env.TALLY_MCP_EXPECT?.trim().toLowerCase();
  if (!raw) throw new Error('TALLY_MCP_DB is not set. Set it to the database file to open (there is no default, so the connector can never pick the wrong one by accident). See docs/MCP.md.');
  if (!isAbsolute(raw)) throw new Error(`TALLY_MCP_DB must be an absolute path (got "${raw}").`);
  if (expect !== 'real' && expect !== 'demo' && expect !== 'test') throw new Error('TALLY_MCP_EXPECT must be "real", "demo" or "test": say which database TALLY_MCP_DB is meant to be. See docs/MCP.md.');
  const dbFile = resolve(raw);
  const isReal = dbFile === realDbFile();
  const isDemo = dbFile === demoDbFile();
  const actual: TargetKind = isReal ? 'real' : isDemo ? 'demo' : 'test';
  if (actual !== expect) {
    throw new Error(`Refusing to start: TALLY_MCP_EXPECT says "${expect}" but ${dbFile} is ${actual === 'test' ? 'neither your real nor your demo database' : `your ${actual.toUpperCase()} database`}. Fix the config so they agree.`);
  }
  if (!existsSync(dbFile)) throw new Error(`No database at ${dbFile}. The connector never creates one: open Tally (or run the CLI) once first${actual === 'demo' ? ', or npm run seed for the demo database' : ''}.`);
  return { dbFile, kind: actual, label: actual === 'real' ? 'REAL database' : actual === 'demo' ? 'DEMO database' : 'TEST database' };
}
