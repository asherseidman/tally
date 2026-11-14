// Prints the exact connector config for this machine (absolute paths, because Claude starts it without your shell's PATH).
// npm run mcp:config            -> your REAL database
// npm run mcp:config -- --demo  -> the DEMO database (safe to try)
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

const demo = process.argv.includes('--demo');
const dir = join(homedir(), 'Library', 'Application Support', 'todo-planner');
const db = join(dir, demo ? 'demo.db' : 'planner.db');
const expect = demo ? 'demo' : 'real';
const name = demo ? 'tally-demo' : 'tally';
const script = resolve('dist-mcp/tally-mcp.mjs');
// prefer the stable symlink (it survives `brew upgrade`) over the versioned Cellar path, when it is the same program
const node = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p) && realpathSync(p) === realpathSync(process.execPath)) ?? process.execPath;
const env = { TALLY_MCP_DB: db, TALLY_MCP_EXPECT: expect };

if (!existsSync(script)) console.log(`(first run: npm run build:mcp   — builds ${script})\n`);
console.log(`Connector for the ${demo ? 'DEMO' : 'REAL'} database: ${db}\n`);
console.log('Claude desktop app: add this inside "mcpServers" in ~/Library/Application Support/Claude/claude_desktop_config.json (Settings, Developer, Edit Config), then quit and reopen Claude:\n');
console.log(JSON.stringify({ mcpServers: { [name]: { command: node, args: [script], env } } }, null, 2));
console.log('\nClaude Code (one command, then /mcp to check):\n');
console.log(`claude mcp add ${name} --scope user -e TALLY_MCP_DB="${db}" -e TALLY_MCP_EXPECT=${expect} -- ${node} ${script}`);
