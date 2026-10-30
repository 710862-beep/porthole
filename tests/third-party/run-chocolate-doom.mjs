#!/usr/bin/env node
/*
 * GATE 1 Tier B / GATE 2 runner: run the pinned, UNMODIFIED official Chocolate Doom 3.1.1
 * Windows x64 build with the Freedoom 0.13.0 IWAD inside the wasm-bindgen emulator.
 *
 * Fail-closed criteria, separating the claims:
 *   EXECUTION — the guest's own timedemo completes. Upstream Chocolate Doom reports timedemo
 *     results from G_CheckDemoStatus() via I_Error(), which exits with code -1 on every
 *     platform (that is the success path, not a crash). So success = exit:0, OR exit:-1 with
 *     the guest-printed line "timed N gametics in M realtics" (N > 0) in the guest console.
 *   RENDERING — frames the GUEST presented through SDL (presented_frames > 0, copied from
 *     guest texture memory at SDL_RenderPresent) whose FNV-1a checksum is recorded at first,
 *     mid-run and final frame, with at least 2 distinct checksums (the framebuffer visibly
 *     evolves under demo input; a static or host-filled buffer cannot satisfy this).
 * What PASS does NOT assert: checksum equality against a reference render of the same binary
 * on real Wine/Windows (Gate 2 reference comparison, still owed), interactive GAMEPLAY
 * (this is recorded-demo playback), or anything about Chrome/Chromebook (Gate 4).
 * Sampled guest frames are dumped as PPM artifacts for human inspection.
 *
 * Workload knobs (recorded in the report; the binary is never modified):
 *   PORTHOLE_DOOM_ARGS      guest argv tail, default "-iwad C:\Game\DOOM2.WAD -timedemo demo1 -nosound"
 *   PORTHOLE_DOOM_RESIDENT  VMM resident-page budget, default 65536 pages (256 MiB)
 *   PORTHOLE_DOOM_TIMEOUT_S wall-clock budget, default 1200 (measured full run: ~450 s)
 *
 * --title-probe mode (Gate 2 Wine reference): run WITHOUT -timedemo until the guest has
 * presented PORTHOLE_TITLE_PRESENTS frames (default 30 — the static Freedoom TITLEPIC is up),
 * then dump the guest's NATIVE-resolution frame (measurement tap on the 320x200 streaming
 * texture, before host scaling) as PPM + FNV-1a64. The same binary under real Wine produces
 * its own 320x200 screenshot (PCX) of the same title screen; scripts/compare-title-frame.mjs
 * compares the two byte-for-byte. Deterministic because TITLEPIC + PLAYPAL come from the same
 * pinned IWAD and the title page is static for seconds on both systems.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { X64JitHost } from '../../js/x64-jit-host.js';

const wasmDir = process.env.PORTHOLE_X64_WASM_DIR || 'vendor/porthole-x64-wasm';
const exeRel = 'tests/assets/third-party/chocolate-doom.exe';
const wadRel = 'tests/assets/third-party/freedoom2.wad';
const titleProbe = process.argv.includes('--title-probe');
const titlePresents = Math.max(1, Number(process.env.PORTHOLE_TITLE_PRESENTS || 30) || 30);
const guestArgs = process.env.PORTHOLE_DOOM_ARGS
  ?? (titleProbe ? '-iwad C:\\Game\\DOOM2.WAD -nosound' : '-iwad C:\\Game\\DOOM2.WAD -timedemo demo1 -nosound');
const residentPages = Math.max(64, Number(process.env.PORTHOLE_DOOM_RESIDENT || 65536) || 65536);
const timeoutMs = Math.max(10, Number(process.env.PORTHOLE_DOOM_TIMEOUT_S || 1200) || 1200) * 1000;
const limits = { slice: 2_000_000, maxSlices: 100000 };
const jitEnabled = process.env.PORTHOLE_JIT !== '0';
const maxInstructions = Math.max(0, Number(process.env.PORTHOLE_DOOM_MAX_INSTRUCTIONS || 0) || 0);

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Exact JS replica of the emulator's frame_checksum: FNV-1a/64 over w(LE u32)|h(LE u32)|RGBA8. */
function fnv1a64Frame(w, h, rgba) {
  let hash = 0xcbf29ce484222325n;
  const mix = (b) => { hash ^= BigInt(b); hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn; };
  const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  for (const b of le32(w)) mix(b);
  for (const b of le32(h)) mix(b);
  for (const b of rgba) mix(b);
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

/** Write an RGBA8 frame as a binary PPM (P6) artifact (alpha dropped) for human inspection. */
function writePPM(file, w, h, rgba) {
  const header = Buffer.from(`P6\n${w} ${h}\n255\n`, 'ascii');
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    rgb[j] = rgba[i * 4]; rgb[j + 1] = rgba[i * 4 + 1]; rgb[j + 2] = rgba[i * 4 + 2];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, rgb]));
}
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
    `claim_scope=EXECUTION (guest timedemo) + RENDERING (guest-presented frames); NOT a Wine-reference checksum match, NOT interactive gameplay`,
    `presented_frames=${run.presentedFrames ?? 0} framebuffer_checksum=${run.frameChecksum || 'none'} frame_size=${run.frameWidth || 0}x${run.frameHeight || 0}`,
    `timedemo_gametics=${run.gametics ?? 0} realtics=${run.realtics ?? 0} distinct_frame_checksums=${run.distinctFrameChecksums ?? 0} checksum_cross_check=${run.checksumCrossCheck ?? false}`,
    `frame_first=${run.firstFrame ? `${run.firstFrame.checksum} @presented=${run.firstFrame.presentedAtCapture} ${run.firstFrame.file}` : 'none'}`,
    `frame_mid=${run.midFrame ? `${run.midFrame.checksum} @presented=${run.midFrame.presentedAtCapture} ${run.midFrame.file}` : 'none'}`,
    `frame_final=${run.finalFrame ? `${run.finalFrame.checksum} @presented=${run.finalFrame.presentedAtCapture} ${run.finalFrame.file}` : 'none'}`,
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
  const jit = new X64JitHost(emu, mod, { enabled: jitEnabled });
  report.jit = { enabled: jitEnabled, maxInstructions: maxInstructions || null };
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

  // Gate 2 frame evidence: watch guest presents as they happen, fingerprint every distinct
  // framebuffer state, and snapshot first / mid-run / final frames as PPM artifacts.
  const frameSamples = { distinct: new Set(), first: null, mid: null, final: null, lastPresented: 0 };
  const grabFrame = (label) => {
    const rgba = emu.guest_frame_rgba?.();
    const w = Number(emu.guest_frame_width?.() || 0);
    const h = Number(emu.guest_frame_height?.() || 0);
    if (!rgba || !rgba.length || !w || !h) return null;
    const bytes = new Uint8Array(rgba);
    const file = `artifacts/chocolate-doom-frame-${label}.ppm`;
    writePPM(abs(file), w, h, bytes);
    return { checksum: fnv1a64Frame(w, h, bytes), w, h, file, presentedAtCapture: Number(emu.presented_frames?.() || 0) };
  };
  const sampleFrames = () => {
    const presented = Number(emu.presented_frames?.() || 0);
    if (presented === 0 || presented === frameSamples.lastPresented) return;
    frameSamples.lastPresented = presented;
    const cs = emu.frame_checksum?.() || '';
    if (cs) frameSamples.distinct.add(cs);
    if (!frameSamples.first) frameSamples.first = grabFrame('first');
    if (!frameSamples.mid && presented >= 1500) frameSamples.mid = grabFrame('mid');
  };

  const started = Date.now();
  const deadline = started + timeoutMs;
  const pageStore = new Map();
  let slices = 0;
  let pageFaults = 0;
  let terminal = 'slice-budget';
  while (slices < limits.maxSlices && Date.now() <= deadline) {
    const status = await jit.runSlice(limits.slice);
    slices += 1;
    const drained = emu.drain_evicted_pages?.();
    if (drained && drained.length) {
      const view = new DataView(drained.buffer, drained.byteOffset, drained.byteLength);
      for (let off = 0; off + 8 + 4096 <= drained.length; off += 8 + 4096) {
        pageStore.set(view.getBigUint64(off, true), drained.slice(off + 8, off + 8 + 4096));
      }
    }
    sampleFrames();
    if (maxInstructions && Number(emu.instructions_executed()) >= maxInstructions) { terminal = 'instruction-budget-reached'; break; }
    if (titleProbe && Number(emu.presented_frames?.() || 0) >= titlePresents) {
      terminal = 'title-probe-target-reached';
      break;
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
  report.jit.stats = jit.stats;
  const instructions = Number(emu.instructions_executed());
  const trace = emu.take_trace?.() || '';
  sampleFrames();
  frameSamples.final = grabFrame('final');
  const emuChecksum = emu.frame_checksum?.() || '';
  // JS-side FNV of the grabbed final frame must equal the emulator's own checksum of the same
  // last-presented frame; a mismatch means the capture path and the fingerprint disagree.
  const checksumCrossCheck = frameSamples.final
    ? frameSamples.final.checksum === emuChecksum
    : false;
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
    frameChecksum: emuChecksum,
    frameWidth: Number(emu.guest_frame_width?.() || 0),
    frameHeight: Number(emu.guest_frame_height?.() || 0),
    distinctFrameChecksums: frameSamples.distinct.size,
    firstFrame: frameSamples.first,
    midFrame: frameSamples.mid,
    finalFrame: frameSamples.final,
    checksumCrossCheck,
  };

  if (titleProbe) {
    // Gate 2 Wine-reference tap: dump the guest's native-resolution title frame (see header).
    const nRGBA = emu.guest_native_frame_rgba?.();
    const nw = Number(emu.guest_native_frame_width?.() || 0);
    const nh = Number(emu.guest_native_frame_height?.() || 0);
    const nFrames = Number(emu.guest_native_frames?.() || 0);
    const emuNative = emu.native_frame_checksum?.() || '';
    let nativeInfo = null;
    if (nRGBA && nRGBA.length && nw && nh) {
      const bytes = new Uint8Array(nRGBA);
      const file = 'artifacts/chocolate-doom-title-native.ppm';
      writePPM(abs(file), nw, nh, bytes);
      const set = new Set();
      for (let i = 0; i + 2 < bytes.length; i += 4) {
        set.add((bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]);
      }
      nativeInfo = {
        checksumJs: fnv1a64Frame(nw, nh, bytes),
        checksumEmu: emuNative,
        crossCheck: fnv1a64Frame(nw, nh, bytes) === emuNative,
        w: nw,
        h: nh,
        file,
        nativeFrames: nFrames,
        distinctColours: set.size,
      };
    }
    report.run.nativeFrame = nativeInfo;
    // TITLEPIC is a full-colour 320x200 patch: demand exact native dims, checksum agreement
    // between the JS replica and the emulator, and a non-trivial colour count (a cleared or
    // black tap has 1). Reaching the present target proves the guest booted to the title loop.
    const okNative = !!nativeInfo && nativeInfo.crossCheck && nw === 320 && nh === 200
      && nativeInfo.distinctColours > 16 && terminal === 'title-probe-target-reached';
    report.status = okNative ? 'PASS' : 'FAIL';
    report.reason = okNative ? '' : `title probe: terminal=${terminal} native=${JSON.stringify(nativeInfo)}`;
    fs.mkdirSync(abs('artifacts'), { recursive: true });
    fs.writeFileSync(abs('artifacts/chocolate-doom-title-probe.json'), `${JSON.stringify({
      mode: 'title-probe',
      binarySha256: report.binarySha256,
      iwadSha256: report.iwadSha256,
      wasmSha256: report.wasmSha256,
      nativeFrame: nativeInfo,
      presentedFrames: report.run.presentedFrames,
      instructions,
      terminal,
    }, null, 2)}\n`);
    console.log(`TITLE_PROBE status=${report.status} checksum=${nativeInfo?.checksumJs || 'none'} size=${nw}x${nh} colours=${nativeInfo?.distinctColours ?? 0} presented=${report.run.presentedFrames} native_frames=${nFrames} instructions=${instructions} terminal=${terminal}`);
    writeReport(report);
    process.exit(okNative ? 0 : 1);
  }

  // EXECUTION: upstream reports timedemo completion through I_Error -> exit(-1). Accept that
  // ONLY together with the guest-printed timing line; exit:0 is accepted unconditionally.
  const timed = /timed (\d+) gametics in (\d+) realtics/.exec(report.run.console || '');
  const gametics = timed ? Number(timed[1]) : 0;
  const realtics = timed ? Number(timed[2]) : 0;
  report.run.gametics = gametics;
  report.run.realtics = realtics;
  const timedemoDone = gametics > 0;
  const okExit = terminal === 'exit:0' || (terminal === 'exit:4294967295' && timedemoDone);
  // RENDERING: guest presents happened, the framebuffer genuinely evolves under demo input
  // (>=100 distinct checksums sampled across the run, and first/mid/final frames pairwise
  // different — a stale, cleared or otherwise static buffer has exactly 1-2), and the
  // host-side fingerprint of the captured frame agrees with the emulator's own checksum.
  // (History: an earlier build passed a >=2 check with a constant clear-colour buffer because
  // SDL_RenderCopy moved no pixels; these thresholds exist so that class of fake frame can
  // never pass again. A real 2,664-tic demo yields distinct checksums in the high hundreds.)
  const fcs = [frameSamples.first, frameSamples.mid, frameSamples.final]
    .filter(Boolean).map((f) => f.checksum);
  const sampledPairwiseDistinct = fcs.length === 3 && new Set(fcs).size === 3;
  const framesOk = report.run.presentedFrames > 0
    && !!report.run.frameChecksum
    && report.run.distinctFrameChecksums >= 100
    && sampledPairwiseDistinct
    && checksumCrossCheck;
  if (okExit && framesOk) {
    report.status = 'PASS';
  } else {
    report.status = 'FAIL';
    const blockers = report.run.unimplemented ? report.run.unimplemented.split(/\s+/).filter(Boolean).slice(0, 24).join(' ') : '';
    const why = [];
    if (!okExit) why.push(`terminal=${terminal} (timedemoDone=${timedemoDone}, gametics=${gametics})`);
    if (!framesOk) why.push(`presented=${report.run.presentedFrames} distinctChecksums=${report.run.distinctFrameChecksums} sampledPairwiseDistinct=${sampledPairwiseDistinct} crossCheck=${checksumCrossCheck}`);
    report.reason = `${why.join('; ')}${blockers ? `; first named blockers: ${blockers}` : ''}`;
  }
  writeReport(report);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

await main();
