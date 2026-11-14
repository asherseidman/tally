// Signs release/mac-arm64/Tally.app for local use.
//   default:                       ad-hoc ("-"): runs on this Mac, and keeps one identity for the life of THIS build
//   PLANNER_SIGN_IDENTITY="name":  signs with that code-signing identity from your Keychain instead. A certificate-based identity stays the
//                                  same across rebuilds, so macOS asks about the Keychain only once ever, not once per build
//                                  (create one with: npm run make-signing-identity).
// electron-builder already signs ad-hoc; this step re-signs inside-out with a fixed identifier so the result is deterministic and verifiable.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const app = 'release/mac-arm64/Tally.app';
if (!existsSync(app)) { console.error(`Not found: ${app}. Run: npm run build`); process.exit(1); }
const identity = process.env.PLANNER_SIGN_IDENTITY || '-';
if (identity !== '-') {
  const found = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!found.includes(`"${identity}"`)) { console.error(`No code-signing identity named "${identity}" in your Keychain. Create one with: npm run make-signing-identity`); process.exit(1); }
}
// inside-out: every nested helper app, framework and dylib first, the app itself last
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isSymbolicLink()) continue;
    if (name.isDirectory()) {
      if (/\.(app|framework)$/.test(name.name)) { walk(p, out); out.push(p); } else walk(p, out);
    } else if (/\.(dylib|so|node)$/.test(name.name)) out.push(p);
  }
  return out;
};
const targets = walk(app).filter((p) => !p.endsWith('/Tally.app'));
for (const t of targets) execFileSync('codesign', ['--force', '--sign', identity, t], { stdio: 'pipe' });
execFileSync('codesign', ['--force', '--sign', identity, '--identifier', 'local.todoplanner.planner', app], { stdio: 'pipe' });
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
console.log(`signed ${targets.length} nested item(s) and ${app} with ${identity === '-' ? 'an ad-hoc signature' : `"${identity}"`}`);
