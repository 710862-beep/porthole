/*
 * shim-user32.js — janelas Win32 → DOM e eventos DOM → mensagens WM_*.
 * É um subconjunto user-mode: nenhum window manager/kernel Windows é emulado.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const Shim = Porthole.Shim;

  const WM = Object.freeze({
    NULL: 0x0000, CREATE: 0x0001, DESTROY: 0x0002, MOVE: 0x0003,
    SIZE: 0x0005, PAINT: 0x000f, CLOSE: 0x0010, QUIT: 0x0012,
    INPUT: 0x00ff,
    KEYDOWN: 0x0100, KEYUP: 0x0101, CHAR: 0x0102,
    MOUSEMOVE: 0x0200, LBUTTONDOWN: 0x0201, LBUTTONUP: 0x0202,
    RBUTTONDOWN: 0x0204, RBUTTONUP: 0x0205, MOUSEWHEEL: 0x020a,
  });
  const VK = Object.freeze({ BACK: 8, TAB: 9, RETURN: 13, SHIFT: 16, CONTROL: 17, ESCAPE: 27, SPACE: 32, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 });

  function virtualKey(event) {
    const named = { ArrowLeft: VK.LEFT, ArrowUp: VK.UP, ArrowRight: VK.RIGHT, ArrowDown: VK.DOWN, Enter: VK.RETURN, Escape: VK.ESCAPE, Backspace: VK.BACK, Tab: VK.TAB, Shift: VK.SHIFT, Control: VK.CONTROL, ' ': VK.SPACE };
    if (Object.prototype.hasOwnProperty.call(named, event.key)) return named[event.key];
    if (/^[a-z]$/i.test(event.key)) return event.key.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(event.key)) return event.key.charCodeAt(0);
    return 0;
  }

  class User32Shim extends Shim {
    constructor(context) {
      super('user32.dll', context);
      this.document = context.document || global.document;
      this.windowLayer = context.windowLayer || null;
      this.windows = new Map();
      this.nextWindow = 1;
      this.queue = [];
      this.input = { keys: new Set(), mouse: { x: 0, y: 0, buttons: 0, active: false }, focused: false, messages: 0 };
      this.inputElement = null;
      this.inputDisposers = [];
      this.rawInput = Porthole.RawInputManager ? new Porthole.RawInputManager({
        document: this.document,
        postMessage: (hwnd, message, wParam, lParam) => this.PostMessageW(hwnd, message, wParam, lParam),
        onCaptureChange: (locked) => { if (!locked) this.input.mouse.buttons = 0; },
      }) : null;
    }

    CreateWindowExA(exStyle, className, title, style, x, y, width, height) {
      return this._call('CreateWindowExA', arguments, () => this._createWindow(className, title, style, x, y, width, height));
    }
    CreateWindowExW(exStyle, className, title, style, x, y, width, height) {
      return this._call('CreateWindowExW', arguments, () => this._createWindow(className, title, style, x, y, width, height));
    }

    _createWindow(className, title, style, x, y, width, height) {
      const handle = this.nextWindow++;
      let element = null;
      let client = null;
      if (this.document && this.windowLayer) {
        element = this.document.createElement('section');
        element.className = 'win32-window';
        element.dataset.hwnd = String(handle);
        const titlebar = this.document.createElement('div');
        titlebar.className = 'win32-window-title';
        titlebar.textContent = String(title || className || 'Win32 window');
        client = this.document.createElement('div');
        client.className = 'win32-window-client';
        element.append(titlebar, client);
        element.style.left = `${Number(x) >= 0 && Number(x) < 0x7fffffff ? Number(x) : 16}px`;
        element.style.top = `${Number(y) >= 0 && Number(y) < 0x7fffffff ? Number(y) : 16}px`;
        element.style.width = `${Math.max(80, Number(width) > 0 && Number(width) < 0x7fffffff ? Number(width) : 640)}px`;
        element.style.height = `${Math.max(60, Number(height) > 0 && Number(height) < 0x7fffffff ? Number(height) : 480)}px`;
        this.windowLayer.appendChild(element);
      }
      this.windows.set(handle, { handle, className, title: String(title || ''), style, element, client, wndProc: null, visible: true, x, y, width, height });
      this.PostMessageW(handle, WM.CREATE, 0, 0);
      return handle;
    }

    _window(handle) {
      const win = this.windows.get(Number(handle));
      if (!win) throw new Error(`HWND inválido: ${handle}.`);
      return win;
    }

    ShowWindow(handle, command) {
      return this._call('ShowWindow', arguments, () => {
        const win = this._window(handle);
        const wasVisible = win.visible;
        win.visible = Number(command) !== 0;
        if (win.element) win.element.hidden = !win.visible;
        return wasVisible;
      });
    }

    UpdateWindow(handle) { return this._call('UpdateWindow', arguments, () => this.SendMessageW(handle, WM.PAINT, 0, 0)); }

    DestroyWindow(handle) {
      return this._call('DestroyWindow', arguments, () => {
        const win = this._window(handle);
        this.SendMessageW(handle, WM.DESTROY, 0, 0);
        if (win.element) win.element.remove();
        this.windows.delete(Number(handle));
        return true;
      });
    }

    SetWindowTextA(handle, text) { return this._call('SetWindowTextA', arguments, () => this._setText(handle, text)); }
    SetWindowTextW(handle, text) { return this._call('SetWindowTextW', arguments, () => this._setText(handle, text)); }
    _setText(handle, text) {
      const win = this._window(handle);
      win.title = String(text);
      const titlebar = win.element && win.element.querySelector('.win32-window-title');
      if (titlebar) titlebar.textContent = win.title;
      return true;
    }
    GetWindowTextW(handle) { return this._window(handle).title; }

    GetClientRect(handle) {
      const win = this._window(handle);
      const rect = win.client && win.client.getBoundingClientRect ? win.client.getBoundingClientRect() : { width: Number(win.width) || 0, height: Number(win.height) || 0 };
      return { left: 0, top: 0, right: rect.width, bottom: rect.height };
    }

    SetWindowLongW(handle, index, value) {
      const win = this._window(handle);
      if (Number(index) === -4) {
        const previous = win.wndProc;
        if (value != null && typeof value !== 'function') throw new TypeError('WndProc JS precisa ser uma função.');
        win.wndProc = value;
        return previous;
      }
      return 0;
    }
    SetWindowLongA(handle, index, value) { return this.SetWindowLongW(handle, index, value); }
    SetWindowLongPtrW(handle, index, value) { return this.SetWindowLongW(handle, index, value); }

    PostMessageW(handle, message, wParam, lParam) {
      if (this.queue.length >= 2048) this.queue.shift();
      this.queue.push({ hwnd: Number(handle), message: Number(message) >>> 0, wParam, lParam, time: Date.now() });
      this.input.messages += 1;
      return true;
    }
    PostMessageA(handle, message, wParam, lParam) { return this.PostMessageW(handle, message, wParam, lParam); }

    SendMessageW(handle, message, wParam, lParam) {
      const win = this._window(handle);
      if (typeof win.wndProc === 'function') return win.wndProc(Number(handle), Number(message) >>> 0, wParam, lParam);
      return 0;
    }
    SendMessageA(handle, message, wParam, lParam) { return this.SendMessageW(handle, message, wParam, lParam); }

    PeekMessageW(handle, removeMessage) {
      const index = this.queue.findIndex((msg) => !handle || msg.hwnd === Number(handle));
      if (index < 0) return null;
      const message = this.queue[index];
      if (removeMessage == null || Number(removeMessage) !== 0) this.queue.splice(index, 1);
      return Object.assign({}, message);
    }
    PeekMessageA(handle, removeMessage) { return this.PeekMessageW(handle, removeMessage); }
    GetMessageW(handle) { return this.PeekMessageW(handle, 1); }

    DispatchMessageW(message) {
      if (!message) return 0;
      return this.SendMessageW(message.hwnd, message.message, message.wParam, message.lParam);
    }
    DispatchMessageA(message) { return this.DispatchMessageW(message); }
    DefWindowProcW() { return 0; }
    DefWindowProcA() { return 0; }

    _raw() {
      if (!this.rawInput) this._unsupported('Raw Input (input-raw.js não carregado)');
      return this.rawInput;
    }
    RegisterRawInputDevices(devices) { return this._call('RegisterRawInputDevices', arguments, () => this._raw().register(devices)); }
    GetRawInputData(handle) { return this._raw().getRawInputData(handle); }
    ClipCursor(rect) { return this._call('ClipCursor', arguments, () => this._raw().clip(rect)); }
    GetClipCursor() { return this._raw().getClip(); }
    SetCapture(handle) {
      return this._call('SetCapture', arguments, async () => {
        const granted = await this._raw().requestCapture();
        return granted ? Number(handle) : 0;
      });
    }
    ReleaseCapture() { return this._call('ReleaseCapture', arguments, () => this._raw().releaseCapture()); }

    attachInput(element) {
      this.detachInput();
      if (!element || !element.addEventListener) return;
      this.inputElement = element;
      const listen = (type, handler, options) => {
        element.addEventListener(type, handler, options);
        this.inputDisposers.push(() => element.removeEventListener(type, handler, options));
      };
      const key = (down) => (event) => {
        const vk = virtualKey(event);
        if (!vk) return;
        this.input.focused = true;
        if (down) this.input.keys.add(vk); else this.input.keys.delete(vk);
        if (!this.rawInput || !this.rawInput.shouldSuppressLegacy('keyboard')) {
          this.PostMessageW(0, down ? WM.KEYDOWN : WM.KEYUP, vk, event.repeat ? 1 : 0);
        }
        if ([VK.LEFT, VK.RIGHT, VK.UP, VK.DOWN, VK.SPACE].includes(vk)) event.preventDefault();
      };
      listen('keydown', key(true));
      listen('keyup', key(false));
      listen('focus', () => { this.input.focused = true; });
      listen('blur', () => { this.input.focused = false; this.input.keys.clear(); this.input.mouse.buttons = 0; });
      const pointer = (event) => {
        this.input.mouse.active = true;
        const rect = element.getBoundingClientRect();
        const width = rect.width || element.width || 1;
        const height = rect.height || element.height || 1;
        const canvasWidth = element.width || width;
        const canvasHeight = element.height || height;
        let x = Math.max(0, Math.min(canvasWidth, (event.clientX - rect.left) * canvasWidth / width));
        let y = Math.max(0, Math.min(canvasHeight, (event.clientY - rect.top) * canvasHeight / height));
        const clip = this.rawInput && this.rawInput.clipRect;
        if (clip) {
          // O browser não confina o cursor do SO sem Pointer Lock. ClipCursor
          // limita o cursor virtual/mensagens ao RECT em coordenadas de cliente.
          const left = Math.max(0, (clip.left - rect.left) * canvasWidth / width);
          const top = Math.max(0, (clip.top - rect.top) * canvasHeight / height);
          const right = Math.min(canvasWidth, (clip.right - rect.left) * canvasWidth / width);
          const bottom = Math.min(canvasHeight, (clip.bottom - rect.top) * canvasHeight / height);
          if (left <= right) x = Math.max(left, Math.min(right, x));
          if (top <= bottom) y = Math.max(top, Math.min(bottom, y));
        }
        this.input.mouse.x = x;
        this.input.mouse.y = y;
      };
      listen('pointermove', (event) => {
        if (!this.rawInput || !this.rawInput.locked) pointer(event);
        else this.input.mouse.active = true;
        if (!this.rawInput || !this.rawInput.shouldSuppressLegacy('mouse')) this.PostMessageW(0, WM.MOUSEMOVE, this.input.mouse.buttons, 0);
      });
      listen('pointerdown', (event) => {
        if (!this.rawInput || !this.rawInput.locked) pointer(event);
        this.input.mouse.buttons |= (1 << event.button);
        this.PostMessageW(0, event.button === 2 ? WM.RBUTTONDOWN : WM.LBUTTONDOWN, event.button, 0);
        if (element.focus) element.focus({ preventScroll: true });
        if (element.setPointerCapture) element.setPointerCapture(event.pointerId);
      });
      listen('pointerup', (event) => {
        if (!this.rawInput || !this.rawInput.locked) pointer(event);
        this.input.mouse.buttons &= ~(1 << event.button);
        this.PostMessageW(0, event.button === 2 ? WM.RBUTTONUP : WM.LBUTTONUP, event.button, 0);
      });
      listen('contextmenu', (event) => event.preventDefault());
      listen('wheel', (event) => { this.PostMessageW(0, WM.MOUSEWHEEL, event.deltaY, 0); event.preventDefault(); }, { passive: false });
      if (this.rawInput) this.rawInput.attach(element);
    }

    detachInput() {
      for (const dispose of this.inputDisposers.splice(0)) dispose();
      if (this.rawInput) this.rawInput.detach();
      this.input.keys.clear();
      this.inputElement = null;
    }

    GetAsyncKeyState(key) {
      if (typeof key === 'string') {
        if (/^Key[A-Z]$/.test(key)) key = key.charCodeAt(3);
        else if (/^Digit[0-9]$/.test(key)) key = key.charCodeAt(5);
      }
      return this.input.keys.has(Number(key)) ? 0x8000 : 0;
    }
    GetCursorPos() { return { x: this.input.mouse.x, y: this.input.mouse.y }; }

    dispose() {
      this.detachInput();
      if (this.rawInput) this.rawInput.dispose();
      for (const win of this.windows.values()) if (win.element) win.element.remove();
      this.windows.clear();
      this.queue.length = 0;
    }
  }

  Porthole.User32Shim = User32Shim;
  Porthole.Win32 = Object.assign(Porthole.Win32 || {}, { WM, VK, virtualKey });
})(typeof window !== 'undefined' ? window : globalThis);
