import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './helpers';
import { openDb } from '../src/db/index';
import { getSetting } from '../src/db/repo';
import { dispatch, type ApiDeps } from '../src/app/api';
import { PRESETS, deriveScheme, resolveScheme, parseSchemeValue, normalizeHex, contrastRatio, schemeCss, DEFAULT_SCHEME_ID } from '../src/app/colorScheme';
import type { Ctx } from '../src/core/ctx';

function deps(ctx: Ctx = makeCtx('2026-11-09T14:00:00Z'), pushed: string[] = []): ApiDeps {
  return { ctx, dbFile: ':memory:', demo: false, backupFolder: '/nonexistent', calendar: () => ({ calendar: undefined as never }), hooks: { setScheme: (css) => { pushed.push(css); } } };
}
const call = async (d: ApiDeps, ch: string, args?: unknown) => dispatch(d, ch, args);
const ok = async (d: ApiDeps, ch: string, args?: unknown) => { const r = await dispatch(d, ch, args); if (!r.ok) throw new Error(r.error); return r.value as any; };
const custom = (primary: string, accent: string) => JSON.stringify({ primary, accent });

describe('deriving a color scheme', () => {
  it('has the default Blue and Maize and about eight presets, with generic names', () => {
    expect(PRESETS[0]).toMatchObject({ id: DEFAULT_SCHEME_ID, name: 'Blue and Maize', primary: '#00274C', accent: '#FFCB05' });
    expect(PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(PRESETS.map((p) => p.name)).toEqual(['Blue and Maize', 'Ocean', 'Forest', 'Crimson', 'Violet', 'Slate', 'Sunset', 'Graphite']); // generic color names only
  });
  it('gives light and dark tokens for every preset, with distinct surfaces per theme', () => {
    for (const p of PRESETS) {
      const d = deriveScheme(p.primary, p.accent);
      expect(d.ok, p.name).toBe(true);
      if (!d.ok) continue;
      expect(d.light.surface).toBe('#FFFFFF');
      expect(contrastRatio(d.dark.text, d.dark.bg)).toBeGreaterThan(7);
      expect(d.light.bg).not.toBe(d.dark.bg);
      expect(Object.keys(d.light).sort()).toEqual(Object.keys(d.dark).sort());
    }
  });
  it('the primary drives the top bar and the accent is the fill, with readable text on it', () => {
    const d = deriveScheme('#1B4332', '#E9C46A');
    if (!d.ok) throw new Error(d.reason);
    expect(contrastRatio(d.light['bar-text'], d.light['bar-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(d.light.accent).toBe('#E9C46A');
    expect(contrastRatio(d.light['on-accent'], d.light.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(d.dark['on-accent'], d.dark.accent)).toBeGreaterThanOrEqual(4.5);
  });
  it('adjusts lightness: a very light primary still gets a dark top bar and dark text', () => {
    const d = deriveScheme('#F5F0C8', '#C0392B');
    if (!d.ok) throw new Error(d.reason);
    expect(contrastRatio(d.light['bar-text'], d.light['bar-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(d.light.text, d.light.bg)).toBeGreaterThanOrEqual(7);
  });
  it('lightens a dark accent in the dark theme so it does not sink into the surfaces', () => {
    const d = deriveScheme('#7A1F2B', '#7A5500');
    if (!d.ok) throw new Error(d.reason);
    expect(d.dark.accent).not.toBe('#7A5500');
    expect(contrastRatio(d.dark.accent, d.dark.surface)).toBeGreaterThanOrEqual(3);
  });
  it('refuses an accent too dark to show on the top bar, in plain words', () => {
    const d = deriveScheme('#1B4332', '#0A0A0A');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/too dark.*top bar.*lighter accent/i);
  });
  it('normalizes hex: #abc, abc, #AABBCC', () => {
    expect(normalizeHex('#abc')).toBe('#AABBCC');
    expect(normalizeHex('1b4332')).toBe('#1B4332');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
  });
  it('emits one stylesheet: light tokens, then the dark ones under the dark media query', () => {
    const d = deriveScheme('#1B4332', '#E9C46A');
    if (!d.ok) throw new Error(d.reason);
    const css = schemeCss(d.light, d.dark);
    expect(css).toMatch(/^:root\{--bg:#[0-9A-F]{6};/);
    expect(css).toContain('@media (prefers-color-scheme: dark){:root{');
  });
  it('the default scheme adds no stylesheet at all (nothing changes for existing installs)', () => {
    const r = resolveScheme(undefined);
    expect(r.ok && r.scheme.css).toBe('');
    const r2 = resolveScheme('blue-maize');
    expect(r2.ok && r2.scheme.css).toBe('');
  });
  it('parses the stored value strictly', () => {
    expect(parseSchemeValue('ocean')).toMatchObject({ ok: true, choice: { id: 'ocean' } });
    expect(parseSchemeValue('nope').ok).toBe(false);
    expect(parseSchemeValue('{"primary":"#123456"}').ok).toBe(false);
    expect(parseSchemeValue('{"primary":"#123456","accent":"#abcdef","extra":1}').ok).toBe(false);
    expect(parseSchemeValue('{bad json').ok).toBe(false);
  });
});

describe('saving a color scheme through the app API', () => {
  it('defaults to Blue and Maize with an empty stylesheet', async () => {
    const d = deps();
    const s = await ok(d, 'settings.get');
    expect(s.general.colorScheme).toMatchObject({ id: 'blue-maize', custom: false, value: 'blue-maize' });
    expect(s.general.colorScheme.presets.length).toBeGreaterThanOrEqual(8);
    expect(await ok(d, 'appearance.get')).toEqual({ value: 'blue-maize', css: '' });
  });
  it('saves a preset, pushes the new stylesheet to the windows, and reads it back', async () => {
    const pushed: string[] = [];
    const d = deps(undefined, pushed);
    const s = await ok(d, 'settings.set', { key: 'color_scheme', value: 'forest' });
    expect(s.general.colorScheme.id).toBe('forest');
    expect(getSetting(d.ctx.db, 'color_scheme')).toBe('forest');
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain('--bar-bg:');
    expect((await ok(d, 'appearance.get')).css).toBe(pushed[0]);
  });
  it('saves a custom scheme as one JSON setting (hex normalized)', async () => {
    const d = deps();
    const s = await ok(d, 'settings.set', { key: 'color_scheme', value: custom('#1b4332', 'e9c46a') });
    expect(s.general.colorScheme).toMatchObject({ custom: true, id: 'custom', primary: '#1B4332', accent: '#E9C46A' });
    expect(JSON.parse(getSetting(d.ctx.db, 'color_scheme')!)).toEqual({ primary: '#1B4332', accent: '#E9C46A' });
  });
  it('invalid custom colors are refused with a reason, nothing is saved, and the last valid scheme stays', async () => {
    const pushed: string[] = [];
    const d = deps(undefined, pushed);
    await ok(d, 'settings.set', { key: 'color_scheme', value: 'ocean' });
    pushed.length = 0;
    for (const bad of [custom('not-a-color', '#FFCB05'), custom('#1B4332', '#12'), custom('#1B4332', '#0A0A0A'), '{"primary":"#1B4332"}', 'nonsense']) {
      const r = await call(d, 'settings.set', { key: 'color_scheme', value: bad });
      expect(r.ok, bad).toBe(false);
    }
    const r = await call(d, 'settings.set', { key: 'color_scheme', value: custom('#1B4332', '#0A0A0A') });
    expect((r as any).error).toMatch(/too dark/i);
    expect(getSetting(d.ctx.db, 'color_scheme')).toBe('ocean');
    expect(pushed).toEqual([]);
    expect((await ok(d, 'settings.get')).general.colorScheme.id).toBe('ocean');
  });
  it('the Custom picker can ask whether colors would be accepted, without saving', async () => {
    const d = deps();
    expect(await ok(d, 'appearance.check', { primary: '#1b4332', accent: '#e9c46a' })).toEqual({ ok: true, primary: '#1B4332', accent: '#E9C46A' });
    const bad = await ok(d, 'appearance.check', { primary: '#1B4332', accent: '#0A0A0A' });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/too dark/i);
    expect(getSetting(d.ctx.db, 'color_scheme')).toBeUndefined();
  });
  it('Reset removes the setting and pushes the default (empty) stylesheet', async () => {
    const pushed: string[] = [];
    const d = deps(undefined, pushed);
    await ok(d, 'settings.set', { key: 'color_scheme', value: 'crimson' });
    const s = await ok(d, 'settings.reset', { key: 'color_scheme' });
    expect(s.general.colorScheme.id).toBe('blue-maize');
    expect(getSetting(d.ctx.db, 'color_scheme')).toBeUndefined();
    expect(pushed.at(-1)).toBe('');
  });
  it('a saved value that no longer validates falls back to the default instead of breaking the window', async () => {
    const d = deps();
    d.ctx.db.run("INSERT INTO settings(key, value) VALUES ('color_scheme', '{\"primary\":\"zzz\",\"accent\":\"#fff\"}')");
    expect(await ok(d, 'appearance.get')).toEqual({ value: 'blue-maize', css: '' });
  });
  it('persists in the database file: a fresh connection (a restart) sees the saved scheme', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-scheme-'));
    try {
      const file = join(dir, 'x.db');
      const db1 = openDb(file);
      const ctx1 = { ...makeCtx('2026-11-09T14:00:00Z'), db: db1 } as Ctx;
      await ok(deps(ctx1), 'settings.set', { key: 'color_scheme', value: custom('#3b1f5e', '#d4b5ff') });
      db1.close?.();
      const db2 = openDb(file);
      const ctx2 = { ...makeCtx('2026-11-09T14:00:00Z'), db: db2 } as Ctx;
      const a = await ok(deps(ctx2), 'appearance.get');
      expect(JSON.parse(a.value)).toEqual({ primary: '#3B1F5E', accent: '#D4B5FF' });
      expect(a.css).toContain('--accent:');
      db2.close?.();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
