#!/usr/bin/env node
/*
 * Real-game startup runner.
 *
 * Executes the PE32+ fixtures built by `scripts/build-game-fixtures.mjs` inside the **WebAssembly**
 * x86-64 emulator (the same module the browser loads), and reports, per fixture:
 *
 *   - the exact instruction count and exit code
 *   - every Win32/NT API the guest called, with counts
 *   - every COM method the guest called, with counts
 *   - the APIs/methods that are not implemented
 *   - the guest console, which for the D3D12 fixture names the exact stage that failed
 *
 * Status policy: a fixture may be *incomplete* (`STAGE_BLOCKED`: the guest asked for an API we do
 * not implement yet and exited cleanly at a named stage) but must never *crash* (`GUEST_FAULT`).
 * Only crashes, malformed exits and timeouts fail the job.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildGameFixtures } from '../../scripts/build-game-fixtures.mjs';

function parseArgs(argv) {
  const out = {
    report: 'artifacts/game-report.json',
    wasmDir: process.env.PORTHOLE_X64_WASM_DIR || 'vendor/porthole-x64-wasm',
    fixtures: 'tests/assets/game',
    summaryOut: 'artifacts/game-report.txt',
    build: false,
    only: null,
    slice: 2_000_000,
    maxSlices: 60,
    timeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--report') out.report = argv[++i];
    else if (a === '--wasm-dir') out.wasmDir = argv[++i];
    else if (a === '--fixtures') out.fixtures = argv[++i];
    else if (a === '--summary-out') out.summaryOut = argv[++i];
    else if (a === '--build') out.build = true;
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--slice') out.slice = Number(argv[++i]);
    else if (a === '--max-slices') out.maxSlices = Number(argv[++i]);
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function loadEmulator(wasmDir) {
  const gluePath = path.join(wasmDir, 'porthole_x64_wasm.js');
  const wasmPath = path.join(wasmDir, 'porthole_x64_wasm_bg.wasm');
  if (!fs.existsSync(gluePath) || !fs.existsSync(wasmPath)) {
    return { available: false, reason: `Wasm artifact missing in ${wasmDir}` };
  }
  const mod = await import(pathToFileURL(path.resolve(gluePath)).href);
  if (typeof mod.default === 'function') await mod.default(fs.readFileSync(wasmPath));
  if (typeof mod.BrowserX64Emulator !== 'function') {
    return { available: false, reason: 'Wasm binding does not export BrowserX64Emulator' };
  }
  return {
    available: true,
    module: mod,
    wasmSha256: crypto.createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex'),
  };
}

/** Parses the guest console for the fixture's own stage markers. */
function parseStage(consoleText) {
  const failed = /STAGE_FAIL n=(\d+) api=([^\s]+) hr=(0x[0-9a-f]+) last_error=(\d+)/i.exec(consoleText);
  if (failed) {
    return {
      failedStage: Number(failed[1]),
      failedApi: failed[2],
      hresult: failed[3],
      lastError: Number(failed[4]),
      lastStage: null,
    };
  }
  const stages = [...consoleText.matchAll(/STAGE (\d+): (.+)/g)];
  return {
    failedStage: null,
    failedApi: null,
    hresult: null,
    lastError: null,
    lastStage: stages.length ? { stage: Number(stages.at(-1)[1]), api: stages.at(-1)[2] } : null,
  };
}

async function runOne(binding, entry, options) {
  const started = Date.now();
  const item = {
    name: entry.name,
    path: entry.path,
    sha256: entry.sha256,
    description: entry.description,
    status: 'NOT_RUN',
    instructions: 0,
    exitCode: null,
    slices: 0,
    pageFaults: 0,
    durationMs: 0,
    error: null,
    finalRip: null,
    lastError: null,
    console: '',
    hle: [],
    com: [],
    unimplementedApis: [],
    unimplementedMethods: [],
    stage: null,
    expectation: entry.expect,
  };

  const bytes = fs.readFileSync(entry.path);
  const emu = new binding.module.BrowserX64Emulator(1024);
  delete emu.constructor;

  // Provision the virtual volume a game expects to find.
  emu.vfs_mkdir('C:\\Windows');
  emu.vfs_mkdir('C:\\Windows\\System32');
  emu.vfs_mkdir('C:\\Users');
  emu.vfs_mkdir('C:\\Users\\PORTHOLE');
  emu.vfs_mkdir('C:\\Game');
  emu.vfs_insert(`C:\\Game\\${entry.name}`, new Uint8Array(bytes));

  item.load = JSON.parse(emu.load_pe(new Uint8Array(bytes)));
  emu.set_command_line(`C:\\Game\\${entry.name}`);

  const pageCache = new Map();
  let done = null;
  let sliceCount = 0;
  const deadline = started + options.timeoutMs;

  while (sliceCount < options.maxSlices) {
    if (Date.now() > deadline) {
      item.status = 'TIMEOUT';
      item.error = `Timeout after ${options.timeoutMs} ms`;
      done = 'timeout';
      break;
    }
    const status = emu.run_slice(options.slice);
    sliceCount += 1;
    if (status === 'next') continue;
    if (status.startsWith('exit:')) {
      item.exitCode = Number(status.slice(5));
      done = 'exit';
      break;
    }
    if (status.startsWith('page-fault:')) {
      const pageBase = status.slice(11);
      item.pageFaults += 1;
      if (item.pageFaults > 2000) {
        // A guest that faults on the same page forever supplies zeroes forever: stop rather than
        // burn the whole slice budget and report a timeout with no information in it.
        item.status = 'GUEST_FAULT';
        item.error = `page thrash: >2000 supplied page faults (last 0x${pageBase.slice(2)})`;
        done = 'fault';
        break;
      }
      emu.supply_page(BigInt(pageBase), pageCache.get(pageBase) || new Uint8Array(4096));
      continue;
    }
    if (status.startsWith('fault:')) {
      item.status = 'GUEST_FAULT';
      item.error = status.slice(6);
      done = 'fault';
      break;
    }
    item.status = 'BACKEND_ERROR';
    item.error = `Unexpected status: ${status}`;
    done = 'unknown';
    break;
  }
  if (!done) item.status = 'TIMEOUT';
  if (done === 'timeout' || item.status === 'TIMEOUT') item.error = item.error || 'slice budget exhausted';

  item.slices = sliceCount;
  item.instructions = Number(emu.instructions_executed());
  item.console = emu.take_console();
  item.finalRip = `0x${emu.rip().toString(16)}`;
  item.lastError = emu.last_error();
  item.durationMs = Date.now() - started;
  // A frame is only "presented" if the renderer produced pixels: capture them and hash the
  // buffer so the report proves a frame, not just a successful Present() return value.
  // wasm-bindgen maps u64 to BigInt, and JSON.stringify refuses BigInt.
  item.framesPresented = emu.frames_presented ? Number(emu.frames_presented()) : 0;
  const frame = emu.take_frame ? emu.take_frame() : null;
  if (frame && frame.length) {
    item.frame = {
      width: emu.frame_width ? Number(emu.frame_width()) : 0,
      height: emu.frame_height ? Number(emu.frame_height()) : 0,
      bytes: frame.length,
      sha256: crypto.createHash('sha256').update(Buffer.from(frame)).digest('hex'),
      sample: Array.from(frame.slice(0, 16)),
      nonZeroBytes: frame.reduce((n, b) => (b ? n + 1 : n), 0),
    };
  }
  item.hle = emu.hle_histogram(40).split(' ').filter(Boolean);
  item.com = (emu.com_histogram ? emu.com_histogram(60) : '').split(' ').filter(Boolean);
  item.unimplementedApis = (emu.unimplemented_symbols() || '').split(' ').filter(Boolean);
  item.unimplementedMethods = (emu.unimplemented_methods ? emu.unimplemented_methods() : '')
    .split(' ').filter(Boolean);
  item.stage = parseStage(item.console);

  if (item.status === 'BACKEND_ERROR') return item;

  if (done === 'exit') {
    const marker = entry.expect?.marker;
    const markerSeen = !marker || item.console.includes(marker);
    if (item.exitCode === entry.expect?.exitCode && markerSeen) {
      item.status = 'PASS';
      item.error = null;
    } else if (item.stage.failedStage) {
      // The guest reached a named stage, learned the API is unsupported, and exited deliberately.
      item.status = 'STAGE_BLOCKED';
      item.error = `stage ${item.stage.failedStage} ${item.stage.failedApi} hr=${item.stage.hresult}`;
    } else if (item.exitCode !== entry.expect?.exitCode) {
      item.status = 'FAIL';
      item.error = `exit ${item.exitCode}, expected ${entry.expect?.exitCode}`;
    } else {
      item.status = 'FAIL';
      item.error = `completion marker "${marker}" missing from guest output`;
    }
  } else if (done === 'fault') {
    item.status = item.status === 'GUEST_FAULT' ? 'GUEST_FAULT' : 'FAIL';
  }
  return item;
}

const summaryLines = [];
function say(line = '') {
  summaryLines.push(line);
  console.log(line);
}

function printBlock(item) {
  say(`\n=== ${item.name} :: ${item.status}${item.error ? ` (${item.error})` : ''}`);
  say(`    instructions=${item.instructions} exit=${item.exitCode} slices=${item.slices} page_faults=${item.pageFaults}`);
  if (item.load) {
    say(`    imageBase=0x${item.load.imageBase.toString(16)} entryPoint=0x${item.load.entryPoint.toString(16)} imports=${item.load.imports}`);
  }
  if (item.frame) {
    say(
      `    frame: ${item.frame.width}x${item.frame.height} bytes=${item.frame.bytes} ` +
      `nonZero=${item.frame.nonZeroBytes} sha256=${item.frame.sha256.slice(0, 16)}… ` +
      `pixel0=[${item.frame.sample.slice(0, 4).join(',')}]`
    );
  }
  if (item.hle.length) say(`    win32: ${item.hle.slice(0, 22).join(' ')}`);
  if (item.com.length) say(`    com:   ${item.com.slice(0, 22).join(' ')}`);
  if (item.unimplementedApis.length) say(`    unimplemented win32: ${item.unimplementedApis.join(' ')}`);
  if (item.unimplementedMethods.length) say(`    unimplemented com:   ${item.unimplementedMethods.join(' ')}`);
  if (item.stage?.lastStage) say(`    last stage: ${item.stage.lastStage.stage} ${item.stage.lastStage.api}`);
  const all = item.console.split('\n').filter(Boolean);
  // Short consoles are printed whole; long ones are filtered down to the fixture's own markers.
  const lines = all.length <= 40
    ? all
    : all.filter((l) => /^(STAGE|DOOM_STARTUP|GAME_STARTUP|HELLO_WORLD|  )/.test(l));
  if (lines.length) say(lines.slice(-18).map((l) => `    | ${l}`).join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    version: 1,
    kind: 'porthole-x64-game-startup',
    generatedAt: new Date().toISOString(),
    wasmSha256: null,
    status: 'NOT_RUN',
    tests: [],
  };

  if (options.build || !fs.existsSync(path.join(options.fixtures, 'MANIFEST.json'))) {
    console.log('[game] Building PE32+ startup fixtures...');
    buildGameFixtures({ outDir: options.fixtures });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(options.fixtures, 'MANIFEST.json'), 'utf8'));
  const binding = await loadEmulator(options.wasmDir);
  if (!binding.available) {
    report.error = binding.reason;
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[game] NOT_RUN: ${binding.reason}`);
    process.exitCode = 2;
    return;
  }
  report.wasmSha256 = binding.wasmSha256;

  const selected = options.only
    ? manifest.binaries.filter((b) => b.name.includes(options.only))
    : manifest.binaries;

  for (const entry of selected) {
    process.stdout.write(`[game] ${entry.name} ... `);
    const item = await runOne(binding, entry, options);
    report.tests.push(item);
    console.log(`${item.status}${item.error ? ` (${item.error})` : ''} · ${item.instructions} instr`);
  }

  const by = (s) => report.tests.filter((t) => t.status === s).length;
  report.summary = {
    declared: report.tests.length,
    passed: by('PASS'),
    stageBlocked: by('STAGE_BLOCKED'),
    failed: by('FAIL'),
    faults: by('GUEST_FAULT'),
    timeouts: by('TIMEOUT'),
    notRun: by('NOT_RUN'),
  };
  // Crashes are always a defect. A named, deliberate stop at an unimplemented stage is the
  // current milestone state, not a regression.
  report.status = report.summary.faults || report.summary.failed || report.summary.timeouts
    ? 'FAIL'
    : 'PASS';

  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);

  for (const item of report.tests) printBlock(item);

  // GitHub Actions renders `::notice::` as a Checks annotation, which is how these numbers stay
  // quotable after the job log is gone.
  for (const item of report.tests) {
    const bits = [
      `${item.name}: ${item.status}`,
      `instructions=${item.instructions}`,
      `exit=${item.exitCode}`,
      `slices=${item.slices}`,
      `page_faults=${item.pageFaults}`,
    ];
    if (item.frame) bits.push(`frame=${item.frame.width}x${item.frame.height}/${item.frame.bytes}B/sha256:${item.frame.sha256.slice(0, 16)}`);
    if (item.stage?.failedStage) bits.push(`failed_stage=${item.stage.failedStage}:${item.stage.failedApi}:${item.stage.hresult}`);
    if (item.unimplementedMethods.length) bits.push(`missing_com=${item.unimplementedMethods.length}`);
    if (item.unimplementedApis.length) bits.push(`missing_api=${item.unimplementedApis.length}`);
    console.log(`::notice title=porthole-game-fixture::${bits.join(' ')}`);
  }

  say(
    `\n[game] ${report.status}: ${report.summary.passed}/${report.summary.declared} pass · ` +
    `${report.summary.stageBlocked} blocked at a named stage · ${report.summary.faults} faults · ` +
    `report ${options.report}`
  );
  if (options.summaryOut) {
    fs.mkdirSync(path.dirname(options.summaryOut), { recursive: true });
    fs.writeFileSync(
      options.summaryOut,
      `${report.status} ${JSON.stringify(report.summary)} wasm=${report.wasmSha256}\n${summaryLines.join('\n')}\n`
    );
  }
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}

export { runOne, loadEmulator, parseStage };
