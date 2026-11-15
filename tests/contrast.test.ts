import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS, deriveScheme } from '../src/app/colorScheme';

/** WCAG 2.x contrast, computed from the actual token values in renderer/src/styles.css (light block and dark block). */
const css = readFileSync(join(__dirname, '..', 'renderer', 'src', 'styles.css'), 'utf8');
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  return out;
}
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = css.slice(css.indexOf(':root {', darkStart), css.indexOf('}', css.indexOf(':root {', darkStart)));
const light = tokens(lightBlock);
const dark = { ...light, ...tokens(darkBlock) };

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** [foreground, background] pairs that carry TEXT: need 4.5:1. */
const TEXT: [string, string][] = [
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-raised'], ['text', 'surface-muted'],
  ['text-muted', 'bg'], ['text-muted', 'surface'], ['text-muted', 'surface-muted'],
  ['text-soft', 'surface'], ['text-soft', 'surface-muted'], ['link', 'surface'], ['link', 'bg'], ['link', 'surface-muted'],
  ['on-accent', 'accent'], ['on-accent', 'accent-hover'], ['on-primary', 'primary'], ['on-primary', 'primary-hover'],
  ['success', 'success-bg'], ['success', 'surface'], ['warning', 'warning-bg'], ['danger', 'danger-bg'], ['danger', 'surface'], ['on-danger', 'danger-fill'],
  ['bar-text', 'bar-bg'], ['bar-muted', 'bar-bg'], ['bar-accent', 'bar-bg'], ['bar-text', 'bar-hover'], ['demo-text', 'demo-bg'], ['on-block', 'block'],
  ['text', 'free'], ['text', 'busy'], ['text', 'prop'], ['text', 'tent'], ['text', 'warning-bg'], ['text', 'success-bg'], ['surface', 'now'],
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [`chip-${i}-fg`, `chip-${i}-bg`] as [string, string]),
];
/** [foreground, background] pairs for CONTROLS and graphics (borders, focus ring, grid outlines): need 3:1. */
const UI: [string, string][] = [
  ['border-strong', 'surface'], ['border-strong', 'bg'], ['focus', 'surface'], ['focus', 'bg'], ['focus', 'surface-muted'],
  ['accent', 'bar-bg'], ['free-line', 'surface'], ['busy-line', 'surface'], ['prop-line', 'surface'], ['tent-line', 'surface'],
  ['now', 'surface'], ['danger-fill', 'surface'], ['primary', 'surface'], ['busy-line', 'busy'], ['prop-line', 'prop'], ['tent-line', 'tent'], ['free-line', 'free'],
];

function runPairs(t: Record<string, string>) {
  it.each(TEXT)('text %s on %s is at least 4.5:1', (fg, bg) => {
    expect(t[fg], `missing token --${fg}`).toBeTruthy();
    expect(t[bg], `missing token --${bg}`).toBeTruthy();
    expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(UI)('control %s against %s is at least 3:1', (fg, bg) => {
    expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
}
describe.each([['light', light], ['dark', dark]] as const)('%s theme meets WCAG AA', (_name, t) => { runPairs(t); });

/** Every preset: the derived tokens sit on top of the static ones (status colors, chips and grid semantics stay fixed), exactly like the injected stylesheet. */
describe.each(PRESETS)('color scheme $name', (preset) => {
  const d = deriveScheme(preset.primary, preset.accent);
  it('derives', () => { expect(d.ok).toBe(true); });
  if (!d.ok) return;
  describe.each([['light', { ...light, ...d.light }], ['dark', { ...dark, ...d.dark }]] as const)('%s meets WCAG AA', (_n, t) => { runPairs(t); });
  it('uses the accent only as a fill with readable text on it, never as text on a light surface', () => {
    expect(d.light['on-accent']).not.toBe(d.light.accent);
    for (const k of ['text', 'text-muted', 'text-soft', 'link', 'focus']) expect(d.light[k].toUpperCase()).not.toBe(d.light.accent.toUpperCase());
  });
});

describe('brand rules', () => {
  it('the brand pair is Michigan Blue and Maize', () => {
    expect(light['brand-blue'].toUpperCase()).toBe('#00274C');
    expect(light['brand-maize'].toUpperCase()).toBe('#FFCB05');
  });
  it('maize is never used as text on a light surface (it would fail); it only fills, with blue on it', () => {
    expect(ratio('#FFCB05', light.surface)).toBeLessThan(3); // why the rule exists
    for (const k of ['text', 'text-muted', 'text-soft', 'link', 'focus']) expect(light[k].toUpperCase()).not.toBe('#FFCB05');
    expect(light['on-accent'].toUpperCase()).toBe('#00274C');
  });
  it('the old blue --accent is not used as text color anywhere (maize text fails on light backgrounds)', () => {
    expect(css).not.toMatch(/(?<![\w-])color:\s*var\(--accent\)/);
  });
});
