/* graphics-device.js — seleção WebGL → CPU baseada em capacidade real. */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  class GraphicsDevice {
    static create(canvas, options) {
      const opts = options || {};
      const log = typeof opts.logger === 'function' ? opts.logger : function () {};
      if (opts.forceSoftware) {
        log('Fallback CPU solicitado pelo usuário; WebGL ignorado.', 'warning');
        return new Porthole.SoftwareRenderer(canvas);
      }
      try {
        const backend = new Porthole.WebGLBackend(canvas, opts);
        const info = backend.getInfo();
        log(`${info.api}: ${info.renderer} → ${info.label}`, info.software ? 'warning' : 'success');
        return backend;
      } catch (error) {
        // Linux/ChromeOS em VMs e Windows sem driver WebGL seguem o mesmo
        // fallback. A decisão depende do contexto real, não apenas do SO.
        log(`WebGL falhou (${error.message}) → rasterizador CPU.`, 'warning');
        return new Porthole.SoftwareRenderer(canvas);
      }
    }
  }

  Porthole.GraphicsDevice = GraphicsDevice;
})(typeof window !== 'undefined' ? window : globalThis);
