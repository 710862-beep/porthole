#!/usr/bin/env node
/*
 * GATE 2 reference frame — derived from the game data, not from the emulator and not from Wine.
 *
 * Independently decodes the Freedoom title screen from the pinned IWAD (tests/assets/
 * third-party/freedoom2.wad, SHA-256 a8772e08...): parses the WAD directory, extracts the
 * TITLEPIC patch lump and PLAYPAL, renders the patch with the exact semantics of the guest's
 * own V_DrawPatch (chocolate-doom v_video.c: column posts, source at +3, advance length+4,
 * transparent pixels leave the zero-cleared screen buffer), then applies the palette
 * conversion the guest itself performs in I_SetPalette (gammatable[0] == identity at the
 * default usegamma=0, then & ~3 VGA 6-bit masking, alpha 0xFF).
 *
 * The result is the 320x200 RGBA frame ANY correct execution of chocolate-doom.exe must show
 * on the title page. It is compared byte-for-byte (FNV-1a64 + exact pixel count) against the
 * emulator's native-frame tap (run-chocolate-doom.mjs --title-probe PPM).
 *
 * Known-good hash, measured first from the emulator title probe and to be reproduced by this
 * independent decoder (fail-closed in CI): fnv1a64:02d3105200077dee
 *
 * Usage: node scripts/decode-title-reference.mjs [emulator-title.ppm]
 * Exit 0: reference decodes to the expected hash AND (if a PPM is given) matches it exactly.
 */
import fs from 'node:fs';
import path from 'node:path';

const EXPECTED_FNV = 'fnv1a64:02d3105200077dee';
const WAD = 'tests/assets/third-party/freedoom2.wad';
const SCREEN_W = 320;
const SCREEN_H = 200;

function fnv1a64Frame(w, h, rgba) {
  let hash = 0xcbf29ce484222325n;
  const mix = (b) => { hash ^= BigInt(b); hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn; };
  const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  for (const b of le32(w)) mix(b);
  for (const b of le32(h)) mix(b);
  for (const b of rgba) mix(b);
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function readWadLump(wad, name) {
  const magic = wad.toString('latin1', 0, 4);
  if (magic !== 'IWAD' && magic !== 'PWAD') throw new Error(`bad WAD magic ${magic}`);
  const numLumps = wad.readInt32LE(4);
  const dirOff = wad.readInt32LE(8);
  for (let i = 0; i < numLumps; i++) {
    const e = dirOff + i * 16;
    const filePos = wad.readInt32LE(e);
    const size = wad.readInt32LE(e + 4);
    const lumpName = wad.toString('latin1', e + 8, e + 16).replace(/\0+$/, '').toUpperCase();
    if (lumpName === name) return wad.subarray(filePos, filePos + size);
  }
  throw new Error(`lump ${name} not found (${numLumps} lumps)`);
}

/** Render a Doom patch at (0,0) over a zero-filled 320x200 index buffer (V_DrawPatch semantics). */
function renderPatchFullScreen(patch) {
  const w = patch.readInt16LE(0);
  const h = patch.readInt16LE(2);
  const leftOff = patch.readInt16LE(4);
  const topOff = patch.readInt16LE(6);
  const info = { patchW: w, patchH: h, leftOff, topOff };
  if (w !== SCREEN_W || h !== SCREEN_H) {
    // Fullscreen draw semantics only degenerate cleanly for an exactly-screen-sized patch;
    // anything else needs the real V_DrawPatchFullScreen behaviour — fail loudly instead.
    throw new Error(`TITLEPIC is ${w}x${h} (offsets ${leftOff},${topOff}), expected ${SCREEN_W}x${SCREEN_H}`);
  }
  const idx = new Uint8Array(SCREEN_W * SCREEN_H); // guest memsets I_VideoBuffer to 0
  for (let col = 0; col < w; col++) {
    let p = patch.readInt32LE(8 + col * 4);
    for (;;) {
      const topDelta = patch[p];
      if (topDelta === 0xff) break;
      const length = patch[p + 1];
      const src = p + 3;
      for (let i = 0; i < length; i++) {
        const y = topDelta + i;
        if (y >= 0 && y < SCREEN_H) idx[y * SCREEN_W + col] = patch[src + i];
      }
      p += length + 4;
    }
  }
  return { idx, info };
}

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
  off++;
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

const wad = fs.readFileSync(WAD);
const playpal = readWadLump(wad, 'PLAYPAL');
if (playpal.length < 768) throw new Error(`PLAYPAL too short: ${playpal.length}`);
// Guest I_SetPalette at usegamma=0: gammatable[0] is identity; VGA 6-bit DAC masking & ~3.
const displayPal = [];
for (let i = 0; i < 256; i++) {
  displayPal.push([
    playpal[i * 3] & ~3,
    playpal[i * 3 + 1] & ~3,
    playpal[i * 3 + 2] & ~3,
    255,
  ]);
}
const titlepic = readWadLump(wad, 'TITLEPIC');
const { idx, info } = renderPatchFullScreen(titlepic);
const rgba = new Uint8Array(SCREEN_W * SCREEN_H * 4);
for (let i = 0; i < SCREEN_W * SCREEN_H; i++) {
  const c = displayPal[idx[i]];
  rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = c[3];
}
const colours = new Set();
for (let i = 0; i < SCREEN_W * SCREEN_H; i++) {
  colours.add((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]);
}
const referenceFnv = fnv1a64Frame(SCREEN_W, SCREEN_H, rgba);

// Write a PPM of the reference for eyeball diffs.
fs.mkdirSync('artifacts', { recursive: true });
const header = Buffer.from(`P6\n${SCREEN_W} ${SCREEN_H}\n255\n`, 'ascii');
const rgb = Buffer.alloc(SCREEN_W * SCREEN_H * 3);
for (let i = 0, j = 0; i < SCREEN_W * SCREEN_H; i++, j += 3) {
  rgb[j] = rgba[i * 4]; rgb[j + 1] = rgba[i * 4 + 1]; rgb[j + 2] = rgba[i * 4 + 2];
}
fs.writeFileSync('artifacts/title-reference-decoded.ppm', Buffer.concat([header, rgb]));

console.log(`TITLE_REFERENCE patch=${info.patchW}x${info.patchH} offsets=${info.leftOff},${info.topOff} colours=${colours.size} fnv=${referenceFnv} expected=${EXPECTED_FNV} hashMatchesExpected=${referenceFnv === EXPECTED_FNV}`);

let ok = referenceFnv === EXPECTED_FNV;
const ppmPath = process.argv[2];
if (ppmPath) {
  const emu = decodePPM(fs.readFileSync(ppmPath));
  if (emu.w !== SCREEN_W || emu.h !== SCREEN_H) {
    console.log(`TITLE_REFERENCE_COMPARE dimsMismatch emu=${emu.w}x${emu.h}`);
    ok = false;
  } else {
    let equal = 0;
    let maxDelta = 0;
    for (let i = 0; i < SCREEN_W * SCREEN_H; i++) {
      let same = true;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(emu.rgba[i * 4 + c] - rgba[i * 4 + c]);
        if (d > maxDelta) maxDelta = d;
        if (d !== 0) same = false;
      }
      if (same) equal++;
    }
    const emuFnv = fnv1a64Frame(emu.w, emu.h, emu.rgba);
    console.log(`TITLE_REFERENCE_COMPARE emuFnv=${emuFnv} equal=${equal}/${SCREEN_W * SCREEN_H} maxDelta=${maxDelta} identical=${equal === SCREEN_W * SCREEN_H}`);
    ok = ok && equal === SCREEN_W * SCREEN_H;
  }
}
process.exit(ok ? 0 : 1);
