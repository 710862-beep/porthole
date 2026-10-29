/* shim-gdi32.js — subconjunto GDI → Canvas 2D. */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const Shim = Porthole.Shim;

  function colorRef(color) {
    const value = Number(color) >>> 0;
    return `rgb(${value & 255}, ${(value >>> 8) & 255}, ${(value >>> 16) & 255})`;
  }

  class GDI32Shim extends Shim {
    constructor(context) {
      super('gdi32.dll', context);
      this.document = context.document || global.document;
      this.defaultCanvas = context.canvas || null;
      this.contexts = new Map();
      this.objects = new Map();
      this.nextHandle = 1;
    }

    _context2d(canvas) {
      return canvas && canvas.getContext ? canvas.getContext('2d') : canvas && canvas.canvas ? canvas : null;
    }

    CreateCompatibleDC(source) {
      return this._call('CreateCompatibleDC', arguments, () => {
        let canvas;
        if (this.document) {
          canvas = this.document.createElement('canvas');
          const sourceCanvas = source && source.canvas || source || this.defaultCanvas;
          canvas.width = sourceCanvas && sourceCanvas.width || 640;
          canvas.height = sourceCanvas && sourceCanvas.height || 480;
        } else {
          // Em testes sem DOM, o contexto fornecido é usado como superfície real.
          canvas = source && source.canvas ? source.canvas : source || this.defaultCanvas;
        }
        const context = this._context2d(canvas);
        if (!context) throw new Error('Canvas 2D indisponível para CreateCompatibleDC.');
        const handle = this.nextHandle++;
        this.contexts.set(handle, { canvas: context.canvas || canvas, context, selected: new Map() });
        return handle;
      });
    }

    GetDC() {
      return this._call('GetDC', arguments, () => {
        const context = this._context2d(this.defaultCanvas);
        if (!context) throw new Error('Canvas 2D indisponível para GetDC.');
        const handle = this.nextHandle++;
        this.contexts.set(handle, { canvas: this.defaultCanvas, context, selected: new Map() });
        return handle;
      });
    }

    _dc(handle) {
      const dc = this.contexts.get(Number(handle));
      if (!dc) throw new Error(`HDC inválido: ${handle}.`);
      return dc;
    }

    DeleteDC(handle) { return this._call('DeleteDC', arguments, () => this.contexts.delete(Number(handle))); }
    ReleaseDC(handle) { return this.DeleteDC(handle); }

    BitBlt(destination, x, y, width, height, source, sourceX, sourceY, rasterOp) {
      return this._call('BitBlt', arguments, () => {
        const op = Number(rasterOp == null ? 0x00cc0020 : rasterOp) >>> 0;
        if (op !== 0x00cc0020) this._unsupported(`BitBlt ROP 0x${op.toString(16)}`);
        const dst = this._dc(destination);
        const src = this._dc(source);
        // CanvasRenderingContext2D.drawImage é a operação equivalente a um
        // SRCCOPY entre device contexts neste subconjunto.
        dst.context.drawImage(src.canvas, Number(sourceX || 0), Number(sourceY || 0), Number(width), Number(height), Number(x), Number(y), Number(width), Number(height));
        return true;
      });
    }

    FillRect(destination, rect, color) {
      return this._call('FillRect', arguments, () => {
        const dc = this._dc(destination);
        dc.context.fillStyle = colorRef(color);
        dc.context.fillRect(Number(rect.left), Number(rect.top), Number(rect.right - rect.left), Number(rect.bottom - rect.top));
        return true;
      });
    }

    SetPixel(destination, x, y, color) {
      return this._call('SetPixel', arguments, () => {
        const dc = this._dc(destination);
        dc.context.fillStyle = colorRef(color);
        dc.context.fillRect(Number(x), Number(y), 1, 1);
        return Number(color) >>> 0;
      });
    }

    CreateSolidBrush(color) {
      const handle = this.nextHandle++;
      this.objects.set(handle, { type: 'brush', color: Number(color) >>> 0 });
      return handle;
    }
    SelectObject(destination, object) {
      const dc = this._dc(destination);
      const resource = this.objects.get(Number(object));
      if (!resource) throw new Error(`HGDIOBJ inválido: ${object}.`);
      dc.selected.set(resource.type, object);
      return object;
    }
    DeleteObject(object) { return this.objects.delete(Number(object)); }

    dispose() { this.contexts.clear(); this.objects.clear(); }
  }

  Porthole.GDI32Shim = GDI32Shim;
  Porthole.GDIUtils = { colorRef };
})(typeof window !== 'undefined' ? window : globalThis);
