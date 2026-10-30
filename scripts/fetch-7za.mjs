#!/usr/bin/env node
/**
 * Fetch the unmodified 7-Zip Standalone Console x64 executable used by the independent-binary
 * emulator gate. The npm tarball is a third-party repackaging of the upstream 7-Zip binary;
 * both its archive and the executable are pinned by SHA-256. Nothing is added to Git.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = 'https://registry.npmjs.org/7zip-bin/-/7zip-bin-5.2.0.tgz';
const ARCHIVE_SHA256 = '04f9738ee00be8be53f5d06254a9e6e4b5117b17f8b74058477d870e62764a7d';
const EXE_SHA256 = 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95';
const OUT = path.join(ROOT, 'tests/assets/third-party/7za.exe');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const response = await fetch(URL, { redirect: 'error' });
if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
const tarball = Buffer.from(await response.arrayBuffer());
const archiveHash = sha256(tarball);
if (archiveHash !== ARCHIVE_SHA256) {
  throw new Error(`npm tarball SHA-256 mismatch: expected ${ARCHIVE_SHA256}, got ${archiveHash}`);
}

const temp = path.join(ROOT, 'artifacts/7zip-bin-5.2.0.tgz');
fs.mkdirSync(path.dirname(temp), { recursive: true });
fs.writeFileSync(temp, tarball);
const extract = spawnSync('tar', ['-xOf', temp, 'package/win/x64/7za.exe'], {
  encoding: 'buffer',
  maxBuffer: 8 * 1024 * 1024,
});
if (extract.status !== 0) {
  throw new Error(`Could not extract package/win/x64/7za.exe: ${extract.stderr?.toString() || extract.error}`);
}
const bytes = Buffer.from(extract.stdout);
const exeHash = sha256(bytes);
if (exeHash !== EXE_SHA256) {
  throw new Error(`7za.exe SHA-256 mismatch: expected ${EXE_SHA256}, got ${exeHash}`);
}
if (bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Not an MZ/PE executable');
const peOffset = bytes.readUInt32LE(0x3c);
if (bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Missing PE signature');
if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('PE machine is not AMD64 (0x8664)');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, bytes);
console.log(`ACQUIRED ${path.relative(ROOT, OUT)}`);
console.log(`source=${URL}`);
console.log(`archive_sha256=${archiveHash}`);
console.log(`exe_sha256=${exeHash}`);
console.log('upstream_product=7-Zip Standalone Console 21.07 (x64), PE32+, machine=0x8664');
console.log(`runner=Node ${process.version}`);
console.log(`device=${os.platform()} ${os.release()} ${os.arch()} / ${os.cpus()[0]?.model || 'unknown'} / RAM=${os.totalmem()}`);
