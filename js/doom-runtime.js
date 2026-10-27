/* ==========================================================================
   doom-runtime.js — Host JavaScript do motor DOOM em WebAssembly

   Motor: jacobenget/doom.wasm (GPL-2), ABI minimalista de 14 símbolos.
   Este arquivo implementa os 10 IMPORTS que o módulo exige e consome seus
   EXPORTS. Toda a comunicação UI(DOM) <-> motor(Wasm) acontece por aqui.

   Pontes fundamentais (comentadas no código):
   1. Memória linear compartilhada: o framebuffer do DOOM vive dentro do
      ArrayBuffer exportado pelo Wasm; lemos via Uint8Array e desenhamos no
      <canvas> com putImageData.
   2. WAD: fetch -> ArrayBuffer -> cópia para a memória Wasm dentro do
      callback loading.readWads (protocolo de 2 etapas wadSizes/readWads).
   3. Input: eventos DOM (KeyboardEvent/PointerEvent) são traduzidos para os
      códigos de tecla do DOOM e entregues via reportKeyDown/reportKeyUp.
   ========================================================================== */
(function () {
  'use strict';

  const WebOS = (window.WebOS = window.WebOS || {});

  // Caminho feliz: 100% same-origin (vendoreado). Remoto é só fallback de
  // emergência e ambos os mirrors respondem Access-Control-Allow-Origin: *.
  const ASSETS = {
    wasmLocal: 'vendor/doom/doom.wasm',
    wadLocal: 'vendor/doom/DOOM1.WAD',
    wasmMirrors: [
      'https://cdn.jsdelivr.net/gh/jacobenget/doom.wasm@gh-pages/examples/browser/assets/doom.wasm',
      'https://raw.githubusercontent.com/jacobenget/doom.wasm/gh-pages/examples/browser/assets/doom.wasm',
    ],
    wadMirrors: [
      'https://cdn.jsdelivr.net/gh/abus-sh/doom-wasm@main/linuxdoom-1.10/doom1.wad',
      'https://raw.githubusercontent.com/abus-sh/doom-wasm/main/linuxdoom-1.10/doom1.wad',
    ],
  };

  const TICK_HZ = 35; // o DOOM clássico trabalha a 35 tics por segundo

  class DoomRuntime {
    /**
     * @param {HTMLCanvasElement} canvas elemento DOM que exibirá o jogo
     * @param {object} opts callbacks e URLs customizados
     */
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.opts = Object.assign({
        wasmUrl: ASSETS.wasmLocal,
        wadUrl: ASSETS.wadLocal,
        onLog: () => {},        // (mensagem, nível) => void
        onStatus: () => {},     // (estado, detalhe) => void
        onFps: () => {},        // (fps, framesNoSegundo) => void
      }, opts);

      this.state = 'idle';       // idle | loading | running | paused | error
      this.wadSource = null;    // 'local' | 'remote' | 'embedded'
      this.wasmSource = null;
      this.inputEnabled = false;
      this.running = false;

      this._memory = null;
      this._exports = null;
      this._imageData = null;
      this._ctx2d = canvas.getContext('2d', { alpha: false });
      this._pressed = new Set();
      this._keyMap = new Map();

      this._acc = 0;
      this._lastTs = 0;
      this._framesThisSecond = 0;
      this._fpsCheckpoint = 0;
      this._rafId = 0;
      this._destroyed = false;
      // Registry de instâncias (útil para diagnósticos e testes automatizados)
      DoomRuntime._instances.push(this);
      DoomRuntime._last = this;
    }

    static _instances = [];

    /* --------------------------------------------------------------------
     * Carregamento do WAD (fetch -> ArrayBuffer validado)
     * ------------------------------------------------------------------ */
    async _fetchWad() {
      // wadUrl === null significa "pule o fetch e use o WAD embutido no .wasm"
      // (usado pelo benchmark de FPS do Diagnostics para isolar CPU/GPU de rede)
      if (this.opts.wadUrl === null) {
        this.wadSource = 'embedded';
        this.opts.onLog('WAD embutido solicitado explicitamente (sem fetch)', 'dim');
        return null;
      }
      const candidates = [
        { url: this.opts.wadUrl, source: 'local' },
        ...ASSETS.wadMirrors.map((url) => ({ url, source: 'remote' })),
      ];
      for (const cand of candidates) {
        try {
          this.opts.onLog(`Buscando WAD em ${cand.url}`, 'dim');
          const res = await fetch(cand.url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const buf = await res.arrayBuffer();
          // Validações do teste (c): status ok, tamanho e magic "IWAD"
          if (buf.byteLength < 1_000_000) throw new Error('WAD menor que o esperado');
          const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
          if (magic !== 'IWAD') throw new Error('Magic inválido: ' + magic);
          this.wadSource = cand.source;
          this.opts.onLog(`WAD carregado (${cand.source}): ${buf.byteLength} bytes, magic IWAD ✓`, 'ok');
          return new Uint8Array(buf);
        } catch (err) {
          this.opts.onLog(`Falha no WAD (${cand.url}): ${err.message}`, 'err');
        }
      }
      // Nenhum fetch funcionou: o módulo tem o shareware embutido de fábrica
      this.opts.onLog('Usando WAD shareware embutido no próprio .wasm (fallback final)', 'err');
      return null;
    }

    async _fetchWasm() {
      const candidates = [
        { url: this.opts.wasmUrl, source: 'local' },
        ...ASSETS.wasmMirrors.map((url) => ({ url, source: 'remote' })),
      ];
      for (const cand of candidates) {
        try {
          this.opts.onLog(`Buscando módulo Wasm em ${cand.url}`, 'dim');
          const res = await fetch(cand.url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          // instantiate(arrayBuffer) e não instantiateStreaming: independe do
          // MIME application/wasm do servidor.
          const bytes = await res.arrayBuffer();
          this.wasmSource = cand.source;
          this.opts.onLog(`Módulo Wasm baixado (${cand.source}): ${bytes.byteLength} bytes`, 'ok');
          return bytes;
        } catch (err) {
          this.opts.onLog(`Falha no Wasm (${cand.url}): ${err.message}`, 'err');
        }
      }
      throw new Error('Não foi possível obter doom.wasm de nenhuma origem.');
    }

    /* --------------------------------------------------------------------
     * Inicialização completa: WAD + Wasm + imports ABI + input
     * ------------------------------------------------------------------ */
    async init() {
      if (this._destroyed) throw new Error('Runtime já destruído');
      this._setStatus('loading', 'Baixando assets e instanciando WebAssembly…');
      const [wasmBytes, wadBytes] = await Promise.all([this._fetchWasm(), this._fetchWad()]);
      this._wadBytes = wadBytes; // null => módulo usa WAD embutido

      const imports = this._buildImports();
      const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
      this._exports = instance.exports;
      this._memory = instance.exports.memory;
      this._buildKeyMap();
      this._attachInput();

      // initGame dispara, via import, loading.onGameInit(w,h) e o parse do WAD
      this._exports.initGame();
      this._setStatus('running', 'Motor inicializado');
      this.opts.onLog('initGame() executado; motor rodando no tick de 35 Hz', 'ok');
      this.start();
      // Se a janela já estava focada durante o carregamento, aplica o foco agora
      if (this.inputEnabled) this.setInputEnabled(true);
      return this;
    }

    /* -------------------- ABI: os 10 imports do módulo ----------------- */
    _buildImports() {
      const runtime = this;
      return {
        loading: {
          // Chamado 1x: dimensões do framebuffer (640x400 no DOOM clássico)
          onGameInit: (width, height) => {
            runtime.canvas.width = width;
            runtime.canvas.height = height;
            runtime._imageData = runtime._ctx2d.createImageData(width, height);
            runtime.opts.onLog(`onGameInit: framebuffer ${width}x${height} alocado`, 'ok');
          },
          // Etapa 1/2 do WAD: reportar número de arquivos e bytes totais.
          // Escrevemos dois int32 little-endian nos ponteiros fornecidos.
          wadSizes: (nPtr, totalPtr) => {
            const view = new DataView(runtime._memory.buffer);
            if (runtime._wadBytes) {
              view.setInt32(nPtr, 1, true);
              view.setInt32(totalPtr, runtime._wadBytes.byteLength, true);
            } else {
              runtime.wadSource = 'embedded';
              view.setInt32(nPtr, 0, true); // 0 => "use o shareware embutido"
              view.setInt32(totalPtr, 0, true);
            }
          },
          // Etapa 2/2: copiar bytes do WAD direto para a memória linear do
          // Wasm, no endereço que o próprio módulo reservou.
          readWads: (dstPtr, sizesPtr) => {
            const mem = new Uint8Array(runtime._memory.buffer);
            mem.set(runtime._wadBytes, dstPtr);
            new DataView(runtime._memory.buffer)
              .setInt32(sizesPtr, runtime._wadBytes.byteLength, true);
            runtime.opts.onLog(
              `readWads: ${runtime._wadBytes.byteLength} bytes copiados para a memória Wasm @${dstPtr}`, 'ok');
          },
        },
        ui: {
          // A cada quadro pronto, o Wasm entrega o ponteiro do framebuffer.
          // Os pixels estão em BGRA little-endian; o Canvas2D espera RGBA.
          drawFrame: (fbPtr) => runtime._drawFrame(fbPtr),
        },
        runtimeControl: {
          // Monotônico e real: o DOOM faz busy-wait com este relógio.
          timeInMilliseconds: () => BigInt(Math.trunc(performance.now())),
        },
        console: {
          onInfoMessage: (ptr, len) => runtime.opts.onLog(runtime._readString(ptr, len), 'info'),
          onErrorMessage: (ptr, len) => runtime.opts.onLog(runtime._readString(ptr, len), 'err'),
        },
        gameSaving: {
          // Savegames desabilitados nesta integração (stubs da ABI)
          sizeOfSaveGame: () => 0,
          readSaveGame: () => 0,
          writeSaveGame: () => 0,
        },
      };
    }

    /**
     * PONTE DOM <-> WASM (renderização):
     * O motor escreve pixels BGRA dentro da memória linear exportada. Aqui
     * copiamos para um ImageData RGBA do canvas, trocando B e R, e em seguida
     * putImageData pinta no DOM. A view é recriada por chamada porque o Wasm
     * pode crescer a memória (memory.grow), invalidando TypedArrays antigas.
     */
    _drawFrame(fbPtr) {
      const w = this.canvas.width;
      const h = this.canvas.height;
      const src = new Uint8Array(this._memory.buffer, fbPtr, w * h * 4);
      const dst = this._imageData.data;
      for (let i = 0, p = 0; i < src.length; i += 4, p += 4) {
        dst[p] = src[i + 2];     // R <- B
        dst[p + 1] = src[i + 1]; // G
        dst[p + 2] = src[i];     // B <- R
        dst[p + 3] = 255;        // A opaco
      }
      this._ctx2d.putImageData(this._imageData, 0, 0);

      // Contabilidade de FPS reais (quadros efetivamente desenhados)
      this._framesThisSecond++;
    }

    _readString(ptr, len) {
      return new TextDecoder('utf8').decode(new Uint8Array(this._memory.buffer, ptr, len));
    }

    /* --------------------------------------------------------------------
     * PONTE DE INPUT: teclado e mouse do DOM -> códigos DOOM (Wasm)
     * ------------------------------------------------------------------ */
    _buildKeyMap() {
      const k = this._exports;
      // Teclas nomeadas via globais KEY_* exportados pelo módulo
      this._keyMap.set('ArrowLeft', k.KEY_LEFTARROW);
      this._keyMap.set('ArrowRight', k.KEY_RIGHTARROW);
      this._keyMap.set('ArrowUp', k.KEY_UPARROW);
      this._keyMap.set('ArrowDown', k.KEY_DOWNARROW);
      this._keyMap.set(',', k.KEY_STRAFE_L);
      this._keyMap.set('.', k.KEY_STRAFE_R);
      this._keyMap.set('Control', k.KEY_FIRE);
      this._keyMap.set(' ', k.KEY_USE);
      this._keyMap.set('Shift', k.KEY_SHIFT);
      this._keyMap.set('Tab', k.KEY_TAB);
      this._keyMap.set('Escape', k.KEY_ESCAPE);
      this._keyMap.set('Enter', k.KEY_ENTER);
      this._keyMap.set('Backspace', k.KEY_BACKSPACE);
      this._keyMap.set('Alt', k.KEY_ALT);
      // Extensões ergonômicas sobre os mesmos códigos (WASD + E/F)
      this._keyMap.set('w', k.KEY_UPARROW);
      this._keyMap.set('s', k.KEY_DOWNARROW);
      this._keyMap.set('a', k.KEY_STRAFE_L);
      this._keyMap.set('d', k.KEY_STRAFE_R);
      this._keyMap.set('e', k.KEY_USE);
      this._keyMap.set('f', k.KEY_FIRE);
    }

    _domKeyToDoom(event) {
      if (this._keyMap.has(event.key)) return this._keyMap.get(event.key);
      // Caracteres únicos seguem como ASCII (números, letras de menu etc.)
      if (event.key.length === 1) return event.key.charCodeAt(0);
      return null;
    }

    _attachInput() {
      const c = this.canvas;

      this._onKeyDown = (event) => {
        if (!this.inputEnabled) return; // jogo só processa input com a janela ativa
        const doomKey = this._domKeyToDoom(event);
        if (doomKey === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (!this._pressed.has(doomKey)) {
          this._pressed.add(doomKey);
          this._exports.reportKeyDown(doomKey);
        }
      };
      this._onKeyUp = (event) => {
        if (!this.inputEnabled) return;
        const doomKey = this._domKeyToDoom(event);
        if (doomKey === null) return;
        event.preventDefault();
        event.stopPropagation();
        this._pressed.delete(doomKey);
        this._exports.reportKeyUp(doomKey);
      };

      /**
       * PONTE MOUSE -> ENGINE:
       * A ABI de 14 símbolos só expõe eventos de TECLA, não eixos de mouse.
       * Por isso traduzimos os botões do pointer para teclas virtuais do
       * DOOM: clique esquerdo = atirar (KEY_FIRE), clique direito = usar
       * (KEY_USE). O movimento do cursor não gira a visão — limitação honesta
       * da interface mínima do módulo, documentada em README/agents.md.
       */
      this._onMouseDown = (event) => {
        if (!this.inputEnabled) return;
        c.focus();
        if (event.button === 0) {
          this._press(this._exports.KEY_FIRE);
        } else if (event.button === 2) {
          this._press(this._exports.KEY_USE);
        }
      };
      this._onMouseUp = (event) => {
        if (event.button === 0) this._release(this._exports.KEY_FIRE);
        if (event.button === 2) this._release(this._exports.KEY_USE);
      };
      this._onContextMenu = (event) => event.preventDefault();
      this._onBlur = () => this.releaseAllKeys();

      c.addEventListener('keydown', this._onKeyDown);
      c.addEventListener('keyup', this._onKeyUp);
      c.addEventListener('mousedown', this._onMouseDown);
      window.addEventListener('mouseup', this._onMouseUp);
      c.addEventListener('contextmenu', this._onContextMenu);
      c.addEventListener('blur', this._onBlur);
    }

    _press(doomKey) {
      if (!this._pressed.has(doomKey)) {
        this._pressed.add(doomKey);
        this._exports.reportKeyDown(doomKey);
      }
    }
    _release(doomKey) {
      if (this._pressed.has(doomKey)) {
        this._pressed.delete(doomKey);
        this._exports.reportKeyUp(doomKey);
      }
    }
    releaseAllKeys() {
      if (!this._exports) return;
      this._pressed.forEach((k) => this._exports.reportKeyUp(k));
      this._pressed.clear();
    }

    /* --------------------------------------------------------------------
     * Loop de jogo: requestAnimationFrame + acumulador de 35 Hz
     * ------------------------------------------------------------------ */
    start() {
      if (this.running || this._destroyed) return;
      this.running = true;
      this._lastTs = performance.now();
      this._fpsCheckpoint = this._lastTs;
      const frame = (ts) => {
        if (!this.running || this._destroyed) return;
        const dt = Math.min(100, ts - this._lastTs); // evita burst após aba oculta
        this._lastTs = ts;
        this._acc += dt;
        const tickMs = 1000 / TICK_HZ;
        let guard = 0;
        while (this._acc >= tickMs && guard < 5) {
          this._exports.tickGame();
          this._acc -= tickMs;
          guard++;
        }
        // FPS efetivo do raster, reportado uma vez por segundo
        if (ts - this._fpsCheckpoint >= 1000) {
          this.opts.onFps(this._framesThisSecond, this._framesThisSecond);
          this._framesThisSecond = 0;
          this._fpsCheckpoint = ts;
        }
        this._rafId = requestAnimationFrame(frame);
      };
      this._rafId = requestAnimationFrame(frame);
    }

    stop() {
      this.running = false;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this.releaseAllKeys();
    }

    /* Chamado pelo Window Manager no focus/blur da janela do WebOS */
    setInputEnabled(enabled) {
      this.inputEnabled = enabled;
      // Antes do init terminar não há exports nem canvas pronto: não troca status
      if (!this._exports) return;
      if (enabled) {
        this.canvas.focus();
        this._setStatus('running', 'Janela ativa — capturando entrada');
      } else {
        this.releaseAllKeys();
        this.canvas.blur();
        this._setStatus('paused', 'Janela inativa — entrada congelada');
      }
    }

    _setStatus(state, detail) {
      this.state = state;
      this.opts.onStatus(state, detail);
    }

    destroy() {
      this._destroyed = true;
      this.stop();
      const idx = DoomRuntime._instances.indexOf(this);
      if (idx >= 0) DoomRuntime._instances.splice(idx, 1);
      if (DoomRuntime._last === this) DoomRuntime._last = DoomRuntime._instances.at(-1) || null;
      const c = this.canvas;
      c.removeEventListener('keydown', this._onKeyDown);
      c.removeEventListener('keyup', this._onKeyUp);
      c.removeEventListener('mousedown', this._onMouseDown);
      window.removeEventListener('mouseup', this._onMouseUp);
      c.removeEventListener('contextmenu', this._onContextMenu);
      c.removeEventListener('blur', this._onBlur);
      this._exports = null;
      this._memory = null;
    }
  }

  WebOS.DoomRuntime = DoomRuntime;
})();
