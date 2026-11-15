// Checks the packaged app (release/mac-arm64/Tally.app) without opening or changing any of your data.
//   - it is signed and the signature verifies; the bundle id and identifier are the fixed ones
//   - the code is in app.asar, the native modules are UNPACKED (better-sqlite3 and the Keychain module cannot load from inside an asar)
//   - the app runs, better-sqlite3 and the Keychain module load, and it points at the real database and the iCloud backup folder
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const app = process.env.PLANNER_APP || 'release/mac-arm64/Tally.app';
const bin = join(app, 'Contents/MacOS/Tally');
let failures = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); if (!ok) failures++; };
if (!existsSync(bin)) { console.error(`Not found: ${bin}. Run: npm run build`); process.exit(1); }

// signature
try { execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' }); check('the signature verifies (codesign --verify --deep --strict)', true); }
catch (e) { check('the signature verifies', false, String(e.stderr || e.message).trim()); }
// codesign prints its description on stderr
const sig = execFileSync('sh', ['-c', `codesign -dv --verbose=2 "${app}" 2>&1`], { encoding: 'utf8' });
const adhoc = /Signature=adhoc/.test(sig);
check('signature kind', true, adhoc ? 'ad-hoc: stable for this build; macOS asks about the Keychain once per installed build' : 'certificate identity: stable across rebuilds');
check('code identifier is local.todoplanner.planner', /Identifier=local\.todoplanner\.planner/.test(sig));

// layout
const plist = readFileSync(join(app, 'Contents/Info.plist'), 'utf8');
check('bundle id local.todoplanner.planner', plist.includes('<string>local.todoplanner.planner</string>'));
const res = join(app, 'Contents/Resources');
check('app code is packed in app.asar', existsSync(join(res, 'app.asar')), `${(statSync(join(res, 'app.asar')).size / 1048576).toFixed(1)} MB`);
const unpacked = join(res, 'app.asar.unpacked');
const nodes = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.node')) nodes.push(p.replace(unpacked + '/', '')); } };
if (existsSync(unpacked)) walk(unpacked);
check('native modules are unpacked from the asar', nodes.some((n) => /better-sqlite3/.test(n)) && nodes.some((n) => /keyring/.test(n)), nodes.join(', '));
const asarList = execFileSync(join(process.cwd(), 'node_modules/.bin/asar'), ['list', join(res, 'app.asar')], { encoding: 'utf8' });
check('main process and renderer are inside the asar', asarList.includes('/dist-electron/main.mjs') && asarList.includes('/dist/renderer/index.html') && asarList.includes('/dist-electron/preload.cjs'));
check('build-only packages are not shipped (react, vite, vitest, electron-builder)', !/node_modules\/(react|vite|vitest|electron-builder|esbuild|typescript)\//.test(asarList));

// it runs, and points at the right place (read-only: nothing is opened for writing)
let cfg;
try {
  const out = execFileSync(bin, ['--print-config'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  cfg = JSON.parse(out.split('\n').find((l) => l.startsWith('PLANNERCONFIG ')).slice('PLANNERCONFIG '.length));
} catch (e) { check('the packaged app runs (--print-config)', false, String(e.message).slice(0, 200)); }
if (cfg) {
  check('the packaged app runs', cfg.packaged === true, `Electron ${cfg.electron}, ${cfg.arch}`);
  check('better-sqlite3 loads inside the package', cfg.sqlite === 'loaded', cfg.sqlite);
  check('the Keychain module (@napi-rs/keyring) loads inside the package', cfg.keyring === 'loaded', cfg.keyring);
  const realDb = join(process.env.HOME, 'Library/Application Support/todo-planner/planner.db');
  check('it uses the REAL database path', cfg.db === realDb && !cfg.demo, cfg.db);
  check('no environment override is redirecting it', cfg.envOverrides.length === 0, cfg.envOverrides.join(', ') || 'none');
  if (cfg.dbExists) {
    check('it reads the same backup folder setting as the command line', cfg.backupFolderIsSaved && !!cfg.backupFolder, cfg.backupFolder);
    check('that folder is in iCloud Drive', cfg.backupFolderInICloud, cfg.backupFolderInICloud ? 'Mobile Documents/com~apple~CloudDocs' : 'not an iCloud path');
    check('and it exists, with backups in it', cfg.backupFolderExists && !!cfg.newestBackup, cfg.newestBackup ? `newest ${cfg.newestBackup.name}` : 'none found');
  } else if (process.env.CI) console.log('SKIP  real-database and backup-folder checks (CI runner has no personal data)');
  else check('the real database exists', false, 'not found (first run?)');
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
