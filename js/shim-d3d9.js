/*
 * shim-d3d9.js — IDirect3D9/IDirect3DDevice9 → GTL WebGL ou CPU.
 * Handles, locks, FVF e draws são reais; o subconjunto não cobre texturas,
 * fixed-function completo ou shaders arbitrários do DirectX 9.0c.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const Shim = Porthole.Shim;
  const D3DFVF_XYZ = 0x002;
  const D3DFVF_XYZRHW = 0x004;
  const D3DFVF_DIFFUSE = 0x040;

  function vertexCount(type, count) {
    if (type === 1) return count;
    if (type === 2) return count * 2;
    if (type === 3) return count + 1;
    if (type === 4) return count * 3;
    if (type === 5 || type === 6) return count + 2;
    throw new Error(`D3DPRIMITIVETYPE ${type} não suportado.`);
  }

  class D3D9Device {
    constructor(shim, presentationParameters) {
      this.shim = shim;
      this.context = shim.context;
      this.backend = shim.backend;
      this.presentationParameters = presentationParameters || {};
      this.resources = new Map();
      this.nextHandle = 1;
      this.stream = null;
      this.indices = null;
      this.fvf = D3DFVF_XYZRHW | D3DFVF_DIFFUSE;
      this.vertexShader = null;
      this.pixelShader = null;
      this.inScene = false;
      this.frames = 0;
      this.drawCalls = 0;
      this.lastPresent = 0;
    }

    _call(method, args, operation) { return this.shim._call(method, args, operation); }
    _resource(handle, type) {
      const resource = this.resources.get(Number(handle));
      if (!resource || (type && resource.type !== type)) throw new Error(`Recurso D3D9 inválido: ${handle}.`);
      return resource;
    }

    CreateVertexBuffer(length, usage, fvf, pool) {
      return this._call('CreateVertexBuffer', arguments, () => {
        const size = Number(length);
        if (!Number.isSafeInteger(size) || size <= 0 || size > 64 * 1024 * 1024) throw new Error('Tamanho inválido para vertex buffer.');
        const format = Number(fvf || this.fvf);
        const handle = this.nextHandle++;
        const data = new Uint8Array(size);
        const backendResource = this.backend.createVertexBuffer(size);
        this.resources.set(handle, { handle, type: 'vertex', length: size, usage, fvf: format, pool, data, backend: backendResource, locked: false });
        return handle;
      });
    }

    CreateIndexBuffer(length, usage, format, pool) {
      return this._call('CreateIndexBuffer', arguments, () => {
        const size = Number(length);
        const bits = Number(format) === 101 || Number(format) === 16 ? 16 : Number(format) === 102 || Number(format) === 32 ? 32 : 0;
        if (!bits) throw new Error(`Formato de índice ${format} não suportado.`);
        if (!Number.isSafeInteger(size) || size <= 0 || size > 64 * 1024 * 1024) throw new Error('Tamanho inválido para index buffer.');
        const handle = this.nextHandle++;
        const data = new Uint8Array(size);
        const backendResource = this.backend.createIndexBuffer(size, bits);
        this.resources.set(handle, { handle, type: 'index', length: size, usage, format: bits, pool, data, backend: backendResource, locked: false });
        return handle;
      });
    }

    Lock(handle, offsetToLock, sizeToLock) {
      return this._call('Lock', arguments, () => {
        const resource = this._resource(handle);
        if (resource.locked) throw new Error('Recurso D3D9 já está bloqueado.');
        const offset = Number(offsetToLock || 0);
        const size = Number(sizeToLock || (resource.length - offset));
        if (offset < 0 || size < 0 || offset + size > resource.length) throw new Error('Lock fora dos limites do buffer.');
        resource.locked = true;
        resource.lockRange = { offset, size };
        return resource.data.subarray(offset, offset + size);
      });
    }

    Unlock(handle) {
      return this._call('Unlock', arguments, () => {
        const resource = this._resource(handle);
        if (!resource.locked) throw new Error('Unlock sem Lock correspondente.');
        resource.locked = false;
        this.backend.uploadBuffer(resource.backend, resource.data);
        return 0; // D3D_OK
      });
    }

    WriteVertices(handle, data, offset) {
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      const start = Number(offset || 0);
      const target = this.Lock(handle, start, bytes.byteLength);
      target.set(bytes);
      this.Unlock(handle);
      return bytes.byteLength;
    }

    SetFVF(fvf) {
      return this._call('SetFVF', arguments, () => {
        const format = Number(fvf) >>> 0;
        const position = format & 0x0e;
        if (position !== D3DFVF_XYZ && position !== D3DFVF_XYZRHW) throw new Error(`FVF 0x${format.toString(16)} não suportado.`);
        if (format & ~(0x0e | D3DFVF_DIFFUSE)) throw new Error(`Flags FVF além de XYZ/XYZRHW/DIFFUSE não suportadas: 0x${format.toString(16)}.`);
        this.fvf = format;
        return 0;
      });
    }

    SetStreamSource(streamNumber, handle, offsetInBytes, stride) {
      return this._call('SetStreamSource', arguments, () => {
        if (Number(streamNumber) !== 0) throw new Error('Somente stream 0 está implementado.');
        const resource = this._resource(handle, 'vertex');
        const actualStride = Number(stride) || this._stride(resource.fvf);
        this.stream = { resource, backend: resource.backend, offset: Number(offsetInBytes || 0), stride: actualStride };
        return 0;
      });
    }

    _stride(fvf) { return ((fvf & 0x0e) === D3DFVF_XYZRHW ? 16 : 12) + (fvf & D3DFVF_DIFFUSE ? 4 : 0); }

    SetIndices(handle) {
      return this._call('SetIndices', arguments, () => {
        const resource = this._resource(handle, 'index');
        this.indices = resource;
        return 0;
      });
    }

    Clear(count, rectangles, flags, color) {
      return this._call('Clear', arguments, () => {
        // Assinatura conveniente Clear(color) também é aceita pelo workload JS.
        const actualColor = arguments.length === 1 ? count : color;
        this.backend.clear(Number(actualColor == null ? 0xff000000 : actualColor) >>> 0);
        return 0;
      });
    }

    BeginScene() { return this._call('BeginScene', arguments, () => { if (this.inScene) throw new Error('BeginScene aninhado.'); this.inScene = true; return 0; }); }
    EndScene() { return this._call('EndScene', arguments, () => { if (!this.inScene) throw new Error('EndScene sem BeginScene.'); this.inScene = false; return 0; }); }

    _drawStream() {
      if (!this.stream) throw new Error('SetStreamSource é obrigatório antes do draw.');
      return { resource: this.stream.resource.backend, backend: this.stream.resource.backend, offset: this.stream.offset, stride: this.stream.stride, fvf: this.fvf, bytes: this.stream.resource.data };
    }

    _validateDraw(type, start, primitiveCount, indexed) {
      const count = Number(primitiveCount);
      if (!Number.isSafeInteger(count) || count <= 0 || count > 1000000) throw new Error('PrimitiveCount inválido.');
      const vertices = vertexCount(Number(type), count);
      const stride = this.stream.stride;
      const available = Math.floor((this.stream.resource.length - this.stream.offset) / stride);
      if (!indexed && Number(start) + vertices > available) throw new Error('DrawPrimitive excede os vértices do stream.');
      if (indexed) {
        const bytes = this.indices.format / 8;
        if ((Number(start) + vertices) * bytes > this.indices.length) throw new Error('DrawIndexedPrimitive excede o index buffer.');
      }
      return vertices;
    }

    DrawPrimitive(primitiveType, startVertex, primitiveCount) {
      return this._call('DrawPrimitive', arguments, () => {
        const type = Number(primitiveType);
        const stream = this._drawStream();
        this._validateDraw(type, Number(startVertex), Number(primitiveCount), false);
        this.backend.drawPrimitive(type, Number(startVertex), Number(primitiveCount), stream);
        this.drawCalls += 1;
        return 0;
      });
    }

    DrawIndexedPrimitive(primitiveType, baseVertexIndex, minVertexIndex, numVertices, startIndex, primitiveCount) {
      return this._call('DrawIndexedPrimitive', arguments, () => {
        if (Number(baseVertexIndex) !== 0) throw new Error('BaseVertexIndex diferente de zero não está implementado.');
        if (!this.indices) throw new Error('SetIndices é obrigatório antes de DrawIndexedPrimitive.');
        const type = Number(primitiveType);
        const stream = this._drawStream();
        this._validateDraw(type, Number(startIndex), Number(primitiveCount), true);
        this.backend.drawIndexedPrimitive(type, Number(startIndex), Number(primitiveCount), stream, this.indices.backend);
        this.drawCalls += 1;
        return 0;
      });
    }

    Present() {
      return this._call('Present', arguments, () => {
        this.backend.present();
        this.frames += 1;
        this.lastPresent = global.performance ? performance.now() : Date.now();
        return 0;
      });
    }

    CreateVertexShader(hlsl) {
      return this._call('CreateVertexShader', arguments, () => {
        const glsl = Porthole.HLSLTranslator.translateVertex(hlsl);
        const backend = this.backend.createVertexShader(glsl);
        const handle = this.nextHandle++;
        this.resources.set(handle, { handle, type: 'vertexShader', backend });
        return handle;
      });
    }

    CreatePixelShader(hlsl) {
      return this._call('CreatePixelShader', arguments, () => {
        const glsl = Porthole.HLSLTranslator.translatePixel(hlsl);
        const backend = this.backend.createPixelShader(glsl);
        const handle = this.nextHandle++;
        this.resources.set(handle, { handle, type: 'pixelShader', backend });
        return handle;
      });
    }

    SetVertexShader(handle) {
      return this._call('SetVertexShader', arguments, () => {
        this.vertexShader = handle ? this._resource(handle, 'vertexShader') : null;
        this.backend.setShaders(this.vertexShader && this.vertexShader.backend, this.pixelShader && this.pixelShader.backend);
        return 0;
      });
    }

    SetPixelShader(handle) {
      return this._call('SetPixelShader', arguments, () => {
        this.pixelShader = handle ? this._resource(handle, 'pixelShader') : null;
        this.backend.setShaders(this.vertexShader && this.vertexShader.backend, this.pixelShader && this.pixelShader.backend);
        return 0;
      });
    }

    GetDeviceCaps() { return this.backend.getCapabilities(); }

    Release() {
      return this._call('Release', arguments, () => {
        for (const resource of this.resources.values()) {
          if (resource.type === 'vertex' || resource.type === 'index') this.backend.deleteBuffer(resource.backend);
        }
        this.resources.clear();
        this.stream = null;
        this.indices = null;
        return 0;
      });
    }
  }

  class D3D9Shim extends Shim {
    constructor(context) {
      super('d3d9.dll', context);
      if (!context.graphicsBackend) throw new Error('d3d9.dll requer um graphicsBackend inicializado.');
      this.backend = context.graphicsBackend;
      this.devices = new Set();
    }

    Direct3DCreate9(sdkVersion) {
      return this._call('Direct3DCreate9', arguments, () => {
        if (Number(sdkVersion) !== 32 && Number(sdkVersion) !== 0) {
          this.context.tracer.log('d3d9.dll', `D3D_SDK_VERSION ${sdkVersion} aceito em modo de compatibilidade.`, 'warning');
        }
        return this;
      });
    }

    CreateDevice(adapter, deviceType, focusWindow, behaviorFlags, presentationParameters) {
      return this._call('CreateDevice', arguments, () => {
        const device = new D3D9Device(this, presentationParameters);
        this.devices.add(device);
        return device;
      });
    }

    GetAdapterCount() { return 1; }
    GetAdapterIdentifier() { return { description: this.backend.getInfo().renderer, driver: this.backend.getInfo().api, whqlLevel: 0 }; }

    dispose() {
      for (const device of this.devices) if (device.resources.size) device.Release();
      this.devices.clear();
    }
  }

  Porthole.D3D9Shim = D3D9Shim;
  Porthole.D3D9Device = D3D9Device;
  Porthole.D3D9 = { D3DFVF_XYZ, D3DFVF_XYZRHW, D3DFVF_DIFFUSE, vertexCount };
})(typeof window !== 'undefined' ? window : globalThis);
