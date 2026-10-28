/*
 * shim-kernel32.js — subconjunto kernel32 → memória JS, VFS e dynamic linker.
 * A I/O web é assíncrona. O backend retrowin32 possui um adaptador síncrono
 * próprio com cache/overlay; estes métodos JS continuam assíncronos e não
 * fingem ser chamadas Win32 síncronas para o workload integrado.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const Shim = Porthole.Shim;

  function fileTime(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value <= 0) return null;
    return (BigInt(Math.trunc(value)) + 11644473600000n) * 10000n;
  }

  class Kernel32Shim extends Shim {
    constructor(context) {
      super('kernel32.dll', context);
      this.lastError = 0;
      this.nextAllocation = 0x10000000;
      this.allocations = new Map();
      this.nextFileHandle = 0x100;
      this.files = new Map();
      this.clock = context.clock || (Porthole.MonotonicClock ? new Porthole.MonotonicClock() : null);
    }

    GetLastError() { return this.lastError; }
    SetLastError(code) { this.lastError = Number(code) >>> 0; }

    LoadLibraryA(name) { return this._call('LoadLibraryA', arguments, () => this.context.linker.loadLibrary(name, 'kernel32!LoadLibraryA')); }
    LoadLibraryW(name) { return this._call('LoadLibraryW', arguments, () => this.context.linker.loadLibrary(name, 'kernel32!LoadLibraryW')); }
    FreeLibrary(module) { return this._call('FreeLibrary', arguments, () => this.context.linker.freeLibrary(module)); }
    GetProcAddress(module, name) { return this._call('GetProcAddress', arguments, () => this.context.linker.getProcAddress(module, name)); }

    VirtualAlloc(address, size, allocationType, protect) {
      return this._call('VirtualAlloc', arguments, () => {
        const length = Number(size);
        if (!Number.isSafeInteger(length) || length <= 0 || length > 256 * 1024 * 1024) {
          this.lastError = 87; // ERROR_INVALID_PARAMETER
          return 0;
        }
        if (Number(address) !== 0) this._unsupported('VirtualAlloc com endereço fixo');
        const aligned = Math.ceil(length / 4096) * 4096;
        const base = this.nextAllocation;
        this.nextAllocation += aligned + 4096;
        const buffer = new ArrayBuffer(aligned);
        this.allocations.set(base, { base, size: aligned, requestedSize: length, buffer, protect: protect >>> 0 });
        this.lastError = 0;
        return base;
      });
    }

    VirtualFree(base) {
      return this._call('VirtualFree', arguments, () => this.allocations.delete(Number(base)));
    }

    VirtualProtect(base, size, protect) {
      return this._call('VirtualProtect', arguments, () => {
        const allocation = this._allocation(Number(base), Number(size));
        allocation.protect = Number(protect) >>> 0;
        return true;
      });
    }

    _allocation(pointer, length) {
      for (const allocation of this.allocations.values()) {
        if (pointer >= allocation.base && pointer + length <= allocation.base + allocation.size) return allocation;
      }
      const error = new Error(`Ponteiro inválido: 0x${(pointer >>> 0).toString(16)}.`);
      error.code = 'INVALID_POINTER';
      this.lastError = 487;
      throw error;
    }

    writeMemory(pointer, source) {
      const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
      const allocation = this._allocation(Number(pointer), bytes.byteLength);
      new Uint8Array(allocation.buffer, pointer - allocation.base, bytes.byteLength).set(bytes);
      return bytes.byteLength;
    }

    readMemory(pointer, length) {
      const allocation = this._allocation(Number(pointer), Number(length));
      return new Uint8Array(allocation.buffer, pointer - allocation.base, length).slice();
    }

    async CreateFileA(path, desiredAccess, shareMode, security, creationDisposition, flags) {
      return this._call('CreateFileA', arguments, () => this._createFile(path, desiredAccess, creationDisposition, flags));
    }

    async CreateFileW(path, desiredAccess, shareMode, security, creationDisposition, flags) {
      return this._call('CreateFileW', arguments, () => this._createFile(path, desiredAccess, creationDisposition, flags));
    }

    async _createFile(path, desiredAccess, creationDisposition) {
      if (!this.context.vfs) throw new Error('VFS não configurado.');
      const access = Number(desiredAccess == null ? 0x80000000 : desiredAccess) >>> 0;
      const disposition = Number(creationDisposition == null ? 3 : creationDisposition);
      const canWrite = Boolean(access & 0x40000000) || disposition === 2;
      let data = new Uint8Array(0);
      let existed = false;
      if (disposition !== 2) {
        try {
          data = new Uint8Array(await this.context.vfs.readFile(path));
          existed = true;
        } catch (error) {
          if (error.code !== 'NOT_FOUND' || disposition === 3) {
            this.lastError = error.code === 'NOT_FOUND' ? 2 : 5;
            throw error;
          }
        }
      }
      if (disposition === 2) existed = await this.context.vfs.exists(path);
      const handle = this.nextFileHandle++;
      this.files.set(handle, { path, access, data, position: 0, canWrite, existed });
      this.lastError = 0;
      return handle;
    }

    _file(handle) {
      const file = this.files.get(Number(handle));
      if (!file) {
        this.lastError = 6; // ERROR_INVALID_HANDLE
        throw new Error(`HANDLE de arquivo inválido: ${handle}.`);
      }
      return file;
    }

    async ReadFile(handle, length) {
      return this._call('ReadFile', arguments, async () => {
        const file = this._file(handle);
        const count = Math.max(0, Math.min(Number(length), file.data.byteLength - file.position));
        const result = file.data.slice(file.position, file.position + count);
        file.position += count;
        return { bytesRead: count, data: result.buffer };
      });
    }

    async WriteFile(handle, input, length) {
      return this._call('WriteFile', arguments, async () => {
        const file = this._file(handle);
        if (!file.canWrite) {
          this.lastError = 5;
          throw new Error('Arquivo aberto sem GENERIC_WRITE.');
        }
        const source = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
        const count = length == null ? source.byteLength : Math.min(Number(length), source.byteLength);
        const end = file.position + count;
        if (end > file.data.byteLength) {
          const expanded = new Uint8Array(end);
          expanded.set(file.data);
          file.data = expanded;
        }
        file.data.set(source.subarray(0, count), file.position);
        file.position = end;
        await this.context.vfs.writeFile(file.path, file.data);
        return { bytesWritten: count };
      });
    }

    SetFilePointer(handle, distance, method) {
      return this._call('SetFilePointer', arguments, () => {
        const file = this._file(handle);
        const origin = Number(method || 0);
        const base = origin === 1 ? file.position : origin === 2 ? file.data.byteLength : 0;
        const position = base + Number(distance);
        if (position < 0) throw new Error('SetFilePointer antes do início do arquivo.');
        file.position = position;
        return position;
      });
    }

    GetFileSize(handle) { return this._call('GetFileSize', arguments, () => this._file(handle).data.byteLength); }

    async GetFileAttributesExW(path, infoLevel) {
      return this._call('GetFileAttributesExW', arguments, async () => {
        if (Number(infoLevel || 0) !== 0) { this.lastError = 87; throw new Error('Somente GetFileExInfoStandard está implementado.'); }
        if (!this.context.vfs || typeof this.context.vfs.stat !== 'function') this._unsupported('GetFileAttributesExW sem VFS.stat');
        const stat = await this.context.vfs.stat(path);
        const size = Number(stat.size || 0);
        this.lastError = 0;
        return {
          fileAttributes: Number(stat.fileAttributes) >>> 0,
          creationTime: null,
          lastAccessTime: null,
          lastWriteTime: fileTime(stat.lastModified),
          fileSize: size,
          fileSizeHigh: Math.floor(size / 0x100000000) >>> 0,
          fileSizeLow: size >>> 0,
          kind: stat.kind,
          resolvedPath: stat.resolvedPath,
          unavailableFields: ['creationTime', 'lastAccessTime'],
        };
      });
    }
    GetFileAttributesExA(path, infoLevel) { return this.GetFileAttributesExW(path, infoLevel); }

    async GetFileAttributesW(path) {
      return this._call('GetFileAttributesW', arguments, async () => {
        try { const stat = await this.context.vfs.stat(path); this.lastError = 0; return Number(stat.fileAttributes) >>> 0; }
        catch (error) { this.lastError = error.code === 'NOT_FOUND' ? 2 : 5; return 0xffffffff; }
      });
    }
    GetFileAttributesA(path) { return this.GetFileAttributesW(path); }

    CloseHandle(handle) { return this._call('CloseHandle', arguments, () => this.files.delete(Number(handle))); }

    GetTickCount() { return this.clock ? this.clock.getTickCount() : Math.floor((global.performance ? performance.now() : Date.now())) >>> 0; }
    QueryPerformanceCounter() {
      if (!this.clock) this._unsupported('QueryPerformanceCounter sem MonotonicClock');
      return this.clock.queryPerformanceCounter();
    }
    QueryPerformanceFrequency() {
      if (!this.clock) this._unsupported('QueryPerformanceFrequency sem MonotonicClock');
      return this.clock.queryPerformanceFrequency();
    }
    GetTickCount64() {
      return this.clock ? this.clock.getTickCount64() : Math.floor(global.performance ? performance.now() : Date.now());
    }

    GetCurrentProcessId() { return 1; }
    GetSystemInfo() {
      return { pageSize: 4096, allocationGranularity: 65536, processorArchitecture: 0, numberOfProcessors: global.navigator && navigator.hardwareConcurrency || 1 };
    }
    OutputDebugStringA(message) { this.context.tracer.log('kernel32.dll', String(message), 'debug'); }
    OutputDebugStringW(message) { this.OutputDebugStringA(message); }
    Sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds)))); }

    dispose() {
      this.allocations.clear();
      this.files.clear();
    }
  }

  Porthole.Kernel32Shim = Kernel32Shim;
})(typeof window !== 'undefined' ? window : globalThis);
