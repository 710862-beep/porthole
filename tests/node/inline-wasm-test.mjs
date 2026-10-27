// Valida os bytes do módulo Wasm artesanal embutido em js/diagnostics.js (teste a).
// Execução: node tests/node/inline-wasm-test.mjs
import assert from 'node:assert/strict';

const INLINE_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

const { instance } = await WebAssembly.instantiate(INLINE_WASM, {});
assert.equal(typeof instance.exports.add, 'function', 'export add ausente');
assert.equal(instance.exports.add(2, 3), 5);
assert.equal(instance.exports.add(40, 2), 42);
assert.equal(instance.exports.add(-7, 7), 0);
console.log(`✅ inline-wasm-test: módulo de ${INLINE_WASM.length} bytes OK (add i32,i32->i32).`);
