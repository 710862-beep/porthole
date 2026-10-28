import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScripts, makeFile } from './helpers.mjs';

const require = createRequire(import.meta.url);
const P = loadScripts('porthole-linker', 'vfs', 'vfs-fallback');
require('../../vfs-persist.js');
require('../../shims/registry.js');
require('../../spoof-hardware.js');
loadScripts('shim-kernel32', 'shim-user32');
require('../../input-raw.js');

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log('  ✓', name); };
const text = (bytes) => new TextDecoder().decode(bytes);

class ControlledVFS {
  constructor() { this.files = new Map(); this.isMapped = true; this.failNext = false; this.delay = 0; this.writes = []; }
  getInfo() { return { mapped: true, persistent: true, kind: 'controlled-host' }; }
  key(path) { return P.VFSUtils.normalizePath(path).key; }
  async readFile(path) {
    const value = this.files.get(this.key(path));
    if (!value) { const error = new Error('not found'); error.code = 'NOT_FOUND'; throw error; }
    return value.slice().buffer;
  }
  async writeFile(path, data) {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
    const label = text(bytes);
    if (this.failNext) { this.failNext = false; throw new Error('host write failed'); }
    if (label === 'first') await new Promise((resolve) => setTimeout(resolve, 25));
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    this.files.set(this.key(path), bytes);
    this.writes.push({ path, bytes });
    return { path, bytes: bytes.byteLength, persistent: true };
  }
  async exists(path) { return this.files.has(this.key(path)); }
  async listDirectory() { return []; }
}

console.log('\n[VFS maduro / paths e persistência]');
check('prefixo estendido aceita long path sem mudar a chave canônica', () => {
  const long = `C:\\${'a'.repeat(190)}\\${'b'.repeat(90)}\\save.bin`;
  const extended = P.VFSUtils.normalizePath(`\\\\?\\${long}`);
  assert.ok(extended.win32.length > 260);
  assert.equal(extended.extended, true);
  assert.equal(extended.key, P.VFSUtils.normalizePath(long).key);
});
check('UNC estendido, outro drive e escape continuam bloqueados', () => {
  assert.throws(() => P.VFSUtils.normalizePath('\\\\?\\UNC\\server\\share\\x'), (e) => e.code === 'UNSUPPORTED_PATH');
  assert.throws(() => P.VFSUtils.normalizePath('\\\\?\\D:\\x'), (e) => e.code === 'UNMAPPED_DRIVE');
  assert.throws(() => P.VFSUtils.normalizePath('\\\\?\\C:\\..\\escape'), (e) => e.code === 'PATH_ESCAPE');
});

const gatedHost = new ControlledVFS();
const gated = new P.VFSPersistence({ vfs: gatedHost });
gatedHost.delay = 20;
const pendingWrite = gated.writeFile('C:\\Save\\state.json', 'new-state');
assert.equal(text(await gated.readFile('C:\\Save\\state.json')), 'new-state');
assert.equal(gatedHost.files.has('save/state.json'), false);
assert.equal(gated.getInfo().pendingWrites, 1);
await pendingWrite;
assert.equal(text(await gatedHost.readFile('C:\\Save\\state.json')), 'new-state');
assert.equal(gated.overlays.size, 0, 'overlay persistente pode ser liberado após confirmação do host');
checks += 1; console.log('  ✓ overlay é imediato e Promise confirma a escrita no host');

const orderedHost = new ControlledVFS();
const ordered = new P.VFSPersistence({ vfs: orderedHost });
const first = ordered.writeFile('C:\\Save\\order.txt', 'first');
const second = ordered.writeFile('c:\\save\\ORDER.TXT', 'second');
await Promise.all([first, second]);
assert.equal(text(await orderedHost.readFile('C:\\Save\\order.txt')), 'second');
assert.deepEqual(orderedHost.writes.map((entry) => text(entry.bytes)), ['first', 'second']);
await ordered.flush();
checks += 1; console.log('  ✓ escritas concorrentes no mesmo arquivo preservam ordem de invocação');

const failingHost = new ControlledVFS();
const failing = new P.VFSPersistence({ vfs: failingHost });
failingHost.failNext = true;
await assert.rejects(failing.writeFile('C:\\Save\\durable.txt', 'dirty'), /host write failed/);
assert.equal(text(await failing.readFile('C:\\Save\\durable.txt')), 'dirty');
await assert.rejects(failing.flush(), (e) => e.code === 'PERSISTENCE_FAILED');
await failing.writeFile('C:\\Save\\durable.txt', 'recovered');
await failing.flush();
assert.equal(text(await failingHost.readFile('C:\\Save\\durable.txt')), 'recovered');
checks += 1; console.log('  ✓ overlay dirty não é confundido com durabilidade e erro pode ser recuperado');

const linkedFallback = new P.FallbackVFS({});
const linkedBase = new P.VirtualFileSystem({ fallback: linkedFallback });
await linkedBase.useFallbackFiles([makeFile('Host/Target/file.txt', 'one')]);
const linked = new P.VFSPersistence({ vfs: linkedBase });
await linked.createSymlink('C:\\Link', 'C:\\Target');
assert.equal(text(await linked.readFile('C:\\Link\\file.txt')), 'one');
await linked.writeFile('C:\\Link\\file.txt', 'two');
assert.equal(text(await linked.readFile('C:\\Target\\file.txt')), 'two');
await linked.createSymlink('C:\\Target\\Alias.txt', 'file.txt');
assert.equal(text(await linked.readFile('C:\\Target\\Alias.txt')), 'two');
assert.equal((await linkedBase.listDirectory('C:\\')).find((entry) => entry.name === 'Link').kind, 'symlink');
assert.throws(() => linkedBase.createSymlink('C:\\Escape', '..\\..\\outside'), (e) => e.code === 'PATH_ESCAPE');
checks += 1; console.log('  ✓ links virtuais relativos/absolutos compartilham destino e não escapam da raiz');

await linked.createSymlink('C:\\CycleA', 'C:\\CycleB');
await linked.createSymlink('C:\\CycleB', 'C:\\CycleA');
await assert.rejects(linked.readFile('C:\\CycleA'), (e) => e.code === 'ELOOP');
checks += 1; console.log('  ✓ ciclo de links retorna ELOOP em vez de recursão infinita');

const attributes = new P.Kernel32Shim({ vfs: linked, tracer: new P.ApiTracer() });
const fileInfo = await attributes.GetFileAttributesExW('C:\\Link\\file.txt', 0);
assert.equal(fileInfo.fileAttributes, 0x80);
assert.equal(fileInfo.fileSize, 3);
assert.equal(fileInfo.resolvedPath, 'C:\\Target\\file.txt');
assert.equal(typeof fileInfo.lastWriteTime, 'bigint');
assert.equal(await attributes.GetFileAttributesW('C:\\Target'), 0x10);
assert.equal(await attributes.GetFileAttributesW('C:\\Target\\missing.bin'), 0xffffffff);
assert.equal(attributes.GetLastError(), 2);
checks += 1; console.log('  ✓ GetFileAttributesExW/W usam stat real e ERROR_FILE_NOT_FOUND');

console.log('\n[advapi32 / hives persistentes]');
const registryHost = new ControlledVFS();
const registryVFS = new P.VFSPersistence({ vfs: registryHost });
const advapi = new P.Registry.Advapi32Shim({ vfs: registryVFS });
const created = await advapi.RegCreateKeyExW(0x80000001, 'Software\\PortholeTest\\App');
assert.equal(created.status, 0);
assert.equal(created.disposition, 1);
assert.equal(await advapi.RegSetValueExW(created.handle, 'Session', P.Registry.TYPE.SZ, 'unit-test-not-a-real-token'), 0);
assert.equal(await advapi.RegSetValueExW(created.handle, 'Enabled', P.Registry.TYPE.DWORD, 1), 0);
assert.equal(await advapi.RegSetValueExW(created.handle, 'Blob', P.Registry.TYPE.BINARY, new Uint8Array([0, 1, 254, 255])), 0);
assert.equal(await advapi.RegSetValueExW(created.handle, 'Large', P.Registry.TYPE.QWORD, 0x123456789n), 0);
assert.equal(await advapi.RegSetValueExW(created.handle, 'Names', P.Registry.TYPE.MULTI_SZ, ['alpha', 'beta']), 0);
assert.equal(await advapi.RegFlushKey(created.handle), 0);
assert.ok(registryHost.files.has('porthole/registry/hives.json'));
checks += 1; console.log('  ✓ RegCreate/Set/Flush grava snapshot JSON versionado no VFS');

const reloaded = new P.Registry.Advapi32Shim({ vfs: registryVFS });
const reopened = await reloaded.RegOpenKeyExW('HKEY_CURRENT_USER', 'software\\portholetest\\app');
assert.equal(reopened.status, 0);
assert.deepEqual(await reloaded.RegQueryValueExW(reopened.handle, 'Enabled'), { status: 0, type: 4, data: 1, size: 4 });
assert.deepEqual(Array.from((await reloaded.RegQueryValueExW(reopened.handle, 'Blob')).data), [0, 1, 254, 255]);
assert.equal((await reloaded.RegQueryValueExW(reopened.handle, 'Large')).data, 0x123456789n);
assert.deepEqual((await reloaded.RegQueryValueExW(reopened.handle, 'Names')).data, ['alpha', 'beta']);
checks += 1; console.log('  ✓ nova instância recarrega valores SZ/DWORD/BINARY/QWORD/MULTI_SZ');

const software = await reloaded.RegOpenKeyExW(0x80000001, 'Software');
assert.deepEqual(await reloaded.RegEnumKeyExW(software.handle, 0), { status: 0, name: 'PortholeTest' });
assert.equal(await reloaded.RegDeleteKeyW(0x80000001, 'Software'), P.Registry.ERROR.ACCESS_DENIED);
assert.equal(reloaded.RegCloseKey(reopened.handle), 0);
assert.equal((await reloaded.RegQueryValueExW(reopened.handle, 'Enabled')).status, P.Registry.ERROR.INVALID_HANDLE);
checks += 1; console.log('  ✓ enumeração, proteção de chave não vazia e ciclo de vida de HANDLE');

console.log('\n[Raw Input / Pointer Lock mocks, não browser físico]');
class FakeDocument extends EventTarget {
  constructor() { super(); this.pointerLockElement = null; }
  exitPointerLock() { this.pointerLockElement = null; this.dispatchEvent(new Event('pointerlockchange')); }
}
class FakeElement extends EventTarget {
  constructor(document) { super(); this.ownerDocument = document; this.width = 200; this.height = 100; this.requests = 0; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 100 }; }
  requestPointerLock() { this.requests += 1; return Promise.resolve(); }
  focus() {}
  setPointerCapture() {}
}
const document = new FakeDocument();
const element = new FakeElement(document);
const user = new P.User32Shim({ document, tracer: new P.ApiTracer() });
user.attachInput(element);
assert.equal(user.RegisterRawInputDevices([{ usagePage: 1, usage: 2, flags: 0, hwnd: 77 }, { usagePage: 1, usage: 6, flags: 0 }]), true);
const capture = user.SetCapture(77);
assert.equal(element.requests, 1);
document.pointerLockElement = element;
document.dispatchEvent(new Event('pointerlockchange'));
assert.equal(await capture, 77);
assert.equal(user.rawInput.locked, true);
user.queue.length = 0;
function mouse(dx, dy) {
  const event = new Event('pointermove');
  Object.defineProperties(event, { movementX: { value: dx }, movementY: { value: dy }, buttons: { value: 0 }, clientX: { value: 0 }, clientY: { value: 0 } });
  element.dispatchEvent(event);
}
mouse(5, -2); mouse(-3, 7);
const rawMessages = user.queue.filter((message) => message.message === P.Win32.WM.INPUT);
assert.equal(rawMessages.length, 2);
const deltas = rawMessages.map((message) => user.GetRawInputData(message.lParam).data);
assert.deepEqual(deltas.map(({ dx, dy }) => [dx, dy]), [[5, -2], [-3, 7]]);
assert.deepEqual(deltas.reduce((sum, item) => [sum[0] + item.dx, sum[1] + item.dy], [0, 0]), [2, 5]);
assert.ok(deltas.every((item) => user.GetRawInputData(item.handle).header.type === 0));
checks += 1; console.log('  ✓ WM_INPUT recebe deltas relativos (+2,+5) durante lock confirmado');

const key = new Event('keydown', { cancelable: true });
Object.defineProperties(key, { key: { value: 'w' }, repeat: { value: false } });
element.dispatchEvent(key);
assert.ok(user.queue.some((message) => message.message === P.Win32.WM.KEYDOWN && message.wParam === 87));
const rawKeyMessage = user.queue.filter((message) => message.message === P.Win32.WM.INPUT).at(-1);
const rawKey = user.GetRawInputData(rawKeyMessage.lParam);
assert.equal(rawKey.header.type, 1);
assert.equal(rawKey.data.virtualKey, 87);
assert.equal(rawKey.data.flags, 0);
checks += 1; console.log('  ✓ KeyboardEvent gera WM_KEYDOWN e pacote WM_INPUT de teclado');

user.queue.length = 0;
assert.equal(user.ReleaseCapture(), true);
assert.equal(user.rawInput.locked, false);
mouse(100, 100);
assert.equal(user.queue.filter((message) => message.message === P.Win32.WM.INPUT).length, 0);
assert.equal(user.ClipCursor({ left: 10, top: 20, right: 30, bottom: 40 }), true);
assert.deepEqual(user.GetClipCursor(), { left: 10, top: 20, right: 30, bottom: 40 });
assert.equal(user.ClipCursor(null), true);
checks += 1; console.log('  ✓ perda de lock interrompe WM_INPUT e ClipCursor tem ciclo explícito');

user.ClipCursor({ left: 25, top: 25, right: 75, bottom: 75 });
const absolute = (x, y) => {
  const event = new Event('pointermove');
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, movementX: { value: 0 }, movementY: { value: 0 } });
  element.dispatchEvent(event);
};
absolute(100, 90);
assert.deepEqual(user.GetCursorPos(), { x: 75, y: 75 });
absolute(0, 0);
assert.deepEqual(user.GetCursorPos(), { x: 25, y: 25 });
user.ClipCursor(null);
absolute(100, 90);
assert.deepEqual(user.GetCursorPos(), { x: 100, y: 90 });
checks += 1; console.log('  ✓ ClipCursor limita o cursor virtual/mensagens ao RECT no canvas');

const deniedElement = new FakeElement(document);
deniedElement.requestPointerLock = () => Promise.reject(new Error('denied'));
user.attachInput(deniedElement);
assert.equal(await user.SetCapture(88), 0);
assert.equal(user.rawInput.locked, false);
checks += 1; console.log('  ✓ negação de Pointer Lock retorna falha sem captura fictícia');
user.dispose();

console.log('\n[Identidade virtual e clocks]');
check('HardwareIdentity informa virtualização em vez de fingerprint físico', () => {
  const identity = new P.HardwareIdentity({ processors: 4, renderer: { label: 'CPU llvmpipe-style', api: 'Canvas2D' } });
  assert.equal(identity.getProfile().virtual, true);
  assert.equal(identity.queryWMI('Win32_ComputerSystem').Manufacturer, 'Porthole');
  assert.equal(identity.queryWMI('Win32_VideoController').Virtual, true);
  assert.throws(() => identity.queryWMI('Win32_Unknown'), (e) => e.code === 'NOT_IMPLEMENTED');
});
check('QPC/QPF e GetTickCount compartilham fonte monotônica coerente', () => {
  const values = [10.25, 9.5, 11.5];
  const clock = new P.MonotonicClock({ now: () => values.shift() });
  assert.equal(clock.queryPerformanceFrequency(), 1000000n);
  assert.equal(clock.queryPerformanceCounter(), 10250n);
  assert.equal(clock.getTickCount(), 10);
  assert.equal(clock.getTickCount(), 11);
});

console.log(`\nmaturity: ${checks} verificações concluídas.`);
