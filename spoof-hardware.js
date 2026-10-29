/*
 * spoof-hardware.js — nome mantido pela estrutura solicitada, sem evasão.
 * Fornece identidade virtual coerente e relógio monotônico; não finge hardware
 * físico, não esconde Wine/VM e não implementa bypass de anti-cheat/debugging.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  class MonotonicClock {
    constructor(options) {
      const opts = options || {};
      this.source = typeof opts.now === 'function'
        ? opts.now
        : () => global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now();
      this.last = 0;
    }

    now() {
      const value = Number(this.source());
      if (!Number.isFinite(value) || value < 0) throw new Error('Fonte de relógio monotônico inválida.');
      this.last = Math.max(this.last, value);
      return this.last;
    }

    getTickCount() { return Math.floor(this.now()) >>> 0; }
    getTickCount64() { return Math.floor(this.now()); }
    queryPerformanceCounter() { return BigInt(Math.floor(this.now() * 1000)); }
    queryPerformanceFrequency() { return 1000000n; } // counter está em microssegundos
  }

  class HardwareIdentity {
    constructor(options) {
      const opts = options || {};
      this.renderer = opts.renderer || null;
      this.processors = Math.max(1, Number(opts.processors || global.navigator && global.navigator.hardwareConcurrency || 1) | 0);
      this.architecture = opts.architecture === 'x64' ? 'x64' : 'x86';
    }

    getProfile() {
      return {
        virtual: true,
        manufacturer: 'Porthole',
        model: 'Porthole Win32 user-mode compatibility layer',
        architecture: this.architecture,
        processors: this.processors,
        processor: { manufacturer: 'Porthole', name: `Porthole virtual ${this.architecture} CPU` },
        display: {
          name: this.renderer && this.renderer.label || 'Porthole virtual display',
          api: this.renderer && this.renderer.api || 'Canvas/WebGL',
          physical: false,
        },
      };
    }

    queryWMI(className) {
      const profile = this.getProfile();
      switch (String(className || '').toLocaleLowerCase('en-US')) {
        case 'win32_computersystem':
          return { Manufacturer: profile.manufacturer, Model: profile.model, VirtualMachine: true };
        case 'win32_processor':
          return { Manufacturer: profile.processor.manufacturer, Name: profile.processor.name, NumberOfLogicalProcessors: profile.processors };
        case 'win32_videocontroller':
          return { Name: profile.display.name, VideoProcessor: profile.display.api, AdapterCompatibility: 'Porthole', Virtual: true };
        default: {
          const error = new Error(`Classe WMI não suportada: ${className}.`);
          error.code = 'NOT_IMPLEMENTED';
          throw error;
        }
      }
    }
  }

  Porthole.MonotonicClock = MonotonicClock;
  Porthole.HardwareIdentity = HardwareIdentity;
})(typeof window !== 'undefined' ? window : globalThis);
