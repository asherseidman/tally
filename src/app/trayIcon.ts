/**
 * The menu-bar glyph, as raw pixels (pure, so a test can prove it is not empty). 32x32 BGRA = 16x16 points at @2x, black with an
 * alpha channel: a "template image", which macOS tints for light and dark menu bars. A clock outline when idle; a filled disc with the
 * hands cut out while a timer runs.
 */
export const TRAY_ICON_PIXELS = 32;

export function trayIconBitmap(running: boolean): Buffer {
  const S = TRAY_ICON_PIXELS, c = (S - 1) / 2;
  const buf = Buffer.alloc(S * S * 4);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = Math.hypot(x - c, y - c);
      const hand = (Math.abs(x - c) <= 1.1 && y >= c - 8.5 && y <= c + 0.5) || (Math.abs(y - c) <= 1.1 && x >= c - 0.5 && x <= c + 6.5) ? 1 : 0;
      const ring = clamp(1.75 - Math.abs(r - 11.5));
      const disc = clamp(13.5 - r);
      const a = running ? disc * (1 - hand) : Math.max(ring, hand * (r < 12 ? 1 : 0));
      const o = (y * S + x) * 4;
      buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

/** How many pixels are clearly visible (alpha above 200). An empty or broken icon has (nearly) none. */
export const visiblePixels = (bitmap: Buffer): number => {
  let n = 0;
  for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] > 200) n++;
  return n;
};
