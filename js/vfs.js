/*
 * vfs.js — contrato comum do Virtual File System e paths Win32.
 * A raiz escolhida pelo usuário é sempre C:\. Nenhum backend recebe acesso a
 * caminhos arbitrários do host e '..' nunca pode escapar dessa raiz.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  class VFSError extends Error {
    constructor(code, message, path) {
      super(message);
      this.name = 'VFSError';
      this.code = code;
      this.path = path || null;
    }
  }

  function normalizePath(input) {
    if (typeof input !== 'string') {
      throw new VFSError('INVALID_PATH', 'O caminho deve ser uma string.');
    }
    const original = input;
    if (!input.trim()) input = 'C:\\';
    if (input.includes('\0')) {
      throw new VFSError('INVALID_PATH', 'NUL não é permitido em caminhos.', original);
    }

    let value = input.trim().replace(/\//g, '\\');
    let extended = false;
    // O prefixo estendido é útil para long paths, mas não libera UNC, devices
    // nem outra raiz. Canonicalizamos para a mesma chave de C:\\ usada pelo VFS.
    if (/^\\\\\?\\UNC\\/i.test(value)) {
      throw new VFSError('UNSUPPORTED_PATH', 'UNC estendido não é suportado.', original);
    }
    if (/^\\\\\?\\/.test(value)) {
      extended = true;
      value = value.slice(4);
    } else if (/^\\\\/.test(value)) {
      throw new VFSError('UNSUPPORTED_PATH', 'UNC e paths de dispositivo não são suportados.', original);
    }

    const drive = value.match(/^([A-Za-z]):(.*)$/);
    if (extended && (!drive || !drive[2])) {
      throw new VFSError('INVALID_PATH', 'Um path estendido deve ser absoluto, como \\\\?\\C:\\pasta\\arquivo.', original);
    }
    if (drive) {
      if (drive[1].toUpperCase() !== 'C') {
        throw new VFSError('UNMAPPED_DRIVE', `Somente C: está mapeado; recebido ${drive[1]}:`, original);
      }
      value = drive[2];
      if (value && !value.startsWith('\\')) {
        throw new VFSError('INVALID_PATH', 'Use um caminho absoluto como C:\\pasta\\arquivo.', original);
      }
    }
    value = value.replace(/^\\+/, '');

    const segments = [];
    for (const segment of value.split('\\')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (!segments.length) {
          throw new VFSError('PATH_ESCAPE', 'O caminho tentou escapar da raiz C:\\.', original);
        }
        segments.pop();
        continue;
      }
      if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) {
        throw new VFSError('INVALID_PATH', `Segmento Win32 inválido: ${segment}`, original);
      }
      segments.push(segment);
    }

    const relative = segments.join('/');
    return Object.freeze({
      original,
      extended,
      drive: 'C:',
      segments: Object.freeze(segments.slice()),
      relative,
      key: relative.toLocaleLowerCase('en-US'),
      win32: segments.length ? `C:\\${segments.join('\\')}` : 'C:\\',
    });
  }

  function asBuffer(data) {
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    if (data instanceof ArrayBuffer) return data;
    throw new VFSError('INVALID_DATA', 'Escrita aceita string, ArrayBuffer, TypedArray ou Blob.');
  }

  class VirtualFileSystem {
    constructor(options) {
      const opts = options || {};
      this.native = opts.native || null;
      this.fallback = opts.fallback || null;
      this.backend = opts.backend || null;
      this.onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    }

    get isMapped() { return Boolean(this.backend && this.backend.isMapped); }

    getInfo() {
      if (!this.backend) {
        return { mapped: false, kind: 'none', persistent: false, rootName: null, label: 'Nenhuma pasta mapeada' };
      }
      return Object.assign({ mapped: this.backend.isMapped }, this.backend.getInfo());
    }

    async mapDirectory(options) {
      const forceFallback = options && options.forceFallback;
      if (!forceFallback && this.native) {
        const info = await this.native.mapDirectory();
        this.backend = this.native;
        this.onChange(this.getInfo());
        return info;
      }
      if (!this.fallback) {
        throw new VFSError('UNAVAILABLE', 'Nenhum seletor de diretório está disponível.');
      }
      const info = await this.fallback.mapDirectory();
      this.backend = this.fallback;
      this.onChange(this.getInfo());
      return info;
    }

    // Entrada determinística usada também pelos testes e por integrações futuras.
    async useFallbackFiles(files, options) {
      if (!this.fallback) throw new VFSError('UNAVAILABLE', 'Fallback VFS não configurado.');
      const info = await this.fallback.mapFiles(files, options);
      this.backend = this.fallback;
      this.onChange(this.getInfo());
      return info;
    }

    _ready() {
      if (!this.backend || !this.backend.isMapped) {
        throw new VFSError('NOT_MAPPED', 'Mapeie uma pasta como C:\\ antes de acessar arquivos.');
      }
      return this.backend;
    }

    readFile(path) { return this._ready().readFile(path); }
    writeFile(path, data) { return this._ready().writeFile(path, asBuffer(data)); }
    listDirectory(path) { return this._ready().listDirectory(path || 'C:\\'); }
    exists(path) { return this._ready().exists(path); }
    createDirectory(path) {
      const backend = this._ready();
      if (typeof backend.createDirectory !== 'function') throw new VFSError('NOT_IMPLEMENTED', 'createDirectory indisponível.');
      return backend.createDirectory(path);
    }
    stat(path) {
      const backend = this._ready();
      if (typeof backend.stat !== 'function') throw new VFSError('NOT_IMPLEMENTED', 'stat não é suportado por este backend.');
      return backend.stat(path);
    }
    resolvePath(path) {
      const backend = this._ready();
      return typeof backend.resolvePath === 'function' ? backend.resolvePath(path) : normalizePath(path);
    }
    createSymlink(path, target) {
      const backend = this._ready();
      if (typeof backend.createSymlink !== 'function') throw new VFSError('NOT_IMPLEMENTED', 'Links virtuais não são suportados por este backend.');
      return backend.createSymlink(path, target);
    }
    readlink(path) {
      const backend = this._ready();
      if (typeof backend.readlink !== 'function') throw new VFSError('NOT_IMPLEMENTED', 'readlink não é suportado por este backend.');
      return backend.readlink(path);
    }
  }

  Porthole.VFSError = VFSError;
  Porthole.VFSUtils = { normalizePath, asBuffer };
  Porthole.VirtualFileSystem = VirtualFileSystem;
})(typeof window !== 'undefined' ? window : globalThis);
