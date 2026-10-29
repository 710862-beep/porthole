/*
 * shim-d3d11.js — subconjunto D3D11 sobre o GTL compartilhado.
 * Buffers, topology, draws, clear e Present são reais. Não há alegação de
 * cobertura de texturas, render states, compute ou pipeline D3D11 completo.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const Shim = Porthole.Shim;

  function primitives(topology, vertexCount) {
    const count = Number(vertexCount);
    if (topology === 1) return count;
    if (topology === 2) return Math.floor(count / 2);
    if (topology === 3) return Math.max(0, count - 1);
    if (topology === 4) return Math.floor(count / 3);
    if (topology === 5) return Math.max(0, count - 2);
    throw new Error(`D3D11_PRIMITIVE_TOPOLOGY ${topology} não suportada.`);
  }

  class D3D11Device {
    constructor(shim) {
      this.shim = shim;
      this.d3d9 = shim.d3d9;
      this.device9 = shim.device9;
      this.resources = new Map();
      this.nextHandle = 1;
      this.immediateContext = new D3D11Context(this);
      this.swapChain = new D3D11SwapChain(this);
    }
    _call(method, args, operation) { return this.shim._call(method, args, operation); }

    CreateBuffer(description, initialData) {
      return this._call('CreateBuffer', arguments, () => {
        const desc = description || {};
        const size = Number(desc.ByteWidth);
        const bind = Number(desc.BindFlags);
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error('D3D11_BUFFER_DESC.ByteWidth inválido.');
        const handle = this.nextHandle++;
        let record;
        if ((bind & 4) && bind !== 4) throw new Error('Constant buffer não pode combinar outros BindFlags neste subconjunto.');
        if (bind & 1) { // D3D11_BIND_VERTEX_BUFFER
          const handle9 = this.device9.CreateVertexBuffer(size, desc.Usage || 0, Porthole.D3D9.D3DFVF_XYZRHW | Porthole.D3D9.D3DFVF_DIFFUSE, 0);
          record = { handle, kind: 'vertex', handle9, stride: Number(desc.StructureByteStride || 20) };
        } else if (bind & 2) { // D3D11_BIND_INDEX_BUFFER
          const format = Number(desc.Format) === 42 || Number(desc.Format) === 32 ? 32 : 16;
          const handle9 = this.device9.CreateIndexBuffer(size, desc.Usage || 0, format, 0);
          record = { handle, kind: 'index', handle9, format };
        } else if (bind & 4) { // D3D11_BIND_CONSTANT_BUFFER: storage real; upload de uniforms depende do shader/backend.
          record = { handle, kind: 'constant', data: new ArrayBuffer(size), size };
        } else throw new Error('Somente D3D11_BIND_VERTEX_BUFFER/INDEX_BUFFER/CONSTANT_BUFFER estão implementados.');
        if (initialData) {
          const bytes = ArrayBuffer.isView(initialData) ? new Uint8Array(initialData.buffer, initialData.byteOffset, initialData.byteLength) : new Uint8Array(initialData);
          if (bytes.byteLength > size) throw new Error('D3D11_SUBRESOURCE_DATA excede ByteWidth.');
          if (record.kind === 'constant') new Uint8Array(record.data).set(bytes);
          else this.device9.WriteVertices(record.handle9, bytes, 0);
        }
        this.resources.set(handle, record);
        return handle;
      });
    }

    CreateVertexShader(hlsl) {
      return this._call('CreateVertexShader', arguments, () => {
        const handle = this.nextHandle++;
        this.resources.set(handle, { handle, kind: 'vertexShader', handle9: this.device9.CreateVertexShader(hlsl) });
        return handle;
      });
    }
    CreatePixelShader(hlsl) {
      return this._call('CreatePixelShader', arguments, () => {
        const handle = this.nextHandle++;
        this.resources.set(handle, { handle, kind: 'pixelShader', handle9: this.device9.CreatePixelShader(hlsl) });
        return handle;
      });
    }
    _resource(handle, kind) {
      const resource = this.resources.get(Number(handle));
      if (!resource || (kind && resource.kind !== kind)) throw new Error(`ID3D11Buffer inválido: ${handle}.`);
      return resource;
    }
    Release() { return this._call('Release', arguments, () => { this.resources.clear(); return this.device9.Release(); }); }
  }

  class D3D11Context {
    constructor(device) {
      this.device = device;
      this.vertexBuffer = null;
      this.indexBuffer = null;
      this.topology = 4;
      this.constantBuffers = { vs: new Array(14).fill(null), ps: new Array(14).fill(null) };
    }
    _call(method, args, operation) { return this.device._call(method, args, operation); }

    IASetVertexBuffers(startSlot, count, buffers, strides, offsets) {
      return this._call('IASetVertexBuffers', arguments, () => {
        if (Number(startSlot) !== 0 || Number(count) !== 1) throw new Error('Somente um vertex buffer no slot 0 está implementado.');
        const handle = Array.isArray(buffers) ? buffers[0] : buffers;
        const stride = Array.isArray(strides) ? strides[0] : strides;
        const offset = Array.isArray(offsets) ? offsets[0] : offsets;
        this.vertexBuffer = this.device._resource(handle, 'vertex');
        this.device.device9.SetFVF(Porthole.D3D9.D3DFVF_XYZRHW | Porthole.D3D9.D3DFVF_DIFFUSE);
        this.device.device9.SetStreamSource(0, this.vertexBuffer.handle9, Number(offset || 0), Number(stride || this.vertexBuffer.stride));
        this.device.device9._drawStream(); // valida o stream no momento do bind
      });
    }

    IASetIndexBuffer(handle, format, offset) {
      return this._call('IASetIndexBuffer', arguments, () => {
        if (Number(offset || 0) !== 0) throw new Error('Offset de index buffer não implementado.');
        this.indexBuffer = this.device._resource(handle, 'index');
        const bits = Number(format) === 42 || Number(format) === 32 ? 32 : Number(format) === 57 || Number(format) === 16 || format == null ? 16 : 0;
        if (!bits || bits !== this.indexBuffer.format) throw new Error('DXGI format do index buffer diverge do CreateBuffer.');
        this.device.device9.SetIndices(this.indexBuffer.handle9);
      });
    }

    IASetPrimitiveTopology(topology) { return this._call('IASetPrimitiveTopology', arguments, () => { primitives(Number(topology), 3); this.topology = Number(topology); }); }
    VSSetShader(handle) { return this._call('VSSetShader', arguments, () => { const resource = handle ? this.device._resource(handle, 'vertexShader') : null; this.device.device9.SetVertexShader(resource && resource.handle9); }); }
    PSSetShader(handle) { return this._call('PSSetShader', arguments, () => { const resource = handle ? this.device._resource(handle, 'pixelShader') : null; this.device.device9.SetPixelShader(resource && resource.handle9); }); }

    _setConstantBuffers(stage, startSlot, count, buffers) {
      const start = Number(startSlot), amount = Number(count);
      const list = Array.isArray(buffers) ? buffers : [buffers];
      if (!Number.isInteger(start) || !Number.isInteger(amount) || start < 0 || amount < 0 || start + amount > 14 || list.length < amount) throw new Error('Slots de constant buffer inválidos.');
      for (let i = 0; i < amount; i += 1) this.constantBuffers[stage][start + i] = list[i] ? this.device._resource(list[i], 'constant') : null;
    }
    VSSetConstantBuffers(startSlot, count, buffers) { return this._call('VSSetConstantBuffers', arguments, () => this._setConstantBuffers('vs', startSlot, count, buffers)); }
    PSSetConstantBuffers(startSlot, count, buffers) { return this._call('PSSetConstantBuffers', arguments, () => this._setConstantBuffers('ps', startSlot, count, buffers)); }

    UpdateSubresource(handle, box, sourceData) {
      return this._call('UpdateSubresource', arguments, () => {
        const resource = this.device._resource(handle, 'constant');
        const source = ArrayBuffer.isView(sourceData) ? new Uint8Array(sourceData.buffer, sourceData.byteOffset, sourceData.byteLength) : new Uint8Array(sourceData);
        const left = box ? Number(box.left || 0) : 0;
        const right = box ? Number(box.right) : resource.size;
        if (box && (['top', 'front'].some((key) => Number(box[key] || 0) !== 0) || ['bottom', 'back'].some((key) => Number(box[key] == null ? 1 : box[key]) !== 1))) {
          throw new Error('UpdateSubresource 1D aceita somente uma linha/profundidade.');
        }
        if (!Number.isInteger(left) || !Number.isInteger(right) || left < 0 || right < left || right > resource.size || source.byteLength < right - left) throw new Error('D3D11_BOX fora do constant buffer.');
        new Uint8Array(resource.data, left, right - left).set(source.subarray(0, right - left));
        return 0;
      });
    }

    ClearRenderTargetView(view, color) {
      return this._call('ClearRenderTargetView', arguments, () => {
        const rgba = color || [0, 0, 0, 1];
        const component = (index) => Math.max(0, Math.min(255, Math.round(Number(rgba[index]) * 255)));
        const argb = ((component(3) << 24) | (component(0) << 16) | (component(1) << 8) | component(2)) >>> 0;
        this.device.device9.Clear(0, null, 1, argb, 1, 0);
      });
    }

    Draw(vertexCount, startVertexLocation) {
      return this._call('Draw', arguments, () => {
        const count = primitives(this.topology, vertexCount);
        if (!count) return 0;
        return this.device.device9.DrawPrimitive(this.topology, Number(startVertexLocation || 0), count);
      });
    }

    DrawIndexed(indexCount, startIndexLocation, baseVertexLocation) {
      return this._call('DrawIndexed', arguments, () => {
        const count = primitives(this.topology, indexCount);
        if (!count) return 0;
        return this.device.device9.DrawIndexedPrimitive(this.topology, Number(baseVertexLocation || 0), 0, Number(indexCount), Number(startIndexLocation || 0), count);
      });
    }

    Flush() { return 0; }
  }

  class D3D11SwapChain {
    constructor(device) { this.device = device; }
    Present(syncInterval) { return this.device._call('IDXGISwapChain::Present', arguments, () => this.device.device9.Present()); }
    ResizeBuffers(bufferCount, width, height) { return this.device._call('IDXGISwapChain::ResizeBuffers', arguments, () => { this.device.shim.backend.resize(Number(width), Number(height)); return 0; }); }
  }

  class D3D11Shim extends Shim {
    constructor(context) {
      super('d3d11.dll', context);
      if (!context.graphicsBackend) throw new Error('d3d11.dll requer um graphicsBackend inicializado.');
      this.backend = context.graphicsBackend;
      this.d3d9 = new Porthole.D3D9Shim(context);
      this.device9 = this.d3d9.CreateDevice(0, 1, 0, 0, {});
    }

    D3D11CreateDevice() {
      return this._call('D3D11CreateDevice', arguments, () => {
        const device = new D3D11Device(this);
        return { device, immediateContext: device.immediateContext, swapChain: device.swapChain, featureLevel: '9_1 subset' };
      });
    }

    dispose() { if (this.device9) this.device9.Release(); }
  }

  Porthole.D3D11Shim = D3D11Shim;
})(typeof window !== 'undefined' ? window : globalThis);
