#!/usr/bin/env node
/*
 * GATE 2 Wine-reference pixel comparison.
 *
 * Input A: a PCX screenshot written by the pinned chocolate-doom.exe ITSELF (M_ScreenShot)
 * while running under real Wine on Linux — i.e. the guest's own 320x200 palette-indexed
 * framebuffer + the palette it programmed, produced by guest code on a real Windows API.
 * Input B: the PPM dumped by `run-chocolate-doom.mjs --title-probe` from the emulator's
 * native-frame tap (the same guest's 320x200 streaming texture, before host scaling).
 *
 * Both depict the static Freedoom TITLEPIC from the same pinned IWAD, so they must agree
 * pixel-for-pixel if (a) the guest executed identically up to the title screen and
 * (b) our SDL HLE moved those pixels faithfully. Exit 0 only on a 100% pixel match;
 * any mismatch is printed with counts and exits 1 (fail-closed, no fuzzy threshold).
 *
 * Usage: node scripts/compare-title-frame.mjs <wine-shot.pcx> <emulator-title.ppm>
 */
import fs from 'node:fs';

const [pcxPath, ppmPath] = process.argv.slice(2);
if (!pcxPath || !ppmPath) {
  console.error('usage: compare-title-frame.mjs <wine-shot.pcx> <emulator-title.ppm>');
  process.exit(2);
}

function fnv1a64Frame(w, h, rgba) {
  let hash = 0xcbf29ce484222325n;
  const mix = (b) => { hash ^= BigInt(b); hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn; };
  const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  for (const b of le32(w)) mix(b);
  for (const b of le32(h)) mix(b);
  for (const b of rgba) mix(b);
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

/** Decode ZSoft PCX as written by Chocolate Doom's WritePCXfile (8bpp, 1 plane, RLE). */
function decodePCX(buf) {
  if (buf.length < 128 || buf[0] !== 0x0a) throw new Error('PCX: bad magic');
  const xmin = buf.readUInt16LE(4);
  const ymin = buf.readUInt16LE(6);
  const xmax = buf.readUInt16LE(8);
  const ymax = buf.readUInt16LE(10);
  const nplanes = buf[65];
  const bpl = buf.readUInt16LE(66);
  const w = xmax - xmin + 1;
  const h = ymax - ymin + 1;
  if (nplanes !== 1) throw new Error(`PCX: expected 1 plane, got ${nplanes}`);
  // Palette trailer: 0x0C + 256 RGB triples.
  const palOff = buf.length - 769;
  if (palOff < 128 || buf[palOff] !== 0x0c) throw new Error('PCX: 256-colour palette trailer missing');
  const palette = [];
  for (let i = 0; i < 256; i++) {
    palette.push([buf[palOff + 1 + i * 3], buf[palOff + 1 + i * 3 + 1], buf[palOff + 1 + i * 3 + 2]]);
  }
  const idx = new Uint8Array(w * h);
  let src = 128;
  let dst = 0;
  const total = bpl * h;
  while (dst < total && src < palOff) {
    const b = buf[src++];
    if ((b & 0xc0) === 0xc0) {
      const run = b & 0x3f;
      const val = buf[src++];
      for (let i = 0; i < run && dst < total; i++) {
        const x = dst % bpl;
        if (x < w) idx[Math.floor(dst / bpl) * w + x] = val;
        dst++;
      }
    } else {
      const x = dst % bpl;
      if (x < w) idx[Math.floor(dst / bpl) * w + x] = b;
      dst++;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = palette[idx[i]];
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  return { w, h, rgba };
}

/** Decode binary PPM (P6) as written by the tier-B runner. */
function decodePPM(buf) {
  let off = 0;
  const tok = () => {
    while (off < buf.length && buf[off] <= 0x20) off++;
    let s = '';
    while (off < buf.length && buf[off] > 0x20) s += String.fromCharCode(buf[off++]);
    return s;
  };
  if (tok() !== 'P6') throw new Error('PPM: bad magic');
  const w = Number(tok());
  const h = Number(tok());
  const maxv = Number(tok());
  off++; // single whitespace after maxval
  if (maxv !== 255) throw new Error(`PPM: maxval ${maxv}`);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = buf[off + i * 3];
    rgba[i * 4 + 1] = buf[off + i * 3 + 1];
    rgba[i * 4 + 2] = buf[off + i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { w, h, rgba };
}

const a = decodePCX(fs.readFileSync(pcxPath));
const b = decodePPM(fs.readFileSync(ppmPath));
const dimsMatch = a.w === b.w && a.h === b.h;
let equal = 0;
let maxDelta = 0;
const total = Math.min(a.w * a.h, b.w * b.h);
if (dimsMatch) {
  for (let i = 0; i < total; i++) {
    let same = true;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.rgba[i * 4 + c] - b.rgba[i * 4 + c]);
      if (d > maxDelta) maxDelta = d;
      if (d !== 0) same = false;
    }
    if (same) equal++;
  }
}
const coloursA = new Set();
for (let i = 0; i < a.w * a.h; i++) coloursA.add((a.rgba[i * 4] << 16) | (a.rgba[i * 4 + 1] << 8) | a.rgba[i * 4 + 2]);
const verdict = {
  winePcx: { file: pcxPath, w: a.w, h: a.h, fnv: fnv1a64Frame(a.w, a.h, a.rgba), distinctColours: coloursA.size },
  emulatorPpm: { file: ppmPath, w: b.w, h: b.h, fnv: fnv1a64Frame(b.w, b.h, b.rgba) },
  dimsMatch,
  pixelsTotal: total,
  pixelsEqual: equal,
  pixelsDifferent: total - equal,
  maxChannelDelta: maxDelta,
  identical: dimsMatch && equal === total && total > 0,
};
console.log(JSON.stringify(verdict, null, 2));
console.log(`TITLE_COMPARE identical=${verdict.identical} equal=${equal}/${total} maxDelta=${maxDelta} wine_fnv=${verdict.winePcx.fnv} emu_fnv=${verdict.emulatorPpm.fnv}`);
process.exit(verdict.identical ? 0 : 1);
