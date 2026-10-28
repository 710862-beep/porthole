/*
 * vfs-fs-access.js — C:\ apoiado por uma pasta real do host.
 * Chrome/Edge expõem handles somente após showDirectoryPicker() em um gesto do
 * usuário. Leituras e escritas abaixo usam esses handles diretamente.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const { normalizePath } = Porthole.VFSUtils;
  const VFSError = Porthole.VFSError;

  class FileSystemAccessVFS {
    constructor(options) {
      const opts = options || {};
      this.window = opts.window || global;
      this.picker = opts.picker || this.window.showDirectoryPicker;
      this.root = opts.root || null;
      this.rootName = this.root ? this.root.name : null;
      this.kind = 'fs-access';
      this.persistent = true;
      this.directoryCache = new Map();
      this.logger = typeof opts.logger === 'function' ? opts.logger : function () {};
    }

    get isMapped() { return Boolean(this.root); }

    getInfo() {
      return {
        mapped: this.isMapped,
        kind: this.kind,
        persistent: true,
        rootName: this.rootName,
        label: 'File System Access API',
        detail: 'Leituras e escritas na pasta real selecionada',
      };
    }

    async mapDirectory() {
      if (typeof this.picker !== 'function') {
        throw new VFSError('UNAVAILABLE', 'File System Access API indisponível.');
      }
      // Não substituímos uma raiz válida se o usuário cancelar o novo picker.
      const handle = await this.picker.call(this.window, { id: 'porthole-c-drive', mode: 'readwrite' });
      if (!handle || handle.kind !== 'directory') {
        throw new VFSError('INVALID_ROOT', 'O seletor não retornou um diretório.');
      }
      this.root = handle;
      this.rootName = handle.name || 'C';
      this.directoryCache.clear();
      this.directoryCache.set('', handle);
      await this._permission('readwrite');
      this.logger(`C:\\ mapeado para “${this.rootName}” (File System Access API)`);
      return this.getInfo();
    }

    async _permission(mode) {
      if (!this.root) throw new VFSError('NOT_MAPPED', 'Nenhuma pasta mapeada.');
      const options = { mode };
      if (typeof this.root.queryPermission === 'function') {
        const current = await this.root.queryPermission(options);
        if (current === 'granted') return true;
      }
      if (typeof this.root.requestPermission === 'function') {
        const result = await this.root.requestPermission(options);
        if (result === 'granted') return true;
        if (result === 'denied') {
          throw new VFSError('PERMISSION_DENIED', `Permissão ${mode} negada para C:\\.`);
        }
      }
      // Handles recém-escolhidos nem sempre implementam query/requestPermission.
      return true;
    }

    _notFound(path) {
      return new VFSError('NOT_FOUND', `Arquivo não encontrado: ${path.win32}`, path.win32);
    }

    async _childDirectory(parent, name, create) {
      try {
        return await parent.getDirectoryHandle(name, { create: false });
      } catch (error) {
        if (error && error.name !== 'NotFoundError') throw error;
      }
      // Win32 é case-insensitive. Só enumeramos o diretório atual quando a
      // tentativa exata falha, evitando indexar uma árvore inteira do host.
      if (parent.entries) {
        for await (const [entryName, handle] of parent.entries()) {
          if (handle.kind === 'directory' && entryName.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US')) {
            return handle;
          }
        }
      }
      if (create) return parent.getDirectoryHandle(name, { create: true });
      return null;
    }

    async _directory(path, create) {
      this._ready();
      if (!path.segments.length) return this.root;
      const cacheKey = path.key;
      if (!create && this.directoryCache.has(cacheKey)) return this.directoryCache.get(cacheKey);

      let current = this.root;
      let key = '';
      for (const segment of path.segments) {
        key = key ? `${key}/${segment.toLocaleLowerCase('en-US')}` : segment.toLocaleLowerCase('en-US');
        if (!create && this.directoryCache.has(key)) {
          current = this.directoryCache.get(key);
          continue;
        }
        const next = await this._childDirectory(current, segment, create);
        if (!next) throw this._notFound(path);
        current = next;
        this.directoryCache.set(key, current);
      }
      return current;
    }

    async _fileHandle(path, create) {
      if (!path.segments.length) throw new VFSError('IS_DIRECTORY', 'C:\\ é um diretório.', path.win32);
      const parentPath = normalizePath(path.segments.slice(0, -1).join('\\'));
      const parent = await this._directory(parentPath, create);
      const name = path.segments[path.segments.length - 1];
      try {
        return await parent.getFileHandle(name, { create: false });
      } catch (error) {
        if (error && error.name !== 'NotFoundError') throw error;
      }
      if (parent.entries) {
        for await (const [entryName, handle] of parent.entries()) {
          if (handle.kind === 'file' && entryName.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US')) {
            return handle;
          }
        }
      }
      if (create) return parent.getFileHandle(name, { create: true });
      throw this._notFound(path);
    }

    _ready() {
      if (!this.root) throw new VFSError('NOT_MAPPED', 'Mapeie uma pasta como C:\\ primeiro.');
    }

    async readFile(input) {
      const path = normalizePath(input);
      this._ready();
      await this._permission('read');
      const handle = await this._fileHandle(path, false);
      const file = await handle.getFile();
      this.logger(`CreateFile(${path.win32}) → leitura de ${file.size} bytes`);
      return file.arrayBuffer();
    }

    async createDirectory(input) {
      const path = normalizePath(input);
      if (!path.segments.length) throw new VFSError('ALREADY_EXISTS', 'C:\\ já existe.');
      const parent = await this._directory(normalizePath(path.segments.slice(0, -1).join('\\')), false);
      const name = path.segments[path.segments.length - 1];
      if (await this._childDirectory(parent, name, false)) throw new VFSError('ALREADY_EXISTS', 'Diretório já existe.');
      const handle = await parent.getDirectoryHandle(name, { create: true });
      this.directoryCache.set(path.key, handle);
      return { path: path.win32, persistent: true };
    }

    async writeFile(input, data) {
      const path = normalizePath(input);
      this._ready();
      await this._permission('readwrite');
      const handle = await this._fileHandle(path, true);
      const writable = await handle.createWritable();
      try {
        await writable.write(data);
        await writable.close();
      } catch (error) {
        if (typeof writable.abort === 'function') await writable.abort();
        throw error;
      }
      const size = typeof data.size === 'number' ? data.size : data.byteLength;
      this.logger(`WriteFile(${path.win32}) → ${size} bytes persistidos`);
      return { path: path.win32, bytes: size, persistent: true };
    }

    resolvePath(input) { this._ready(); return normalizePath(input); }

    async exists(input) {
      const path = normalizePath(input);
      try {
        await this._fileHandle(path, false);
        return true;
      } catch (error) {
        if (error && (error.code === 'NOT_FOUND' || error.name === 'NotFoundError')) return false;
        throw error;
      }
    }

    async stat(input) {
      const path = normalizePath(input);
      this._ready();
      await this._permission('read');
      if (path.segments.length) {
        try {
          const handle = await this._fileHandle(path, false);
          const file = await handle.getFile();
          return { path: path.win32, resolvedPath: path.win32, kind: 'file', size: file.size, lastModified: file.lastModified || 0, fileAttributes: 0x80 };
        } catch (error) {
          if (!error || (error.code !== 'NOT_FOUND' && error.name !== 'NotFoundError')) throw error;
        }
      }
      try {
        await this._directory(path, false);
        return { path: path.win32, resolvedPath: path.win32, kind: 'directory', size: 0, lastModified: 0, fileAttributes: 0x10 };
      } catch (error) {
        if (error && (error.code === 'NOT_FOUND' || error.name === 'NotFoundError')) throw this._notFound(path);
        throw error;
      }
    }

    async listDirectory(input) {
      const path = normalizePath(input);
      const directory = await this._directory(path, false);
      const entries = [];
      if (!directory.entries) return entries;
      for await (const [name, handle] of directory.entries()) {
        entries.push({ name, kind: handle.kind });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  Porthole.FileSystemAccessVFS = FileSystemAccessVFS;
})(typeof window !== 'undefined' ? window : globalThis);
