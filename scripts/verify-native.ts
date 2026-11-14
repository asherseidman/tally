/**
 * Verifies better-sqlite3 works under plain Node AND Electron's runtime.
 * better-sqlite3 13 is a Node-API module, so ONE build serves both: no rebuild step, no toggling between ABIs.
 * (If a future version stops being Node-API, this check fails loudly and a rebuild step is needed.)
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db/index';

const require = createRequire(import.meta.url);

console.log('1. plain Node');
const db = openDb(':memory:');
console.log(`  node ${process.versions.node} / ABI ${process.versions.modules}: schema migrated, sqlite ${db.get<{ v: string }>('SELECT sqlite_version() v')!.v}`);
db.close();

console.log('2. Electron runtime (same binary, no rebuild)');
const electronPath = require('electron') as string; // the electron package exports the path of its binary on every OS
try {
  execFileSync(electronPath, ['scripts/electron-check.cjs'], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
} catch (e) {
  console.error('Electron check FAILED:', (e as Error).message);
  process.exit(1);
}
console.log('\nOK: better-sqlite3 works under both Node and Electron.');
