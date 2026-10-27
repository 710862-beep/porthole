/* ==========================================================================
   window-manager.js — Gerenciador de janelas do Porthole WebOS
   Vanilla JS puro, sem dependências. Usa Pointer Events (mouse + toque).

   Conceitos:
   - Cada janela é um objeto Win (DOM + estado + controller).
   - O z-index é monotônico: focar uma janela sempre a põe no topo.
   - Arrastar: pointerdown no titlebar → setPointerCapture → move no documento.
   - Redimensionar: 8 alças (.resize-handle) com direções N/S/E/W + diagonais.
   - Minimizar/maximizar/fechar refletem no botão correspondente da taskbar.
   ========================================================================== */
(function () {
  'use strict';

  const WebOS = (window.WebOS = window.WebOS || {});
  const layer = () => document.getElementById('window-layer');
  const taskbarButtons = () => document.getElementById('taskbar-windows');

  const TASKBAR_H = 40; // deve coincidir com --taskbar-h do CSS
  const EDGE = 8;

  let topZ = 100;        // próximo z-index disponível
  let seq = 0;           // sequência para ids únicos
  const windows = new Map();

  /* ----------------------------------------------------------------------
   * Win: representa uma janela do WebOS
   * -------------------------------------------------------------------- */
  class Win {
    constructor(opts) {
      this.id = opts.id || `win-${++seq}`;
      this.title = opts.title || 'Janela';
      this.glyph = opts.glyph || '🗔';
      this.opts = opts;
      this.isMinimized = false;
      this.isMaximized = false;
      this.prevRect = null; // retângulo antes de maximizar
      this.active = false;

      this._buildDom(opts.width || 720, opts.height || 480);
      this._wireControls();
      this._wireDrag();
      this._wireResize();
      windows.set(this.id, this);
    }

    _buildDom(w, h) {
      const el = document.createElement('div');
      el.className = 'app-window';
      el.dataset.winId = this.id;
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      // Posição inicial em cascata, dentro da área útil do desktop
      const desktop = document.getElementById('desktop');
      const maxLeft = Math.max(10, desktop.clientWidth - w - 24);
      const maxTop = Math.max(10, desktop.clientHeight - h - 24);
      const offset = (windows.size % 6) * 26;
      el.style.left = Math.min(40 + offset, maxLeft) + 'px';
      el.style.top = Math.min(30 + offset, maxTop) + 'px';
      el.style.zIndex = ++topZ;

      el.innerHTML = `
        <div class="window-titlebar">
          <div class="window-title">
            <span class="wt-glyph">${this.glyph}</span>
            <span class="wt-text"></span>
          </div>
          <div class="window-controls">
            <button class="win-min" title="Minimizar" aria-label="Minimizar">─</button>
            <button class="win-max" title="Maximizar" aria-label="Maximizar">▢</button>
            <button class="win-close" title="Fechar" aria-label="Fechar">✕</button>
          </div>
        </div>
        <div class="window-body"></div>
        <div class="resize-handle rh-n"  data-dir="n"></div>
        <div class="resize-handle rh-s"  data-dir="s"></div>
        <div class="resize-handle rh-e"  data-dir="e"></div>
        <div class="resize-handle rh-w" data-dir="w"></div>
        <div class="resize-handle rh-ne" data-dir="ne"></div>
        <div class="resize-handle rh-nw" data-dir="nw"></div>
        <div class="resize-handle rh-se" data-dir="se"></div>
        <div class="resize-handle rh-sw" data-dir="sw"></div>
      `;
      el.querySelector('.wt-text').textContent = this.title;
      layer().appendChild(el);

      this.el = el;
      this.body = el.querySelector('.window-body');
      this.titlebar = el.querySelector('.window-titlebar');

      // Botão correspondente na taskbar
      const tb = document.createElement('button');
      tb.className = 'taskbar-app';
      tb.dataset.winId = this.id;
      tb.innerHTML = `<span class="ta-glyph">${this.glyph}</span><span></span>`;
      tb.querySelector('span:last-child').textContent = this.title;
      tb.addEventListener('click', () => {
        if (this.isMinimized) this.restore();
        else if (this.active) this.minimize();
        else this.focus();
      });
      taskbarButtons().appendChild(tb);
      this.taskbarBtn = tb;

      // Qualquer clique no corpo da janela também a foca (sem roubar foco de inputs)
      el.addEventListener('pointerdown', () => this.focus());
    }

    _wireControls() {
      this.el.querySelector('.win-min').addEventListener('click', (e) => {
        e.stopPropagation();
        this.minimize();
      });
      this.el.querySelector('.win-max').addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMaximize();
      });
      this.el.querySelector('.win-close').addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
      });
      // Duplo clique no titlebar maximiza/restaura, como no Windows
      this.titlebar.addEventListener('dblclick', (e) => {
        e.preventDefault();
        this.toggleMaximize();
      });
    }

    /* --------------------------------------------------------------------
     * Arrastar pela barra de título
     * ------------------------------------------------------------------ */
    _wireDrag() {
      this.titlebar.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.window-controls')) return;
        if (this.isMaximized) return; // maximizada não arrasta
        e.preventDefault();
        this.focus();
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = this.el.getBoundingClientRect();
        this.titlebar.setPointerCapture(e.pointerId);
        this.el.classList.add('is-dragging');

        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          const desktop = document.getElementById('desktop');
          // Mantém ao menos uma faixa da titlebar visível e dentro do desktop
          const maxLeft = desktop.clientWidth - 60;
          const maxTop = desktop.clientHeight - this.titlebar.offsetHeight;
          const left = Math.min(Math.max(rect.left + dx, -rect.width + 80), maxLeft);
          const top = Math.min(Math.max(rect.top + dy, 0), maxTop);
          this.el.style.left = left + 'px';
          this.el.style.top = top + 'px';
        };
        const onUp = (ev) => {
          this.titlebar.releasePointerCapture(ev.pointerId);
          this.el.classList.remove('is-dragging');
          this.titlebar.removeEventListener('pointermove', onMove);
          this.titlebar.removeEventListener('pointerup', onUp);
        };
        this.titlebar.addEventListener('pointermove', onMove);
        this.titlebar.addEventListener('pointerup', onUp);
      });
    }

    /* --------------------------------------------------------------------
     * Redimensionar por 8 alças direcionais
     * ------------------------------------------------------------------ */
    _wireResize() {
      this.el.querySelectorAll('.resize-handle').forEach((handle) => {
        handle.addEventListener('pointerdown', (e) => {
          if (this.isMaximized) return;
          e.preventDefault();
          e.stopPropagation();
          this.focus();
          const dir = handle.dataset.dir;
          const startX = e.clientX;
          const startY = e.clientY;
          const rect = this.el.getBoundingClientRect();
          const minW = 320;
          const minH = 200;
          handle.setPointerCapture(e.pointerId);
          this.el.classList.add('is-resizing');

          const onMove = (ev) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            let { left, top, width, height } = rect;
            if (dir.includes('e')) width = Math.max(minW, rect.width + dx);
            if (dir.includes('s')) height = Math.max(minH, rect.height + dy);
            if (dir.includes('w')) {
              width = Math.max(minW, rect.width - dx);
              left = rect.right - width;
            }
            if (dir.includes('n')) {
              height = Math.max(minH, rect.height - dy);
              top = rect.bottom - height;
            }
            const desktop = document.getElementById('desktop');
            // Limita ao retângulo do desktop
            if (top < 0) { height += top; top = 0; }
            if (left < 0) { width += left; left = 0; }
            height = Math.min(height, desktop.clientHeight - top);
            width = Math.min(width, desktop.clientWidth - left);
            Object.assign(this.el.style, {
              left: left + 'px', top: top + 'px',
              width: width + 'px', height: height + 'px',
            });
          };
          const onUp = (ev) => {
            handle.releasePointerCapture(ev.pointerId);
            this.el.classList.remove('is-resizing');
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
          };
          handle.addEventListener('pointermove', onMove);
          handle.addEventListener('pointerup', onUp);
        });
      });
    }

    /* --------------------------------------------------------------------
     * Ciclo de vida e foco
     * ------------------------------------------------------------------ */
    focus() {
      if (this.isMinimized) this.restore();
      if (getActive() === this) {
        this.el.style.zIndex = ++topZ;
        return;
      }
      windows.forEach((w) => w._setActive(false));
      this._setActive(true);
      this.el.style.zIndex = ++topZ;
      if (typeof this.opts.onFocus === 'function') this.opts.onFocus(this);
    }

    _setActive(active) {
      this.active = active;
      this.el.classList.toggle('inactive', !active);
      this.taskbarBtn.classList.toggle('active', active && !this.isMinimized);
    }

    minimize() {
      this.isMinimized = true;
      this.el.classList.add('minimized');
      this.taskbarBtn.classList.remove('active');
      if (typeof this.opts.onBlur === 'function') this.opts.onBlur(this);
      // Foca a próxima janela do topo, se houver
      const next = [...windows.values()]
        .filter((w) => !w.isMinimized && w !== this)
        .sort((a, b) => parseInt(b.el.style.zIndex) - parseInt(a.el.style.zIndex))[0];
      if (next) next.focus();
    }

    restore() {
      this.isMinimized = false;
      this.el.classList.remove('minimized');
      this.focus();
    }

    toggleMaximize() {
      if (this.isMaximized) {
        this.isMaximized = false;
        this.el.classList.remove('maximized');
        if (this.prevRect) Object.assign(this.el.style, this.prevRect);
      } else {
        this.prevRect = {
          left: this.el.style.left, top: this.el.style.top,
          width: this.el.style.width, height: this.el.style.height,
        };
        this.isMaximized = true;
        this.el.classList.add('maximized');
      }
      this.focus();
    }

    setTitle(t) {
      this.title = t;
      this.el.querySelector('.wt-text').textContent = t;
      this.taskbarBtn.querySelector('span:last-child').textContent = t;
    }

    close() {
      if (typeof this.opts.onClose === 'function') {
        // O callback pode retornar false para impedir o fechamento
        if (this.opts.onClose(this) === false) return;
      }
      windows.delete(this.id);
      this.el.remove();
      this.taskbarBtn.remove();
      if (getActive() === this) {
        const next = [...windows.values()]
          .filter((w) => !w.isMinimized)
          .sort((a, b) => parseInt(b.el.style.zIndex) - parseInt(a.el.style.zIndex))[0];
        if (next) next.focus();
        else if (typeof this.opts.onBlur === 'function') this.opts.onBlur(this);
      }
    }
  }

  function getActive() {
    return [...windows.values()].find((w) => w.active && !w.isMinimized) || null;
  }

  /* API pública do Window Manager */
  WebOS.wm = {
    create(opts) {
      const win = new Win(opts);
      if (typeof opts.mount === 'function') opts.mount(win);
      win.focus();
      return win;
    },
    get(id) { return windows.get(id) || null; },
    getActive,
    byApp(appId) { return [...windows.values()].find((w) => w.opts.appId === appId) || null; },
    closeAll() { [...windows.values()].forEach((w) => w.close()); },
    _windows: windows,
  };
})();
