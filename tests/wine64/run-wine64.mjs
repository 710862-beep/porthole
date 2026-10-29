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

async function runOne(binding, manifestEntry, options) {
  const started = Date.now();
  const item = {
    name: manifestEntry.name,
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

  const loadInfo = JSON.parse(emu.load_pe(new Uint8Array(bytes)));
  item.load = loadInfo;

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
    sliceCount += 1;
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
    } else if (item.failures !== 0 || item.exitCode !== 0) {
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
    ? manifest.binaries.filter((b) => b.name.includes(options.only))
    : manifest.binaries;

  for (const entry of selected) {
    process.stdout.write(`[wine64] ${entry.name} ... `);
    const item = await runOne(binding, entry, options);
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
