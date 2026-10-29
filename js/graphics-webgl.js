/*
 * graphics-webgl.js — backend WebGL do Graphics Translation Layer.
 * A superfície WebGL é interna; Present() copia o front buffer para o canvas
 * visível via Canvas 2D. Assim o mesmo canvas pode receber o fallback CPU.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const PRIMITIVE_MODES = { 1: 'POINTS', 2: 'LINES', 3: 'LINE_STRIP', 4: 'TRIANGLES', 5: 'TRIANGLE_STRIP', 6: 'TRIANGLE_FAN' };
  const FIXED_VERTEX = `
attribute vec4 aPosition;
attribute vec4 aColor;
uniform vec2 uViewport;
varying vec4 vColor;
void main() {
  vec2 clip = vec2((aPosition.x / uViewport.x) * 2.0 - 1.0,
                   1.0 - (aPosition.y / uViewport.y) * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  /* D3DCOLOR em memória little-endian chega como B,G,R,A. */
  vColor = aColor.bgra;
}`;
  const FIXED_FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() { gl_FragColor = vColor; }`;

  function rendererInfo(gl) {
    let vendor = String(gl.getParameter(gl.VENDOR) || 'desconhecido');
    let renderer = String(gl.getParameter(gl.RENDERER) || 'WebGL');
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    if (extension) {
      try {
        vendor = String(gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) || vendor);
        renderer = String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) || renderer);
      } catch (_) { /* Extensão pode ser restringida por política de privacidade. */ }
    }
    const software = /swiftshader|llvmpipe|lavapipe|software|basic render|softpipe/i.test(`${vendor} ${renderer}`);
    return {
      kind: 'webgl', vendor, renderer, software,
      mode: software ? 'webgl-software' : 'webgl-hardware',
      label: software ? `WebGL software (${renderer})` : 'Hardware WebGL (GPU detectada)',
    };
  }

  class WebGLBackend {
    constructor(canvas, options) {
      const opts = options || {};
      this.canvas = canvas;
      this.output = canvas.getContext('2d', { alpha: false });
      if (!this.output) throw new Error('Canvas 2D indisponível para a swap chain.');
      this.surface = opts.surface || (global.document && global.document.createElement('canvas'));
      if (!this.surface) throw new Error('Não foi possível criar a superfície WebGL.');
      const attributes = { alpha: false, antialias: true, depth: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' };
      this.gl = this.surface.getContext('webgl2', attributes);
      this.isWebGL2 = Boolean(this.gl);
      if (!this.gl) this.gl = this.surface.getContext('webgl', attributes) || this.surface.getContext('experimental-webgl', attributes);
      if (!this.gl) throw new Error('WebGL/WebGL2 indisponível.');
      const gl = this.gl;
      this.info = Object.assign(rendererInfo(gl), { api: this.isWebGL2 ? 'WebGL 2' : 'WebGL 1' });
      this.resources = new Set();
      this.program = null;
      this.currentVertexShader = null;
      this.currentPixelShader = null;
      this.stream = null;
      this.indices = null;
      this.fixedVertexShader = this._compile(gl.VERTEX_SHADER, FIXED_VERTEX);
      this.fixedFragmentShader = this._compile(gl.FRAGMENT_SHADER, FIXED_FRAGMENT);
      this._link(this.fixedVertexShader, this.fixedFragmentShader);
      this.resize(canvas.width || 640, canvas.height || 360);
    }

    _compile(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      if (!shader) throw new Error('gl.createShader falhou.');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Falha ao compilar shader WebGL: ${log}`);
      }
      return shader;
    }

    _link(vertexShader, fragmentShader) {
      const gl = this.gl;
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.bindAttribLocation(program, 0, 'aPosition');
      gl.bindAttribLocation(program, 1, 'aColor');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`Falha ao linkar programa WebGL: ${log}`);
      }
      if (this.program) gl.deleteProgram(this.program);
      this.program = program;
      this.viewportUniform = gl.getUniformLocation(program, 'uViewport');
      gl.useProgram(program);
    }

    resize(width, height) {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      this.canvas.width = w;
      this.canvas.height = h;
      this.surface.width = w;
      this.surface.height = h;
      this.gl.viewport(0, 0, w, h);
    }

    createVertexBuffer(byteLength) {
      const buffer = this.gl.createBuffer();
      if (!buffer) throw new Error('gl.createBuffer falhou para vertex buffer.');
      const resource = { buffer, byteLength, target: this.gl.ARRAY_BUFFER };
      this.resources.add(resource);
      return resource;
    }

    createIndexBuffer(byteLength, format) {
      if (format === 32 && !this.isWebGL2 && !this.gl.getExtension('OES_element_index_uint')) {
        throw new Error('Índices de 32 bits exigem OES_element_index_uint no WebGL 1.');
      }
      const buffer = this.gl.createBuffer();
      if (!buffer) throw new Error('gl.createBuffer falhou para index buffer.');
      const resource = { buffer, byteLength, format, target: this.gl.ELEMENT_ARRAY_BUFFER };
      this.resources.add(resource);
      return resource;
    }

    uploadBuffer(resource, bytes) {
      const gl = this.gl;
      gl.bindBuffer(resource.target, resource.buffer);
      gl.bufferData(resource.target, bytes, gl.DYNAMIC_DRAW);
      resource.byteLength = bytes.byteLength;
    }

    deleteBuffer(resource) {
      if (!resource) return;
      this.gl.deleteBuffer(resource.buffer);
      this.resources.delete(resource);
    }

    _bindStream(stream) {
      if (!stream || !stream.resource) throw new Error('Nenhum stream source configurado.');
      const gl = this.gl;
      const fvf = stream.fvf;
      const position = fvf & 0x0e;
      if (position !== 0x04 && position !== 0x02) throw new Error(`FVF de posição 0x${position.toString(16)} não suportado.`);
      const floats = position === 0x04 ? 4 : 3;
      const stride = stream.stride || (floats * 4 + (fvf & 0x40 ? 4 : 0));
      gl.bindBuffer(gl.ARRAY_BUFFER, stream.resource.buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, floats, gl.FLOAT, false, stride, stream.offset || 0);
      if (fvf & 0x40) {
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, stride, (stream.offset || 0) + floats * 4);
      } else {
        gl.disableVertexAttribArray(1);
        gl.vertexAttrib4f(1, 1, 1, 1, 1);
      }
    }

    _drawState(stream) {
      const gl = this.gl;
      gl.useProgram(this.program);
      if (this.viewportUniform) gl.uniform2f(this.viewportUniform, this.canvas.width, this.canvas.height);
      this._bindStream(stream);
    }

    clear(color) {
      const gl = this.gl;
      const value = Number(color) >>> 0;
      gl.clearColor(((value >>> 16) & 255) / 255, ((value >>> 8) & 255) / 255, (value & 255) / 255, ((value >>> 24) & 255) / 255);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    static vertexCount(primitiveType, primitiveCount) {
      const type = Number(primitiveType);
      const count = Number(primitiveCount);
      if (type === 1) return count;
      if (type === 2) return count * 2;
      if (type === 3) return count + 1;
      if (type === 4) return count * 3;
      if (type === 5 || type === 6) return count + 2;
      throw new Error(`D3DPRIMITIVETYPE ${type} não suportado.`);
    }

    drawPrimitive(type, startVertex, primitiveCount, stream) {
      const gl = this.gl;
      this._drawState(stream);
      const modeName = PRIMITIVE_MODES[type];
      if (!modeName) throw new Error(`Primitiva D3D ${type} não suportada.`);
      const count = WebGLBackend.vertexCount(type, primitiveCount);
      gl.drawArrays(gl[modeName], Number(startVertex), count);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`gl.drawArrays retornou erro 0x${error.toString(16)}.`);
    }

    drawIndexedPrimitive(type, startIndex, primitiveCount, stream, indexResource) {
      if (!indexResource) throw new Error('Nenhum index buffer configurado.');
      const gl = this.gl;
      this._drawState(stream);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexResource.buffer);
      const modeName = PRIMITIVE_MODES[type];
      if (!modeName) throw new Error(`Primitiva D3D ${type} não suportada.`);
      const count = WebGLBackend.vertexCount(type, primitiveCount);
      const format = indexResource.format === 32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      gl.drawElements(gl[modeName], count, format, Number(startIndex) * (indexResource.format === 32 ? 4 : 2));
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`gl.drawElements retornou erro 0x${error.toString(16)}.`);
    }

    createVertexShader(glsl) { return { shader: this._compile(this.gl.VERTEX_SHADER, glsl), type: 'vertex' }; }
    createPixelShader(glsl) { return { shader: this._compile(this.gl.FRAGMENT_SHADER, glsl), type: 'pixel' }; }
    setShaders(vertex, pixel) {
      this.currentVertexShader = vertex || null;
      this.currentPixelShader = pixel || null;
      this._link(vertex ? vertex.shader : this.fixedVertexShader, pixel ? pixel.shader : this.fixedFragmentShader);
    }

    present() {
      // Swap chain simulada: o front buffer WebGL é apresentado no canvas HTML5.
      this.output.drawImage(this.surface, 0, 0, this.canvas.width, this.canvas.height);
      this.frames = (this.frames || 0) + 1;
    }

    readCenterPixel() {
      const gl = this.gl;
      const pixel = new Uint8Array(4);
      gl.readPixels(Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel;
    }

    getInfo() { return Object.assign({}, this.info); }
    getCapabilities() {
      const gl = this.gl;
      return { webgl2: this.isWebGL2, maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS) };
    }

    dispose() {
      for (const resource of this.resources) this.gl.deleteBuffer(resource.buffer);
      this.resources.clear();
      if (this.program) this.gl.deleteProgram(this.program);
      this.gl.deleteShader(this.fixedVertexShader);
      this.gl.deleteShader(this.fixedFragmentShader);
    }
  }

  Porthole.WebGLBackend = WebGLBackend;
  Porthole.GraphicsUtils = Object.assign(Porthole.GraphicsUtils || {}, { rendererInfo, FIXED_VERTEX, FIXED_FRAGMENT });
})(typeof window !== 'undefined' ? window : globalThis);
