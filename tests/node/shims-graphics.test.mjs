import assert from 'node:assert/strict';
import { loadScripts, makeCanvas, makeFile, triangleBytes } from './helpers.mjs';

const P = loadScripts(
  'porthole-linker', 'vfs', 'vfs-fallback', 'shim-kernel32', 'shim-user32', 'shim-gdi32',
  'graphics-webgl', 'graphics-fallback', 'hlsl-translator', 'shim-d3d9', 'shim-d3d11',
);
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log('  ✓', name); };

console.log('\n[kernel32]');
const fallback = new P.FallbackVFS({});
await fallback.mapFiles([makeFile('Host/root.txt', 'host')]);
const kernelLinker = new P.DynamicLinker({ context: { vfs: fallback } });
kernelLinker.register('kernel32.dll', (context) => new P.Kernel32Shim(context));
const kernel = kernelLinker.loadLibrary('kernel32.dll');
check('VirtualAlloc/read/write/VirtualFree usam memória real', () => {
  const pointer = kernel.VirtualAlloc(0, 4096, 0x1000, 4);
  assert.ok(pointer > 0);
  kernel.writeMemory(pointer, new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(Array.from(kernel.readMemory(pointer, 4)), [1, 2, 3, 4]);
  assert.equal(kernel.VirtualFree(pointer), true);
  assert.throws(() => kernel.readMemory(pointer, 1), /Ponteiro inválido/);
});
const fileHandle = await kernel.CreateFileA('C:\\Save\\config.ini', 0xc0000000, 0, null, 4, 0);
const written = await kernel.WriteFile(fileHandle, new TextEncoder().encode('shader=glsl'));
assert.equal(written.bytesWritten, 11);
assert.equal(new TextDecoder().decode(await fallback.readFile('C:\\Save\\config.ini')), 'shader=glsl');
assert.equal(kernel.CloseHandle(fileHandle), true);
passed += 1; console.log('  ✓ CreateFile/WriteFile atravessam o VFS');

console.log('\n[user32]');
const user = new P.User32Shim({ tracer: new P.ApiTracer() });
let received = null;
check('CreateWindowEx/PostMessage/DispatchMessage entregam mensagem à WndProc', () => {
  const hwnd = user.CreateWindowExA(0, 'STATIC', 'Teste', 0, 0, 0, 320, 200);
  user.PeekMessageW(0, 1); // remove WM_CREATE
  user.SetWindowLongW(hwnd, -4, (h, m, w) => { received = { h, m, w }; return 7; });
  user.PostMessageW(hwnd, 0x0400, 42, 0);
  const message = user.PeekMessageW(0, 1);
  assert.equal(user.DispatchMessageW(message), 7);
  assert.deepEqual(received, { h: hwnd, m: 0x0400, w: 42 });
});
class FakeInput extends EventTarget {
  constructor() { super(); this.width = 200; this.height = 100; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 200, height: 100 }; }
  focus() {}
  setPointerCapture() {}
}
check('Teclado e mouse DOM atualizam GetAsyncKeyState/GetCursorPos', () => {
  const input = new FakeInput(); user.attachInput(input);
  const keydown = new Event('keydown', { cancelable: true });
  Object.defineProperties(keydown, { key: { value: 'a' }, repeat: { value: false } });
  input.dispatchEvent(keydown);
  assert.equal(user.GetAsyncKeyState(65), 0x8000);
  const move = new Event('pointermove');
  Object.defineProperties(move, { clientX: { value: 60 }, clientY: { value: 45 } });
  input.dispatchEvent(move);
  assert.deepEqual(user.GetCursorPos(), { x: 50, y: 25 });
  user.detachInput();
});

console.log('\n[gdi32]');
check('BitBlt SRCCOPY chama Canvas2D.drawImage', () => {
  const canvas = makeCanvas();
  const gdi = new P.GDI32Shim({ canvas, tracer: new P.ApiTracer() });
  const source = gdi.CreateCompatibleDC(canvas), destination = gdi.GetDC();
  assert.equal(gdi.BitBlt(destination, 0, 0, 32, 32, source, 0, 0, 0x00cc0020), true);
  assert.equal(canvas.getContext('2d').drawCalls, 1);
});

console.log('\n[d3d9 + software rasterizer]');
const canvas = makeCanvas();
const backend = new P.SoftwareRenderer(canvas);
const linker = new P.DynamicLinker({ context: { graphicsBackend: backend } });
linker.register('d3d9.dll', (context) => new P.D3D9Shim(context));
const d3d = linker.loadLibrary('d3d9.dll').Direct3DCreate9(32);
const device = d3d.CreateDevice(0, 1, 0, 0, {});
const vb = device.CreateVertexBuffer(60, 0, 0x44, 0);
device.WriteVertices(vb, triangleBytes());
device.SetFVF(0x44); device.SetStreamSource(0, vb, 0, 20);
check('CreateVertexBuffer/Lock/Unlock/DrawPrimitive/Present produzem pixels', () => {
  device.Clear(0, null, 1, 0xff09121e, 1, 0);
  device.BeginScene(); device.DrawPrimitive(4, 0, 1); device.EndScene(); device.Present();
  const pixel = backend.readCenterPixel();
  assert.equal(pixel[3], 255); assert.notDeepEqual(Array.from(pixel), [9, 18, 30, 255]);
  assert.equal(device.frames, 1); assert.equal(canvas.getContext('2d').presents, 1);
});
check('CreateIndexBuffer/SetIndices/DrawIndexedPrimitive desenham o mesmo triângulo', () => {
  const ib = device.CreateIndexBuffer(6, 0, 101, 0);
  device.WriteVertices(ib, new Uint16Array([0, 1, 2])); device.SetIndices(ib);
  device.Clear(0, null, 1, 0xff09121e, 1, 0);
  device.BeginScene(); device.DrawIndexedPrimitive(4, 0, 0, 3, 0, 1); device.EndScene(); device.Present();
  assert.equal(device.drawCalls, 2); assert.equal(backend.readCenterPixel()[3], 255);
});
check('Draw fora dos limites falha em vez de reportar sucesso', () => {
  assert.throws(() => device.DrawPrimitive(4, 0, 2), /excede/);
});

console.log('\n[HLSL limitado]');
check('Mapeamento manual e shaders triviais são traduzidos', () => {
  assert.match(P.HLSLTranslator.translateVertex('float4 main(float4 p : POSITION) : SV_POSITION { return p; }'), /gl_Position/);
  assert.match(P.HLSLTranslator.translatePixel('float4 main() : COLOR { return float4(1, 0, 0, 1); }'), /gl_FragColor/);
  assert.throws(() => P.HLSLTranslator.translatePixel('float4 main() : COLOR { for(int i=0;i<4;i++){} return 0; }'), /fora do subconjunto/);
});

console.log('\n[d3d11 subset]');
check('D3D11 buffers/topology/Draw/Present usam o GTL real', () => {
  const canvas11 = makeCanvas();
  const backend11 = new P.SoftwareRenderer(canvas11);
  const linker11 = new P.DynamicLinker({ context: { graphicsBackend: backend11 } });
  linker11.register('d3d11.dll', (context) => new P.D3D11Shim(context));
  const d3d11 = linker11.loadLibrary('d3d11.dll');
  const { device: dev11, immediateContext: context11, swapChain } = d3d11.D3D11CreateDevice();
  const buffer = dev11.CreateBuffer({ ByteWidth: 60, BindFlags: 1, StructureByteStride: 20 }, triangleBytes());
  context11.IASetVertexBuffers(0, 1, [buffer], [20], [0]);
  context11.IASetPrimitiveTopology(4);
  context11.ClearRenderTargetView(null, [0.02, 0.04, 0.08, 1]);
  context11.Draw(3, 0); swapChain.Present(0);
  assert.equal(backend11.frames, 1); assert.equal(backend11.readCenterPixel()[3], 255);
});

console.log(`\nshims-graphics: ${passed} verificações concluídas.`);
