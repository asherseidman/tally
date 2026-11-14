import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function appDataDir(): string {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
  const dir = join(base, 'todo-planner');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Real DB, or the separate demo DB. PLANNER_DB overrides the real DB path. */
export function dbPath(demo: boolean): string {
  if (demo) return process.env.PLANNER_DEMO_DB ?? join(appDataDir(), 'demo.db');
  return process.env.PLANNER_DB ?? join(appDataDir(), 'planner.db');
}
