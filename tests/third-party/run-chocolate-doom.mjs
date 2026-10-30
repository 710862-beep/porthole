#!/usr/bin/env node
/*
 * GATE 1 Tier B / GATE 2 probe: run the pinned, UNMODIFIED official Chocolate Doom 3.1.1
 * Windows x64 build with the Freedoom 0.13.0 IWAD inside the wasm-bindgen emulator.
 *
 * This runner is fail-closed and separates the four claims: today it can only produce
 * EXECUTION evidence (or a named-blocker failure log). It reports PASS only when the guest
 * both (a) exits 0 after a deterministic timedemo and (b) has actually PRESENTED guest-written
 * frames through the emulator's frame path (presented_frames > 0 with a framebuffer checksum).
 * A host-authored pixel never counts. Until the SDL2 HLE path exists, the expected result is
 * FAIL with the first named API blockers — that log is the deliverable, not a fake success.
 *
 * Workload knobs (recorded in the report; the binary is never modified):
 *   PORTHOLE_DOOM_ARGS      guest argv tail, default "-iwad C:\Game\DOOM2.WAD -timedemo demo1 -nodraw -nosound"
 *   PORTHOLE_DOOM_RESIDENT  VMM resident-page budget, default 65536 pages (256 MiB)
 *   PORTHOLE_DOOM_TIMEOUT_S wall-clock budget, default 540
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const wasmDir = process.env.PORTHOLE_X64_WASM_DIR || 'vendor/porthole-x64-wasm';
const exeRel = 'tests/assets/third-party/chocolate-doom.exe';
const wadRel = 'tests/assets/third-party/freedoom2.wad';
const guestArgs = process.env.PORTHOLE_DOOM_ARGS ?? '-iwad C:\\Game\\DOOM2.WAD -timedemo demo1 -nodraw -nosound';
const residentPages = Math.max(64, Number(process.env.PORTHOLE_DOOM_RESIDENT || 65536) || 65536);
const timeoutMs = Math.max(10, Number(process.env.PORTHOLE_DOOM_TIMEOUT_S || 540) || 540) * 1000;
const limits = { slice: 2_000_000, maxSlices: 100000 };

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const abs = (p) => path.resolve(root, p);

/** Dump the PE import table (dll -> symbols) for the gate evidence file. */
function dumpImports(bytes) {
  const u16 = (o) => bytes.readUInt16LE(o);
  const u32 = (o) => bytes.readUInt32LE(o);
  const pe = u32(0x3c);
  const nsec = u16(pe + 6);
  const optSize = u16(pe + 20);
  const opt = pe + 24;
  const ddImports = opt + 112 + 8; // DataDirectory[1]
  const importRva = u32(ddImports);
  const sections = [];
  for (let i = 0; i < nsec; i++) {
    const s = opt + optSize + i * 40;
    sections.push({ va: u32(s + 12), vsize: Math.max(u32(s + 8), u32(s + 16)), raw: u32(s + 20) });
  }
  const rva2off = (rva) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + s.vsize) return s.raw + (rva - s.va);
    return -1;
  };
  const cstr = (off) => {
    let end = off;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return bytes.toString('latin1', off, end);
  };
  const out = [];
  let desc = rva2off(importRva);
  if (desc < 0) return '(import directory unmapped)';
  for (;;) {
    const oft = u32(desc);
    const nameRva = u32(desc + 12);
    const ft = u32(desc + 16);
    if (!oft && !nameRva && !ft) break;
    const dll = cstr(rva2off(nameRva));
    const names = [];
    let thunk = rva2off(oft || ft);
    for (;;) {
      const lo = u32(thunk);
      const hi = u32(thunk + 4);
      if (!lo && !hi) break;
      if (hi & 0x80000000) names.push(`#${lo & 0xffff}`);
      else names.push(cstr(rva2off(lo) + 2));
      thunk += 8;
    }
    out.push(`${dll}: ${names.join(', ')}`);
    desc += 20;
  }
  return out.join('\n');
}

function missingWasm() {
  const glue = path.join(abs(wasmDir), 'porthole_x64_wasm.js');
  const wasm = path.join(abs(wasmDir), 'porthole_x64_wasm_bg.wasm');
  const missing = [glue, wasm].filter((p) => !fs.existsSync(p));
  return missing.length ? `Wasm artifacts missing: ${missing.join(', ')}` : null;
}

async function loadBinding() {
  const reason = missingWasm();
  if (reason) return { error: reason };
  const dir = abs(wasmDir);
  const gluePath = path.join(dir, 'porthole_x64_wasm.js');
  const wasmPath = path.join(dir, 'porthole_x64_wasm_bg.wasm');
  const mod = await import(pathToFileURL(gluePath).href);
  if (typeof mod.default === 'function') await mod.default(fs.readFileSync(wasmPath));
  if (typeof mod.BrowserX64Emulator !== 'function') return { error: 'BrowserX64Emulator export missing' };
  return { mod, wasmSha256: sha256(fs.readFileSync(wasmPath)) };
}

function writeReport(report) {
  const out = abs('artifacts/chocolate-doom-tier-b-report.json');
  const textOut = abs('artifacts/chocolate-doom-tier-b-report.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const run = report.run || {};
  const lines = [
    `GATE 1 Tier B / GATE 2 (Chocolate Doom): ${report.status}`,
    `binary=${report.binary} sha256=${report.binarySha256 || 'unknown'} bytes=${report.binaryBytes || 0}`,
    `iwad=${report.iwad} sha256=${report.iwadSha256 || 'unknown'} bytes=${report.iwadBytes || 0}`,
    `runner=${report.runner} device=${JSON.stringify(report.device)}`,
    `argv=chocolate-doom.exe ${guestArgs} resident_pages=${residentPages}`,
    `claim_scope=EXECUTION probe; RENDERING requires guest-presented frames (see presented_frames)`,
    `presented_frames=${run.presentedFrames ?? 0} framebuffer_checksum=${run.frameChecksum || 'none'}`,
    `reason=${report.reason || 'none'}`,
    '',
    `run: terminal=${run.terminal || 'not-started'} rip=${run.rip || '-'} last_error=${run.lastError ?? '-'} instructions=${run.instructions ?? 0} page_faults=${run.pageFaults ?? 0} wall_ms=${run.wallMs ?? 0} mips=${run.mips ?? '-'}`,
    `named_blockers(unimplemented)=${run.unimplemented || '(none reported)'}`,
    `hle=${run.hle || ''}`,
    'guest_output:',
    (run.console || '(no guest output)').split('\n').slice(-160).join('\n'),
  ];
  if (run.faultSnapshot) {
    lines.push('fault_snapshot:');
    lines.push(run.faultSnapshot.split('\n').slice(0, 60).join('\n'));
  }
  lines.push('hle_trace_tail:');
  lines.push((run.traceTail || '(no trace)').split('\n').slice(-200).join('\n'));
  lines.push('import_table:');
  lines.push(report.importTable || '(unavailable)');
  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync(textOut, text);
  console.log(text);
}

async function main() {
  const device = {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()?.[0]?.model || 'unknown',
    totalMemoryBytes: os.totalmem(),
    availableParallelism: os.availableParallelism?.() || os.cpus().length,
  };
  const report = {
    status: 'NOT_RUN',
    binary: 'Chocolate Doom 3.1.1 (official win64 build) chocolate-doom.exe',
    iwad: 'Freedoom 0.13.0 freedoom2.wad',
    runner: `Node ${process.version}`,
    device,
    reason: '',
    run: null,
    importTable: '',
  };
  const exeFile = abs(exeRel);
  const wadFile = abs(wadRel);
  for (const f of [exeFile, wadFile]) {
    if (!fs.existsSync(f)) {
      report.reason = `Missing acquired binary ${f} — run node scripts/fetch-chocolate-doom.mjs`;
      writeReport(report);
      console.error(`[tier-b] NOT_RUN: ${report.reason}`);
      process.exit(2);
    }
  }
  const exeBytes = fs.readFileSync(exeFile);
  const wadBytes = fs.readFileSync(wadFile);
  report.binarySha256 = sha256(exeBytes);
  report.binaryBytes = exeBytes.length;
  report.iwadSha256 = sha256(wadBytes);
  report.iwadBytes = wadBytes.length;
  if (wadBytes.toString('latin1', 0, 4) !== 'IWAD') {
    report.reason = 'freedoom2.wad does not start with IWAD magic';
    writeReport(report);
    process.exit(2);
  }
  report.importTable = dumpImports(exeBytes);

  const binding = await loadBinding();
  if (binding.error) {
    report.reason = binding.error;
    writeReport(report);
    console.error(`[tier-b] NOT_RUN: ${binding.error}`);
    process.exit(2);
  }
  const { mod } = binding;
  report.wasmSha256 = binding.wasmSha256;

  const emu = new mod.BrowserX64Emulator(residentPages);
  for (const dir of [
    'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Users', 'C:\\Users\\PORTHOLE',
    'C:\\Users\\PORTHOLE\\Temp', 'C:\\Users\\PORTHOLE\\AppData', 'C:\\Users\\PORTHOLE\\AppData\\Roaming',
    'C:\\Game',
  ]) emu.vfs_mkdir(dir);
  emu.vfs_insert('C:\\Game\\chocolate-doom.exe', new Uint8Array(exeBytes));
  emu.vfs_insert('C:\\Game\\DOOM2.WAD', new Uint8Array(wadBytes));
  emu.enable_trace?.(2000);
  emu.set_hle_trace_only?.(true);
  const load = JSON.parse(emu.load_pe(new Uint8Array(exeBytes)));
  emu.set_exe_path?.('C:\\Game\\chocolate-doom.exe');
  emu.set_command_line(`C:\\Game\\chocolate-doom.exe ${guestArgs}`);
  report.load = load;

  const started = Date.now();
  const deadline = started + timeoutMs;
  const pageStore = new Map();
  let slices = 0;
  let pageFaults = 0;
  let terminal = 'slice-budget';
  while (slices < limits.maxSlices && Date.now() <= deadline) {
    const status = emu.run_slice(limits.slice);
    slices += 1;
    const drained = emu.drain_evicted_pages?.();
    if (drained && drained.length) {
      const view = new DataView(drained.buffer, drained.byteOffset, drained.byteLength);
      for (let off = 0; off + 8 + 4096 <= drained.length; off += 8 + 4096) {
        pageStore.set(view.getBigUint64(off, true), drained.slice(off + 8, off + 8 + 4096));
      }
    }
    if (status === 'next') continue;
    if (status.startsWith('page-fault:')) {
      pageFaults += 1;
      if (pageFaults > 200000) { terminal = `page-fault-storm:${status.slice(11)}`; break; }
      const base = BigInt(status.slice(11));
      emu.supply_page(base, pageStore.get(base) || new Uint8Array(4096));
      continue;
    }
    terminal = status;
    break;
  }
  if (Date.now() > deadline && terminal === 'slice-budget') terminal = 'timeout-still-running';
  const wallMs = Date.now() - started;
  const instructions = Number(emu.instructions_executed());
  const trace = emu.take_trace?.() || '';
  report.run = {
    terminal,
    slices,
    pageFaults,
    instructions,
    wallMs,
    mips: wallMs > 0 ? Number((instructions / (wallMs / 1000) / 1e6).toFixed(2)) : null,
    rip: `0x${emu.rip().toString(16)}`,
    lastError: emu.last_error(),
    console: emu.take_console(),
    unimplemented: emu.unimplemented_symbols?.() || '',
    hle: emu.hle_histogram?.(120) || '',
    telemetry: emu.telemetry_json?.() || '',
    traceTail: trace.split('\n').slice(-220).join('\n'),
    faultSnapshot: terminal.startsWith('fault:') ? (emu.fault_snapshot?.() || '') : '',
    // Gate 2 accounting: only frames the GUEST presented through the emulator frame path count.
    presentedFrames: Number(emu.presented_frames?.() || 0),
    frameChecksum: emu.frame_checksum?.() || '',
  };

  if (terminal === 'exit:0' && report.run.presentedFrames > 0 && report.run.frameChecksum) {
    report.status = 'PASS';
  } else {
    report.status = 'FAIL';
    const blockers = report.run.unimplemented ? report.run.unimplemented.split(/\s+/).filter(Boolean).slice(0, 24).join(' ') : '';
    report.reason = terminal === 'exit:0'
      ? `guest exited 0 but presented_frames=${report.run.presentedFrames} (no guest frame = no rendering claim)`
      : `guest terminal=${terminal}${blockers ? `; first named blockers: ${blockers}` : ''}`;
  }
  writeReport(report);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

await main();
