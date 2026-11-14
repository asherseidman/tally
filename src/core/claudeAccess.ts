import type { Db } from '../db/index';
import { getSetting } from '../db/repo';

/** The one switch that lets Claude (over the MCP connector) change tasks. OFF unless the user turned it on in Settings. Read fresh on every call. */
export const CLAUDE_WRITES_KEY = 'mcp_allow_writes';
export const claudeWritesAllowed = (db: Db): boolean => getSetting(db, CLAUDE_WRITES_KEY) === 'true';

/** Separate switches, each OFF unless turned on in Settings, General, Claude connector. Read fresh on every call. */
export const CLAUDE_DELETES_KEY = 'mcp_allow_deletes';
export const CLAUDE_SCHEDULE_KEY = 'mcp_allow_schedule';
export const claudeDeletesAllowed = (db: Db): boolean => getSetting(db, CLAUDE_DELETES_KEY) === 'true';
export const claudeScheduleAllowed = (db: Db): boolean => getSetting(db, CLAUDE_SCHEDULE_KEY) === 'true';
