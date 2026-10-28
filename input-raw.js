/*
 * input-raw.js — Raw Input e Pointer Lock para a ponte user32.
 * A API JS entrega objetos de pacote; não finge o layout binário completo de
 * RAWINPUT. Deltas relativos só são emitidos com pointerLockElement ativo.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const WM_INPUT = 0x00ff;
  const RIDEV_NOLEGACY = 0x30;
  const USAGE = Object.freeze({ MOUSE: 2, KEYBOARD: 6 });

  class RawInputManager {
    constructor(options) {
      const opts = options || {};
      this.document = opts.document || global.document || null;
      this.postMessage = typeof opts.postMessage === 'function' ? opts.postMessage : function () {};
      this.onCaptureChange = typeof opts.onCaptureChange === 'function' ? opts.onCaptureChange : function () {};
      this.element = null;
      this.registrations = new Map();
      this.packets = new Map();
      this.nextPacket = 1;
      this.sequence = 0;
      this.clipRect = null;
      this.locked = false;
      this.capturePending = null;
      this.cancelCapture = null;
      this.disposers = [];
      this.lastError = null;
    }

    attach(element) {
      this.detach();
      if (!element || !element.addEventListener) return;
      this.element = element;
      this.document = element.ownerDocument || this.document || global.document || null;
      const listen = (target, type, handler, options) => {
        if (!target || !target.addEventListener) return;
        target.addEventListener(type, handler, options);
        this.disposers.push(() => target.removeEventListener(type, handler, options));
      };
      listen(element, 'pointermove', (event) => this._mouse(event));
      listen(element, 'keydown', (event) => this._keyboard(event, true));
      listen(element, 'keyup', (event) => this._keyboard(event, false));
      listen(element, 'blur', () => { if (this.locked) this.releaseCapture(); });
      listen(this.document, 'pointerlockchange', () => this._lockChanged());
      listen(this.document, 'pointerlockerror', () => this._captureFailed(new Error('Pointer Lock foi negado pelo navegador.')));
      listen(this.document, 'visibilitychange', () => { if (this.document.hidden && this.locked) this.releaseCapture(); });
      this._lockChanged();
    }

    register(devices) {
      if (!Array.isArray(devices) || !devices.length || devices.length > 32) throw new TypeError('RegisterRawInputDevices requer 1–32 dispositivos.');
      const next = new Map();
      for (const device of devices) {
        const usagePage = Number(device.usagePage == null ? device.usUsagePage : device.usagePage);
        const usage = Number(device.usage == null ? device.usUsage : device.usage);
        const flags = Number(device.flags == null ? device.dwFlags || 0 : device.flags) >>> 0;
        const hwnd = Number(device.hwnd == null ? device.hwndTarget || 0 : device.hwnd) || 0;
        if (usagePage !== 1 || ![USAGE.MOUSE, USAGE.KEYBOARD].includes(usage)) {
          const error = new Error(`Raw Input usage não suportado: ${usagePage}/${usage}.`);
          error.code = 'NOT_IMPLEMENTED';
          throw error;
        }
        if (flags & ~RIDEV_NOLEGACY) {
          const error = new Error(`Flags Raw Input não suportadas: 0x${flags.toString(16)}.`);
          error.code = 'NOT_IMPLEMENTED';
          throw error;
        }
        next.set(usage, { usagePage, usage, flags, hwnd });
      }
      this.registrations = next;
      this.lastError = null;
      return true;
    }

    shouldSuppressLegacy(kind) {
      const usage = kind === 'keyboard' ? USAGE.KEYBOARD : USAGE.MOUSE;
      const registration = this.registrations.get(usage);
      return Boolean(registration && (registration.flags & RIDEV_NOLEGACY) && (kind === 'keyboard' || this.locked));
    }

    clip(rect) {
      if (rect == null) { this.clipRect = null; return true; }
      const normalized = { left: Number(rect.left), top: Number(rect.top), right: Number(rect.right), bottom: Number(rect.bottom) };
      if (!Object.values(normalized).every(Number.isFinite) || normalized.right < normalized.left || normalized.bottom < normalized.top) {
        throw new TypeError('RECT inválido para ClipCursor.');
      }
      this.clipRect = normalized;
      return true;
    }

    getClip() { return this.clipRect ? Object.assign({}, this.clipRect) : null; }

    requestCapture() {
      if (!this.element || typeof this.element.requestPointerLock !== 'function' || !this.document) {
        this.lastError = new Error('Pointer Lock indisponível; chame a partir de um gesto do usuário em um navegador compatível.');
        return Promise.resolve(false);
      }
      if (this.document.pointerLockElement === this.element) { this._lockChanged(); return Promise.resolve(true); }
      if (this.capturePending) return this.capturePending;

      const element = this.element;
      const document = this.document;
      let resolveCapture;
      const pending = new Promise((resolve) => { resolveCapture = resolve; });
      this.capturePending = pending;
      let settled = false;
      let timer = 0;
      const cleanup = () => {
        document.removeEventListener('pointerlockchange', changed);
        document.removeEventListener('pointerlockerror', failed);
        if (timer) clearTimeout(timer);
      };
      const finish = (result, error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.capturePending === pending) this.capturePending = null;
        this.cancelCapture = null;
        this.lastError = error || null;
        resolveCapture(result);
      };
      const changed = () => { if (document.pointerLockElement === element) { this._lockChanged(); finish(true); } };
      const failed = () => finish(false, new Error('Pointer Lock foi negado pelo navegador.'));
      this.cancelCapture = () => finish(false, new Error('Captura cancelada porque o elemento foi desanexado.'));
      document.addEventListener('pointerlockchange', changed);
      document.addEventListener('pointerlockerror', failed);
      timer = setTimeout(() => finish(false, new Error('Pointer Lock não foi confirmado; o navegador exige gesto/foco.')), 1500);
      try {
        // A chamada ocorre antes de qualquer await para preservar a ativação
        // transitória do gesto que invocou SetCapture.
        const result = element.requestPointerLock();
        if (result && typeof result.catch === 'function') result.catch((error) => finish(false, error));
        if (document.pointerLockElement === element) Promise.resolve().then(changed);
      } catch (error) { finish(false, error); }
      return pending;
    }

    releaseCapture() {
      if (!this.document || this.document.pointerLockElement !== this.element) return false;
      if (typeof this.document.exitPointerLock !== 'function') return false;
      this.document.exitPointerLock();
      return true;
    }

    _lockChanged() {
      const locked = Boolean(this.element && this.document && this.document.pointerLockElement === this.element);
      if (locked === this.locked) return;
      this.locked = locked;
      if (!locked) this.sequence = 0;
      this.onCaptureChange(locked);
    }

    _captureFailed(error) {
      this.lastError = error;
      // O listener temporário de requestCapture trata a resolução do Promise.
    }

    _emitPacket(data, registration) {
      const handle = this.nextPacket++;
      const packet = Object.assign({ handle, sequence: ++this.sequence, timestamp: global.performance ? performance.now() : Date.now() }, data);
      this.packets.set(handle, packet);
      if (this.packets.size > 256) this.packets.delete(this.packets.keys().next().value);
      this.postMessage(registration.hwnd || 0, WM_INPUT, 0, handle);
    }

    _mouse(event) {
      const registration = this.registrations.get(USAGE.MOUSE);
      if (!registration || !this.locked) return;
      const dx = Number(event.movementX) || 0;
      const dy = Number(event.movementY) || 0;
      if (!dx && !dy) return;
      this._emitPacket({ type: 'mouse', dx, dy, buttons: Number(event.buttons) || 0 }, registration);
    }

    _keyboard(event, down) {
      const registration = this.registrations.get(USAGE.KEYBOARD);
      if (!registration) return;
      const virtualKey = Porthole.Win32 && Porthole.Win32.virtualKey ? Porthole.Win32.virtualKey(event) : Number(event.keyCode) || 0;
      if (!virtualKey) return;
      this._emitPacket({ type: 'keyboard', virtualKey, scanCode: Number(event.scanCode) || 0, flags: down ? 0 : 1, repeat: Boolean(event.repeat) }, registration);
    }

    getRawInputData(handle) {
      const packet = this.packets.get(Number(handle));
      if (!packet) return null;
      return { header: { type: packet.type === 'mouse' ? 0 : 1 }, data: Object.assign({}, packet) };
    }

    detach() {
      if (this.cancelCapture) this.cancelCapture();
      for (const dispose of this.disposers.splice(0)) dispose();
      if (this.locked && this.document && typeof this.document.exitPointerLock === 'function') this.document.exitPointerLock();
      this.element = null;
      this.locked = false;
      this.capturePending = null;
    }

    dispose() {
      this.detach();
      this.registrations.clear();
      this.packets.clear();
      this.clipRect = null;
    }
  }

  Porthole.RawInputManager = RawInputManager;
  Porthole.RawInput = { WM_INPUT, RIDEV_NOLEGACY, USAGE };
})(typeof window !== 'undefined' ? window : globalThis);
