// Draws the Tally app icon (build/icon.png, 1024x1024) with no dependencies: maize tally marks (four strokes and a cross stroke)
// on a deep Michigan Blue rounded square. Original artwork; colors only (no university marks).
// electron-builder turns it into the .icns. Run: node scripts/make-icon.mjs [--if-missing]
import { deflateSync } from 'node:zlib';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const OUT = 'build/icon.png';
if (process.argv.includes('--if-missing') && existsSync(OUT)) process.exit(0);
mkdirSync('build', { recursive: true });

const S = 1024, c = (S - 1) / 2;
const clamp = (v) => Math.max(0, Math.min(1, v));
const px = Buffer.alloc(S * S * 4);
// signed distance to a rounded square of half-size h and corner radius r
const sdRound = (x, y, h, r) => { const qx = Math.abs(x - c) - (h - r), qy = Math.abs(y - c) - (h - r); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
const segDist = (x, y, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)); return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)); };
const BLUE = [0x00, 0x27, 0x4c], BLUE2 = [0x0a, 0x3d, 0x70], MAIZE = [0xff, 0xcb, 0x05];
// four upright strokes, and one long stroke crossing them, in icon coordinates
const posts = [340, 450, 560, 670].map((x) => [x, 300, x - 12, 724]);
const cross = [230, 640, 794, 384];
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4;
    const body = clamp(0.5 - sdRound(x, y, 480, 210)); // the rounded square, antialiased
    // a quiet diagonal blue gradient for depth
    const g = clamp((x + y) / (2 * S));
    let col = BLUE.map((v, i) => v + (BLUE2[i] - v) * (1 - g));
    let mark = 0;
    for (const [ax, ay, bx, by] of posts) mark = Math.max(mark, clamp(0.5 - (segDist(x, y, ax, ay, bx, by) - 34)));
    mark = Math.max(mark, clamp(0.5 - (segDist(x, y, ...cross) - 30)));
    col = col.map((v, i) => v + (MAIZE[i] - v) * mark);
    px[o] = Math.round(col[0]); px[o + 1] = Math.round(col[1]); px[o + 2] = Math.round(col[2]); px[o + 3] = Math.round(body * 255);
  }
}
// minimal PNG encoder
const crcTable = Array.from({ length: 256 }, (_, n) => { let k = n; for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0; });
const crc = (buf) => { let k = 0xffffffff; for (const byte of buf) k = crcTable[(k ^ byte) & 0xff] ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c4 = Buffer.alloc(4); c4.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c4]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${OUT}`);
