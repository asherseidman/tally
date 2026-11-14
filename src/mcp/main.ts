// The Tally MCP connector: a local stdio server that a Claude client starts. No network port, no LLM, no API key, no Google.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb, schemaVersionOf } from '../db/index';
import { MIGRATIONS } from '../db/schema';
import { getSetting } from '../db/repo';
import { systemClock } from '../clock';
import { backupFolderFor } from '../cli/context';
import type { Ctx } from '../core/ctx';
import { claudeWritesAllowed } from '../core/claudeAccess';
import { resolveTarget } from './target';
import { createServer } from './server';

async function main() {
  const target = resolveTarget(process.env);
  const version = schemaVersionOf(target.dbFile);
  if (version !== undefined && version > MIGRATIONS.length) throw new Error(`${target.dbFile} is from a newer Tally (schema ${version}); update Tally before using the connector.`);
  // The connector never migrates a database that another program (the app) may be using. Open the current Tally or the CLI once to upgrade it.
  if (version === undefined || version < MIGRATIONS.length) throw new Error(`${target.dbFile} needs a database upgrade first. Open Tally (or run: npm run plan -- doctor) once, then reconnect. The upgrade takes a verified backup automatically.`);
  const db = openDb(target.dbFile); // WAL + busy timeout: safe next to the running app
  const ctx: Ctx = { db, clock: systemClock, tz: getSetting(db, 'timezone') ?? 'America/Detroit', defaultTime: getSetting(db, 'default_due_time') ?? '23:59' };
  const backupFolder = backupFolderFor(getSetting(db, 'backup_folder'), target.dbFile, target.kind === 'demo');
  // stdout is the protocol; everything human-readable goes to stderr
  console.error(`[tally-mcp] ${target.label}: ${target.dbFile}`);
  console.error(`[tally-mcp] Claude may change tasks: ${claudeWritesAllowed(db) ? 'YES' : 'no (read-only; turn it on in Tally, Settings, General)'}`);
  const server = createServer({ ctx, target, backupFolder });
  const close = () => { try { db.close(); } catch { /* already closed */ } process.exit(0); };
  process.stdin.on('end', close);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(`[tally-mcp] ${(e as Error).message}`);
  process.exit(1);
});
