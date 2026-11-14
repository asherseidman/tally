import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { claudeWritesAllowed } from '../core/claudeAccess';
import { registerTools, type McpEnv } from './tools';

export function createServer(e: McpEnv): McpServer {
  const server = new McpServer(
    { name: 'tally', version: '1.0.0' },
    {
      instructions:
        `Tally is the user's personal to-do planner. This connector is using the ${e.target.label} (${e.target.dbFile}). ` +
        `Call tally_status first. Reading is always allowed. Changing tasks is ${claudeWritesAllowed(e.ctx.db) ? 'currently allowed' : 'currently OFF: the user must turn on “Allow Claude to change my tasks” in Tally, Settings, General'}. ` +
        'Claude cannot apply a schedule to Google Calendar, delete anything, restore backups or change settings: those tools do not exist. ' +
        'To import a file, call import_dry_run, show the user the diff, and only call import_confirm after they approve that exact diff.',
    },
  );
  registerTools(server, e);
  return server;
}
