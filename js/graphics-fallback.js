/*
 * graphics-fallback.js — rasterizador por CPU, llvmpipe-style.
 * NÃO é o LLVMpipe do Mesa: é uma implementação JS real com framebuffer RGBA,
 * barycentric fill e interpolação de cor, apresentada com Canvas 2D.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  class SoftwareRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d', { alpha: false });
      if (!this.context) throw new Error('Canvas 2D indisponível para o rasterizador CPU.');
      this.info = {
        kind: 'software-cpu', mode: 'software-cpu', software: true,
        vendor: 'Porthole', renderer: 'CPU barycentric rasterizer', api: 'Canvas 2D',
        label: 'Software llvmpipe-style (CPU; não é Mesa LLVMpipe)',
      };
      this.width = 0;
      this.height = 0;
      this.frames = 0;
      this.resize(canvas.width || 640, canvas.height || 360);
    }

    resize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      this.canvas.width = w;
      this.canvas.height = h;
      this.width = w;
      this.height = h;
      this.image = this.context.createImageData(w, h);
      this.pixels = this.image.data;
      this.words = new Uint32Array(this.pixels.buffer);
      this.clear(0xff101820);
    }

    createVertexBuffer(byteLength) { return { byteLength, bytes: null, target: 'vertex' }; }
    createIndexBuffer(byteLength, format) { return { byteLength, format, bytes: null, target: 'index' }; }
    uploadBuffer(resource, bytes) { resource.bytes = bytes; resource.byteLength = bytes.byteLength; }
    deleteBuffer(resource) { if (resource) resource.bytes = null; }

    clear(color) {
      const value = Number(color) >>> 0;
      const r = (value >>> 16) & 255;
      const g = (value >>> 8) & 255;
      const b = value & 255;
      const a = (value >>> 24) & 255;
      // Os navegadores-alvo são little-endian; o loop mantém o caminho correto
      // também em uma arquitetura big-endian.
      const probe = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
      if (probe) this.words.fill(((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
      else {
        for (let i = 0; i < this.pixels.length; i += 4) {
          this.pixels[i] = r; this.pixels[i + 1] = g; this.pixels[i + 2] = b; this.pixels[i + 3] = a;
        }
      }
    }

    _vertex(stream, index) {
      if (!stream || !stream.resource || !stream.resource.bytes) throw new Error('Vertex buffer vazio ou stream ausente.');
      const bytes = stream.resource.bytes;
      const view = stream.view || (stream.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const fvf = stream.fvf;
      const position = fvf & 0x0e;
      const floats = position === 0x04 ? 4 : position === 0x02 ? 3 : 0;
      if (!floats) throw new Error(`FVF de posição 0x${position.toString(16)} não suportado.`);
      const stride = stream.stride || floats * 4 + (fvf & 0x40 ? 4 : 0);
      const offset = (stream.offset || 0) + index * stride;
      if (offset < 0 || offset + stride > bytes.byteLength) throw new Error(`Vértice ${index} fora do vertex buffer.`);
      const color = fvf & 0x40 ? view.getUint32(offset + floats * 4, true) : 0xffffffff;
      return {
        x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true),
        z: floats === 4 ? view.getFloat32(offset + 8, true) : 0,
        rhw: floats === 4 ? view.getFloat32(offset + 12, true) : 1,
        r: (color >>> 16) & 255, g: (color >>> 8) & 255, b: color & 255, a: (color >>> 24) & 255,
      };
    }

    _pixel(x, y, color) {
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
      const offset = (y * this.width + x) * 4;
      this.pixels[offset] = color.r;
      this.pixels[offset + 1] = color.g;
      this.pixels[offset + 2] = color.b;
      this.pixels[offset + 3] = color.a;
    }

    _line(a, b) {
      let x0 = Math.round(a.x), y0 = Math.round(a.y);
      const x1 = Math.round(b.x), y1 = Math.round(b.y);
      const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
      const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
      let error = dx + dy;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      let step = 0;
      while (true) {
        const t = step / steps;
        this._pixel(x0, y0, { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t });
        if (x0 === x1 && y0 === y1) break;
        const twice = 2 * error;
        if (twice >= dy) { error += dy; x0 += sx; }
        if (twice <= dx) { error += dx; y0 += sy; }
        step += 1;
        if (step > 8192) break;
      }
    }

    static _edge(a, b, x, y) { return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x); }

    _triangle(a, b, c) {
      const area = SoftwareRenderer._edge(a, b, c.x, c.y);
      if (!Number.isFinite(area) || Math.abs(area) < 0.00001) return;
      const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
      const maxX = Math.min(this.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
      const maxY = Math.min(this.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      if (minX > maxX || minY > maxY) return;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = SoftwareRenderer._edge(b, c, px, py);
          const w1 = SoftwareRenderer._edge(c, a, px, py);
          const w2 = SoftwareRenderer._edge(a, b, px, py);
          const inside = area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
          if (!inside) continue;
          const u = w0 / area, v = w1 / area, w = w2 / area;
          const offset = (y * this.width + x) * 4;
          this.pixels[offset] = a.r * u + b.r * v + c.r * w;
          this.pixels[offset + 1] = a.g * u + b.g * v + c.g * w;
          this.pixels[offset + 2] = a.b * u + b.b * v + c.b * w;
          this.pixels[offset + 3] = a.a * u + b.a * v + c.a * w;
        }
      }
    }

    _draw(type, primitiveCount, indices, stream) {
      const vertex = (index) => this._vertex(stream, index);
      const indexAt = (offset) => indices ? indices[offset] : offset;
      if (type === 4) {
        for (let i = 0; i < primitiveCount; i += 1) {
          const base = i * 3;
          this._triangle(vertex(indexAt(base)), vertex(indexAt(base + 1)), vertex(indexAt(base + 2)));
        }
      } else if (type === 5 || type === 6) {
        for (let i = 0; i < primitiveCount; i += 1) {
          if (type === 6) this._triangle(vertex(indexAt(0)), vertex(indexAt(i + 1)), vertex(indexAt(i + 2)));
          else if (i % 2) this._triangle(vertex(indexAt(i + 1)), vertex(indexAt(i)), vertex(indexAt(i + 2)));
          else this._triangle(vertex(indexAt(i)), vertex(indexAt(i + 1)), vertex(indexAt(i + 2)));
        }
      } else if (type === 2) {
        for (let i = 0; i < primitiveCount; i += 1) this._line(vertex(indexAt(i * 2)), vertex(indexAt(i * 2 + 1)));
      } else if (type === 3) {
        for (let i = 0; i < primitiveCount; i += 1) this._line(vertex(indexAt(i)), vertex(indexAt(i + 1)));
      } else if (type === 1) {
        for (let i = 0; i < primitiveCount; i += 1) this._pixel(Math.round(vertex(indexAt(i)).x), Math.round(vertex(indexAt(i)).y), vertex(indexAt(i)));
      } else throw new Error(`Primitiva D3D ${type} não suportada pela CPU.`);
    }

    drawPrimitive(type, startVertex, primitiveCount, stream) {
      const count = Porthole.WebGLBackend ? Porthole.WebGLBackend.vertexCount(type, primitiveCount) : primitiveCount * 3;
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) indices[i] = Number(startVertex) + i;
      this._draw(Number(type), Number(primitiveCount), indices, stream);
    }

    drawIndexedPrimitive(type, startIndex, primitiveCount, stream, indexResource) {
      if (!indexResource || !indexResource.bytes) throw new Error('Index buffer vazio.');
      const count = Porthole.WebGLBackend ? Porthole.WebGLBackend.vertexCount(type, primitiveCount) : primitiveCount * 3;
      const bytes = indexResource.bytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const format = indexResource.format === 32 ? 4 : 2;
      const indices = new Uint32Array(count);
      for (let i = 0; i < count; i += 1) {
        const offset = (Number(startIndex) + i) * format;
        if (offset + format > bytes.byteLength) throw new Error('DrawIndexedPrimitive fora do index buffer.');
        indices[i] = format === 4 ? view.getUint32(offset, true) : view.getUint16(offset, true);
      }
      this._draw(Number(type), Number(primitiveCount), indices, stream);
    }

    createVertexShader() { throw new Error('Shaders HLSL personalizados não são executados pelo rasterizador CPU.'); }
    createPixelShader() { throw new Error('Shaders HLSL personalizados não são executados pelo rasterizador CPU.'); }
    setShaders() { /* Fixed function: seleção vazia restaura o pipeline CPU. */ }

    present() {
      this.context.putImageData(this.image, 0, 0);
      this.frames += 1;
    }

    readCenterPixel() {
      const offset = (Math.floor(this.height / 2) * this.width + Math.floor(this.width / 2)) * 4;
      return this.pixels.slice(offset, offset + 4);
    }

    getInfo() { return Object.assign({}, this.info); }
    getCapabilities() { return { webgl2: false, maxTextureSize: 0, maxVertexAttribs: 2, rasterizer: 'CPU' }; }
    dispose() { this.pixels = null; this.words = null; this.image = null; }
  }

  Porthole.SoftwareRenderer = SoftwareRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
