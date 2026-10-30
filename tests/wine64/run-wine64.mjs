#!/usr/bin/env node
/*
 * Real 64-bit Wine conformance runner.
 *
 * Executes unmodified upstream Wine test binaries (`PE32+`, machine 0x8664, built by
 * `scripts/build-wine64-tests.mjs`) **inside the pure-browser x86-64 emulator** compiled to
 * WebAssembly, under Node. This is the acceptance gate for the x86-64 work.
 *
 * Status values are deliberately explicit; nothing is reported as PASS unless the guest exited
 * with code 0 *and* the winetest summary line reports zero failures.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildWine64Suite } from '../../scripts/build-wine64-tests.mjs';

function parseArgs(argv) {
  const out = {
    report: 'artifacts/wine64-report.json',
    wasmDir: process.env.PORTHOLE_X64_WASM_DIR || 'vendor/porthole-x64-wasm',
    fixtures: 'tests/assets/wine64',
    build: false,
    only: null,
    slice: 2_000_000,
    maxSlices: 400,
    timeoutMs: 240_000,
    auditDir: 'artifacts/torture/wine64',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--report') out.report = argv[++i];
    else if (a === '--wasm-dir') out.wasmDir = argv[++i];
    else if (a === '--fixtures') out.fixtures = argv[++i];
    else if (a === '--build') out.build = true;
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--slice') out.slice = Number(argv[++i]);
    else if (a === '--max-slices') out.maxSlices = Number(argv[++i]);
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--audit-dir') out.auditDir = argv[++i];
    else throw new Error(`Argumento desconhecido: ${a}`);
  }
  return out;
}

const WINE_SUMMARY = /(\d+) tests executed \((\d+) marked as todo, (\d+) as flaky, (\d+) failures?\), (\d+) skipped\./;
const UNHANDLED = /unhandled exception ([0-9a-f]+)/i;

async function loadEmulator(wasmDir) {
  const gluePath = path.join(wasmDir, 'porthole_x64_wasm.js');
  const wasmPath = path.join(wasmDir, 'porthole_x64_wasm_bg.wasm');
  if (!fs.existsSync(gluePath) || !fs.existsSync(wasmPath)) {
    return { available: false, reason: `Artefato Wasm ausente em ${wasmDir}` };
  }
  const mod = await import(pathToFileURL(path.resolve(gluePath)).href);
  if (typeof mod.default === 'function') {
    await mod.default(fs.readFileSync(wasmPath));
  }
  if (typeof mod.BrowserX64Emulator !== 'function') {
    return { available: false, reason: 'Binding Wasm não exporta BrowserX64Emulator' };
  }
  return { available: true, module: mod, wasmSha256: crypto.createHash('sha256').update(fs.readFileSync(wasmPath)).digest('hex') };
}

async function runOne(binding, manifestEntry, options, testName = null) {
  const started = Date.now();
  const item = {
    name: testName ? `${manifestEntry.name} ${testName}` : manifestEntry.name,
    subtest: testName,
    sha256: manifestEntry.sha256,
    subtests: manifestEntry.subtests,
    origin: manifestEntry.origin,
    status: 'NOT_RUN',
    durationMs: 0,
    instructions: 0,
    exitCode: null,
    slices: 0,
    pageFaults: 0,
    console: '',
    failures: null,
    testsExecuted: null,
    skipped: null,
    error: null,
  };

  const bytes = fs.readFileSync(manifestEntry.path);
  const emu = new binding.module.BrowserX64Emulator(1024);
  delete emu.constructor;

  // Provision the guest `C:\` tree: the test binary itself plus the temp dir the tests use.
  emu.vfs_mkdir('C:\\Windows');
  emu.vfs_mkdir('C:\\Windows\\System32');
  emu.vfs_mkdir('C:\\Users');
  emu.vfs_mkdir('C:\\Users\\PORTHOLE');
  emu.vfs_mkdir('C:\\Users\\PORTHOLE\\Temp');
  emu.vfs_insert(`C:\\WineTests\\${manifestEntry.name}`, new Uint8Array(bytes));

  for (const [k, v] of Object.entries({ WINETEST_DEBUG: '1', WINETEST_COLOR: '0', WINETEST_MUTE_THRESHOLD: '0', WINETEST_REPORT_FLAKY: '1', WINETEST_INTERACTIVE: '0' })) emu.set_environment_variable(k, v);
  emu.enable_api_audit(100000);
  emu.enable_trace(4096);
  emu.set_hle_trace_only(true);
  const audit = [];
  const loadInfo = JSON.parse(emu.load_pe(new Uint8Array(bytes)));
  item.load = loadInfo;
  // winetest binaries take the subtest name as argv[1]; without it they print usage and exit(1).
  if (testName) emu.set_command_line(`${manifestEntry.name} ${testName}`);

  const pageCache = new Map();
  let sliceCount = 0;
  let done = null;
  const deadline = started + options.timeoutMs;

  while (sliceCount < options.maxSlices) {
    if (Date.now() > deadline) {
      item.status = 'TIMEOUT';
      item.error = `Timeout após ${options.timeoutMs} ms`;
      done = 'timeout';
      break;
    }
    const status = emu.run_slice(options.slice);
    const chunk = emu.take_api_audit();
    if (chunk) audit.push(...chunk.split('\n').filter(Boolean).map(l => JSON.parse(l)));
    sliceCount += 1;
    const drained = emu.drain_evicted_pages();
    const view = new DataView(drained.buffer, drained.byteOffset, drained.byteLength);
    for (let off = 0; off + 4104 <= drained.length; off += 4104) pageCache.set(view.getBigUint64(off, true), drained.slice(off + 8, off + 4104));
    if (status === 'next') continue;
    if (status.startsWith('exit:')) {
      item.exitCode = Number(status.slice(5));
      done = 'exit';
      break;
    }
    if (status.startsWith('page-fault:')) {
      const pageBase = Number(status.slice(11));
      item.pageFaults += 1;
      if (pageCache.has(pageBase)) {
        emu.supply_page(BigInt(pageBase), pageCache.get(pageBase));
      } else {
        emu.supply_page(BigInt(pageBase), new Uint8Array(4096));
      }
      continue;
    }
    if (status.startsWith('fault:')) {
      item.status = 'GUEST_FAULT';
      item.error = status.slice(6);
      done = 'fault';
      break;
    }
    item.status = 'BACKEND_ERROR';
    item.error = `Status inesperado: ${status}`;
    done = 'unknown';
    break;
  }

  if (!done) {
    item.status = 'TIMEOUT';
    item.error = `Orçamento de slices esgotado (${sliceCount} × ${options.slice} instruções)`;
  }

  item.slices = sliceCount;
  item.instructions = Number(emu.instructions_executed());
  item.console = emu.take_console();
  item.durationMs = Date.now() - started;
  item.finalRip = `0x${emu.rip().toString(16)}`;
  item.lastError = emu.last_error();
  item.telemetry = JSON.parse(emu.telemetry_json());
  item.faultSnapshot = emu.fault_snapshot();
  item.trace = emu.take_trace();
  item.apiAudit = audit;
  item.assertions = audit.filter(e => e.debugString?.startsWith('PORTHOLE_ASSERT ')).map(e => {
    const assertion = JSON.parse(e.debugString.slice('PORTHOLE_ASSERT '.length));
    const preceding = audit.filter(x => x.kind === 'api' && x.seq < e.seq && !x.api.endsWith('!OutputDebugStringA')).slice(-12);
    return { ...assertion, instruction: e.instruction, apiCandidates: preceding,
      correlation: 'preceding-call-window; not a proof of causality' };
  });
  item.auditOverflow = audit.filter(e => e.kind === 'audit-overflow');
  if (options.auditDir) {
    fs.mkdirSync(options.auditDir, { recursive: true });
    const stem = path.join(options.auditDir, item.name.replace(/[^a-z0-9_.-]/gi, '_'));
    fs.writeFileSync(`${stem}.console.log`, item.console);
    fs.writeFileSync(`${stem}.api.jsonl`, audit.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(`${stem}.trace.log`, `${item.faultSnapshot}\n${item.trace}\n`);
  }

  const summary = WINE_SUMMARY.exec(item.console);
  if (summary) {
    item.testsExecuted = Number(summary[1]);
    item.failures = Number(summary[4]);
    item.skipped = Number(summary[5]);
  }
  const unhandled = UNHANDLED.exec(item.console);

  if (done === 'exit') {
    if (unhandled) {
      item.status = 'FAIL';
      item.error = `unhandled exception ${unhandled[1]}`;
    } else if (!summary) {
      item.status = 'FAIL';
      item.error = 'Nenhuma linha de resumo do winetest no stdout do convidado.';
    } else if (item.testsExecuted === 0) {
      item.status = 'FAIL';
      item.error = 'Zero Wine assertions executed.';
    } else if (item.failures !== 0 || item.exitCode !== 0 || item.auditOverflow.length) {
      item.status = 'FAIL';
      item.error = `${item.failures} falhas, exit ${item.exitCode}`;
    } else {
      item.status = 'PASS';
    }
  }

  return item;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    version: 1,
    kind: 'porthole-x64-wine64-conformance',
    generatedAt: new Date().toISOString(),
    wineCommit: fs.existsSync('docs/wine-commit.txt') ? fs.readFileSync('docs/wine-commit.txt', 'utf8').trim() : null,
    wasmSha256: null,
    status: 'NOT_RUN',
    tests: [],
  };

  if (options.build || !fs.existsSync(path.join(options.fixtures, 'MANIFEST.json'))) {
    console.log('[wine64] Compilando binários PE32+ a partir do código-fonte Wine fixado...');
    buildWine64Suite({ outDir: options.fixtures });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(options.fixtures, 'MANIFEST.json'), 'utf8'));

  const binding = await loadEmulator(options.wasmDir);
  if (!binding.available) {
    report.status = 'NOT_RUN';
    report.error = binding.reason;
    for (const entry of manifest.binaries) {
      report.tests.push({ name: entry.name, status: 'NOT_RUN', error: binding.reason });
    }
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[wine64] NOT_RUN: ${binding.reason}`);
    process.exitCode = 2;
    return;
  }
  report.wasmSha256 = binding.wasmSha256;

  const selected = options.only
    ? manifest.binaries.filter((b) => options.only.split(',').some((n) => b.name.includes(n)))
    : manifest.binaries;

  const worklist = [];
  for (const entry of selected) {
    const names = Array.isArray(entry.subtests) && entry.subtests.length ? entry.subtests : [null];
    for (const st of names) worklist.push([entry, st]);
  }

  for (const [entry, testName] of worklist) {
    process.stdout.write(`[wine64] ${entry.name}${testName ? ` ${testName}` : ''} ... `);
    const item = await runOne(binding, entry, options, testName);
    report.tests.push(item);
    console.log(`${item.status}${item.error ? ` (${item.error})` : ''} · ${item.instructions} instr · ${item.durationMs} ms` + (item.failures != null ? ` · ${item.failures} falhas` : ''));
    if (item.status === 'FAIL') {
      const lines = item.console.split('\n').filter((l) => l.includes('Test failed') || l.includes('failure') || l.includes(': Test ')).slice(0, 25);
      if (lines.length) console.log(lines.map((l) => `           ${l}`).join('\n'));
    } else if (item.status !== 'PASS' && item.console) {
      console.log(item.console.split('\n').slice(-8).map((l) => `           ${l}`).join('\n'));
    }
  }

  const passed = report.tests.filter((t) => t.status === 'PASS').length;
  report.summary = {
    declared: report.tests.length,
    passed,
    failed: report.tests.filter((t) => t.status === 'FAIL').length,
    notRun: report.tests.filter((t) => t.status === 'NOT_RUN').length,
    faults: report.tests.filter((t) => t.status === 'GUEST_FAULT').length,
    timeouts: report.tests.filter((t) => t.status === 'TIMEOUT').length,
  };
  report.status = report.tests.length > 0 && passed === report.tests.length ? 'PASS'
    : report.tests.some((t) => t.status === 'NOT_RUN') ? 'NOT_RUN' : 'FAIL';

  fs.mkdirSync(path.dirname(options.report), { recursive: true });
  fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="porthole-x64-wine64" tests="${report.tests.length}" failures="${report.tests.length - passed}">\n${report.tests
    .map((t) => `  <testcase name="${t.name}" time="${((t.durationMs || 0) / 1000).toFixed(3)}">${t.status === 'PASS' ? '' : `<failure message="${t.status}">${(t.error || '').replace(/[<>&]/g, '')}</failure>`}</testcase>`)
    .join('\n')}\n</testsuite>\n`;
  fs.writeFileSync(`${options.report}.xml`, xml);

  console.log(`[wine64] ${report.status}: ${passed}/${report.tests.length} PASS · relatório ${options.report}`);
  process.exitCode = report.status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}

export { runOne, loadEmulator };
