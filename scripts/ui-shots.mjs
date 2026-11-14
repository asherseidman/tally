// UI screenshots for docs/ui, on a scratch DEMO database with a fixed fake fixture, in both themes.
//   node scripts/ui-shots.mjs <label> [screen ...]     e.g. node scripts/ui-shots.mjs after today
// Writes docs/ui/<label>-<screen>-<light|dark>.png at 1280 px wide. Nothing touches your real data or Google.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const electron = createRequire(import.meta.url)('electron');

const [label = 'shot', ...screens] = process.argv.slice(2);
const list = screens.length ? screens : ['today'];
// a screen name like today@900x640 also takes the shot in a small window
const sizeOf = (screen) => (screen.includes('@') ? screen.split('@')[1] : '');
mkdirSync('docs/ui', { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'ui-shots-'));
const base = join(dir, 'base.db');
execFileSync('npx', ['tsx', 'src/cli/seed.ts'], { env: { ...process.env, PLANNER_DEMO_DB: base }, stdio: 'ignore' });
execFileSync('npx', ['tsx', 'scripts/ui-fixture.ts'], { env: { ...process.env, PLANNER_DEMO_DB: base }, stdio: 'inherit' });
for (const screen of list) {
  for (const theme of ['light', 'dark']) {
    const db = join(dir, `${screen}-${theme}.db`);
    copyFileSync(base, db);
    const out = `docs/ui/${label}-${screen.replace('@', '-')}-${theme}.png`;
    const r = spawnSync(electron, ['.'], {
      env: { ...process.env, PLANNER_DEMO: '1', PLANNER_DEMO_DB: db, PLANNER_THEME: theme, PLANNER_SELFTEST: out, PLANNER_SELFTEST_WAIT: '3500', PLANNER_SHOT_WIDTH: sizeOf(screen) ? sizeOf(screen).split('x')[0] : '1280', PLANNER_WINDOW_SIZE: sizeOf(screen), PLANNER_SHOT_SCREEN: screen.split('@')[0], PLANNER_QUIT_TIMER: 'keep' },
      encoding: 'utf8', timeout: 60000,
    });
    console.log(`${r.status === 0 ? 'wrote' : 'FAILED'} ${out}${r.status === 0 ? '' : '\n' + (r.stdout + r.stderr).slice(-400)}`);
  }
}
