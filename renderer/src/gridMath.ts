/** Pure helpers for the availability grid (tested in tests/gridMath.test.ts). The grid works in wall-clock minutes. */
export const GRID_START = 6 * 60; // 6 AM
export const GRID_END = 24 * 60; // midnight
export const ROW_MIN = 30;
export const ROWS = (GRID_END - GRID_START) / ROW_MIN; // 36

export interface Span {
  start: number;
  end: number;
}

export const rowStart = (row: number) => GRID_START + row * ROW_MIN;
export const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const label12 = (min: number) => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Clamp a pointer y offset (px within the column) to a row index. */
export const rowAt = (y: number, rowPx: number) => Math.max(0, Math.min(ROWS - 1, Math.floor(y / rowPx)));

/** Rows a..b (either order, inclusive) as a time range for the API: "09:00" .. "12:30". */
export function rangeFromRows(a: number, b: number): { start: string; end: string } {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { start: hm(rowStart(lo)), end: hm(rowStart(hi + 1)) === '24:00' ? '24:00' : hm(rowStart(hi + 1)) };
}

/** True if the whole 30-minute row is inside free time. */
export const isFreeRow = (free: Span[], row: number) => {
  const s = rowStart(row);
  return free.some((f) => f.start <= s && f.end >= s + ROW_MIN);
};

/** Absolute placement of a span inside the column, in px (clipped to the visible 6 AM..midnight range). */
export function placement(span: Span, rowPx: number): { top: number; height: number } | undefined {
  const s = Math.max(span.start, GRID_START);
  const e = Math.min(span.end, GRID_END);
  if (e <= s) return undefined;
  return { top: ((s - GRID_START) / ROW_MIN) * rowPx, height: Math.max(((e - s) / ROW_MIN) * rowPx, 4) };
}

export type Cursor = { day: number; row: number };
export function moveCursor(c: Cursor, key: string): Cursor {
  switch (key) {
    case 'ArrowUp': return { ...c, row: Math.max(0, c.row - 1) };
    case 'ArrowDown': return { ...c, row: Math.min(ROWS - 1, c.row + 1) };
    case 'ArrowLeft': return { ...c, day: Math.max(0, c.day - 1) };
    case 'ArrowRight': return { ...c, day: Math.min(6, c.day + 1) };
    case 'Home': return { ...c, row: 0 };
    case 'End': return { ...c, row: ROWS - 1 };
    default: return c;
  }
}

/** A drag/selection decides its mode from its FIRST cell: starting on free time erases, starting on empty paints. */
export const modeFor = (startWasFree: boolean): 'paint' | 'erase' => (startWasFree ? 'erase' : 'paint');

/** Where "now" falls in the grid (pixels from the top for a given row height), or null outside the visible hours. Wall-clock time in `tz`. */
export function nowTop(ms: number, tz: string, rowPx: number): number | null {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const min = Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
  const top = ((min - GRID_START) / ROW_MIN) * rowPx;
  return top >= 0 && top <= ROWS * rowPx ? top : null;
}
