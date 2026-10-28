import assert from 'node:assert/strict';
import { loadScripts, makeCanvas, triangleBytes } from './helpers.mjs';

const P = loadScripts('porthole-linker', 'graphics-webgl', 'hlsl-translator', 'shim-d3d9');

function makeGL() {
  const calls = { buffers: 0, uploads: 0, arrays: [], elements: [], programs: 0 };
  const gl = {
    calls,
    VENDOR: 1, RENDERER: 2, MAX_TEXTURE_SIZE: 3, MAX_VERTEX_ATTRIBS: 4,
    VERTEX_SHADER: 10, FRAGMENT_SHADER: 11, COMPILE_STATUS: 12, LINK_STATUS: 13,
    ARRAY_BUFFER: 20, ELEMENT_ARRAY_BUFFER: 21, DYNAMIC_DRAW: 22,
    POINTS: 30, LINES: 31, LINE_STRIP: 32, TRIANGLES: 33, TRIANGLE_STRIP: 34, TRIANGLE_FAN: 35,
    FLOAT: 40, UNSIGNED_BYTE: 41, UNSIGNED_SHORT: 42, UNSIGNED_INT: 43,
    COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, NO_ERROR: 0,
    RGBA: 50,
    getParameter(parameter) {
      if (parameter === 1) return 'Porthole test vendor';
      if (parameter === 2) return 'Mock GPU';
      if (parameter === 101) return 'Porthole test vendor';
      if (parameter === 102) return 'NVIDIA Test GPU';
      if (parameter === 3) return 8192;
      if (parameter === 4) return 8;
      return 0;
    },
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_VENDOR_WEBGL: 101, UNMASKED_RENDERER_WEBGL: 102 };
      if (name === 'OES_element_index_uint') return {};
      return null;
    },
    createShader(type) { return { type }; }, shaderSource() {}, compileShader() {},
    getShaderParameter() { return true; }, getShaderInfoLog() { return ''; }, deleteShader() {},
    createProgram() { calls.programs += 1; return {}; }, attachShader() {}, bindAttribLocation() {}, linkProgram() {},
    getProgramParameter() { return true; }, getProgramInfoLog() { return ''; }, deleteProgram() {},
    getUniformLocation() { return {}; }, useProgram() {}, uniform2f() {},
    createBuffer() { calls.buffers += 1; return { id: calls.buffers }; }, deleteBuffer() {},
    bindBuffer() {}, bufferData(target, bytes) { calls.uploads += 1; assert.ok(bytes.byteLength > 0); },
    viewport() {}, enableVertexAttribArray() {}, disableVertexAttribArray() {}, vertexAttribPointer() {}, vertexAttrib4f() {},
    clearColor() {}, clear() {},
    drawArrays(mode, start, count) { calls.arrays.push({ mode, start, count }); },
    drawElements(mode, count, format, offset) { calls.elements.push({ mode, count, format, offset }); },
    getError() { return 0; },
    readPixels(x, y, w, h, format, type, output) { output.set([10, 20, 30, 255]); },
  };
  return gl;
}

const gl = makeGL();
const canvas = makeCanvas(96, 96);
const surface = { width: 0, height: 0, getContext(type) { return type === 'webgl2' ? gl : null; } };
const backend = new P.WebGLBackend(canvas, { surface });
const linker = new P.DynamicLinker({ context: { graphicsBackend: backend } });
linker.register('d3d9.dll', (context) => new P.D3D9Shim(context));
const device = linker.loadLibrary('d3d9.dll').Direct3DCreate9(32).CreateDevice(0, 1, 0, 0, {});
const vb = device.CreateVertexBuffer(60, 0, 0x44, 0);
device.WriteVertices(vb, triangleBytes());
device.SetFVF(0x44); device.SetStreamSource(0, vb, 0, 20);

console.log('\n[WebGL call translation / mock, não teste de GPU]');
assert.equal(gl.calls.buffers, 1);
assert.ok(gl.calls.uploads >= 1);
console.log('  ✓ CreateVertexBuffer → gl.createBuffer; Unlock → gl.bufferData');
device.Clear(0, null, 1, 0xff000000, 1, 0);
device.BeginScene(); device.DrawPrimitive(4, 0, 1); device.EndScene(); device.Present();
assert.deepEqual(gl.calls.arrays[0], { mode: gl.TRIANGLES, start: 0, count: 3 });
assert.equal(canvas.getContext('2d').drawCalls, 1);
console.log('  ✓ DrawPrimitive → gl.drawArrays(TRIANGLES); Present → swap chain Canvas');
const ib = device.CreateIndexBuffer(6, 0, 101, 0);
device.WriteVertices(ib, new Uint16Array([0, 1, 2])); device.SetIndices(ib);
device.BeginScene(); device.DrawIndexedPrimitive(4, 0, 0, 3, 0, 1); device.EndScene();
assert.deepEqual(gl.calls.elements[0], { mode: gl.TRIANGLES, count: 3, format: gl.UNSIGNED_SHORT, offset: 0 });
console.log('  ✓ DrawIndexedPrimitive → gl.drawElements(UNSIGNED_SHORT)');
assert.equal(backend.getInfo().mode, 'webgl-hardware');
assert.equal(backend.isWebGL2, true);
console.log('  ✓ WEBGL_debug_renderer_info classifica o renderer sem inferência de SO');
backend.dispose();
console.log('\nwebgl-backend: 4 verificações concluídas.');
