// Installs release/mac-arm64/Tally.app into /Applications (replacing an older Tally). Run: npm run install:app
// The app used to be called Planner. If /Applications/Planner.app exists it says so and asks before removing it
// (non-interactive: pass --remove-old to remove it, or leave it and remove it by hand later).
// It never touches your database, backups or Google sign-in: those live in ~/Library/Application Support/todo-planner and your Keychain.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const src = 'release/mac-arm64/Tally.app';
const dest = '/Applications/Tally.app';
const old = '/Applications/Planner.app';
const running = (pattern) => { try { return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim(); } catch { return ''; } };
if (!existsSync(src)) { console.error(`Not found: ${src}. Run: npm run build`); process.exit(1); }
if (running('/Tally.app/Contents/MacOS/Tally')) { console.error('Tally is running. Quit it first (menu-bar icon, then "Quit Tally", or Cmd+Q), then run this again.'); process.exit(1); }
if (running('/Planner.app/Contents/MacOS/Planner')) { console.error('The old Planner app is running. Quit it first (its menu-bar icon, then "Quit Planner", or Cmd+Q), then run this again.'); process.exit(1); }

if (existsSync(dest)) { rmSync(dest, { recursive: true, force: true }); console.log(`replaced the old ${dest}`); }
execFileSync('ditto', [src, dest], { stdio: 'inherit' }); // ditto keeps the signature and permissions intact
try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', dest], { stdio: 'ignore' }); } catch { /* nothing to remove */ }
execFileSync('codesign', ['--verify', '--deep', '--strict', dest], { stdio: 'inherit' });
console.log(`Installed ${dest}.`);

if (existsSync(old)) {
  console.log(`\nThe old app is still installed: ${old}`);
  console.log('Removing it deletes ONLY that app bundle. Your tasks, settings, backups and Google sign-in are not in it and are kept.');
  let yes = process.argv.includes('--remove-old');
  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    yes = /^y(es)?$/i.test((await rl.question(`Remove ${old} now? [y/N] `)).trim());
    rl.close();
  }
  if (yes) { rmSync(old, { recursive: true, force: true }); console.log(`Removed ${old}.`); }
  else console.log(`Left it in place. To remove it later: quit Planner, then drag ${old} to the Trash (or: rm -rf "${old}").`);
}
console.log(`
Launch it:  open -a Tally      (or Launchpad / Spotlight: "Tally")
It opens ~/Library/Application Support/todo-planner/planner.db and uses your iCloud backup folder, exactly like npm run dev.
macOS asks about the Keychain only when Google is first used (Settings, Google, "Check connection"): choose "Always Allow" once.
Notifications: the first notification asks for permission; choose Allow.`);
