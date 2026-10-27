/* ==========================================================================
   webos.js — Bootstrap do Porthole WebOS
   Registra os aplicativos, monta desktop/menu Iniciar/taskbar, alimenta o
   relógio e conecta os apps ao Window Manager e ao runtime DOOM.
   Vanilla JS puro; depende de window-manager.js, gpu.js, doom-runtime.js e
   diagnostics.js já carregados (ordem dos <script> no index.html).
   ========================================================================== */
(function () {
  'use strict';

  const WebOS = (window.WebOS = window.WebOS || {});
  const $ = (sel) => document.querySelector(sel);

  /* ----------------------------------------------------------------------
   * Utilitários de sistema
   * -------------------------------------------------------------------- */
  let toastTimer = 0;
  WebOS.toast = function (msg, ms = 3800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  };

  function openApp(appId) {
    const app = APPS[appId];
    if (!app) return;
    // Apps de instância única: se já estão abertos, só focar a janela
    const existing = WebOS.wm.byApp(appId);
    if (existing) {
      existing.focus();
      return;
    }
    WebOS.wm.create({
      appId,
      id: 'win-' + appId,
      title: app.title,
      glyph: app.glyph,
      width: app.width,
      height: app.height,
      mount: app.mount,
      // Callbacks lazy: o app DOOM amarra onFocus/onBlur/onClose durante o mount,
      // então precisamos reler as propriedades no momento em que o WM os invoca.
      onFocus: (w) => app.onFocus && app.onFocus(w),
      onBlur: (w) => app.onBlur && app.onBlur(w),
      onClose: (w) => app.onClose && app.onClose(w),
    });
  }
  WebOS.openApp = openApp;

  /* ----------------------------------------------------------------------
   * APP 1 — DOOM (WebAssembly + WAD + Device Status GPU/CPU)
   * -------------------------------------------------------------------- */
  const doomApp = {
    id: 'doom', title: 'DOOM (WebAssembly)', glyph: '👹',
    width: 880, height: 620,
    _runtime: null,

    mount(win) {
      const gpu = WebOS.gpu.detect();
      let forceSoftware = false;

      win.body.innerHTML = `
        <div class="doom-root">
          <div class="device-status">
            <span class="ds-item">GPU do host:
              <span id="ds-gpu-pill" class="ds-pill"></span></span>
            <span class="ds-item">Pipeline do jogo:
              <span id="ds-pipeline-pill" class="ds-pill gpu-sw"></span></span>
            <span class="ds-item">FPS: <b id="ds-fps">--</b></span>
            <span class="ds-item">Entrada: <b id="ds-input">inativa</b></span>
            <span class="ds-item" style="margin-left:auto">
              <button id="ds-force-sw" class="win10-btn" style="padding:3px 10px;font-size:11px">
                Simular bloqueio de GPU
              </button>
            </span>
          </div>
          <div class="doom-stage">
            <canvas class="doom-canvas" tabindex="0" width="640" height="400"
                    title="Clique e use o teclado para jogar"></canvas>
            <div class="doom-overlay" id="doom-overlay">
              <div>
                <div class="big-glyph">👹</div>
                <h2 id="doom-overlay-title">Inicializando DOOM…</h2>
                <p id="doom-overlay-text">Baixando o módulo WebAssembly e o DOOM1.WAD.</p>
                <div class="doom-progress"><i id="doom-progress-bar"></i></div>
                <p class="doom-err" id="doom-overlay-err"></p>
              </div>
            </div>
          </div>
          <div class="doom-console" id="doom-console" aria-live="polite"></div>
          <div class="doom-helpbar">
            <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> mover</span>
            <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> WASD</span>
            <span><kbd>Ctrl</kbd>/clique esquerdo atirar</span>
            <span><kbd>Espaço</kbd>/<kbd>E</kbd>/clique direito usar</span>
            <span><kbd>Enter</kbd> confirmar · <kbd>Esc</kbd> menu</span>
          </div>
        </div>`;

      const canvas = win.body.querySelector('.doom-canvas');
      const overlay = win.body.querySelector('#doom-overlay');
      const consoleEl = win.body.querySelector('#doom-console');
      const fpsEl = win.body.querySelector('#ds-fps');
      const inputEl = win.body.querySelector('#ds-input');
      const gpuPill = win.body.querySelector('#ds-gpu-pill');
      const pipePill = win.body.querySelector('#ds-pipeline-pill');
      const bar = win.body.querySelector('#doom-progress-bar');
      const errEl = win.body.querySelector('#doom-overlay-err');

      const log = (msg, level = 'info') => {
        const line = document.createElement('div');
        if (level === 'err') line.className = 'dc-err';
        else if (level === 'ok') line.className = 'dc-ok';
        else if (level === 'dim') line.className = 'dc-dim';
        line.textContent = '› ' + msg;
        consoleEl.appendChild(line);
        consoleEl.scrollTop = consoleEl.scrollHeight;
        bar.style.width = Math.min(95, parseFloat(bar.style.width || '0') + 14) + '%';
      };

      // Device Status: classificação real da GPU via WEBGL_debug_renderer_info
      function renderGpuStatus() {
        if (!gpu.supported) {
          gpuPill.className = 'ds-pill gpu-off';
          gpuPill.textContent = 'Indisponível';
        } else if (forceSoftware || gpu.mode === 'software') {
          gpuPill.className = 'ds-pill gpu-sw';
          gpuPill.textContent = forceSoftware ? 'Bloqueada (simulado)' : 'Software: ' + gpu.renderer;
        } else {
          gpuPill.className = 'ds-pill gpu-hw';
          gpuPill.textContent = 'Hardware: ' + gpu.renderer;
        }
        const pipe = WebOS.gpu.pipelineStatus(gpu, forceSoftware);
        pipePill.textContent = pipe.label.split('(')[0].trim();
        pipePill.title = pipe.reason;
      }
      renderGpuStatus();
      win.body.querySelector('#ds-force-sw').addEventListener('click', (e) => {
        forceSoftware = !forceSoftware;
        e.target.textContent = forceSoftware ? 'Restaurar GPU do host' : 'Simular bloqueio de GPU';
        renderGpuStatus();
        WebOS.toast(forceSoftware
          ? 'GPU bloqueada: pipeline 100% software (análogo ao LLVMpipe).'
          : 'Aceleração do host restaurada.');
      });

      const runtime = new WebOS.DoomRuntime(canvas, {
        onLog: log,
        onStatus: (state, detail) => {
          if (state === 'running') {
            overlay.classList.add('hidden');
            inputEl.textContent = runtime.inputEnabled ? 'ativa' : 'em pausa';
          } else if (state === 'paused') {
            inputEl.textContent = 'em pausa';
          } else if (state === 'error') {
            overlay.classList.remove('hidden');
            win.body.querySelector('#doom-overlay-title').textContent = 'Falha no runtime';
            win.body.querySelector('#doom-overlay-text').textContent = detail;
          }
        },
        onFps: (fps) => { fpsEl.textContent = fps; },
      });
      doomApp._runtime = runtime;

      runtime.init().catch((err) => {
        errEl.textContent = String(err && err.message ? err.message : err);
        overlay.classList.remove('hidden');
        win.body.querySelector('#doom-overlay-title').textContent = 'Não foi possível iniciar o DOOM';
      });

      // O jogo só processa entrada quando a janela do WebOS está ativa
      doomApp.onFocus = () => runtime.setInputEnabled(true);
      doomApp.onBlur = () => runtime.setInputEnabled(false);
      doomApp.onClose = () => {
        runtime.destroy();
        doomApp._runtime = null;
      };
      // Já dispara o foco inicial (a janela nasce focada pelo WM)
      runtime.setInputEnabled(true);
    },
  };

  /* ----------------------------------------------------------------------
   * APP 2 — System Diagnostics & Benchmarks (Modo Desenvolvedor)
   * -------------------------------------------------------------------- */
  const diagnosticsApp = {
    id: 'diagnostics', title: 'System Diagnostics & Benchmarks', glyph: '🩺',
    width: 820, height: 640, dev: true,
    mount(win) { WebOS.diagnostics.mount(win); },
  };

  /* ----------------------------------------------------------------------
   * APP 3 — Bloco de Notas
   * -------------------------------------------------------------------- */
  const notepadApp = {
    id: 'notepad', title: 'Bloco de Notas', glyph: '📝',
    width: 560, height: 460,
    mount(win) {
      win.body.innerHTML = `
        <div class="notepad-root">
          <div class="notepad-toolbar">
            <button id="np-save">Salvar como .txt</button>
            <button id="np-clear">Limpar</button>
          </div>
          <textarea spellcheck="false">Porthole WebOS — Bloco de Notas
================================
Digite aqui. Suas anotações existem apenas no DOM;
"Salvar" gera um download via Blob (sem servidor).
</textarea>
        </div>`;
      const ta = win.body.querySelector('textarea');
      win.body.querySelector('#np-save').addEventListener('click', () => {
        const blob = new Blob([ta.value], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'porthole-nota.txt';
        a.click();
        URL.revokeObjectURL(a.href);
        WebOS.toast('Arquivo porthole-nota.txt gerado.');
      });
      win.body.querySelector('#np-clear').addEventListener('click', () => { ta.value = ''; ta.focus(); });
    },
  };

  /* ----------------------------------------------------------------------
   * APP 4 — Sobre este PC (especificações do "hardware" virtual)
   * -------------------------------------------------------------------- */
  const aboutApp = {
    id: 'about', title: 'Sobre este PC', glyph: '💻',
    width: 600, height: 560,
    mount(win) {
      const gpu = WebOS.gpu.detect();
      const nav = window.navigator;
      const rows = [
        ['Sistema', 'Porthole WebOS 1.0 (clone de interface Windows 10)'],
        ['User Agent', nav.userAgent],
        ['Plataforma', nav.platform || 'desconhecida'],
        ['Idioma', nav.language],
        ['Núcleos lógicos (CPU)', nav.hardwareConcurrency ? nav.hardwareConcurrency + ' threads' : 'não informado'],
        ['Memória estimada', nav.deviceMemory ? nav.deviceMemory + ' GiB' : 'não informada'],
        ['Tela', `${screen.width}×${screen.height} · devicePixelRatio ${window.devicePixelRatio}`],
        ['WebAssembly', typeof WebAssembly === 'object' ? 'disponível (MVP + BigInt i64)' : 'INDIRESPONÍVEL'],
        ['WebGL', gpu.supported ? `${gpu.version} — ${gpu.renderer}` : 'indisponível (modo software)'],
        ['Classificação gráfica', gpu.mode + (gpu.shaderOk ? ' · shader de teste ok' : ' · shader comprometido')],
        ['Motor DOOM', 'jacobenget/doom.wasm v0.1.0 (GPL-2), ABI 14 símbolos, 35 Hz'],
        ['WAD', 'DOOM1.WAD shareware (IWAD, 4.196.020 bytes) vendoreado em vendor/doom/'],
      ];
      win.body.innerHTML = `
        <div class="about-root">
          <h1>Porthole WebOS</h1>
          <p>Um "sistema operacional" de brinquedo que roda inteiro no navegador:
             gerenciador de janelas em Vanilla JS e DOOM clássico compilado para WebAssembly,
             com o WAD carregado via fetch e copiado para a memória linear do Wasm.</p>
          <h2>Especificações do dispositivo virtual</h2>
          <dl class="spec-grid">
            ${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}
          </dl>
          <h2>Componentes de terceiros</h2>
          <ul>
            <li>doom.wasm — GPL-2, jacobenget/doom.wasm</li>
            <li>DOOM1.WAD — shareware da id Software (via abus-sh/doom-wasm)</li>
            <li>html2canvas 1.4.1 — licença MIT</li>
          </ul>
        </div>`;
    },
  };

  const APPS = {
    doom: doomApp,
    diagnostics: diagnosticsApp,
    notepad: notepadApp,
    about: aboutApp,
  };

  /* ----------------------------------------------------------------------
   * Ícones do desktop e Menu Iniciar
   * -------------------------------------------------------------------- */
  function buildDesktopIcons() {
    const wrap = $('#desktop-icons');
    Object.values(APPS).forEach((app) => {
      const icon = document.createElement('div');
      icon.className = 'desktop-icon';
      icon.tabIndex = 0;
      icon.dataset.app = app.id;
      icon.innerHTML = `<span class="di-glyph">${app.glyph}</span><span class="di-label">${app.title}</span>`;
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        wrap.querySelectorAll('.desktop-icon').forEach((i) => i.classList.remove('selected'));
        icon.classList.add('selected');
      });
      icon.addEventListener('dblclick', () => openApp(app.id));
      icon.addEventListener('keydown', (e) => { if (e.key === 'Enter') openApp(app.id); });
      wrap.appendChild(icon);
    });
  }

  function buildStartMenu() {
    const makeItem = (app) => {
      const b = document.createElement('button');
      b.className = 'start-app';
      b.dataset.app = app.id;
      b.innerHTML = `<span class="sa-glyph">${app.glyph}</span>
        <span>${app.title}${app.dev ? '<small>Developer Mode</small>' : ''}</span>`;
      b.addEventListener('click', () => {
        openApp(app.id);
        toggleStart(false);
      });
      return b;
    };
    const list = $('#start-app-list');
    const devList = $('#start-dev-list');
    Object.values(APPS).forEach((app) => {
      (app.dev ? devList : list).appendChild(makeItem(app));
    });
  }

  /* ----------------------------------------------------------------------
   * Menu Iniciar, busca, energia e relógio
   * -------------------------------------------------------------------- */
  function toggleStart(force) {
    const menu = $('#start-menu');
    const btn = $('#start-button');
    const visible = force !== undefined ? force : !menu.classList.contains('visible');
    menu.classList.toggle('visible', visible);
    btn.classList.toggle('open', visible);
    if (visible) $('#search-input').focus();
  }

  function startClock() {
    const timeEl = $('#clock-time');
    const dateEl = $('#clock-date');
    const tick = () => {
      const now = new Date();
      timeEl.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      dateEl.textContent = now.toLocaleDateString('pt-BR');
    };
    tick();
    setInterval(tick, 1000);
  }

  function wireShell() {
    $('#start-button').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStart();
    });
    // Clique fora do menu fecha o Menu Iniciar
    document.addEventListener('pointerdown', (e) => {
      const menu = $('#start-menu');
      if (menu.classList.contains('visible') &&
          !menu.contains(e.target) && !$('#start-button').contains(e.target)) {
        toggleStart(false);
      }
      // Clique no "vazio" do desktop limpa seleção de ícones
      if (e.target.closest('#desktop') && !e.target.closest('.desktop-icon') &&
          !e.target.closest('.app-window')) {
        document.querySelectorAll('.desktop-icon.selected').forEach((i) => i.classList.remove('selected'));
      }
    });

    // Busca do Menu Iniciar: filtra os apps pelo texto
    $('#search-input').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('.start-app').forEach((b) => {
        b.classList.toggle('dimmed', q.length > 0 && !b.textContent.toLowerCase().includes(q));
      });
    });

    // Energia: "suspensão" simulada com overlay
    $('#power-button').addEventListener('click', () => {
      $('#power-overlay').classList.remove('hidden');
      toggleStart(false);
    });
    $('#power-wake').addEventListener('click', () => {
      $('#power-overlay').classList.add('hidden');
      WebOS.toast('Bem-vindo de volta ao Porthole WebOS.');
    });
  }

  /* ----------------------------------------------------------------------
   * Boot
   * -------------------------------------------------------------------- */
  function boot() {
    buildDesktopIcons();
    buildStartMenu();
    startClock();
    wireShell();
    setTimeout(() => {
      const splash = $('#boot-screen');
      splash.classList.add('fade-out');
      setTimeout(() => splash.remove(), 600);
      WebOS.toast('Porthole WebOS iniciado. Dê duplo clique no ícone DOOM para jogar.');
    }, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
