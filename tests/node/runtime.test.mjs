import assert from 'node:assert/strict';
import { loadScripts, makeCanvas } from './helpers.mjs';

const P = loadScripts(
  'platform-detector', 'vfs', 'porthole-linker', 'shim-kernel32', 'shim-user32', 'shim-gdi32',
  'graphics-webgl', 'graphics-fallback', 'graphics-device', 'hlsl-translator',
  'shim-d3d9', 'shim-d3d11', 'runtime',
);

console.log('\n[PortholeRuntime / benchmark real de 5 s]');
const canvas = makeCanvas(128, 96);
const runtime = new P.PortholeRuntime({ canvas, forceSoftware: true, platform: { label: 'Linux' } });
runtime.start();
const result = await runtime.runBenchmark(5000);
assert.equal(result.workload, 'integrated-d3d9-workload');
assert.match(result.origin, /não é um PE externo/);
assert.ok(result.durationMs >= 5000, `duração ${result.durationMs}`);
assert.ok(result.frames > 0, 'nenhum frame apresentado');
assert.ok(result.fps > 0);
assert.equal(result.renderer.kind, 'software-cpu');
assert.equal(result.pixelValidated, true);
assert.ok(runtime.device.frames >= result.frames);
assert.ok(runtime.linker.loadedModules().some((module) => module.name === 'd3d9.dll'));
console.log(`  ✓ ${result.frames} frames, ${result.fps.toFixed(2)} FPS, ${(result.durationMs / 1000).toFixed(3)} s`);
console.log('  ✓ origem dos frames, DLLs e readback são consistentes');
runtime.stop();
assert.equal(runtime.running, false);
assert.equal(runtime.device, null);
console.log('  ✓ stop libera dispositivo e encerra o loop');
console.log('\nruntime: 3 verificações concluídas.');
