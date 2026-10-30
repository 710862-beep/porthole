#!/usr/bin/env node
/**
 * Fetch the unmodified third-party binaries for GATE 1 Tier B / GATE 2 (real DOOM rendering):
 *
 *   1. Chocolate Doom 3.1.1 — OFFICIAL Windows x64 build from the chocolate-doom GitHub release
 *      (`chocolate-doom-3.1.1-win64.zip`). The archive SHA-256 below is pinned from the
 *      release-asset digest published by the GitHub API for that tag; it is verified before
 *      anything is extracted.
 *   2. Freedoom 0.13.0 IWADs (freedoom1.wad / freedoom2.wad) — the freely redistributable
 *      game data. The archive is verified against the project's official
 *      `freedoom-0.13.0-CHECKSUM` file downloaded from the same release, and the expected
 *      SHA-256 values are pinned below once measured (see PINNED section).
 *
 * Extracted files land in the git-ignored `tests/assets/third-party/`; nothing is added to Git.
 * The script prints the SHA-256 of every extracted artifact so the gate evidence (docs) can pin
 * the exact executable and IWAD identities.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = path.join(ROOT, 'tests/assets/third-party');

const CHOC = {
  version: '3.1.1',
  zipName: 'chocolate-doom-3.1.1-win64.zip',
  url: 'https://github.com/chocolate-doom/chocolate-doom/releases/download/chocolate-doom-3.1.1/chocolate-doom-3.1.1-win64.zip',
  // From the GitHub Releases API asset digest for tag chocolate-doom-3.1.1 (measured 2026-10-30).
  zipSha256: '58c34c61ae954493fce5ff01fd553898240a0de25658aa97b43ac9510c49581f',
};
const FREEDOOM = {
  version: '0.13.0',
  zipName: 'freedoom-0.13.0.zip',
  url: 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip',
  checksumUrl: 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0-CHECKSUM',
  // PINNED after first measured download (CI 2026-10-30); until then the official CHECKSUM
  // file from the same release is the verification source and the measured value is printed.
  zipSha256: '',
};

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Minimal ZIP reader: central directory scan, stored (0) + deflate (8) entries only. */
function unzipEntries(buf) {
  // End of central directory record: scan backwards for PK\x05\x06.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: end-of-central-directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function unzipFile(buf, entries, suffix) {
  const name = [...entries.keys()].find((k) => k.toLowerCase().endsWith(suffix.toLowerCase()));
  if (!name) throw new Error(`ZIP: no entry ending ${suffix} (have: ${[...entries.keys()].join(', ')})`);
  const { method, compSize, localOff } = entries.get(name);
  if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('ZIP: bad local header');
  const nameLen = buf.readUInt16LE(localOff + 26);
  const extraLen = buf.readUInt16LE(localOff + 28);
  const dataOff = localOff + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataOff, dataOff + compSize);
  if (method === 0) return { name, data: Buffer.from(comp) };
  if (method === 8) return { name, data: zlib.inflateRawSync(comp) };
  throw new Error(`ZIP: unsupported compression method ${method} for ${name}`);
}

function checkPE(bytes, label) {
  if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`${label}: not an MZ/PE executable`);
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${label}: missing PE signature`);
  const machine = bytes.readUInt16LE(pe + 4);
  if (machine !== 0x8664) throw new Error(`${label}: PE machine 0x${machine.toString(16)} is not AMD64 (0x8664)`);
}

fs.mkdirSync(OUTDIR, { recursive: true });
const pins = {};

// ---- Chocolate Doom (official win64 build) ----------------------------------------------------
console.log(`[tier-b] downloading ${CHOC.url}`);
const chocZip = await download(CHOC.url);
const chocZipHash = sha256(chocZip);
if (chocZipHash !== CHOC.zipSha256) {
  throw new Error(`Chocolate Doom zip SHA-256 mismatch: pinned ${CHOC.zipSha256}, got ${chocZipHash}`);
}
console.log(`[tier-b] ${CHOC.zipName} sha256=${chocZipHash} OK (${chocZip.length} bytes)`);
const chocEntries = unzipEntries(chocZip);
console.log(`[tier-b] chocolate zip entries: ${[...chocEntries.keys()].join(', ')}`);
const exe = unzipFile(chocZip, chocEntries, 'chocolate-doom.exe');
checkPE(exe.data, 'chocolate-doom.exe');
// Pinned from the first measured acquisition (CI run 41032902055, 2026-10-30). The zip hash
// above already pins the archive; this additionally pins the extracted executable identity
// that every Tier B / Gate 2 claim must name.
const CHOC_EXE_SHA256 = '15e81c194df270fbd71450222e71846247926fabfb889e72e7d855903454d752';
if (sha256(exe.data) !== CHOC_EXE_SHA256) {
  throw new Error(`chocolate-doom.exe SHA-256 mismatch: pinned ${CHOC_EXE_SHA256}, got ${sha256(exe.data)}`);
}
fs.writeFileSync(path.join(OUTDIR, 'chocolate-doom.exe'), exe.data);
pins.chocolateDoomExe = { file: 'chocolate-doom.exe', bytes: exe.data.length, sha256: sha256(exe.data), zipEntry: exe.name };
console.log(`[tier-b] chocolate-doom.exe bytes=${exe.data.length} sha256=${pins.chocolateDoomExe.sha256}`);
// Extract every DLL shipped in the zip: the emulator HLE-binds these imports and never loads
// the DLLs, but the Gate 2 Wine reference run executes the same exe natively and needs the
// real DLLs (and their own dependencies) beside it. All hashes recorded in the pin file.
for (const name of [...chocEntries.keys()].filter((k) => k.toLowerCase().endsWith('.dll'))) {
  const base = name.split(/[\\/]/).pop();
  try {
    const d = unzipFile(chocZip, chocEntries, base);
    fs.writeFileSync(path.join(OUTDIR, base), d.data);
    pins[base] = { file: base, bytes: d.data.length, sha256: sha256(d.data) };
    console.log(`[tier-b] ${base} bytes=${d.data.length} sha256=${pins[base].sha256} (recorded; emulator HLE-binds imports, Wine reference loads the real DLL)`);
  } catch (e) {
    console.log(`[tier-b] ${base} extract failed: ${e.message}`);
  }
}

// ---- Freedoom IWADs ---------------------------------------------------------------------------
console.log(`[tier-b] downloading ${FREEDOOM.checksumUrl}`);
const checksumText = (await download(FREEDOOM.checksumUrl)).toString('utf8');
console.log(`[tier-b] official Freedoom CHECKSUM file:\n${checksumText.trim()}`);
console.log(`[tier-b] downloading ${FREEDOOM.url}`);
const fdZip = await download(FREEDOOM.url);
const fdZipHash = sha256(fdZip);
const line = checksumText.split(/\r?\n/).find((l) => l.includes(FREEDOOM.zipName));
if (!line) throw new Error(`CHECKSUM file does not mention ${FREEDOOM.zipName}`);
if (!line.toLowerCase().includes(fdZipHash)) {
  throw new Error(`Freedoom zip SHA-256 ${fdZipHash} not present in official CHECKSUM line: ${line}`);
}
if (FREEDOOM.zipSha256 && FREEDOOM.zipSha256 !== fdZipHash) {
  throw new Error(`Freedoom zip pinned SHA-256 mismatch: pinned ${FREEDOOM.zipSha256}, got ${fdZipHash}`);
}
console.log(`[tier-b] ${FREEDOOM.zipName} sha256=${fdZipHash} OK vs official CHECKSUM (${fdZip.length} bytes)`);
pins.freedoomZip = { file: FREEDOOM.zipName, bytes: fdZip.length, sha256: fdZipHash };
const fdEntries = unzipEntries(fdZip);
// freedoom2.wad pinned from the first measured acquisition (CI run 41032902055).
const WAD_PINS = {
  'freedoom2.wad': 'a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b',
};
for (const wad of ['freedoom1.wad', 'freedoom2.wad']) {
  const w = unzipFile(fdZip, fdEntries, wad);
  const magic = w.data.toString('latin1', 0, 4);
  if (magic !== 'IWAD') throw new Error(`${wad}: bad WAD magic ${JSON.stringify(magic)}`);
  if (WAD_PINS[wad] && sha256(w.data) !== WAD_PINS[wad]) {
    throw new Error(`${wad} SHA-256 mismatch: pinned ${WAD_PINS[wad]}, got ${sha256(w.data)}`);
  }
  fs.writeFileSync(path.join(OUTDIR, wad), w.data);
  pins[wad] = { file: wad, bytes: w.data.length, sha256: sha256(w.data), zipEntry: w.name };
  console.log(`[tier-b] ${wad} bytes=${w.data.length} sha256=${pins[wad].sha256}`);
}

const pinPath = path.join(ROOT, 'artifacts/tier-b-pin.json');
fs.mkdirSync(path.dirname(pinPath), { recursive: true });
fs.writeFileSync(pinPath, `${JSON.stringify({ chocolateDoom: CHOC.version, freedoom: FREEDOOM.version, pins }, null, 2)}\n`);
console.log(`[tier-b] pins written to artifacts/tier-b-pin.json`);
