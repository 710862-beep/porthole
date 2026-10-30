#!/usr/bin/env node
/*
 * GATE 3 host driver (DRAFT — not yet wired into CI).
 *
 * Runs the authored nvme_stress.exe fixture inside the Wasm core with the resident-page
 * LRU deliberately capped FAR below the guest working set (default: 1024 pages = 4 MiB
 * resident vs 512 MiB guest buffer), so page faults to the host page store are unavoidable.
 * The page store here is real files on the host disk ("shards"), standing in for the
 * browser's OPFS/FileSystemHandle bridge — the drain/supply PROTOCOL is identical:
 *
 *   RUNNING --(run_slice returns "page-fault:BASE")--> SUSPENDED
 *   SUSPENDED: host reads the 4 KiB page from its shard file (async I/O in the browser;
 *              the Wasm instance is fully exited at this point — nothing is blocked on a
 *              Promise cast to a value, no guest state is half-committed because the VMM
 *              preflights multi-page accesses and raises the trap before touching data)
 *   SUPPLYING: emu.supply_page(BASE, bytes) inserts the page and clears its swapped mark
 *   RESUMED:   run_slice re-enters; the faulting instruction re-executes from its RIP and
 *              now completes. Measured proof obligation: the guest verifies all 512 MiB
 *              after ~2 full trips through the store and finds zero wrong words.
 *
 * Evictions flow the other way: after every slice, emu.drain_evicted_pages() returns
 * [u64 base][4096 bytes] records for dirty victims; the host persists them into shards.
 * Telemetry (emu.telemetry_json(): residentPages, swappedPages, pagesEvicted, ...) is
 * sampled throughout; fault latencies are timed individually for p50/p99.
 *
 * Fail-closed PASS requires ALL of: guest exit 0 + NVME_STRESS_OK/bad=0 in guest console;
 * pageFaults >= (guestPages - residentPages); store bytes written >= 90% of the guest
 * buffer; resident peak <= resident cap; and an independent host-side re-verification of
 * EVERY pattern word read back from the shard files after forcing full eviction.
 *
 * Knobs: PORTHOLE_GATE3_MIB (default 512; final Gate 3 run uses 1024),
 *        PORTHOLE_GATE3_RESIDENT_PAGES (default 1024 = 4 MiB),
 *        PORTHOLE_GATE3_TIMEOUT_S (default 1800),
 *        PORTHOLE_GATE3_EXE (default tests/assets/gate3/nvme_stress.exe, built by the
 *        same zig fixture pipeline as tests/game).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const abs = (p) => path.resolve(root, p);
const wasmDir = process.env.PORTHOLE_X64_WASM_DIR || 'vendor/porthole-x64-wasm';
const exeRel = process.env.PORTHOLE_GATE3_EXE || 'tests/assets/gate3/nvme_stress.exe';
const mib = Math.max(16, Number(process.env.PORTHOLE_GATE3_MIB || 512) || 512);
const residentPages = Math.max(64, Number(process.env.PORTHOLE_GATE3_RESIDENT_PAGES || 1024) || 1024);
const timeoutMs = Math.max(10, Number(process.env.PORTHOLE_GATE3_TIMEOUT_S || 1800) || 1800) * 1000;
const guestPages = mib * 256;
const PAGE = 4096;

// ---- pattern mirror of tests/gate3/nvme_stress.c pat() ------------------------------
function pat(page, word) {
  const M = (1n << 64n) - 1n;
  let x = ((BigInt(page) + 1n) * 0x9E3779B97F4A7C15n + BigInt(word) * 0xD1B54A32D192ED03n) & M;
  x ^= x >> 29n;
  x = (x * 0xBF58476D1CE4E5B9n) & M;
  x ^= x >> 32n;
  return x;
}

// ---- shard store: guest VA -> file. One shard covers 4 MiB of guest VA (1024 pages). --
const shardDir = abs('artifacts/gate3-shards');
fs.rmSync(shardDir, { recursive: true, force: true });
fs.mkdirSync(shardDir, { recursive: true });
const shardPath = (shardIdx) => path.join(shardDir, `shard-${shardIdx.toString(16)}.bin`);
const SHARD_SPAN = 0x400000n; // 4 MiB
const fds = new Map();
function shardFd(shardIdx) {
  if (!fds.has(shardIdx)) fds.set(shardIdx, fs.openSync(shardPath(shardIdx), 'w+'));
  return fds.get(shardIdx);
}
const store = {
  bytesWritten: 0,
  bytesRead: 0,
  writtenPages: new Set(),
  writePage(base, data) {
    const idx = (base / SHARD_SPAN).valueOf();
    const off = Number(base % SHARD_SPAN);
    fs.writeSync(shardFd(idx), data, 0, PAGE, off);
    this.bytesWritten += PAGE;
    this.writtenPages.add(base);
  },
  readPage(base) {
    const idx = (base / SHARD_SPAN).valueOf();
    const off = Number(base % SHARD_SPAN);
    const buf = Buffer.alloc(PAGE);
    if (fds.has(idx) || fs.existsSync(shardPath(idx))) {
      fs.readSync(shardFd(idx), buf, 0, PAGE, off);
      this.bytesRead += PAGE;
    }
    return new Uint8Array(buf); // absent shard slot == clean/demand-zero page
  },
};

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

async function loadBinding() {
  const dir = abs(wasmDir);
  const mod = await import(pathToFileURL(path.join(dir, 'porthole_x64_wasm.js')).href);
  if (typeof mod.default === 'function') await mod.default(fs.readFileSync(path.join(dir, 'porthole_x64_wasm_bg.wasm')));
  return mod;
}

async function main() {
  const report = {
    gate: 'GATE 3 (NVMe memory) — DRAFT',
    status: 'NOT_RUN',
    reason: '',
    binary: exeRel,
    runner: `Node ${process.version}`,
    device: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()?.[0]?.model || 'unknown', totalMemoryBytes: os.totalmem() },
    config: { guestMiB: mib, guestPages, residentPagesCap: residentPages, residentMiB: residentPages / 256 },
    run: null,
  };
  const exeFile = abs(exeRel);
  if (!fs.existsSync(exeFile)) {
    report.reason = `Missing fixture ${exeRel} — build tests/gate3/nvme_stress.c (zig x86_64-windows-gnu, same pipeline as tests/game)`;
    finish(report, 2);
  }
  const exeBytes = fs.readFileSync(exeFile);
  report.binarySha256 = sha256(exeBytes);
  const mod = await loadBinding();

  const emu = new mod.BrowserX64Emulator(residentPages);
  for (const d of ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Users', 'C:\\Users\\PORTHOLE', 'C:\\Users\\PORTHOLE\\Temp', 'C:\\Game']) emu.vfs_mkdir(d);
  emu.vfs_insert('C:\\Game\\nvme_stress.exe', new Uint8Array(exeBytes));
  emu.load_pe(new Uint8Array(exeBytes));
  emu.set_exe_path?.('C:\\Game\\nvme_stress.exe');
  emu.set_command_line(`C:\\Game\\nvme_stress.exe ${mib}`);

  // ---- drive the trap-and-resume machine -------------------------------------------
  const started = Date.now();
  const deadline = started + timeoutMs;
  const faultLatMs = [];
  let pageFaults = 0;
  let evictionsDrained = 0;
  let slices = 0;
  let terminal = 'slice-budget';
  let residentPeak = 0;
  let swappedPeak = 0;
  const sampleTelemetry = () => {
    try {
      const t = JSON.parse(emu.telemetry_json());
      residentPeak = Math.max(residentPeak, t.residentPages || 0);
      swappedPeak = Math.max(swappedPeak, t.swappedPages || 0);
    } catch { /* telemetry is observational */ }
  };
  while (Date.now() <= deadline) {
    const status = emu.run_slice(2_000_000);
    slices++;
    // Persist evictions BEFORE handling a new fault: a victim chosen to make room for the
    // faulting page must already be durable in the store (same ordering as the browser).
    const drained = emu.drain_evicted_pages?.();
    if (drained && drained.length) {
      const view = new DataView(drained.buffer, drained.byteOffset, drained.byteLength);
      for (let off = 0; off + 8 + PAGE <= drained.length; off += 8 + PAGE) {
        store.writePage(view.getBigUint64(off, true), drained.subarray(off + 8, off + 8 + PAGE));
        evictionsDrained++;
      }
    }
    if (slices % 64 === 0) sampleTelemetry();
    if (status === 'next') continue;
    if (status.startsWith('page-fault:')) {
      pageFaults++;
      const base = BigInt(status.slice('page-fault:'.length));
      const t0 = performance.now();
      const bytes = store.readPage(base); // <-- host I/O happens while the CPU is suspended
      emu.supply_page(base, bytes);
      faultLatMs.push(performance.now() - t0);
      continue;
    }
    terminal = status;
    break;
  }
  if (Date.now() > deadline && terminal === 'slice-budget') terminal = 'timeout-still-running';
  sampleTelemetry();
  const wallMs = Date.now() - started;
  const instructions = Number(emu.instructions_executed());
  const guestConsole = emu.take_console();
  faultLatMs.sort((a, b) => a - b);

  // ---- independent host-side round-trip check --------------------------------------
  // Force everything out (minimum window), drain, then re-derive every expected word
  // from pat() and compare against the shard bytes for the guest buffer's VA range.
  let hostVerify = { checked: 0, bad: 0, note: 'skipped' };
  const bufMatch = /NVME_STRESS_OK/.test(guestConsole);
  // The guest buffer base is dynamic; recover it from the shards we observed: any page is
  // accepted iff its contents match SOME (page-index) pattern offset consistent with a
  // single base. Simpler + stricter: find candidate base = min page_base seen in shards
  // whose first word matches pat(0,0) at word 0. Implementation keeps a set during run:
  hostVerify = verifyShards();

  const telemetryEnd = JSON.parse(emu.telemetry_json() || '{}');
  report.run = {
    terminal,
    slices,
    instructions,
    wallMs,
    mips: wallMs > 0 ? Number((instructions / (wallMs / 1000) / 1e6).toFixed(2)) : null,
    pageFaults,
    evictionsDrained,
    pagesEvictedCounter: telemetryEnd.pagesEvicted ?? null,
    storeMiBWwritten: Number((store.bytesWritten / 1048576).toFixed(2)),
    storeMiBRead: Number((store.bytesRead / 1048576).toFixed(2)),
    faultLatencyMs: { p50: Number(pct(faultLatMs, 0.5).toFixed(3)), p99: Number(pct(faultLatMs, 0.99).toFixed(3)), max: Number((faultLatMs[faultLatMs.length - 1] || 0).toFixed(3)), samples: faultLatMs.length },
    residentPeakPages: residentPeak,
    residentCapPages: residentPages,
    swappedPeakPages: swappedPeak,
    guestOk: bufMatch,
    hostVerify,
    consoleTail: guestConsole.split('\n').slice(-20).join('\n'),
  };

  const minFaults = guestPages - residentPages;
  const checks = {
    guestExit0: terminal === 'exit:0',
    guestVerifyClean: bufMatch,
    faultsUnavoidable: pageFaults >= minFaults,
    storeSawWorkingSet: store.bytesWritten >= guestPages * PAGE * 0.9,
    residentBounded: residentPeak <= residentPages,
    hostByteIdentical: hostVerify.bad === 0 && hostVerify.checked === guestPages,
  };
  report.checks = checks;
  const pass = Object.values(checks).every(Boolean);
  report.status = pass ? 'PASS' : 'FAIL';
  if (!pass) report.reason = `checks=${JSON.stringify(checks)} pageFaults=${pageFaults} minExpected=${minFaults}`;
  finish(report, pass ? 0 : 1);

  function verifyShards() {
    // Flush: shrink to the 64-page minimum so any dirty tail queues for the store.
    // Coverage argument (checked, not assumed, via store.writtenPages below): phases 2+3
    // of the guest are read-only, so the shard copy taken when a page was evicted during
    // the phase-1 write stream (or any later eviction) is authoritative forever. Phase 2
    // streams the whole buffer again, so by guest exit every page has been evicted at
    // least once and therefore exists in the store.
    emu.set_max_resident_pages?.(64);
    const drained = emu.drain_evicted_pages?.();
    if (drained && drained.length) {
      const view = new DataView(drained.buffer, drained.byteOffset, drained.byteLength);
      for (let off = 0; off + 8 + PAGE <= drained.length; off += 8 + PAGE) {
        store.writePage(view.getBigUint64(off, true), drained.subarray(off + 8, off + 8 + PAGE));
      }
    }
    const m = /BUF_BASE=(0x[0-9a-fA-F]+)/.exec(guestConsole);
    if (!m) return { checked: 0, bad: 0, note: 'BUF_BASE not found in guest console' };
    const base0 = BigInt(m[1]);
    let checked = 0;
    let bad = 0;
    let missing = 0;
    for (let p = 0; p < guestPages; p++) {
      const base = base0 + BigInt(p) * BigInt(PAGE);
      if (!store.writtenPages.has(base)) { missing++; continue; }
      const bytes = store.readPage(base);
      const words = new BigUint64Array(bytes.buffer, bytes.byteOffset, PAGE / 8);
      for (let w = 0; w < words.length; w++) {
        if (words[w] !== pat(p, w)) bad++;
      }
      checked++;
    }
    return { checked, bad, missingFromStore: missing, bufBase: `0x${base0.toString(16)}` };
  }

  function finish(rep, code) {
    fs.mkdirSync(abs('artifacts'), { recursive: true });
    fs.writeFileSync(abs('artifacts/gate3-nvme-report.json'), `${JSON.stringify(rep, null, 2)}\n`);
    const r = rep.run || {};
    const lines = [
      `GATE 3 NVMe memory (DRAFT): ${rep.status}`,
      `guest_va_committed_mib=${rep.config.guestMiB} resident_cap_mib=${rep.config.residentMiB} resident_peak_pages=${r.residentPeakPages ?? 0} swapped_peak_pages=${r.swappedPeakPages ?? 0}`,
      `page_faults=${r.pageFaults ?? 0} evictions=${r.evictionsDrained ?? 0} store_written_mib=${r.storeMiBWwritten ?? 0} store_read_mib=${r.storeMiBRead ?? 0}`,
      `fault_latency_ms p50=${r.faultLatencyMs?.p50 ?? 0} p99=${r.faultLatencyMs?.p99 ?? 0} max=${r.faultLatencyMs?.max ?? 0} (Node fs on CI disk; browser/OPFS numbers come from Gate 4 device)`,
      `instructions=${r.instructions ?? 0} wall_ms=${r.wallMs ?? 0} mips=${r.mips ?? '-'} terminal=${r.terminal ?? 'n/a'}`,
      `checks=${JSON.stringify(rep.checks || {})}`,
      `reason=${rep.reason || 'none'}`,
    ];
    fs.writeFileSync(abs('artifacts/gate3-nvme-report.txt'), `${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
    process.exit(code);
  }
}

await main();
