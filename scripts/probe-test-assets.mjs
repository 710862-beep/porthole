/** Real guest probes, not Wine conformance and never an expected-crash pass. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { sanitizeEvidence } from '../ci/autofix.mjs';
const require = createRequire(import.meta.url);
require('../js/vfs.js');
require('../js/porthole-linker.js');
require('../js/retrowin32-backend.js');
const manifest = JSON.parse(fs.readFileSync('tests/assets/MANIFEST.json'));
const report = { kind: 'acquired-pe-guest-probes', tests: [] };
const wasmBytes = fs.readFileSync(process.env.PORTHOLE_WASM || 'vendor/retrowin32/retrowin32.wasm');
for (const asset of manifest.assets) {
  const item = { path: asset.path, sha256: asset.sha256 };
  report.tests.push(item);
  try {
    item.logs = [];
    const backend = new globalThis.Porthole.Retrowin32Backend({ wasmBytes, ...(process.env.PORTHOLE_GLUE?{moduleURL:pathToFileURL(path.resolve(process.env.PORTHOLE_GLUE)).href}:{}), tracer: { log(scope, message, kind) { if (item.logs.length < 200) item.logs.push({ scope, kind, message: sanitizeEvidence(String(message)) }); } } });
    const proc = await backend.createProcess({ path: `C:\\Tests\\${asset.path.split('/').at(-1)}`, bytes: fs.readFileSync(asset.path), preload: false });
    proc.start();
    let timer;
    const result = await Promise.race([proc.done, new Promise(resolve => { timer = setTimeout(async () => { try { await proc.stop('Probe timeout'); } finally { resolve({ status: 'timeout' }); } }, 3000); })]);
    clearTimeout(timer);
    Object.assign(item, result, { path: asset.path, guestPath: result.path, stdout: sanitizeEvidence(proc.output), status: result.status === 'exited' && result.exitCode === 0 && !result.flushError ? 'PASS' : 'BACKEND_FAILURE' });
    if (asset.path.endsWith('/thread.exe') && item.status === 'PASS' && (!proc.output.includes('name=main tls=1 returning') || !proc.output.includes('name=i_am_thread tls=2 returning'))) {
      item.status = 'INCOMPLETE_THREAD_EXECUTION';
      item.error = 'Exit 0 prematuro: os dois loops de threads não concluíram.';
    }
  } catch (e) { item.status = 'BACKEND_FAILURE'; item.error = sanitizeEvidence(e.message); }
  console.log(`${item.path}: ${item.status} ${item.error || ''}`);
}
report.summary = { executed: report.tests.length, passed: report.tests.filter(t => t.status === 'PASS').length, failed: report.tests.filter(t => t.status !== 'PASS').length };
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync(process.env.PORTHOLE_WASM ? 'artifacts/guest-probes-candidate.json' : 'artifacts/guest-probes.json', JSON.stringify(report, null, 2) + '\n');
if (!report.tests.length || report.summary.failed) process.exitCode = 1;
