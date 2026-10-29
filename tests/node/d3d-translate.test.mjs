import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadScripts, makeCanvas } from './helpers.mjs';

const require = createRequire(import.meta.url);
const P = loadScripts('porthole-linker', 'graphics-fallback', 'hlsl-translator', 'shim-d3d9', 'shim-d3d11');
require('../../shims/d3d_translate.js');
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log('  ✓', name); };

console.log('\n[D3D / constant buffer reflection]');
check('cbuffer aplica packing de 16 bytes, matrizes e arrays', () => {
  const [buffer] = P.D3DTranslator.parseConstantBuffers(`
    cbuffer Frame : register(b3) {
      float2 viewport;
      float intensity;
      float4 tint;
      float4x4 world;
      float weights[3];
    };
  `);
  assert.equal(buffer.register, 3);
  assert.deepEqual(buffer.members.map(({ name, offset, size, stride }) => ({ name, offset, size, stride })), [
    { name: 'viewport', offset: 0, size: 8, stride: 8 },
    { name: 'intensity', offset: 8, size: 4, stride: 4 },
    { name: 'tint', offset: 16, size: 16, stride: 16 },
    { name: 'world', offset: 32, size: 64, stride: 64 },
    { name: 'weights', offset: 96, size: 48, stride: 16 },
  ]);
  assert.equal(buffer.size, 144);
});
check('tipos desconhecidos e registers duplicados são rejeitados', () => {
  assert.throws(() => P.D3DTranslator.parseConstantBuffers('cbuffer Bad { struct X value; };'), (e) => e.code === 'HLSL_UNSUPPORTED');
  assert.throws(() => P.D3DTranslator.parseConstantBuffers('cbuffer A:register(b0){float x;}; cbuffer B:register(b0){float y;};'), /duplicado/);
});

console.log('\n[D3D / vertex declarations]');
check('layout multi-stream preserva semantics, strides e D3DCOLOR BGRA', () => {
  const layout = P.D3DTranslator.createVertexLayout([
    { stream: 0, offset: 0, type: 'FLOAT3', usage: 'POSITION' },
    { stream: 0, offset: 12, type: 'D3DCOLOR', usage: 'COLOR' },
    { stream: 1, offset: 0, type: 'FLOAT2', usage: 'TEXCOORD', usageIndex: 0 },
    { stream: 1, offset: 8, type: 'FLOAT2', usage: 'TEXCOORD', usageIndex: 1 },
  ]);
  assert.deepEqual(layout.strides, { 0: 16, 1: 16 });
  const color = layout.attributes.find((item) => item.semantic === 'COLOR0');
  assert.equal(color.normalized, true);
  assert.equal(color.swizzle, 'bgra');
  assert.equal(new Set(layout.attributes.map((item) => item.name)).size, 4);
});

console.log('\n[HLSL / parser de expressões]');
check('mul/lerp/saturate, campos e precedence viram AST emitida em GLSL', () => {
  const glsl = P.D3DTranslator.translateExpression('mul(input.position, world) + saturate(lerp(a, b, 0.5))');
  assert.match(glsl, /input\.position/);
  assert.match(glsl, /\*/);
  assert.match(glsl, /mix\(a, b, 0\.5\)/);
  assert.match(glsl, /clamp\(/);
  assert.equal(P.D3DTranslator.translateExpression('color.bgra'), 'color.bgra');
});
check('funções desconhecidas e tokens extras falham explicitamente', () => {
  assert.throws(() => P.D3DTranslator.translateExpression('tex2D(texture0, uv)'), (e) => e.code === 'HLSL_UNSUPPORTED');
  assert.throws(() => P.D3DTranslator.translateExpression('a = b'), /fora do subconjunto/);
});

console.log('\n[D3D11 / constant buffer storage]');
check('CreateBuffer/UpdateSubresource/VS/PS slots preservam bytes reais', () => {
  const backend = new P.SoftwareRenderer(makeCanvas());
  const linker = new P.DynamicLinker({ context: { graphicsBackend: backend } });
  linker.register('d3d11.dll', (context) => new P.D3D11Shim(context));
  const { device, immediateContext } = linker.loadLibrary('d3d11.dll').D3D11CreateDevice();
  const handle = device.CreateBuffer({ ByteWidth: 16, BindFlags: 4 }, new Float32Array([1, 2, 3, 4]));
  immediateContext.UpdateSubresource(handle, { left: 4, right: 12, top: 0, bottom: 1, front: 0, back: 1 }, new Float32Array([9, 8]));
  immediateContext.VSSetConstantBuffers(0, 1, [handle]);
  immediateContext.PSSetConstantBuffers(2, 1, [handle]);
  assert.deepEqual(Array.from(new Float32Array(device._resource(handle, 'constant').data)), [1, 9, 8, 4]);
  assert.equal(immediateContext.constantBuffers.vs[0].handle, handle);
  assert.equal(immediateContext.constantBuffers.ps[2].handle, handle);
  assert.throws(() => immediateContext.UpdateSubresource(handle, { left: 12, right: 20 }, new Uint8Array(8)), /fora/);
});

console.log(`\nd3d-translate: ${checks} verificações concluídas.`);
