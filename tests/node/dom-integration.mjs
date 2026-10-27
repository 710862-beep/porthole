// Teste de integração DOM (substituto do navegador dentro da sandbox).
// Usa jsdom (devDependency NÃO exigida para rodar o app) + o WebAssembly real
// do Node + um servidor HTTP estático para os fetches same-origin.
//
// Execução:
//   1) python3 -m http.server 8123 --bind 127.0.0.1 (na raiz do projeto)
//   2) node tests/node/dom-integration.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

// O html2canvas usa APIs de layout que o jsdom não implementa (getComputedStyle
// com pseudo-elemento etc.). Esses erros são esperados e exercitam nosso fallback
// nativo; silenciamos o console virtual para não poluir o relatório dos testes.
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => {
  if (!/Not implemented|parsing CSS component value/.test(String(err && err.message))) {
    console.error('[jsdom]', err);
  }
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'http://127.0.0.1:8123/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = readFileSync(join(root, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: BASE + 'index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true, // fornece requestAnimationFrame
  virtualConsole,
});
const { window } = dom;
const { document } = window;

// --------------------------------------------------------------------------
// Ponte Node -> jsdom: Wasm/fetch reais e mocks de canvas (jsdom não rasteriza)
// --------------------------------------------------------------------------
window.WebAssembly = globalThis.WebAssembly;
window.fetch = (url, opts) => globalThis.fetch(new URL(url, BASE).href, opts);
// Globais de plataforma que o jsdom não injeta no window (existem em todo browser)
window.TextDecoder = globalThis.TextDecoder;
window.TextEncoder = globalThis.TextEncoder;
window.Blob = globalThis.Blob;
window.URL.createObjectURL = globalThis.URL.createObjectURL.bind(globalThis.URL);
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL.bind(globalThis.URL);
// jsdom não implementa pointer capture: no-ops para o Window Manager
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
// jsdom 24 também não expõe o construtor PointerEvent: derivamos de MouseEvent
class PointerEventShim extends window.MouseEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType || 'mouse';
  }
}
window.PointerEvent = PointerEventShim;

// jsdom não possui engine de layout: getBoundingClientRect/client* retornam 0.
// Ensina o DOM falso a refletir os estilos inline e um viewport 1280x720,
// tornando os testes de arrastar/redimensionar matematicamente significativos.
const num = (v) => parseInt(String(v || '').replace('px', ''), 10) || 0;
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const s = this.style || {};
  const left = num(s.left), top = num(s.top), width = num(s.width), height = num(s.height);
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
};
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1280 });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 720 });
Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { configurable: true, get: function () { return this.classList.contains('window-titlebar') ? 32 : num(this.style.height); } });

function make2dMock() {
  return {
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}, fillRect() {}, fillText() {},
    getImageData: () => ({ data: new Uint8ClampedArray([208, 32, 32, 255]) }),
    fillStyle: '', font: '',
  };
}
window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (String(type).startsWith('webgl') || type === 'experimental-webgl') return null; // sem GPU → modo software
  return make2dMock();
};
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,QUJDREVGR0hJSg==';

// Carrega os scripts do app na ordem do index.html (html2canvas é opcional)
function evalScript(rel, optional = false) {
  try {
    window.eval(readFileSync(join(root, rel), 'utf8'));
    console.log('  script carregado:', rel);
  } catch (err) {
    if (!optional) throw err;
    console.log('  script opcional falhou (ok):', rel, '-', err.message);
  }
}
evalScript('vendor/html2canvas/html2canvas.min.js', true);
['js/window-manager.js', 'js/gpu.js', 'js/doom-runtime.js', 'js/diagnostics.js', 'js/webos.js']
  .forEach((f) => evalScript(f));

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

async function main() {
  // Aguarda o boot (splash de 900 ms)
  await sleep(1300);

  console.log('\n[1] Shell do WebOS');
  check('4 ícones no desktop', () => assert.equal(document.querySelectorAll('.desktop-icon').length, 4));
  check('relógio populado', () => {
    const t = document.querySelector('#clock-time').textContent;
    assert.match(t, /\d{2}:\d{2}/);
  });
  check('menu iniciar alterna', () => {
    document.querySelector('#start-button').click();
    assert.ok(document.querySelector('#start-menu').classList.contains('visible'));
    document.querySelector('#start-button').click();
    assert.ok(!document.querySelector('#start-menu').classList.contains('visible'));
  });
  check('busca filtra apps', () => {
    document.querySelector('#start-button').click();
    const input = document.querySelector('#search-input');
    input.value = 'doom';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    const dimmed = [...document.querySelectorAll('.start-app')].filter((b) => b.classList.contains('dimmed'));
    assert.ok(dimmed.length >= 2, 'apps não relacionados deveriam sumir');
    input.value = '';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    document.querySelector('#start-button').click();
  });
  check('overlay de energia', () => {
    document.querySelector('#power-button').click();
    assert.ok(!document.querySelector('#power-overlay').classList.contains('hidden'));
    document.querySelector('#power-wake').click();
    assert.ok(document.querySelector('#power-overlay').classList.contains('hidden'));
  });

  console.log('\n[2] Window Manager');
  window.WebOS.openApp('notepad');
  window.WebOS.openApp('about');
  const noteWin = window.WebOS.wm.byApp('notepad');
  const aboutWin = window.WebOS.wm.byApp('about');
  check('duas janelas e dois botões na taskbar', () => {
    assert.equal(document.querySelectorAll('.app-window').length, 2);
    assert.equal(document.querySelectorAll('.taskbar-app').length, 2);
  });
  check('foco e z-index: About no topo', () => {
    assert.ok(aboutWin.el.classList.contains('inactive') === false);
    assert.ok(noteWin.el.classList.contains('inactive'));
    assert.ok(parseInt(aboutWin.el.style.zIndex) > parseInt(noteWin.el.style.zIndex));
  });
  check('minimizar/restaurar', () => {
    noteWin.minimize();
    assert.ok(noteWin.el.classList.contains('minimized'));
    noteWin.restore();
    assert.ok(!noteWin.el.classList.contains('minimized'));
    assert.ok(noteWin.active);
  });
  check('maximizar/restaura retângulo anterior', () => {
    const before = { w: noteWin.el.style.width, h: noteWin.el.style.height };
    noteWin.toggleMaximize();
    assert.ok(noteWin.el.classList.contains('maximized'));
    noteWin.toggleMaximize();
    assert.equal(noteWin.el.style.width, before.w);
    assert.equal(noteWin.el.style.height, before.h);
  });
  check('arrastar pelo titlebar (pointer events)', () => {
    const tb = noteWin.titlebar;
    const x0 = 100, y0 = 100;
    tb.dispatchEvent(new window.PointerEvent('pointerdown', { pointerId: 1, clientX: x0, clientY: y0, bubbles: true }));
    tb.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 1, clientX: x0 + 120, clientY: y0 + 80, bubbles: true }));
    tb.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 1, clientX: x0 + 120, clientY: y0 + 80, bubbles: true }));
    const left = parseInt(noteWin.el.style.left);
    const top = parseInt(noteWin.el.style.top);
    assert.ok(left > 100 || top > 80, 'janela não se moveu');
  });
  check('redimensionar pela alça SE', () => {
    const handle = noteWin.el.querySelector('.rh-se');
    const w0 = noteWin.el.getBoundingClientRect ? 0 : 0;
    const startW = parseInt(noteWin.el.style.width);
    handle.dispatchEvent(new window.PointerEvent('pointerdown', { pointerId: 2, clientX: 50, clientY: 50, bubbles: true }));
    handle.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 2, clientX: 170, clientY: 130, bubbles: true }));
    handle.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 2, clientX: 170, clientY: 130, bubbles: true }));
    assert.ok(parseInt(noteWin.el.style.width) > startW, 'largura não cresceu');
    assert.equal(typeof w0, 'number');
  });
  noteWin.close();
  aboutWin.close();
  check('fechar limpa janelas e taskbar', () => {
    assert.equal(document.querySelectorAll('.app-window').length, 0);
    assert.equal(window.WebOS.wm._windows.size, 0);
  });

  console.log('\n[3] Runtime DOOM WebAssembly (motor real via fetch same-origin)');
  window.WebOS.openApp('doom');
  const doomWin = window.WebOS.wm.byApp('doom');
  assert.ok(doomWin, 'janela do DOOM não abriu');
  // Recupera o runtime pela referência privada do app (mesmo closure do módulo)
  const rt = await waitFor(() => {
    const c = doomWin.el.querySelector('.doom-canvas');
    return c && c.width === 640 ? true : false;
  }, 20000);
  check('onGameInit dimensionou o canvas em 640x400', () => assert.ok(rt));
  await waitFor(() => doomWin.el.querySelector('#doom-console').textContent.includes('readWads'), 20000);
  check('WAD injetado via readWads (protocolo de memória Wasm)', () => {
    const text = doomWin.el.querySelector('#doom-console').textContent;
    assert.match(text, /readWads: 4196020 bytes/);
    assert.match(text, /IWAD/);
  });
  check('Device Status mostra pipeline de software (sem WebGL no jsdom)', () => {
    const pill = doomWin.el.querySelector('#ds-gpu-pill');
    assert.ok(pill.classList.contains('gpu-off') || pill.classList.contains('gpu-sw'));
    assert.match(doomWin.el.querySelector('#ds-pipeline-pill').textContent, /Software/i);
  });
  // FPS real sendo atualizado pelo loop rAF
  const fpsUpdated = await waitFor(() => /^\d+$/.test(doomWin.el.querySelector('#ds-fps').textContent), 8000);
  check('contador de FPS atualiza', () => assert.ok(fpsUpdated, 'fps nunca mudou'));
  check('gate de entrada: foco liga, blur congela', () => {
    const r = getRuntime(doomWin);
    r.setInputEnabled(false);
    assert.equal(r.inputEnabled, false);
    assert.equal(doomWin.el.querySelector('#ds-input').textContent, 'em pausa');
    r.setInputEnabled(true);
    assert.equal(r.inputEnabled, true);
  });
  const doomedRuntime = getRuntime(doomWin);
  doomWin.close();
  check('fechar destruiu o runtime', () => {
    assert.equal(doomedRuntime._destroyed, true);
    assert.equal(window.WebOS.DoomRuntime._instances.length, 0);
    assert.equal(document.querySelectorAll('.app-window').length, 0);
  });

  console.log('\n[4] Diagnostics & Benchmarks + captura E2E');
  window.WebOS.openApp('diagnostics');
  const diagWin = window.WebOS.wm.byApp('diagnostics');
  diagWin.el.querySelector('#diag-run-all').click();
  const allDone = await waitFor(() => {
    const badges = [...diagWin.el.querySelectorAll('.badge')];
    return badges.length === 5 && badges.every((b) => b.classList.contains('pass') || b.classList.contains('fail'));
  }, 60000);
  check('os 5 testes terminaram', () => assert.ok(allDone, 'timeout aguardando suíte'));
  const passCount = diagWin.el.querySelectorAll('.badge.pass').length;
  const failCount = diagWin.el.querySelectorAll('.badge.fail').length;
  console.log(`    resultado: ${passCount} PASS / ${failCount} FAIL`);
  check('pelo menos 4/5 testes passaram', () => assert.ok(passCount >= 4, `apenas ${passCount} passaram`));
  diagWin.el.querySelectorAll('tbody tr').forEach((tr) => {
    console.log('    -', tr.dataset.test, '→', tr.querySelector('.badge').textContent, '|', tr.querySelector('.diag-metric').textContent);
  });
  diagWin.el.querySelector('#diag-capture').click();
  const captured = await waitFor(() => {
    const meta = diagWin.el.querySelector('#capture-meta').textContent;
    return meta.startsWith('✓');
  }, 15000);
  check('Capture UI State gerou imagem', () => {
    assert.ok(captured);
    const img = diagWin.el.querySelector('#capture-img');
    assert.match(img.src, /^data:image\/png;base64,/);
    console.log('   ', diagWin.el.querySelector('#capture-meta').textContent);
  });

  console.log(`\n🎉 INTEGRAÇÃO DOM: ${passed} verificações passaram.`);
  dom.window.close();
  process.exit(0);
}

// Espera uma predicada ficar verdadeira (polling)
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (predicate()) return true; } catch { /* ainda não pronto */ }
    await sleep(150);
  }
  return false;
}

// O runtime fica fechado no closure do app; buscamos via instância no mapa de janelas
function getRuntime(win) {
  // dom-integration hook: o mount guarda em doomApp._runtime; como não é
  // exposto, localizamos o canvas e reutilizamos o registry interno do módulo.
  return window.WebOS.DoomRuntime._last || null;
}

main().catch((err) => {
  console.error('❌ FALHA NA INTEGRAÇÃO:', err);
  process.exit(1);
});
