// Integração DOM com o index.html real. jsdom não possui WebGL nem rasterizador
// nativo; portanto este teste exercita deliberadamente o fallback CPU próprio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { buildPE, sleep } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  if (!/Not implemented/.test(error.message)) console.error('[jsdom]', error);
});
const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'), {
  url: 'https://porthole.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
});
const { window } = dom;
const { document } = window;
window.TextEncoder = globalThis.TextEncoder;
window.TextDecoder = globalThis.TextDecoder;
window.Blob = globalThis.Blob;
window.Uint8Array = globalThis.Uint8Array;
window.Uint8ClampedArray = globalThis.Uint8ClampedArray;
window.Uint32Array = globalThis.Uint32Array;
window.DataView = globalThis.DataView;
window.ArrayBuffer = globalThis.ArrayBuffer;
Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0' });
Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
window.ResizeObserver = class { observe() {} disconnect() {} };

const contexts = new WeakMap();
window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type !== '2d') return null; // força o fallback, sem fingir WebGL no jsdom
  if (contexts.has(this)) return contexts.get(this);
  const canvas = this;
  const context = {
    canvas, presents: 0, drawCalls: 0, fillStyle: '', strokeStyle: '', lineWidth: 1,
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(image) { this.lastImage = image; this.presents += 1; },
    drawImage() { this.drawCalls += 1; }, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {},
  };
  contexts.set(this, context);
  return context;
};
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';

const html = readFileSync(join(root, 'index.html'), 'utf8');
const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), (match) => match[1])
  .filter((path) => !path.includes('html2canvas'));
for (const script of scripts) window.eval(readFileSync(join(root, script), 'utf8'));
await sleep(180);

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log('  ✓', name); };
const P = window.Porthole;

console.log('\n[DOM / index.html real]');
check('Detector e fallback são apresentados antes do boot gráfico', () => {
  assert.equal(document.getElementById('status-platform').textContent, 'Linux');
  assert.match(document.getElementById('map-directory').textContent, /fallback/);
  assert.equal(document.getElementById('dll-count').textContent, '0');
});
check('Iniciar carrega kernel32/user32/gdi32/d3d9 e escolhe CPU real', () => {
  document.getElementById('start-button').click();
  assert.equal(P.runtime.running, true);
  assert.equal(P.runtime.backend.getInfo().kind, 'software-cpu');
  assert.equal(P.runtime.linker.loadedModules().map((m) => m.name).join(','), 'd3d9.dll,gdi32.dll,kernel32.dll,user32.dll');
});
await sleep(650);
check('Loop apresenta frames, valida pixel e atualiza FPS da UI', () => {
  assert.ok(P.runtime.sessionFrames > 0);
  assert.equal(P.runtime.pipelineValidated, true);
  assert.ok(P.runtime.live.fps > 0);
  assert.match(document.getElementById('frame-origin').textContent, /INTEGRATED D3D9/);
});
check('Input DOM atravessa user32', () => {
  const canvas = document.getElementById('render-canvas');
  canvas.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
  assert.equal(P.runtime.user32.GetAsyncKeyState(65), 0x8000);
  canvas.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  assert.equal(P.runtime.user32.GetAsyncKeyState(65), 0);
});
check('CreateWindowEx cria uma div Win32 real', () => {
  const hwnd = P.runtime.user32.CreateWindowExA(0, 'STATIC', 'Janela de teste', 0, 4, 4, 200, 120);
  assert.ok(document.querySelector(`.win32-window[data-hwnd="${hwnd}"]`));
  P.runtime.user32.DestroyWindow(hwnd);
});
document.getElementById('start-button').click();
const pausedAt = P.runtime.sessionFrames;
await sleep(100);
assert.equal(P.runtime.sessionFrames, pausedAt); passed += 1; console.log('  ✓ nenhum frame novo após pausar');

console.log('\n[DOM / VFS + PE]');
await P.vfs.useFallbackFiles([{
  name: 'DOOM95.exe', webkitRelativePath: 'HostDrive/Games/Doom/DOOM95.exe', size: 4096,
  arrayBuffer: async () => buildPE(),
}]);
check('Pasta fallback atualiza o mapeamento C:\\ na UI', () => {
  assert.equal(P.vfs.isMapped, true);
  assert.match(document.getElementById('mapping-root').textContent, /HostDrive/);
  assert.equal(document.getElementById('load-pe').disabled, false);
});
const loaded = await P.runtime.loadExecutable('C:\\Games\\Doom\\DOOM95.exe');
check('PE real do VFS tem imports resolvidos e continua NÃO EXECUTADO', () => {
  assert.equal(loaded.imports.resolvedFunctions, 2);
  assert.equal(loaded.executed, false);
  assert.equal(loaded.status, 'inspected-not-executed');
  assert.equal(document.getElementById('pe-result').hidden, false);
  assert.match(document.getElementById('pe-execution').textContent, /NÃO EXECUTADO/);
  assert.equal(document.getElementById('doom95-status').textContent, 'INSPECTED');
});
const capture = await P.runtime.captureState(null);
assert.match(capture.framebuffer, /^data:image\/png/);
assert.equal(capture.ui, null);
assert.equal(capture.metadata.frameOrigin, 'integrated-d3d9-workload');
assert.equal(capture.metadata.pe.executed, false);
passed += 1; console.log('  ✓ metadados não atribuem frames integrados ao PE');

console.log('\n[DOM / PE x86 real via UI]');
window.WebAssembly = globalThis.WebAssembly;
window.MessageChannel = globalThis.MessageChannel;
window.fetch = async (url) => {
  if (String(url).endsWith('/hello.exe')) return { ok: true, arrayBuffer: async () => readFileSync(join(root, 'vendor/retrowin32/fixtures/hello.exe')) };
  throw new Error(`URL inesperada no teste: ${url}`);
};
P.runtime.guestBackend = new P.Retrowin32Backend({
  wasmBytes: readFileSync(join(root, 'vendor/retrowin32/retrowin32.wasm')),
  moduleURL: pathToFileURL(join(root, 'vendor/retrowin32/glue.mjs')).href,
});
document.getElementById('run-hello').click();
await sleep(700);
check('clique no fixture executa PE real e atualiza stdout/estado da UI', () => {
  assert.equal(P.runtime.loadedPE.name, 'hello.exe');
  assert.equal(P.runtime.loadedPE.executed, true);
  assert.equal(P.runtime.loadedPE.instructions, 57);
  assert.equal(P.runtime.loadedPE.status, 'exited');
  assert.equal(document.getElementById('guest-output').textContent, 'Hello, world!\n');
  assert.equal(document.getElementById('retro-status').textContent, 'PASS');
  assert.match(document.getElementById('pe-execution').textContent, /EXIT 0/);
});
const guestCapture = await P.runtime.captureState(null);
assert.equal(guestCapture.metadata.pe.backend, 'retrowin32-wasm-x86');
assert.equal(guestCapture.metadata.pe.executed, true);
passed += 1; console.log('  ✓ captura identifica backend e execução real sem confundir framebuffer de console');

P.runtime.stop();
await sleep(150);
dom.window.close();
console.log(`\ndom-integration: ${passed} verificações concluídas.`);
