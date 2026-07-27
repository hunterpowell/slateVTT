// Generates the milestone-1 placeholder assets: one dungeon map and four token
// portraits. Deliberately dependency-free — raw PNG encoding on top of node's
// built-in zlib. Run with `node tools/gen-assets.mjs` from the repo root.
//
// Everything here is deterministic (seeded hash noise, no Math.random) so
// re-running produces byte-identical files.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'client', 'assets');

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param rgba Buffer of width*height*4 straight-alpha bytes. */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------- noise

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, y, scale, seed) {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------- the map

// 26 x 19 cells at 64px. Grid origin is (0,0) so milestone 1 needs no
// calibration — that arrives in milestone 6.
const CELL = 64;
const COLS = 26;
const ROWS = 19;
const MAP_W = COLS * CELL;
const MAP_H = ROWS * CELL;

const ROOMS = [
  { x: 1, y: 1, w: 6, h: 5 },
  { x: 11, y: 1, w: 5, h: 4 },
  { x: 20, y: 2, w: 5, h: 6 },
  { x: 2, y: 9, w: 7, h: 6 },
  { x: 12, y: 7, w: 6, h: 5 },
  { x: 19, y: 12, w: 5, h: 5 },
  { x: 9, y: 14, w: 5, h: 4 },
];

const LINKS = [[0, 1], [1, 2], [0, 3], [3, 4], [4, 2], [3, 6], [6, 5], [4, 5]];

function buildFloorGrid() {
  const floor = new Uint8Array(COLS * ROWS);
  const set = (cx, cy) => {
    if (cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS) floor[cy * COLS + cx] = 1;
  };

  for (const r of ROOMS) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) set(x, y);
    }
  }

  const center = (r) => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) });
  for (const [a, b] of LINKS) {
    const ca = center(ROOMS[a]);
    const cb = center(ROOMS[b]);
    for (let x = Math.min(ca.x, cb.x); x <= Math.max(ca.x, cb.x); x++) set(x, ca.y);
    for (let y = Math.min(ca.y, cb.y); y <= Math.max(ca.y, cb.y); y++) set(cb.x, y);
  }

  return floor;
}

function generateMap() {
  const floor = buildFloorGrid();
  const isFloor = (cx, cy) =>
    cx >= 0 && cx < COLS && cy >= 0 && cy < ROWS && floor[cy * COLS + cx] === 1;

  const px = Buffer.alloc(MAP_W * MAP_H * 4);

  for (let y = 0; y < MAP_H; y++) {
    const cy = (y / CELL) | 0;
    const ly = y - cy * CELL;
    for (let x = 0; x < MAP_W; x++) {
      const cx = (x / CELL) | 0;
      const lx = x - cx * CELL;
      const i = (y * MAP_W + x) * 4;

      // Two octaves of value noise gives the stone a bit of large-scale
      // blotchiness on top of fine grain.
      const n =
        valueNoise(x, y, 26, 11) * 0.65 +
        valueNoise(x, y, 7, 29) * 0.35;

      let r;
      let g;
      let b;

      if (isFloor(cx, cy)) {
        const shade = (n - 0.5) * 40;
        r = 78 + shade;
        g = 74 + shade;
        b = 67 + shade * 0.85;

        // Darken toward any edge that abuts unexcavated rock, so rooms read as
        // carved rather than as flat rectangles.
        const EDGE = 7;
        let dark = 0;
        if (!isFloor(cx - 1, cy)) dark = Math.max(dark, (EDGE - lx) / EDGE);
        if (!isFloor(cx + 1, cy)) dark = Math.max(dark, (EDGE - (CELL - 1 - lx)) / EDGE);
        if (!isFloor(cx, cy - 1)) dark = Math.max(dark, (EDGE - ly) / EDGE);
        if (!isFloor(cx, cy + 1)) dark = Math.max(dark, (EDGE - (CELL - 1 - ly)) / EDGE);
        dark = clamp(dark, 0, 1) * 0.62;

        r *= 1 - dark;
        g *= 1 - dark;
        b *= 1 - dark;
      } else {
        const shade = (n - 0.5) * 14;
        r = 17 + shade;
        g = 19 + shade;
        b = 24 + shade;
      }

      px[i] = clamp(Math.round(r), 0, 255);
      px[i + 1] = clamp(Math.round(g), 0, 255);
      px[i + 2] = clamp(Math.round(b), 0, 255);
      px[i + 3] = 255;
    }
  }

  return encodePng(MAP_W, MAP_H, px);
}

// ----------------------------------------------------------------- the tokens

const TOKEN_SIZE = 160;

function generateToken({ hue, sat }) {
  const size = TOKEN_SIZE;
  const c = (size - 1) / 2;
  const outer = size / 2 - 3;
  const ringInner = outer - 7;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);

      // 1px feather at the outer edge; the browser gets a clean round token
      // without having to composite one itself.
      const alpha = clamp(outer - dist + 0.5, 0, 1);
      if (alpha <= 0) continue;

      let r;
      let g;
      let b;

      if (dist > ringInner) {
        // Rim: a dark bezel so tokens stay legible on light and dark terrain.
        const t = clamp((dist - ringInner) / (outer - ringInner), 0, 1);
        const v = 62 - t * 34;
        r = v;
        g = v;
        b = v + 6;
      } else {
        // Body: lit from the upper-left, plus noise so it isn't a flat disc.
        const lit = clamp(1 - (dx * 0.6 + dy * 0.75 + ringInner * 0.55) / (ringInner * 1.9), 0, 1);
        const n = valueNoise(x, y, 11, hue) - 0.5;
        const level = 0.34 + lit * 0.52 + n * 0.10;
        [r, g, b] = hsl(hue, sat, clamp(level, 0, 1));
      }

      px[i] = clamp(Math.round(r), 0, 255);
      px[i + 1] = clamp(Math.round(g), 0, 255);
      px[i + 2] = clamp(Math.round(b), 0, 255);
      px[i + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, px);
}

function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// Five players plus the DM's monsters. Hues are spread far enough apart to stay
// distinguishable at low zoom, where a token is only a few pixels across.
const TOKENS = [
  { file: 'grog.png', hue: 18, sat: 0.55 },
  { file: 'vex.png', hue: 138, sat: 0.42 },
  { file: 'pike.png', hue: 208, sat: 0.5 },
  { file: 'nyx.png', hue: 272, sat: 0.4 },
  { file: 'bram.png', hue: 45, sat: 0.5 },
  { file: 'ogre.png', hue: 305, sat: 0.34 },
  { file: 'wraith.png', hue: 178, sat: 0.3 },
];

// ------------------------------------------------------------------------ run

mkdirSync(join(ASSETS, 'tokens'), { recursive: true });

const map = generateMap();
writeFileSync(join(ASSETS, 'map.png'), map);
console.log(`map.png            ${MAP_W}x${MAP_H}  grid ${CELL}px  ${(map.length / 1024).toFixed(0)} KB`);

for (const t of TOKENS) {
  const png = generateToken(t);
  writeFileSync(join(ASSETS, 'tokens', t.file), png);
  console.log(`tokens/${t.file.padEnd(11)}${TOKEN_SIZE}x${TOKEN_SIZE}${' '.repeat(11)}${(png.length / 1024).toFixed(0)} KB`);
}
