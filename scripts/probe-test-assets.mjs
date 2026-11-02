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
// The PE32 backend creates a host window for every top-level HWND.  Probes run
// headless, so provide the same deterministic Canvas stub used by the DOM
// integration tests instead of failing before the guest entry point.
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;
function makeCanvasCtx(canvas) {
  const pixels = new Uint8ClampedArray(Math.max(1, canvas.width * canvas.height * 4));
  return {
    canvas, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
    fillRect() {}, clearRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, rect() {}, clip() {},
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, setTransform() {},
    fillText() {}, strokeText() {}, measureText: () => ({ width: 8 }), drawImage() {},
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: pixels.slice(0, w * h * 4) }),
    putImageData() {},
  };
}
dom.window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type !== '2d') return null;
  if (!this.__ctx) this.__ctx = makeCanvasCtx(this);
  return this.__ctx;
};
const manifest = JSON.parse(fs.readFileSync('tests/assets/MANIFEST.json'));
const report = { kind: 'acquired-pe-guest-probes', tests: [] };
const wasmBytes = fs.readFileSync(process.env.PORTHOLE_WASM || 'vendor/retrowin32/retrowin32.wasm');
for (const asset of manifest.assets.filter(a=>!process.env.PORTHOLE_PROBE_ONLY || a.path.endsWith('/'+process.env.PORTHOLE_PROBE_ONLY))) {
  const item = { path: asset.path, sha256: asset.sha256 };
  report.tests.push(item);
  try {
    item.logs = [];
    const backend = new globalThis.Porthole.Retrowin32Backend({ wasmBytes, ...(process.env.PORTHOLE_GLUE?{moduleURL:pathToFileURL(path.resolve(process.env.PORTHOLE_GLUE)).href}:{}), tracer: { log(scope, message, kind) { if (item.logs.length < 200) item.logs.push({ scope, kind, message: sanitizeEvidence(String(message)) }); } } });
    const basename = asset.path.split('/').at(-1);
    // Upstream retrowin32 sample PEs parse their own command line; give them the
    // same argv[0] the browser launcher would, plus the documented sample args.
    const commandLine = basename === 'errors.exe' ? 'errors.exe exit' : basename === 'trace.exe' ? 'trace.exe hello.exe' : basename;
    const proc = await backend.createProcess({ path: `C:\\Tests\\${basename}`, bytes: fs.readFileSync(asset.path), preload: false, commandLine });
    proc.start();
    let timer;
    const result = await Promise.race([proc.done, new Promise(resolve => { timer = setTimeout(async () => { try { await proc.stop('Probe timeout'); } finally { resolve({ status: 'timeout' }); } }, 3000); })]);
    clearTimeout(timer);
    const stdout = sanitizeEvidence(proc.output);
    // errors.exe is an upstream failure-mode sample: its documented `exit` mode
    // must return exactly 2 and print the expectation.  This is an exact result
    // check, not an expected-crash pass.
    const expectedExit = basename === 'errors.exe' ? 2 : 0;
    const expectedOutput = basename === 'errors.exe' ? 'expect: exit code 2' : null;
    const exact = result.status === 'exited' && result.exitCode === expectedExit && !result.flushError && (!expectedOutput || stdout.includes(expectedOutput));
    Object.assign(item, result, { path: asset.path, guestPath: result.path, stdout, expectedExitCode: expectedExit, status: exact ? 'PASS' : 'BACKEND_FAILURE' });
    if (!exact && result.status === 'exited') item.error = `Expected exit ${expectedExit}${expectedOutput ? ` and stdout ${JSON.stringify(expectedOutput)}` : ''}, got exit ${result.exitCode}`;
    if (asset.path.endsWith('/thread.exe') && item.status === 'PASS' && (!proc.output.includes('name=main tls=1 returning') || !proc.output.includes('name=i_am_thread tls=2 returning'))) {
      item.status = 'INCOMPLETE_THREAD_EXECUTION';
      item.error = 'Exit 0 prematuro: os dois loops de threads não concluíram.';
    }
  } catch (e) { item.status = 'BACKEND_FAILURE'; item.error = sanitizeEvidence(e.message); }
  console.log(`${item.path}: ${item.status} ${item.error || ''}`);
}
report.summary = { executed: report.tests.length, passed: report.tests.filter(t => t.status === 'PASS').length, failed: report.tests.filter(t => t.status !== 'PASS').length };
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync(process.env.PORTHOLE_PROBE_ONLY ? 'artifacts/doom95-candidate.json' : process.env.PORTHOLE_WASM ? 'artifacts/guest-probes-candidate.json' : 'artifacts/guest-probes.json', JSON.stringify(report, null, 2) + '\n');
if (!report.tests.length || report.summary.failed) process.exitCode = 1;
