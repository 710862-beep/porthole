import assert from 'node:assert/strict';
import { loadScripts, makeFile } from './helpers.mjs';

const P = loadScripts('platform-detector', 'vfs', 'vfs-fs-access', 'vfs-fallback');
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log('  ✓', name); };

console.log('\n[platform-detector]');
check('ChromeOS tem precedência sobre token Linux', () => {
  const result = P.PlatformDetector.detect({
    userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
    platform: 'Linux x86_64', userAgentData: { platform: 'ChromeOS' },
  }, { isSecureContext: true, showDirectoryPicker() {}, document: {}, HTMLCanvasElement() {} });
  assert.equal(result.id, 'chromeos');
  assert.equal(result.capabilities.fileSystemAccess, true);
  assert.match(result.hostPath, /\/home\/chronos/);
});
check('Windows e Edge são identificados', () => {
  const result = P.PlatformDetector.detect({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Edg/120.0', platform: 'Win32', userAgentData: { platform: 'Windows' } }, {});
  assert.equal(result.id, 'windows'); assert.equal(result.browser, 'Edge');
  assert.equal(result.capabilities.fileSystemAccess, false);
});
check('Linux sem picker usa fallback por capacidade', () => {
  const result = P.PlatformDetector.detect({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0', platform: 'Linux x86_64' }, { isSecureContext: true, document: {} });
  assert.equal(result.id, 'linux'); assert.equal(result.browser, 'Firefox');
  assert.equal(result.capabilities.fileSystemAccess, false);
});
check('File System Access exige contexto seguro', () => {
  const result = P.PlatformDetector.detect({ userAgent: 'Windows NT 10.0', platform: 'Win32' }, { isSecureContext: false, showDirectoryPicker() {} });
  assert.equal(result.capabilities.fileSystemAccess, false);
});

console.log('\n[VFS path normalization]');
check('Barras, drive e case são normalizados', () => {
  const path = P.VFSUtils.normalizePath('c:/Games/Doom/./DOOM95.exe');
  assert.equal(path.win32, 'C:\\Games\\Doom\\DOOM95.exe');
  assert.equal(path.key, 'games/doom/doom95.exe');
});
check('.. interno funciona, escape da raiz é bloqueado', () => {
  assert.equal(P.VFSUtils.normalizePath('C:\\Games\\..\\Save\\x.ini').win32, 'C:\\Save\\x.ini');
  assert.throws(() => P.VFSUtils.normalizePath('C:\\..\\secret'), (e) => e.code === 'PATH_ESCAPE');
});
check('UNC e drives não mapeados são rejeitados', () => {
  assert.throws(() => P.VFSUtils.normalizePath('D:\\game.exe'), (e) => e.code === 'UNMAPPED_DRIVE');
  assert.throws(() => P.VFSUtils.normalizePath('\\\\server\\share\\game.exe'), (e) => e.code === 'UNSUPPORTED_PATH');
});

console.log('\n[VFS fallback]');
const fallback = new P.FallbackVFS({});
const facade = new P.VirtualFileSystem({ fallback });
await facade.useFallbackFiles([
  makeFile('HostDrive/Games/Doom/DOOM95.exe', 'real-pe-bytes'),
  makeFile('HostDrive/Games/Doom/DOOM1.WAD', 'wad'),
]);
const original = new TextDecoder().decode(await facade.readFile('c:\\games\\doom\\doom95.exe'));
assert.equal(original, 'real-pe-bytes'); checks += 1; console.log('  ✓ leitura case-insensitive preserva bytes do arquivo original');
const write = await facade.writeFile('C:\\Save\\config.ini', 'video=webgl');
assert.equal(write.persistent, false);
assert.equal(new TextDecoder().decode(await facade.readFile('c:\\save\\CONFIG.INI')), 'video=webgl');
assert.equal(await facade.exists('C:\\Save\\config.ini'), true);
checks += 1; console.log('  ✓ escrita fica em overlay de memória e pode ser relida');
const rootEntries = await facade.listDirectory('C:\\');
assert.deepEqual(rootEntries.map((x) => x.name).sort(), ['Games', 'Save']);
checks += 1; console.log('  ✓ listagem inclui diretórios originais e overlays');

console.log('\n[VFS File System Access API]');
class FakeFile {
  constructor(name, data = '') { this.name = name; this.kind = 'file'; this.data = new TextEncoder().encode(data); }
  async getFile() { const bytes = this.data; return { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; }
  async createWritable() {
    return { write: async (data) => { this.data = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data); }, close: async () => {}, abort: async () => {} };
  }
}
class FakeDirectory {
  constructor(name) { this.name = name; this.kind = 'directory'; this.children = new Map(); }
  async queryPermission() { return 'granted'; }
  async requestPermission() { return 'granted'; }
  _missing() { const error = new Error('not found'); error.name = 'NotFoundError'; return error; }
  async getDirectoryHandle(name, options = {}) {
    const exact = this.children.get(name);
    if (exact && exact.kind === 'directory') return exact;
    if (!options.create) throw this._missing();
    const created = new FakeDirectory(name); this.children.set(name, created); return created;
  }
  async getFileHandle(name, options = {}) {
    const exact = this.children.get(name);
    if (exact && exact.kind === 'file') return exact;
    if (!options.create) throw this._missing();
    const created = new FakeFile(name); this.children.set(name, created); return created;
  }
  async *entries() { for (const entry of this.children) yield entry; }
}
const root = new FakeDirectory('HostDrive');
const games = new FakeDirectory('Games'), doom = new FakeDirectory('Doom');
root.children.set('Games', games); games.children.set('Doom', doom);
doom.children.set('DOOM95.EXE', new FakeFile('DOOM95.EXE', 'native-pe'));
const native = new P.FileSystemAccessVFS({ picker: async () => root });
await native.mapDirectory();
assert.equal(new TextDecoder().decode(await native.readFile('C:\\games\\doom\\doom95.exe')), 'native-pe');
checks += 1; console.log('  ✓ handle real simulado resolve nomes sem diferenciar caixa');
const persisted = await native.writeFile('C:\\Save\\config.ini', new TextEncoder().encode('renderer=cpu'));
assert.equal(persisted.persistent, true);
assert.equal(new TextDecoder().decode(await native.readFile('C:\\save\\CONFIG.INI')), 'renderer=cpu');
assert.equal(root.children.get('Save').children.get('config.ini').kind, 'file');
checks += 1; console.log('  ✓ createWritable persiste e cria diretórios sob C:\\');
const nativeStat = await native.stat('C:\\games\\doom\\DOOM95.EXE');
const directoryStat = await native.stat('C:\\Games');
assert.equal(nativeStat.kind, 'file');
assert.equal(nativeStat.size, 9);
assert.equal(nativeStat.fileAttributes, 0x80);
assert.equal(directoryStat.fileAttributes, 0x10);
checks += 1; console.log('  ✓ stat consulta metadata de arquivo/diretório no handle do host');

console.log(`\nplatform-vfs: ${checks} verificações concluídas.`);
