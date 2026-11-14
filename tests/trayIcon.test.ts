import { describe, it, expect } from 'vitest';
import { trayIconBitmap, visiblePixels, TRAY_ICON_PIXELS } from '../src/app/trayIcon';

describe('menu-bar icon pixels', () => {
  it('is 32x32 BGRA (16x16 points at @2x) for both states', () => {
    for (const running of [false, true]) expect(trayIconBitmap(running)).toHaveLength(TRAY_ICON_PIXELS * TRAY_ICON_PIXELS * 4);
    expect(TRAY_ICON_PIXELS).toBe(32);
  });
  it('is NOT empty: a real glyph has well over a hundred clearly visible pixels (this test fails for a blank icon)', () => {
    expect(visiblePixels(trayIconBitmap(false))).toBeGreaterThan(100);
    expect(visiblePixels(trayIconBitmap(true))).toBeGreaterThan(300);
    expect(visiblePixels(Buffer.alloc(32 * 32 * 4))).toBe(0); // what an empty image looks like
  });
  it('is a template image: every pixel is black, only alpha varies', () => {
    for (const running of [false, true]) {
      const b = trayIconBitmap(running);
      for (let i = 0; i < b.length; i += 4) { expect(b[i]).toBe(0); expect(b[i + 1]).toBe(0); expect(b[i + 2]).toBe(0); }
    }
  });
  it('idle and running look different, and the glyph stays inside the 16 pt box with a margin', () => {
    expect(trayIconBitmap(false).equals(trayIconBitmap(true))).toBe(false);
    const b = trayIconBitmap(true);
    for (let x = 0; x < 32; x++) for (const y of [0, 31]) expect(b[(y * 32 + x) * 4 + 3]).toBe(0);
    for (let y = 0; y < 32; y++) for (const x of [0, 31]) expect(b[(y * 32 + x) * 4 + 3]).toBe(0);
  });
});
