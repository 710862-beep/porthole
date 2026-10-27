// Smoke test headless do motor DOOM Wasm (roda em Node 22+, sem navegador).
// Objetivo: provar, antes de qualquer UI, que o binário vendorado funciona e
// que o protocolo de injeção de WAD (loading.wadSizes / loading.readWads) está
// implementado corretamente.
//
// Execução: node tests/node/smoke-wasm.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasmBytes = readFileSync(join(root, 'vendor', 'doom', 'doom.wasm'));
const wadBytes = readFileSync(join(root, 'vendor', 'doom', 'DOOM1.WAD'));

// Instancia o módulo aplicando um "modo" de carregamento de WAD.
// mode: 'embedded' (WAD shareware embutido no binário) | 'injected' (DOOM1.WAD via memória)
async function boot(mode) {
  const state = {
    mode,
    width: 0,
    height: 0,
    frames: 0,
    fbPtr: 0,
    info: [],
    errors: [],
    readWadsCalls: 0,
    wadSizesCalls: 0,
    now: 0,
    memory: null, // preenchido após instantiate
  };

  const decode = (ptr, len) =>
    new TextDecoder('utf8').decode(new Uint8Array(state.memory.buffer, ptr, len));

  const imports = {
    loading: {
      onGameInit: (width, height) => {
        state.width = width;
        state.height = height;
      },
      // Escreve dois i32 LE: número de WADs e total de bytes.
      wadSizes: (nPtr, totalPtr) => {
        state.wadSizesCalls++;
        const view = new DataView(state.memory.buffer);
        if (mode === 'injected') {
          view.setInt32(nPtr, 1, true);
          view.setInt32(totalPtr, wadBytes.byteLength, true);
        } else {
          // 0/0 sinaliza "sem WAD customizado → usar o shareware embutido"
          view.setInt32(nPtr, 0, true);
          view.setInt32(totalPtr, 0, true);
        }
      },
      // Copia os bytes do WAD para o destino dado pelo módulo.
      readWads: (dstPtr, sizesPtr) => {
        state.readWadsCalls++;
        const mem8 = new Uint8Array(state.memory.buffer);
        mem8.set(wadBytes, dstPtr);
        new DataView(state.memory.buffer).setInt32(sizesPtr, wadBytes.byteLength, true);
      },
    },
    ui: {
      drawFrame: (fbPtr) => {
        state.frames++;
        state.fbPtr = fbPtr;
      },
    },
    runtimeControl: {
      // Relógio monotônico real: o DOOM faz busy-waits baseados em I_GetTime;
      // um valor congelado prenderia o motor em loop infinito.
      timeInMilliseconds: () => BigInt(Math.trunc(performance.now())),
    },
    console: {
      onInfoMessage: (p, l) => state.info.push(decode(p, l)),
      onErrorMessage: (p, l) => state.errors.push(decode(p, l)),
    },
    gameSaving: {
      sizeOfSaveGame: () => 0,
      readSaveGame: () => 0,
      writeSaveGame: () => 0,
    },
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  state.memory = instance.exports.memory;
  const ex = instance.exports;

  // Sanidade mínima da ABI
  for (const name of ['initGame', 'reportKeyDown', 'reportKeyUp', 'tickGame', 'memory']) {
    assert.ok(ex[name], `export ausente: ${name}`);
  }

  ex.initGame();
  assert.ok(state.width > 0 && state.height > 0, `dimensões inválidas: ${state.width}x${state.height}`);

  // Simula 3 segundos a 35 FPS (105 ticks), avançando o relógio como o browser faria.
  for (let i = 0; i < 105; i++) {
    state.now += 1000 / 35;
    ex.tickGame();
  }

  // Dispara uma tecla (ENTER) para exercitar reportKeyDown/Up sem crashar.
  ex.reportKeyDown(ex.KEY_ENTER);
  ex.reportKeyUp(ex.KEY_ENTER);

  // Confirma que o framebuffer realmente tem pixels variados (não é tela preta/vazia).
  const fb = new Uint8ClampedArray(state.memory.buffer, state.fbPtr, state.width * state.height * 4);
  let nonZero = 0;
  for (let i = 0; i < fb.length; i += 4096) if (fb[i] || fb[i + 1] || fb[i + 2]) nonZero++;
  state.nonZeroSamples = nonZero;

  return state;
}

console.log(`→ vendor/doom/doom.wasm (${wasmBytes.byteLength} bytes)`);
console.log(`→ vendor/doom/DOOM1.WAD (${wadBytes.byteLength} bytes, magic: ${wadBytes.subarray(0, 4).toString()})`);

const embedded = await boot('embedded');
console.log('\n[Cenário A] WAD shareware embutido no binário');
console.log(`  onGameInit      : ${embedded.width}x${embedded.height}`);
console.log(`  wadSizes calls  : ${embedded.wadSizesCalls} | readWads calls: ${embedded.readWadsCalls}`);
console.log(`  frames desenhados (105 ticks): ${embedded.frames}`);
console.log(`  amostras não-zeradas no FB   : ${embedded.nonZeroSamples}`);
console.log(`  logs info: ${embedded.info.length} | erros: ${embedded.errors.length}`);
if (embedded.errors.length) console.log('  stderr:', embedded.errors.slice(0, 3).join(' | '));
assert.equal(embedded.readWadsCalls, 0, 'readWads não deveria ser chamado no modo embutido');
assert.ok(embedded.frames > 10, `poucos frames no modo embutido: ${embedded.frames}`);
assert.ok(embedded.nonZeroSamples > 0, 'framebuffer vazio no modo embutido');

const injected = await boot('injected');
console.log('\n[Cenário B] DOOM1.WAD injetado via memória Wasm (protocolo readWads)');
console.log(`  onGameInit      : ${injected.width}x${injected.height}`);
console.log(`  wadSizes calls  : ${injected.wadSizesCalls} | readWads calls: ${injected.readWadsCalls}`);
console.log(`  frames desenhados (105 ticks): ${injected.frames}`);
console.log(`  amostras não-zeradas no FB   : ${injected.nonZeroSamples}`);
console.log(`  logs info: ${injected.info.length} | erros: ${injected.errors.length}`);
if (injected.errors.length) console.log('  stderr:', injected.errors.slice(0, 3).join(' | '));
assert.equal(injected.readWadsCalls, 1, 'readWads deveria ser chamado exatamente 1x no modo injetado');
assert.ok(injected.frames > 10, `poucos frames no modo injetado: ${injected.frames}`);
assert.ok(injected.nonZeroSamples > 0, 'framebuffer vazio no modo injetado');

console.log('\n✅ SMOKE TEST PASSOU em ambos os cenários. O motor Wasm e a injeção de WAD funcionam.');
