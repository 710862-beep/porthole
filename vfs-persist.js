/*
 * vfs-persist.js — overlay imediato e persistência ordenada para qualquer VFS.
 * A invocação define a ordem last-write-wins por arquivo. Leituras veem o
 * overlay antes do host; o Promise da escrita só confirma durabilidade quando
 * o backend persistente concluir createWritable/close. Fallback continua
 * explicitamente não persistente.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const { normalizePath, asBuffer } = Porthole.VFSUtils;
  const VFSError = Porthole.VFSError;

  function copyBytes(buffer) {
    const view = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    return view.slice();
  }

  class VFSPersistence {
    constructor(options) {
      const opts = options || {};
      if (!opts.vfs) throw new TypeError('VFSPersistence requer um VFS subjacente.');
      this.vfs = opts.vfs;
      this.overlays = new Map();
      this.queues = new Map();
      this.errors = new Map();
      this.dirty = new Set();
      this.sequence = 0;
    }

    get isMapped() { return Boolean(this.vfs && this.vfs.isMapped); }

    getInfo() {
      return Object.assign({}, this.vfs.getInfo(), {
        pendingWrites: this.queues.size,
        dirtyWrites: this.dirty.size,
        writeErrorCount: this.errors.size,
        writeOrdering: 'per-file-invocation-order',
      });
    }

    async mapDirectory(options) {
      await this.flush();
      const info = await this.vfs.mapDirectory(options);
      this._reset();
      return info;
    }

    async useFallbackFiles(files, options) {
      await this.flush();
      const info = await this.vfs.useFallbackFiles(files, options);
      this._reset();
      return info;
    }

    _reset() {
      this.overlays.clear();
      this.queues.clear();
      this.errors.clear();
      this.dirty.clear();
    }

    _path(input) {
      const path = normalizePath(input);
      return typeof this.vfs.resolvePath === 'function' ? this.vfs.resolvePath(path.win32) : path;
    }

    createDirectory(input) {
      const path = this._path(input);
      if (typeof this.vfs.createDirectory !== 'function') throw new VFSError('NOT_IMPLEMENTED', 'createDirectory indisponível.');
      return this.vfs.createDirectory(path.win32);
    }

    async readFile(input) {
      const path = this._path(input);
      const overlay = this.overlays.get(path.key);
      if (overlay) return overlay.bytes.buffer.slice(overlay.bytes.byteOffset, overlay.bytes.byteOffset + overlay.bytes.byteLength);
      return this.vfs.readFile(path.win32);
    }

    writeFile(input, data) {
      const path = this._path(input);
      const buffer = asBuffer(data);
      // Blob exige uma leitura assíncrona antes que seus bytes possam entrar no
      // overlay. TypedArray/ArrayBuffer seguem o caminho imediato.
      if (typeof Blob !== 'undefined' && buffer instanceof Blob) {
        return buffer.arrayBuffer().then((bytes) => this._enqueue(path, bytes));
      }
      return this._enqueue(path, buffer);
    }

    _enqueue(path, buffer) {
      if (!this.isMapped) throw new VFSError('NOT_MAPPED', 'Mapeie uma pasta como C:\\ antes de escrever.', path.win32);
      const bytes = copyBytes(buffer);
      const sequence = ++this.sequence;
      this.overlays.set(path.key, { path, bytes, sequence, lastModified: Date.now() });
      this.dirty.add(path.key);

      const previous = this.queues.get(path.key) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        try {
          const result = await this.vfs.writeFile(path.win32, bytes);
          const current = this.overlays.get(path.key);
          if (result && result.persistent) {
            if (!current || current.sequence === sequence) {
              this.dirty.delete(path.key);
              this.overlays.delete(path.key);
            }
            const error = this.errors.get(path.key);
            if (error && error.sequence <= sequence) this.errors.delete(path.key);
          }
          return Object.assign({}, result, { sequence });
        } catch (error) {
          this.errors.set(path.key, { sequence, error });
          throw error;
        }
      });
      this.queues.set(path.key, operation);
      const cleanup = () => { if (this.queues.get(path.key) === operation) this.queues.delete(path.key); };
      operation.then(cleanup, cleanup);
      return operation;
    }

    async exists(input) {
      const path = this._path(input);
      if (this.overlays.has(path.key)) return true;
      return this.vfs.exists(path.win32);
    }

    async stat(input) {
      const original = normalizePath(input);
      const path = this._path(original.win32);
      const overlay = this.overlays.get(path.key);
      if (overlay) return { path: original.win32, resolvedPath: path.win32, kind: 'file', size: overlay.bytes.byteLength, lastModified: overlay.lastModified, fileAttributes: 0x80 };
      if (typeof this.vfs.stat !== 'function') throw new VFSError('NOT_IMPLEMENTED', 'stat não é suportado por este VFS.');
      return this.vfs.stat(original.win32);
    }

    async createSymlink(input, target) {
      await this.flush();
      if (typeof this.vfs.createSymlink !== 'function') throw new VFSError('NOT_IMPLEMENTED', 'Links virtuais não são suportados por este VFS.');
      return this.vfs.createSymlink(input, target);
    }

    readlink(input) {
      if (typeof this.vfs.readlink !== 'function') throw new VFSError('NOT_IMPLEMENTED', 'readlink não é suportado por este VFS.');
      return this.vfs.readlink(input);
    }

    async listDirectory(input) {
      const path = this._path(input || 'C:\\');
      let entries = [];
      try { entries = await this.vfs.listDirectory(path.win32); }
      catch (error) {
        // Um diretório criado por uma escrita ainda na fila pode existir apenas
        // no overlay. Outros erros continuam sendo propagados.
        if (!error || error.code !== 'NOT_FOUND') throw error;
      }
      const result = new Map();
      for (const entry of entries || []) result.set(entry.name.toLocaleLowerCase('en-US'), entry);
      const depth = path.segments.length;
      for (const overlay of this.overlays.values()) {
        const segments = overlay.path.segments;
        if (segments.length <= depth) continue;
        let belongs = true;
        for (let i = 0; i < depth; i += 1) {
          if (segments[i].toLocaleLowerCase('en-US') !== path.segments[i].toLocaleLowerCase('en-US')) { belongs = false; break; }
        }
        if (!belongs) continue;
        const name = segments[depth];
        const key = name.toLocaleLowerCase('en-US');
        const kind = segments.length === depth + 1 ? 'file' : 'directory';
        const previousEntry = result.get(key);
        if (!previousEntry || previousEntry.kind !== 'directory') result.set(key, { name, kind });
      }
      return Array.from(result.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    async flush() {
      const pending = Array.from(new Set(this.queues.values()));
      if (pending.length) await Promise.allSettled(pending);
      if (typeof this.vfs.flush === 'function') await this.vfs.flush();
      if (this.errors.size) {
        const first = Array.from(this.errors.values()).sort((a, b) => a.sequence - b.sequence)[0].error;
        const error = new VFSError('PERSISTENCE_FAILED', `Falha ao persistir ${this.errors.size} arquivo(s): ${first.message}`, first.path || null);
        error.cause = first;
        error.failures = this.errors.size;
        throw error;
      }
      return { persisted: this.vfs.getInfo().persistent !== false, pendingWrites: this.queues.size };
    }
  }

  Porthole.VFSPersistence = VFSPersistence;
})(typeof window !== 'undefined' ? window : globalThis);
