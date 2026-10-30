#!/usr/bin/env node
/*
 * Tier-A independent-binary gate: run the pinned, unmodified 7-Zip Standalone Console PE32+
 * inside the wasm-bindgen emulator, create an archive, extract it, and byte-compare the result.
 * This runner intentionally never reports PASS when the Wasm module, binary, or round-trip
 * evidence is missing. All guest file I/O goes through the emulator's virtual C:\Game volume.
 *
 * Workload knobs (recorded in the report; the binary itself is never modified):
 *   PORTHOLE_7ZA_INPUT_BYTES  input size, default 262144
 *   PORTHOLE_7ZA_METHOD       extra create switches, default "-mmt1 -mx=1" (single-thread,
 *                             fastest LZMA2). Threaded compression is a separate named gap.
 *   PORTHOLE_7ZA_RESIDENT     VMM resident-page budget, default 65536 pages (256 MiB).
 *                             Evicted pages are round-tripped through a host page store so a
 *                             small budget stays correct (Gate 3 measures that separately).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const wasmDir = process.env.PORTHOLE_X64_WASM_DIR || 'vendor/porthole-x64-wasm';
const exePath = 'tests/assets/third-party/7za.exe';
const samplePath = 'tests/assets/third-party/roundtrip-input.bin';
const archivePath = 'C:\\Game\\roundtrip.7z';
const extractedPath = 'C:\\Game\\extract\\roundtrip-input.bin';
const inputBytes = Math.max(1, Number(process.env.PORTHOLE_7ZA_INPUT_BYTES || 262144) || 262144);
const method = process.env.PORTHOLE_7ZA_METHOD ?? '-mmt1 -mx=1';
const residentPages = Math.max(64, Number(process.env.PORTHOLE_7ZA_RESIDENT || 65536) || 65536);
const limits = { slice: 2_000_000, maxSlices: 2000, timeoutMs: 600_000 };

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const abs = (p) => path.resolve(root, p);
const exe = abs(exePath);

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

function setup(mod, bytes, commandLine) {
  const emu = new mod.BrowserX64Emulator(residentPages);
  for (const dir of ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Users', 'C:\\Users\\PORTHOLE', 'C:\\Users\\PORTHOLE\\Temp', 'C:\\Game']) {
    emu.vfs_mkdir(dir);
  }
  emu.vfs_insert('C:\\Game\\7za.exe', new Uint8Array(fs.readFileSync(exe)));
  emu.vfs_insert('C:\\Game\\roundtrip-input.bin', new Uint8Array(bytes));
  emu.vfs_mkdir('C:\\Game\\extract');
  emu.enable_trace?.(600);
  emu.set_hle_trace_only?.(true);
  const load = JSON.parse(emu.load_pe(new Uint8Array(fs.readFileSync(exe))));
  emu.set_exe_path?.('C:\\Game\\7za.exe');
  emu.set_command_line(commandLine);
  return { emu, load };
}

function execute(emu, timeoutMs = limits.timeoutMs) {
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
  const wallMs = Date.now() - started;
  const consoleText = emu.take_console();
  const trace = emu.take_trace?.() || '';
  const instructions = Number(emu.instructions_executed());
  return {
    terminal,
    slices,
    pageFaults,
    instructions,
    wallMs,
    mips: wallMs > 0 ? Number((instructions / (wallMs / 1000) / 1e6).toFixed(2)) : null,
    rip: `0x${emu.rip().toString(16)}`,
    lastError: emu.last_error(),
    console: consoleText,
    unimplemented: emu.unimplemented_symbols?.() || '',
    hle: emu.hle_histogram?.(100) || '',
    telemetry: emu.telemetry_json?.() || '',
    traceTail: trace.split('\n').slice(-160).join('\n'),
    faultSnapshot: terminal.startsWith('fault:') ? (emu.fault_snapshot?.() || '') : '',
  };
}

function writeReport(report) {
  const out = abs('artifacts/7za-tier-a-report.json');
  const textOut = abs('artifacts/7za-tier-a-report.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `GATE 1 Tier A: ${report.status}`,
    `binary=${report.binary} sha256=${report.binarySha256 || 'unknown'}`,
    `runner=${report.runner} device=${JSON.stringify(report.device)}`,
    `workload=input_bytes=${report.workload?.inputBytes} method=${report.workload?.method || '(default)'} resident_pages=${report.workload?.residentPages}`,
    `reason=${report.reason || 'none'}`,
  ];
  for (const phase of ['create', 'extract']) {
    const run = report[phase];
    if (!run) continue;
    lines.push(`\n${phase}: terminal=${run.terminal} rip=${run.rip} last_error=${run.lastError} instructions=${run.instructions} page_faults=${run.pageFaults} wall_ms=${run.wallMs} mips=${run.mips}`);
    lines.push(`unimplemented=${run.unimplemented || '(none reported)'}`);
    lines.push(`hle=${run.hle}`);
    lines.push('guest_output:');
    lines.push((run.console || '(no guest output)').split('\n').slice(-120).join('\n'));
    if (run.faultSnapshot) {
      lines.push('fault_snapshot:');
      lines.push(run.faultSnapshot.split('\n').slice(0, 60).join('\n'));
    }
    lines.push('hle_trace_tail:');
    lines.push((run.traceTail || '(no trace)').split('\n').slice(-120).join('\n'));
  }
  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync(textOut, text);
  console.log(text);
}

async function main() {
  const report = {
    gate: 'GATE 1 / Tier A',
    binary: '7-Zip Standalone Console 21.07 x64',
    binaryUrl: 'https://registry.npmjs.org/7zip-bin/-/7zip-bin-5.2.0.tgz',
    binarySha256: null,
    runner: `Node ${process.version}`,
    device: {
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpu: os.cpus()[0]?.model || 'unknown',
      totalMemoryBytes: os.totalmem(),
      availableParallelism: os.availableParallelism?.() ?? null,
    },
    workload: { inputBytes, method, residentPages },
    status: 'NOT_RUN',
  };
  if (!fs.existsSync(exe)) {
    report.reason = `Pinned PE missing: ${exePath}; run node scripts/fetch-7za.mjs`;
    console.error(`[7za] NOT_RUN: ${report.reason}`);
    writeReport(report);
    process.exitCode = 2;
    return;
  }
  const exeBytes = fs.readFileSync(exe);
  report.binarySha256 = sha256(exeBytes);
  if (report.binarySha256 !== 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95') {
    report.status = 'FAIL';
    report.reason = `Unexpected 7za.exe hash ${report.binarySha256}`;
    console.error(`[7za] FAIL: ${report.reason}`);
    writeReport(report);
    process.exitCode = 1;
    return;
  }
  const input = Buffer.alloc(inputBytes);
  for (let i = 0; i < input.length; i += 1) input[i] = ((i * 131 + (i >>> 8) * 17) ^ (i >>> 3)) & 0xff;
  fs.mkdirSync(path.dirname(abs(samplePath)), { recursive: true });
  fs.writeFileSync(abs(samplePath), input);

  const binding = await loadBinding();
  if (binding.error) {
    report.reason = binding.error;
    console.error(`[7za] NOT_RUN: ${binding.error}`);
    writeReport(report);
    process.exitCode = 2;
    return;
  }
  report.wasmSha256 = binding.wasmSha256;
  const createCommand = `C:\\Game\\7za.exe a -t7z -y -bd ${method} C:\\Game\\roundtrip.7z C:\\Game\\roundtrip-input.bin`.replace(/\s+/g, ' ').trim();
  const extractCommand = 'C:\\Game\\7za.exe e -y -bd -mmt1 -oC:\\Game\\extract C:\\Game\\roundtrip.7z';
  report.commands = { create: createCommand, extract: extractCommand };
  let create;
  try {
    create = setup(binding.mod, input, createCommand);
  } catch (error) {
    report.status = 'FAIL';
    report.reason = `guest image load failed before first instruction: ${error.stack || error}`;
    writeReport(report);
    process.exitCode = 1;
    return;
  }
  report.load = create.load;
  report.create = execute(create.emu);
  const archive = create.emu.vfs_read(archivePath);
  report.archiveBytes = archive?.length || 0;
  report.archiveSha256 = archive ? sha256(archive) : null;

  let extract;
  try {
    extract = setup(binding.mod, input, extractCommand);
  } catch (error) {
    report.status = 'FAIL';
    report.reason = `extract process image load failed: ${error.stack || error}`;
    writeReport(report);
    process.exitCode = 1;
    return;
  }
  if (archive) extract.emu.vfs_insert(archivePath, new Uint8Array(archive));
  report.extract = execute(extract.emu);
  const extracted = extract.emu.vfs_read(extractedPath);
  report.input = { bytes: input.length, sha256: sha256(input) };
  report.output = extracted ? { bytes: extracted.length, sha256: sha256(extracted) } : null;
  report.byteIdentical = Boolean(extracted && Buffer.compare(input, Buffer.from(extracted)) === 0);
  report.status = report.create.terminal === 'exit:0' && report.extract.terminal === 'exit:0' && report.byteIdentical
    ? 'PASS'
    : 'FAIL';
  if (report.status !== 'PASS') {
    const run = report.create.terminal === 'exit:0' ? report.extract : report.create;
    report.reason = `guest ${run.terminal} at RIP ${run.rip}; last_error=${run.lastError}; unimplemented=${run.unimplemented}`;
  }
  console.log(`[7za] ${report.status} sha256=${report.binarySha256} runner=${report.runner} device=${JSON.stringify(report.device)}`);
  console.log(`[7za] create=${report.create.terminal} extract=${report.extract.terminal} input=${input.length}/${report.input.sha256} output=${report.output ? `${report.output.bytes}/${report.output.sha256}` : 'missing'} identical=${report.byteIdentical}`);
  if (report.reason) console.log(`[7za] blocker=${report.reason}`);
  writeReport(report);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}

await main();
