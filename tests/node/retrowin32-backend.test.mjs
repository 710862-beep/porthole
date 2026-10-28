import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScripts, makeCanvas, makeFile, sleep } from './helpers.mjs';

const P = loadScripts('vfs', 'vfs-fallback', 'porthole-linker', 'pe-loader', 'retrowin32-backend');
const wasm = fs.readFileSync('vendor/retrowin32/retrowin32.wasm');
const fixture = (name) => fs.readFileSync(`vendor/retrowin32/fixtures/${name}`);
const withTimeout = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout aguardando processo retrowin32.')), 8000);
    timer.unref();
  }),
]);
let checks = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  checks += 1;
  console.log('  ✓', name);
};

console.log('\n[retrowin32 / PE32 x86 real]');
const backend = new P.Retrowin32Backend({ wasmBytes: wasm });
const hello = await backend.createProcess({ path: 'C:\\Tests\\hello.exe', bytes: fixture('hello.exe'), preload: false });
check('load_exe não executa instruções antes de start()', hello.getStats().started === false && hello.getStats().instructions === 0);
hello.start();
const helloResult = await withTimeout(hello.done);
check('hello.exe imprime Hello, world! e termina com exit 0', helloResult.status === 'exited' && helloResult.exitCode === 0 && helloResult.stdout === 'Hello, world!\n');
check('hello.exe tem contagem de instruções medida pelo núcleo', helloResult.instructions === 57);

const callback = await backend.createProcess({ path: 'C:\\Tests\\callback.exe', bytes: fixture('callback.exe'), preload: false });
callback.start();
const callbackResult = await withTimeout(callback.done);
check('callback.exe atravessa callback stdcall e retorna ao fluxo', callbackResult.status === 'exited' && callbackResult.exitCode === 0 && callbackResult.stdout === 'callback0 invoked: 1234\nretrowin32_callback1 returned: 1\n');
check('callback.exe executa 477 instruções no artefato pinned', callbackResult.instructions === 477);

const helloAgain = await backend.createProcess({ path: 'C:\\Tests\\hello.exe', bytes: fixture('hello.exe'), preload: false });
helloAgain.start();
const againResult = await withTimeout(helloAgain.done);
check('uma nova instância Wasm não herda logger/host do processo anterior', againResult.status === 'exited' && againResult.stdout === 'Hello, world!\n' && againResult.instructions === 57);

const lockedBackend = new P.Retrowin32Backend({ wasmBytes: wasm });
const firstPending = lockedBackend.createProcess({ path: 'C:\\Tests\\hello.exe', bytes: fixture('hello.exe'), preload: false });
const secondPending = lockedBackend.createProcess({ path: 'C:\\Tests\\hello.exe', bytes: fixture('hello.exe'), preload: false });
await assert.rejects(secondPending, /um convidado por vez/);
const first = await firstPending;
first.start();
const firstResult = await withTimeout(first.done);
check('criações concorrentes são serializadas sem corromper o primeiro processo', firstResult.status === 'exited' && firstResult.stdout === 'Hello, world!\n');

const borrowed = { borrowed: false, unblock() {}, run() { this.borrowed = true; throw new Error('falha simulada de API'); }, free() { if (this.borrowed) throw new Error('borrow ainda ativo'); } };
Object.defineProperty(borrowed, 'instr_count', { get() { if (this.borrowed) throw new Error('getter durante borrow'); return 0; } });
const failure = new P.Retrowin32Process(backend, { path: 'C:\\Tests\\failure.exe', bytes: fixture('hello.exe'), preload: false });
failure.emu = borrowed;
failure.status = 'loaded';
failure.start();
const failureResult = await withTimeout(failure.done);
check('exceção Rust não causa getter/free secundário nem esconde o erro', failureResult.status === 'error' && failureResult.error === 'falha simulada de API' && failureResult.instructionCounterValid === false && failureResult.runBatches === 1);

console.log('\n[retrowin32 / VFS síncrono sobre VFS assíncrono]');
const fallback = new P.FallbackVFS({ logger() {} });
const vfs = new P.VirtualFileSystem({ fallback });
await vfs.useFallbackFiles([
  makeFile('HostDrive/Tests/hello.exe', fixture('hello.exe')),
  makeFile('HostDrive/Tests/data.bin', new Uint8Array([1, 2, 3, 4])),
]);
const fileProcess = await backend.createProcess({
  path: 'C:\\Tests\\hello.exe', bytes: await vfs.readFile('C:\\Tests\\hello.exe'), vfs, preload: true,
});
check('a árvore do executável é pré-carregada antes de run()', fileProcess.preloadReport.files === 2 && fileProcess.preloadReport.complete);
const createOptions = { read: false, write: true, truncate: false, create: true, create_new: false };
check('open do convidado rejeita UNC, outro drive e escape da raiz', fileProcess.open('D:\\outside.bin', createOptions) === null && fileProcess.open('\\\\server\\share\\x.bin', createOptions) === null && fileProcess.open('..\\..\\outside.bin', createOptions) === null);
const file = fileProcess.open('data.bin', { read: true, write: true, truncate: false, create: false, create_new: false });
const read = new Uint8Array(4);
check('open relativo usa o diretório do PE e lê bytes reais', file.read(read) === 4 && Array.from(read).join(',') === '1,2,3,4');
file.seek(1);
file.write(new Uint8Array([9, 8]));
await fileProcess.flushWrites();
const persisted = new Uint8Array(await vfs.readFile('C:\\Tests\\data.bin'));
check('WriteFile atualiza overlay e flush preserva os bytes no VFS', Array.from(persisted).join(',') === '1,9,8,4');
await fileProcess.stop('teste de I/O concluído');

console.log('\n[retrowin32 / integração PortholeRuntime]');
const R = loadScripts(
  'platform-detector', 'shim-kernel32', 'shim-user32', 'shim-gdi32', 'graphics-webgl',
  'graphics-fallback', 'graphics-device', 'hlsl-translator', 'shim-d3d9', 'shim-d3d11', 'runtime',
);
const runtimeBackend = new R.Retrowin32Backend({ wasmBytes: wasm });
const runtime = new R.PortholeRuntime({
  canvas: makeCanvas(), guestCanvas: makeCanvas(), forceSoftware: true,
  platform: { label: 'Linux' }, guestBackend: runtimeBackend,
});
const runtimeProcess = await runtime.executeBytes('C:\\Tests\\hello.exe', fixture('hello.exe'), { source: 'test', preload: false });
const runtimeResult = await withTimeout(runtimeProcess.done);
check('PortholeRuntime marca EXECUTADO somente após instruções reais', runtimeResult.status === 'exited' && runtime.loadedPE.executed === true && runtime.loadedPE.instructions === 57 && runtime.loadedPE.backend === 'retrowin32-wasm-x86');
const capture = await runtime.captureState(null);
check('captura de console não atribui framebuffer ao PE', capture.metadata.pe.executed === true && capture.metadata.frameOrigin === 'integrated-d3d9-workload');
runtime.stop();

const delayedBackend = new R.Retrowin32Backend({ wasmBytes: wasm });
const createProcess = delayedBackend.createProcess.bind(delayedBackend);
delayedBackend.createProcess = async (options) => { await sleep(100); return createProcess(options); };
const cancellingRuntime = new R.PortholeRuntime({ canvas: makeCanvas(), guestCanvas: makeCanvas(), forceSoftware: true, platform: { label: 'Linux' }, guestBackend: delayedBackend });
const pending = cancellingRuntime.executeBytes('C:\\Tests\\hello.exe', fixture('hello.exe'), { source: 'test', preload: false });
await sleep(15);
cancellingRuntime.start();
let cancelled = false;
try { await pending; } catch (error) { cancelled = error.code === 'CANCELLED'; }
await sleep(80);
check('troca de contexto cancela prepare tardio sem tomar o workload', cancelled && cancellingRuntime.running && cancellingRuntime.state === 'running' && cancellingRuntime.loadedPE.status === 'stopped' && cancellingRuntime.loadedPE.executed === false);
cancellingRuntime.stop();

console.log(`\nretrowin32-backend: ${checks} verificações concluídas.`);
