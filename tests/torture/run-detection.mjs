#!/usr/bin/env node
/* Executes unmodified upstream al-khaser/pafish PE32+ binaries in the Wasm VMM.
 * BAD/traced findings are failures. A fault/timeout is incomplete, never a pass. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEmulator } from '../wine64/run-wine64.mjs';

function args(argv) {
  const o = { manifest: 'tests/assets/torture/MANIFEST.json', suite: null, wasmDir: process.env.PORTHOLE_X64_WASM_DIR || 'vendor/porthole-x64-wasm', report: 'artifacts/torture/detection-report.json', rawDir: 'artifacts/torture/detection', timeoutMs: 600000, slice: 250000, maxSlices: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--suite') o.suite = argv[++i];
    else if (k === '--manifest') o.manifest = argv[++i];
    else if (k === '--wasm-dir') o.wasmDir = argv[++i];
    else if (k === '--report') o.report = argv[++i];
    else if (k === '--raw-dir') o.rawDir = argv[++i];
    else if (k === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else throw Error(`Unknown argument ${k}`);
  }
  return o;
}
export function parseDetection(suite, consoleText) {
  const findings = [], checks = [];
  let pending = null;
  for (const line of consoleText.split(/\r?\n/)) {
    const warning = /^\[\*\] Warning: API (\S+) was expected to exist but was not found\./.exec(line);
    if (warning) findings.push({ kind: 'missing-api', api: warning[1], expected: 'export available', actual: 'not found', raw: line });
    const check = /^\[\*\] (.*?)(?:\s*\.\.\.)?(?:\s*\[\s*(?:BAD|GOOD)\s*\])?\s*$/.exec(line);
    if (check && !line.includes('Warning:')) pending = check[1].trim();
    const result = /\[\s*(BAD|GOOD)\s*\]/.exec(line);
    if (result && pending) {
      const item = { kind: 'check', name: pending, expected: 'GOOD', actual: result[1], raw: `${pending} [ ${result[1]} ]` };
      checks.push(item); if (item.actual === 'BAD') findings.push(item); pending = null;
    }
    const pafish = /^\[\*\] (.*?) \.\.\. (traced!|OK|BAD)(?:\s|$)/.exec(line);
    if (suite === 'pafish' && pafish) {
      const item = { kind: 'check', name: pafish[1], expected: 'OK', actual: pafish[2], raw: line };
      checks.push(item); if (/traced|BAD/.test(item.actual)) findings.push(item);
    }
  }
  return { checks, findings, completed: suite === 'al-khaser' ? consoleText.includes('Analysis done') : consoleText.includes('Pafish has finished analyzing') };
}

/** Pure report finalizer so serialization/scope regressions are unit-testable without a guest. */
export function finalizeDetectionReport(report) {
  const tests = Array.isArray(report.tests) ? report.tests : [];
  report.summary = {
    declared: tests.length,
    passed: tests.filter(t => t.status === 'PASS').length,
    failed: tests.filter(t => t.status === 'FAIL').length,
    faults: tests.filter(t => t.status === 'GUEST_FAULT').length,
    timeouts: tests.filter(t => t.status === 'TIMEOUT').length,
    backendErrors: tests.filter(t => t.status === 'BACKEND_ERROR').length,
    notRun: tests.filter(t => t.status === 'NOT_RUN').length,
  };
  report.status = tests.length && tests.every(t => t.status === 'PASS') ? 'PASS' : report.error ? 'NOT_RUN' : 'FAIL';
  // Full audit lives in raw JSONL. The JSON report keeps only the bounded per-test tail;
  // duplicating a root-level audit previously exceeded V8's maximum string length on Windows.
  delete report.apiAudit;
  return report;
}

async function main() {
  const o = args(process.argv.slice(2));
  const report = { version: 1, kind: 'porthole-vm-detection', generatedAt: new Date().toISOString(), status: 'NOT_RUN', tests: [] };
  const binding = await loadEmulator(o.wasmDir);
  if (!binding.available) { report.error = binding.reason; }
  else {
    report.wasmSha256 = binding.wasmSha256;
    const manifest = JSON.parse(fs.readFileSync(o.manifest, 'utf8'));
    const entries = manifest.binaries.filter(b => !o.suite || b.suite === o.suite);
    if (!entries.length) report.error = `No built fixtures for ${o.suite}`;
    for (const entry of entries) {
      const started = Date.now(), audit = [];
      const item = { name: entry.name, suite: entry.suite, sha256: entry.sha256, sourceRevision: entry.sourceRevision, argv: entry.args, status: 'NOT_RUN', findings: [], checks: [] };
      report.tests.push(item);
      try {
        if (entry.sha256 !== (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(entry.path)).digest('hex')) throw Error('Fixture hash mismatch');
        const emu = new binding.module.BrowserX64Emulator(4096);
        for (const dir of ['C:\\Game', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Users', 'C:\\Users\\PORTHOLE', 'C:\\Users\\PORTHOLE\\Temp']) emu.vfs_mkdir(dir);
        emu.vfs_insert(`C:\\Game\\${entry.name}`, new Uint8Array(fs.readFileSync(entry.path)));
        emu.set_exe_path(`C:\\Game\\${entry.name}`);
        emu.set_command_line([entry.name, ...entry.args].join(' '));
        for (const [k,v] of Object.entries(entry.env || {})) emu.set_environment_variable(k,v);
        if (entry.suite === 'pafish' && typeof emu.set_virtual_input_profile === 'function') emu.set_virtual_input_profile(true);
        emu.enable_api_audit(100000); emu.enable_trace(4096); emu.set_hle_trace_only(true);
        item.load = JSON.parse(emu.load_pe(new Uint8Array(fs.readFileSync(entry.path))));
        const pages = new Map(); let terminal = null;
        for (let n = 0; n < o.maxSlices && Date.now() - started < o.timeoutMs; n++) {
          const status = emu.run_slice(o.slice);
          const chunk = emu.take_api_audit(); if (chunk) audit.push(...chunk.split('\n').filter(Boolean).map(JSON.parse));
          const drained = emu.drain_evicted_pages();
          const view = new DataView(drained.buffer, drained.byteOffset, drained.byteLength);
          for (let off = 0; off + 4104 <= drained.length; off += 4104) pages.set(view.getBigUint64(off, true), drained.slice(off + 8, off + 4104));
          if (status === 'modal') {
            const request = JSON.parse(emu.modal_request());
            (item.modals ||= []).push({ request, response: 1, policy: 'headless-auto-IDOK' });
            emu.modal_respond(1); continue;
          }
          if (status === 'next') {
            // Virtual pointer profile: slow deterministic drift exercises GetCursorPos/movement
            // checks through the real input API, not by altering detection results.
            if (entry.suite === 'pafish' && typeof emu.inject_mouse_move === 'function') {
              emu.inject_mouse_move(640 + (n % 97), 360 + (Math.floor(n / 97) % 53));
            }
            continue;
          }
          if (status.startsWith('page-fault:')) {
            const base = Number(status.slice(11)); const saved = pages.get(base);
            emu.supply_page(BigInt(base), saved || new Uint8Array(4096)); continue;
          }
          terminal = status; break;
        }
        item.terminal = terminal; item.exitCode = terminal?.startsWith('exit:') ? Number(terminal.slice(5)) : null;
        item.console = emu.take_console(); item.instructions = Number(emu.instructions_executed()); item.durationMs = Date.now() - started;
        item.faultSnapshot = emu.fault_snapshot(); item.trace = emu.take_trace(); item.telemetry = JSON.parse(emu.telemetry_json());
        const guestLogBytes = emu.vfs_read(entry.suite === 'al-khaser' ? 'C:\\Game\\log.txt' : 'C:\\Game\\pafish.log');
        item.guestLog = guestLogBytes ? Buffer.from(guestLogBytes).toString('utf8') : '';
        Object.assign(item, parseDetection(entry.suite, `${item.console}\n${item.guestLog}`));
        item.apiAudit = audit.slice(-500); item.auditOverflow = audit.filter(e => e.kind === 'audit-overflow');
        item.findings.forEach(f => { f.apiCandidates = audit.filter(e => e.kind === 'api').slice(-20); f.correlation = 'last-call window; upstream check does not identify a causal API'; });
        item.status = !terminal ? 'TIMEOUT' : terminal.startsWith('fault:') ? 'GUEST_FAULT' : item.exitCode !== 0 || !item.completed ? 'FAIL' : item.findings.length || item.auditOverflow.length ? 'FAIL' : 'PASS';
        if (entry.suite === 'al-khaser') item.caveat = 'Upstream --sleep 1 requested; virtual clock advances on Sleep. Headless modal policy auto-answers IDOK; pafish receives a deterministic virtual pointer profile.';
        fs.mkdirSync(o.rawDir, { recursive: true });
        const stem = path.join(o.rawDir, entry.name);
        fs.writeFileSync(`${stem}.console.log`, item.console);
        fs.writeFileSync(`${stem}.api.jsonl`, audit.map(e => JSON.stringify(e)).join('\n') + '\n');
        fs.writeFileSync(`${stem}.trace.log`, `${item.faultSnapshot}\n${item.trace}\n`);
        if (guestLogBytes) fs.writeFileSync(`${stem}.guest.log`, guestLogBytes);
      } catch (e) { item.status = 'BACKEND_ERROR'; item.error = e.stack || String(e); }
      console.log(`[detection] ${item.name}: ${item.status} checks=${item.checks.length} findings=${item.findings.length} instructions=${item.instructions || 0}`);
    }
  }
  finalizeDetectionReport(report);
  fs.mkdirSync(path.dirname(o.report), { recursive: true });
  fs.writeFileSync(o.report, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'NOT_RUN' ? 2 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
