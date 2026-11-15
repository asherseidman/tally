import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tally ships WITHOUT any Google client. This fails if a client file or a client secret is in the repository (every tracked
 * file) or in a built bundle (dist-electron, dist/renderer, and the packaged app when it has been built).
 * Test data uses obviously fake secrets that start with FAKE.
 */
const root = join(__dirname, '..');
const SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{16,}|"client_secret"\s*:\s*"(?!FAKE|fake|REDACTED|<)[^"]{8,}"/;
const NAME_RE = /(^|\/)(google-client[^/]*\.json|client_secret[^/]*\.json)$/i;
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|yml|yaml|txt|sh|cfg|plist)$/i;

function tracked(): string[] | null {
  try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return null; }
}
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); }
  return out;
}

describe('no Google client file or secret ships', () => {
  const files = tracked();
  it.skipIf(!files)('the repository tracks no google-client.json or client_secret*.json', () => {
    expect(files!.filter((f) => NAME_RE.test(f))).toEqual([]);
  });
  it.skipIf(!files)('no tracked file contains a Google client secret', () => {
    const hits: string[] = [];
    for (const f of files!) {
      if (!TEXT_EXT.test(f)) continue;
      const p = join(root, f);
      if (!existsSync(p) || statSync(p).size > 2_000_000) continue;
      if (SECRET_RE.test(readFileSync(p, 'utf8'))) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
  it('.gitignore keeps google-client.json out of the repository', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^google-client\.json$/m);
  });
  it('the build configuration does not package any client file', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const listed = JSON.stringify([pkg.build?.files, pkg.build?.extraResources, pkg.build?.extraFiles]);
    expect(listed).not.toMatch(/google-client|client_secret/i);
  });
  const built = ['dist-electron', 'dist/renderer'].map((d) => join(root, d)).filter(existsSync);
  it.skipIf(!built.length)('the built main process and renderer contain no client secret or client file', () => {
    for (const dir of built) for (const f of walk(dir)) {
      expect(NAME_RE.test(f), f).toBe(false);
      if (TEXT_EXT.test(f) && statSync(f).size < 20_000_000) expect(SECRET_RE.test(readFileSync(f, 'utf8')), f).toBe(false);
    }
  });
  const app = join(root, 'release', 'mac-arm64', 'Tally.app');
  it.skipIf(!existsSync(app))('the packaged Tally.app contains no client file or client secret', () => {
    const all = walk(app);
    expect(all.filter((f) => NAME_RE.test(f))).toEqual([]);
    const asar = join(app, 'Contents', 'Resources', 'app.asar');
    // the asar stores file contents as plain bytes: scan it for the secret format
    expect(SECRET_RE.test(readFileSync(asar, 'latin1'))).toBe(false);
    const names = execFileSync(join(root, 'node_modules', '.bin', 'asar'), ['list', asar], { encoding: 'utf8' }).split('\n');
    expect(names.filter((n) => NAME_RE.test(n))).toEqual([]);
  });
});
