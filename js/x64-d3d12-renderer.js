/*
 * x64-d3d12-renderer.js — tiered scanout for the pure-browser x86-64 emulator.
 *
 * Tier 1  WebGPU   (navigator.gpu, preferred)
 * Tier 2  WebGL2   (textured full-screen quad, GLSL ES 3.00)
 * Tier 3  Canvas2D (software RGBA8 blit — the guaranteed fallback)
 *
 * The renderer never claims a tier it did not actually initialise; `tier` reflects the live path
 * and `stats.presented` only counts frames that reached a real drawing call.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  const WGSL_SHADER = `
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VSOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0)
  );
  var out: VSOut;
  out.pos = vec4<f32>(positions[idx], 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}
@group(0) @binding(0) var frame_tex: texture_2d<f32>;
@group(0) @binding(1) var frame_sampler: sampler;
@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  return textureSample(frame_tex, frame_sampler, in.uv);
}
`;

  class X64Renderer {
    constructor(options) {
      const opts = options || {};
      this.canvas = opts.canvas;
      this.tier = 'none';
      this.forcedTier = opts.forceSoftware ? 'software' : null;
      this.logger = opts.logger || function () {};
      this.ctx2d = null;
      this.gl = null;
      this.gpu = null;
      this.pipeline = null;
      this.texture = null;
      this.imageData = null;
      this.width = 0;
      this.height = 0;
      this.stats = {
        presented: 0,
        acceptedFrames: 0,
        bytesUploaded: 0,
        pixelMatches: null,
        lastError: null,
      };
    }

    async init(preferredTier) {
      const order = this.forcedTier
        ? [this.forcedTier]
        : preferredTier
          ? [preferredTier, 'webgpu', 'webgl2', 'software'].filter((v, i, a) => a.indexOf(v) === i)
          : ['webgpu', 'webgl2', 'software'];

      for (const tier of order) {
        try {
          if (tier === 'webgpu' && await this.initWebGpu()) return this.tier;
          if (tier === 'webgl2' && this.initWebGl2()) return this.tier;
          if (tier === 'software' && this.initSoftware()) return this.tier;
        } catch (error) {
          this.stats.lastError = `${tier}: ${error.message}`;
          this.logger(`Tier ${tier} indisponível: ${error.message}`);
        }
      }
      throw new Error('Nenhum tier de renderização disponível.');
    }

    async initWebGpu() {
      const nav = global.navigator;
      if (!nav || !nav.gpu) throw new Error('navigator.gpu ausente');
      const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('nenhum adaptador WebGPU');
      const device = await adapter.requestDevice();
      const ctx = this.canvas.getContext('webgpu');
      if (!ctx) throw new Error('getContext("webgpu") falhou');
      const format = nav.gpu.getPreferredCanvasFormat ? nav.gpu.getPreferredCanvasFormat() : 'bgra8unorm';
      ctx.configure({ device, format, alphaMode: 'opaque' });

      const module = device.createShaderModule({ code: WGSL_SHADER });
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.gpu = { device, ctx, format, sampler: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }) };
      this.tier = 'webgpu';
      this.logger('Scanout: WebGPU');
      return true;
    }

    initWebGl2() {
      const gl = this.canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL2 indisponível');
      const vs = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main() { v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5); gl_Position = vec4(a_pos, 0.0, 1.0); }`;
      const fs = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; out vec4 out_color;
void main() { out_color = texture(u_tex, v_uv); }`;
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
        }
        return sh;
      };
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
      }
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.gl = { gl, program, tex };
      this.tier = 'webgl2';
      this.logger('Scanout: WebGL2');
      return true;
    }

    initSoftware() {
      const ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!ctx) throw new Error('Canvas2D indisponível');
      this.ctx2d = ctx;
      this.tier = 'software';
      this.logger('Scanout: rasterizador software (Canvas2D)');
      return true;
    }

    ensureSize(width, height) {
      if (this.width === width && this.height === height) return;
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
      if (this.tier === 'software') {
        this.imageData = this.ctx2d.createImageData(width, height);
      }
      if (this.tier === 'webgpu' && this.gpu) {
        if (this.texture) this.texture.destroy();
        this.texture = this.gpu.device.createTexture({
          size: { width, height },
          format: 'rgba8unorm',
          usage: global.GPUTextureUsage.TEXTURE_BINDING | global.GPUTextureUsage.COPY_DST,
        });
      }
    }

    /** Presents one RGBA8 frame produced by `BrowserX64Emulator::take_frame()`. */
    present(rgba, width, height) {
      if (!rgba || !width || !height) return false;
      this.ensureSize(width, height);
      this.stats.acceptedFrames += 1;

      if (this.tier === 'webgpu' && this.gpu) {
        const { device, ctx, sampler, format } = this.gpu;
        device.queue.writeTexture(
          { texture: this.texture },
          rgba,
          { bytesPerRow: width * 4, rowsPerImage: height },
          { width, height },
        );
        const bind = device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.texture.createView() },
            { binding: 1, resource: sampler },
          ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: ctx.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          }],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(6);
        pass.end();
        device.queue.submit([encoder.finish()]);
        void format;
        this.stats.presented += 1;
        this.stats.bytesUploaded += rgba.byteLength;
        return true;
      }

      if (this.tier === 'webgl2' && this.gl) {
        const { gl, program, tex } = this.gl;
        gl.viewport(0, 0, width, height);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        gl.useProgram(program);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        this.stats.presented += 1;
        this.stats.bytesUploaded += rgba.byteLength;
        return true;
      }

      if (this.tier === 'software' && this.ctx2d) {
        if (!this.imageData) this.imageData = this.ctx2d.createImageData(width, height);
        this.imageData.data.set(rgba.subarray(0, this.imageData.data.length));
        this.ctx2d.putImageData(this.imageData, 0, 0);
        this.stats.presented += 1;
        this.stats.bytesUploaded += rgba.byteLength;
        return true;
      }

      return false;
    }

    /** Reads back the presented framebuffer (all tiers) so conformance checks stay honest. */
    readPixel(x, y) {
      if (this.tier === 'webgpu') return null; // requires an async staging readback
      if (this.tier === 'webgl2' && this.gl) {
        const out = new Uint8Array(4);
        this.gl.gl.readPixels(x, this.height - 1 - y, 1, 1, this.gl.gl.RGBA, this.gl.gl.UNSIGNED_BYTE, out);
        return out;
      }
      if (this.tier === 'software' && this.ctx2d) {
        return this.ctx2d.getImageData(x, y, 1, 1).data;
      }
      return null;
    }
  }

  Porthole.X64Renderer = X64Renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
