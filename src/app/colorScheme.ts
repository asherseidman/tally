/**
 * Color schemes: a primary and an accent color go in, the full token set for BOTH the light and the dark theme comes out.
 * Pure (no Electron, no database). Every derived pair is checked against the project's contrast rules while it is derived:
 *   text 4.5:1, controls and graphics 3:1, and the accent is only ever a FILL (with a readable text color on it); it is never
 *   used as text on a light surface. Lightness is adjusted to reach those ratios; if a pair cannot be made accessible the
 *   result is `{ ok: false, reason }` (in plain words) and the caller keeps the last valid scheme.
 * The default scheme ("Blue and Maize") is the static CSS in renderer/src/styles.css; it is never overridden.
 * Colors only: no school names, marks or wordmarks.
 */

export interface SchemePreset { id: string; name: string; primary: string; accent: string }

export const DEFAULT_SCHEME_ID = 'blue-maize';
export const PRESETS: SchemePreset[] = [
  { id: 'blue-maize', name: 'Blue and Maize', primary: '#00274C', accent: '#FFCB05' },
  { id: 'ocean', name: 'Ocean', primary: '#0B4F6C', accent: '#3DD6C6' },
  { id: 'forest', name: 'Forest', primary: '#1B4332', accent: '#E9C46A' },
  { id: 'crimson', name: 'Crimson', primary: '#7A1F2B', accent: '#F4A261' },
  { id: 'violet', name: 'Violet', primary: '#4B2E83', accent: '#CDB4FF' },
  { id: 'slate', name: 'Slate', primary: '#2F3E4E', accent: '#8FB8DE' },
  { id: 'sunset', name: 'Sunset', primary: '#6B2D5C', accent: '#FF8C42' },
  { id: 'graphite', name: 'Graphite', primary: '#26292E', accent: '#B8C0CC' },
];

// ---- color math -----------------------------------------------------------------------------------------------------
type RGB = [number, number, number];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function normalizeHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return `#${h.toUpperCase()}`;
}
const toRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** [hue 0-360, saturation 0-1, lightness 0-1] */
function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function fromHsl(h: number, s: number, l: number): string {
  s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const passes = (c: string, against: string[], min: number) => against.every((b) => contrastRatio(c, b) >= min);

/** Moves the lightness of `hex` (hue and saturation kept) one point at a time until it reaches `min` against every background; null if it cannot. */
function fit(hex: string, against: string[], min: number, dir: 'darker' | 'lighter'): string | null {
  const [h, s, l0] = toHsl(hex);
  const step = dir === 'darker' ? -0.01 : 0.01;
  for (let l = l0; l >= -0.0001 && l <= 1.0001; l += step) {
    const c = fromHsl(h, s, l);
    if (passes(c, against, min)) return c;
  }
  const end = fromHsl(h, s, dir === 'darker' ? 0 : 1);
  return passes(end, against, min) ? end : null;
}

// ---- tokens that stay fixed for every scheme (status colors, course chips, grid semantics) ---------------------------------
// They are read from the static stylesheet; the derivation only needs these few to check against.
const FIXED_LIGHT = { free: '#DFF1E5', tent: '#FFF1C2', warningBg: '#FFF4CC', successBg: '#E2F3E8' };
const FIXED_DARK = { dangerFill: '#C8372D', free: '#12392A', tent: '#3A2E05', warningBg: '#352A04', successBg: '#0E3322' };

export type Tokens = Record<string, string>;
export type DeriveResult = { ok: true; light: Tokens; dark: Tokens } | { ok: false; reason: string };
const fail = (reason: string): DeriveResult => ({ ok: false, reason });

/** Dark text, white or black on the accent: the first that reaches 4.5:1 (the brand-tinted dark first, then white, then black). */
function textOn(fill: string, tinted: string): string {
  for (const c of [tinted, '#FFFFFF', '#000000']) if (contrastRatio(c, fill) >= 4.5) return c;
  return '#000000';
}

export function deriveScheme(primaryIn: string, accentIn: string): DeriveResult {
  const P = normalizeHex(primaryIn); const A = normalizeHex(accentIn);
  if (!P) return fail(`“${primaryIn}” is not a color. Use a hex color like #1B4332.`);
  if (!A) return fail(`“${accentIn}” is not a color. Use a hex color like #E9C46A.`);
  const [h, s] = toHsl(P);
  const tintS = s < 0.05 ? 0 : clamp(s, 0.12, 0.5); // surfaces keep a hint of the primary's hue (none for a true gray)
  const ink = fromHsl(h, Math.max(s, 0.2) * (s < 0.05 ? 0 : 1), 0.12); // the very dark brand-tinted text color

  // ---------- light ----------
  const lBg = fromHsl(h, tintS * 0.5, 0.96); const lSurface = '#FFFFFF'; const lMuted = fromHsl(h, tintS, 0.94);
  const lBusy = fromHsl(h, tintS * 0.4, 0.85);
  const lProp = fromHsl(h, clamp(s, 0.4, 0.7), 0.93);
  const lBack = [lBg, lSurface, lMuted, lBusy, lProp, FIXED_LIGHT.free, FIXED_LIGHT.tent, FIXED_LIGHT.warningBg, FIXED_LIGHT.successBg];
  const lText = fit(fromHsl(h, s, Math.min(toHsl(P)[2], 0.22)), lBack, 7, 'darker');
  const lMutedText = fit(fromHsl(h, tintS * 0.5, 0.38), [lBg, lSurface, lMuted, lBusy], 5, 'darker');
  const lSoft = fit(fromHsl(h, clamp(s, 0.3, 0.7), 0.36), [lSurface, lMuted], 4.5, 'darker');
  const lLink = fit(fromHsl(h, clamp(s, 0.45, 0.8), 0.38), [lSurface, lBg, lMuted, lProp], 4.5, 'darker');
  const lBorderStrong = fit(fromHsl(h, tintS * 0.4, 0.55), [lSurface, lBg, lMuted], 3, 'darker');
  if (!lText || !lMutedText || !lSoft || !lLink || !lBorderStrong) return fail('Those colors cannot be made readable on a light background.');

  // the top bar is the primary, darkened until white text and the accent both read on it
  let lBar = fromHsl(h, s, Math.min(toHsl(P)[2], 0.26));
  const lBarFit = fit(lBar, [A], 4.5, 'darker') ?? fit(lBar, [A], 3, 'darker');
  if (!lBarFit) return fail(`The accent color ${A} is too dark to stand out against the dark top bar. Choose a lighter accent (the top bar uses your primary color, darkened).`);
  lBar = lBarFit;
  const lBarHover = fromHsl(...(([bh, bs, bl]) => [bh, bs, Math.min(bl + 0.08, 0.6)] as [number, number, number])(toHsl(lBar)));
  const lBarText = '#FFFFFF';
  const lBarMuted = fit(fromHsl(h, tintS * 0.5, 0.8), [lBar, lBarHover], 4.5, 'lighter');
  const lBarAccent = contrastRatio(A, lBar) >= 4.5 ? A : fit(A, [lBar], 4.5, 'lighter');
  if (!lBarMuted || !lBarAccent || !passes(lBarText, [lBar, lBarHover], 4.5)) return fail('The primary color cannot carry readable text in the top bar.');
  const lOnAccent = textOn(A, ink);
  // hover moves the accent in the direction that adds contrast with its text
  const lOnAccentDark = luminance(lOnAccent) < 0.4;
  const lAccentHoverTry = (([ah, as, al]) => fromHsl(ah, as, clamp(al + (lOnAccentDark ? 0.06 : -0.06), 0, 1)))(toHsl(A));
  const lAccentHover = contrastRatio(lOnAccent, lAccentHoverTry) >= 4.5 ? lAccentHoverTry : A;
  const lBorder = fromHsl(h, tintS * 0.7, 0.88);
  const lPropLine = fit(lLink, [lSurface, lProp], 3, 'darker') ?? lLink;
  const lBusyLine = fit(fromHsl(h, tintS * 0.3, 0.45), [lSurface, lBusy], 3, 'darker');
  if (!lBusyLine) return fail('Those colors cannot be made readable on a light background.');

  const light: Tokens = {
    bg: lBg, surface: lSurface, 'surface-raised': lSurface, 'surface-muted': lMuted, border: lBorder, 'border-strong': lBorderStrong,
    text: lText, 'text-muted': lMutedText, 'text-soft': lSoft, link: lLink,
    accent: A, 'accent-hover': lAccentHover, 'on-accent': lOnAccent,
    primary: lBar, 'primary-hover': lBarHover, 'on-primary': lBarText, focus: lLink,
    'bar-bg': lBar, 'bar-text': lBarText, 'bar-muted': lBarMuted, 'bar-hover': lBarHover, 'bar-accent': lBarAccent,
    'demo-bg': A, 'demo-text': lOnAccent,
    busy: lBusy, 'busy-line': lBusyLine, block: lBar, 'on-block': lBarText, prop: lProp, 'prop-line': lPropLine,
  };

  // ---------- dark ----------
  // Greens and teals are bright at the same lightness, so the surface lightness is lowered until the fixed red fills (danger) still stand out on it.
  let sl = 0.13;
  while (sl > 0.04 && contrastRatio(FIXED_DARK.dangerFill, fromHsl(h, tintS * 0.9, sl)) < 3.1) sl -= 0.005;
  const dBg = fromHsl(h, tintS * 0.9, sl * 0.7); const dSurface = fromHsl(h, tintS * 0.9, sl); const dRaised = fromHsl(h, tintS * 0.9, sl * 1.23); const dMuted = fromHsl(h, tintS * 0.9, sl * 0.85);
  const dBusy = fromHsl(h, tintS * 0.4, 0.2); const dProp = fromHsl(h, clamp(s, 0.3, 0.6), 0.22);
  const dBar = fromHsl(h, Math.min(s, 0.6), 0.05);
  const dBack = [dBg, dSurface, dRaised, dMuted, dBusy, dProp, FIXED_DARK.free, FIXED_DARK.tent, FIXED_DARK.warningBg, FIXED_DARK.successBg];
  const dText = fit(fromHsl(h, tintS * 0.5, 0.95), dBack, 7, 'lighter');
  const dMutedText = fit(fromHsl(h, tintS * 0.5, 0.72), [dBg, dSurface, dRaised, dMuted, dBusy], 5, 'lighter');
  const dSoft = fit(fromHsl(h, clamp(s, 0.3, 0.7), 0.75), [dSurface, dMuted], 4.5, 'lighter');
  const dLink = fit(fromHsl(h, clamp(s, 0.5, 0.9), 0.7), [dSurface, dBg, dMuted, dRaised, dProp], 4.5, 'lighter');
  const dBorderStrong = fit(fromHsl(h, tintS * 0.5, 0.55), [dSurface, dBg, dMuted], 3, 'lighter');
  // in the dark theme the accent is also a fill on dark surfaces: lighten it if it would sink into them
  const dAccent = fit(A, [dSurface, dBg, dBar, dMuted], 3, 'lighter');
  if (!dText || !dMutedText || !dSoft || !dLink || !dBorderStrong || !dAccent) return fail('Those colors cannot be made readable on a dark background.');
  const dBarText = fit(fromHsl(h, tintS * 0.4, 0.95), [dBar], 4.5, 'darker') ?? '#FFFFFF';
  const dBarHover = fromHsl(h, Math.min(s, 0.6), 0.12);
  const dBarMuted = fit(fromHsl(h, tintS * 0.5, 0.72), [dBar, dBarHover], 4.5, 'lighter');
  const dBarAccent = contrastRatio(dAccent, dBar) >= 4.5 ? dAccent : fit(dAccent, [dBar], 4.5, 'lighter');
  if (!dBarMuted || !dBarAccent || !passes(dBarText, [dBar, dBarHover], 4.5)) return fail('Those colors cannot be made readable in the dark top bar.');
  const dOnAccent = textOn(dAccent, ink);
  const dOnAccentDark = luminance(dOnAccent) < 0.4;
  const dHoverTry = (([ah, as, al]) => fromHsl(ah, as, clamp(al + (dOnAccentDark ? 0.06 : -0.06), 0, 1)))(toHsl(dAccent));
  const dAccentHover = contrastRatio(dOnAccent, dHoverTry) >= 4.5 ? dHoverTry : dAccent;
  const dFocus = passes(dAccent, [dSurface, dBg, dMuted], 3) ? dAccent : dLink;
  const dPropLine = fit(dLink, [dSurface, dProp], 3, 'lighter') ?? dLink;
  const dBusyLine = fit(fromHsl(h, tintS * 0.3, 0.6), [dSurface, dBusy], 3, 'lighter');
  if (!dBusyLine) return fail('Those colors cannot be made readable on a dark background.');

  const dark: Tokens = {
    bg: dBg, surface: dSurface, 'surface-raised': dRaised, 'surface-muted': dMuted, border: fromHsl(h, tintS * 0.7, 0.22), 'border-strong': dBorderStrong,
    text: dText, 'text-muted': dMutedText, 'text-soft': dSoft, link: dLink,
    accent: dAccent, 'accent-hover': dAccentHover, 'on-accent': dOnAccent,
    primary: dAccent, 'primary-hover': dAccentHover, 'on-primary': dOnAccent, focus: dFocus,
    'bar-bg': dBar, 'bar-text': dBarText, 'bar-muted': dBarMuted, 'bar-hover': dBarHover, 'bar-accent': dBarAccent,
    'demo-bg': dAccent, 'demo-text': dOnAccent,
    busy: dBusy, 'busy-line': dBusyLine, block: dAccent, 'on-block': dOnAccent, prop: dProp, 'prop-line': dPropLine,
  };
  return { ok: true, light, dark };
}

/** The stylesheet text that overrides the static tokens: light first, then the dark block under the system/dark media query. */
export function schemeCss(light: Tokens, dark: Tokens): string {
  const block = (t: Tokens) => Object.entries(t).map(([k, v]) => `--${k}:${v};`).join('');
  return `:root{${block(light)}}@media (prefers-color-scheme: dark){:root{${block(dark)}}}`;
}

// ---- the stored setting ---------------------------------------------------------------------------------------------------
export const SCHEME_KEY = 'color_scheme';

export type SchemeChoice =
  | { kind: 'preset'; id: string; primary: string; accent: string }
  | { kind: 'custom'; id: 'custom'; primary: string; accent: string };

/** Reads the stored value: a preset id, or custom JSON {"primary":"#...","accent":"#..."}. Anything unreadable is an error with a reason. */
export function parseSchemeValue(raw: string | undefined | null): { ok: true; choice: SchemeChoice } | { ok: false; reason: string } {
  const v = (raw ?? '').trim();
  if (!v) return { ok: true, choice: { kind: 'preset', ...pick(DEFAULT_SCHEME_ID) } };
  if (v.startsWith('{')) {
    let o: unknown;
    try { o = JSON.parse(v); } catch { return { ok: false, reason: 'The custom color scheme is not valid.' }; }
    const rec = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
    const keys = Object.keys(rec).sort().join();
    if (keys !== 'accent,primary' || typeof rec.primary !== 'string' || typeof rec.accent !== 'string') return { ok: false, reason: 'A custom color scheme needs exactly a primary and an accent color.' };
    const p = normalizeHex(rec.primary); const a = normalizeHex(rec.accent);
    if (!p) return { ok: false, reason: `“${rec.primary}” is not a color. Use a hex color like #1B4332.` };
    if (!a) return { ok: false, reason: `“${rec.accent}” is not a color. Use a hex color like #E9C46A.` };
    return { ok: true, choice: { kind: 'custom', id: 'custom', primary: p, accent: a } };
  }
  const preset = PRESETS.find((x) => x.id === v);
  if (!preset) return { ok: false, reason: `Unknown color scheme “${v}”.` };
  return { ok: true, choice: { kind: 'preset', id: preset.id, primary: preset.primary, accent: preset.accent } };
}
function pick(id: string) { const p = PRESETS.find((x) => x.id === id)!; return { id: p.id, primary: p.primary, accent: p.accent }; }

/** The canonical string to store for a choice. */
export const schemeValue = (c: SchemeChoice) => (c.kind === 'preset' ? c.id : JSON.stringify({ primary: c.primary, accent: c.accent }));

export interface ResolvedScheme { choice: SchemeChoice; /** '' for the default scheme: the static stylesheet is used as it is */ css: string }

/** Validates a stored/typed value completely (parse + derive). On any problem returns the reason; the caller keeps what it had. */
export function resolveScheme(raw: string | undefined | null): { ok: true; scheme: ResolvedScheme } | { ok: false; reason: string } {
  const p = parseSchemeValue(raw);
  if (!p.ok) return p;
  const c = p.choice;
  if (c.kind === 'preset' && c.id === DEFAULT_SCHEME_ID) return { ok: true, scheme: { choice: c, css: '' } };
  const d = deriveScheme(c.primary, c.accent);
  if (!d.ok) return { ok: false, reason: d.reason };
  return { ok: true, scheme: { choice: c, css: schemeCss(d.light, d.dark) } };
}
