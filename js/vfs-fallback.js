/*
 * vfs-fallback.js — Firefox/Safari e navegadores sem File System Access API.
 * Uma seleção webkitdirectory fornece Blobs legíveis. Escritas ficam em um
 * overlay em memória: nunca afirmamos que a pasta original foi modificada.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const { normalizePath } = Porthole.VFSUtils;
  const VFSError = Porthole.VFSError;

  class FallbackVFS {
    constructor(options) {
      const opts = options || {};
      this.document = opts.document || global.document;
      this.input = opts.input || null;
      this.logger = typeof opts.logger === 'function' ? opts.logger : function () {};
      this.files = new Map();
      this.overlays = new Map();
      this.directories = new Set();
      this.links = new Map();
      this.rootName = null;
      this.kind = 'memory-fallback';
      this.persistent = false;
    }

    get isMapped() { return Boolean(this.rootName); }

    getInfo() {
      return {
        mapped: this.isMapped,
        kind: this.kind,
        persistent: false,
        rootName: this.rootName,
        fileCount: this.files.size,
        overlayCount: this.overlays.size,
        label: 'Input directory + memória',
        detail: 'Leitura dos arquivos selecionados; escritas não persistentes',
      };
    }

    _createInput() {
      if (this.input) return this.input;
      if (!this.document || !this.document.createElement) {
        throw new VFSError('UNAVAILABLE', 'input webkitdirectory indisponível.');
      }
      this.input = this.document.createElement('input');
      this.input.type = 'file';
      this.input.multiple = true;
      this.input.setAttribute('webkitdirectory', '');
      this.input.setAttribute('directory', '');
      this.input.style.display = 'none';
      this.input.setAttribute('aria-hidden', 'true');
      (this.document.body || this.document.documentElement).appendChild(this.input);
      return this.input;
    }

    mapDirectory() {
      const input = this._createInput();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          input.removeEventListener('change', onChange);
          input.removeEventListener('cancel', onCancel);
        };
        const onChange = async () => {
          cleanup();
          try {
            resolve(await this.mapFiles(input.files));
          } catch (error) { reject(error); }
        };
        const onCancel = () => {
          cleanup();
          const error = new VFSError('CANCELLED', 'Seleção de pasta cancelada.');
          error.name = 'AbortError';
          reject(error);
        };
        input.addEventListener('change', onChange, { once: true });
        input.addEventListener('cancel', onCancel, { once: true });
        input.value = '';
        input.click();
      });
    }

    async mapFiles(fileList, options) {
      const selected = Array.from(fileList || []);
      if (!selected.length) throw new VFSError('EMPTY_SELECTION', 'Nenhum arquivo foi selecionado.');

      const firstRelative = selected[0].webkitRelativePath || selected[0].name;
      const rootName = options && options.rootName || firstRelative.split('/')[0] || 'C';
      const nextFiles = new Map();
      const nextDirectories = new Set();

      for (const file of selected) {
        let relative = String(file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
        const pieces = relative.split('/').filter(Boolean);
        if (pieces.length > 1 && pieces[0].toLocaleLowerCase('en-US') === rootName.toLocaleLowerCase('en-US')) {
          pieces.shift();
        }
        if (!pieces.length) continue;
        const path = normalizePath(pieces.join('\\'));
        if (nextFiles.has(path.key)) {
          throw new VFSError('DUPLICATE_PATH', `Dois arquivos colidem em Win32: ${path.win32}`);
        }
        nextFiles.set(path.key, {
          path,
          name: path.segments[path.segments.length - 1],
          file,
          size: Number(file.size || 0),
          lastModified: Number(file.lastModified || 0),
        });
        for (let i = 1; i < path.segments.length; i += 1) {
          nextDirectories.add(path.segments.slice(0, i).join('/').toLocaleLowerCase('en-US'));
        }
      }

      if (!nextFiles.size) throw new VFSError('EMPTY_SELECTION', 'A pasta selecionada não contém arquivos.');
      this.files = nextFiles;
      this.directories = nextDirectories;
      this.overlays.clear();
      this.links.clear();
      this.rootName = rootName;
      this.logger(`C:\\ mapeado para “${rootName}” (${this.files.size} arquivos; fallback em memória)`);
      return this.getInfo();
    }

    _ready() {
      if (!this.isMapped) throw new VFSError('NOT_MAPPED', 'Mapeie uma pasta como C:\\ primeiro.');
    }

    _resolve(path) {
      let current = path;
      const visited = new Set();
      for (let depth = 0; depth <= 16; depth += 1) {
        let match = null;
        for (let i = 1; i <= current.segments.length; i += 1) {
          const key = current.segments.slice(0, i).join('/').toLocaleLowerCase('en-US');
          if (this.links.has(key)) { match = { index: i, link: this.links.get(key) }; break; }
        }
        if (!match) return current;
        if (visited.has(match.link.path.key)) throw new VFSError('ELOOP', `Ciclo de links simbólicos em ${match.link.path.win32}.`, current.win32);
        visited.add(match.link.path.key);
        const segments = match.link.target.segments.concat(current.segments.slice(match.index));
        current = normalizePath(segments.join('\\'));
      }
      throw new VFSError('ELOOP', `Mais de 16 links ao resolver ${path.win32}.`, path.win32);
    }

    resolvePath(input) { this._ready(); return this._resolve(normalizePath(input)); }

    createSymlink(input, target) {
      this._ready();
      const path = normalizePath(input);
      if (!path.segments.length) throw new VFSError('INVALID_PATH', 'C:\\ não pode ser substituída por um link.');
      if (this.files.has(path.key) || this.overlays.has(path.key) || this.links.has(path.key)) throw new VFSError('ALREADY_EXISTS', `O path já existe: ${path.win32}`);
      const targetText = String(target || '');
      const absolute = /^(?:[A-Za-z]:|\\\\|\/)/.test(targetText);
      const parent = path.segments.slice(0, -1).join('\\');
      const resolved = normalizePath(absolute ? targetText : `${parent ? `${parent}\\` : ''}${targetText}`);
      this.links.set(path.key, { path, target: resolved });
      for (let i = 1; i < path.segments.length; i += 1) this.directories.add(path.segments.slice(0, i).join('/').toLocaleLowerCase('en-US'));
      return { path: path.win32, target: resolved.win32, persistent: false, virtual: true };
    }

    readlink(input) {
      this._ready();
      const path = normalizePath(input);
      const link = this.links.get(path.key);
      if (!link) throw new VFSError('NOT_A_SYMLINK', `Não é um link virtual: ${path.win32}`);
      return link.target.win32;
    }

    async readFile(input) {
      this._ready();
      const path = this._resolve(normalizePath(input));
      const overlay = this.overlays.get(path.key);
      const original = this.files.get(path.key);
      const record = overlay || original;
      if (!record) throw new VFSError('NOT_FOUND', `Arquivo não encontrado: ${path.win32}`, path.win32);
      const bytes = await record.file.arrayBuffer();
      this.logger(`CreateFile(${path.win32}) → ${bytes.byteLength} bytes (${overlay ? 'overlay' : 'cache'})`);
      return bytes;
    }

    async createDirectory(input) {
      this._ready();
      const path = this._resolve(normalizePath(input));
      if (!path.key || this.directories.has(path.key) || this.files.has(path.key) || this.overlays.has(path.key)) throw new VFSError('ALREADY_EXISTS', 'Diretório/arquivo já existe.');
      const parent = path.segments.slice(0, -1).join('/').toLocaleLowerCase('en-US');
      if (parent && !this.directories.has(parent)) throw new VFSError('NOT_FOUND', 'Diretório pai não existe.');
      this.directories.add(path.key);
      return { path: path.win32, persistent: false };
    }

    async writeFile(input, data) {
      this._ready();
      const path = this._resolve(normalizePath(input));
      if (!path.segments.length) throw new VFSError('IS_DIRECTORY', 'C:\\ é um diretório.');
      const blob = data instanceof Blob ? data : new Blob([data]);
      this.overlays.set(path.key, {
        path,
        name: path.segments[path.segments.length - 1],
        file: blob,
        size: blob.size,
        lastModified: Date.now(),
      });
      for (let i = 1; i < path.segments.length; i += 1) {
        this.directories.add(path.segments.slice(0, i).join('/').toLocaleLowerCase('en-US'));
      }
      this.logger(`WriteFile(${path.win32}) → ${blob.size} bytes em memória (não persistente)`);
      return { path: path.win32, bytes: blob.size, persistent: false };
    }

    async exists(input) {
      this._ready();
      const path = this._resolve(normalizePath(input));
      if (this.overlays.has(path.key) || this.files.has(path.key)) return true;
      if (!path.segments.length || this.directories.has(path.key)) return true;
      const prefix = `${path.key}/`;
      return Array.from(this.files.keys()).concat(Array.from(this.overlays.keys())).some((key) => key.startsWith(prefix));
    }

    async stat(input) {
      this._ready();
      const original = normalizePath(input);
      const path = this._resolve(original);
      const record = this.overlays.get(path.key) || this.files.get(path.key);
      if (record) return { path: original.win32, resolvedPath: path.win32, kind: 'file', size: record.size, lastModified: record.lastModified || 0, fileAttributes: 0x80 };
      if (await this.exists(path.win32)) return { path: original.win32, resolvedPath: path.win32, kind: 'directory', size: 0, lastModified: 0, fileAttributes: 0x10 };
      throw new VFSError('NOT_FOUND', `Path não encontrado: ${original.win32}`, original.win32);
    }

    async listDirectory(input) {
      this._ready();
      const path = this._resolve(normalizePath(input));
      const prefix = path.key ? `${path.key}/` : '';
      const result = new Map();
      const add = (key, record) => {
        if (!key.startsWith(prefix) || key === path.key) return;
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (!first) return;
        const childKey = prefix + first;
        const depth = prefix ? prefix.split('/').filter(Boolean).length : 0;
        const displayName = record.path && record.path.segments[depth] || first;
        if (rest.includes('/')) {
          if (!result.has(childKey)) result.set(childKey, { name: displayName, kind: 'directory' });
        } else if (!result.has(childKey)) {
          result.set(childKey, { name: record.name || displayName, kind: 'file' });
        }
      };
      for (const [key, record] of this.files) add(key, record);
      for (const [key, record] of this.overlays) add(key, record);
      for (const key of this.directories) {
        if (key.startsWith(prefix) && key !== path.key) {
          const rest = key.slice(prefix.length);
          const first = rest.split('/')[0];
          if (first && !result.has(prefix + first)) result.set(prefix + first, { name: first, kind: 'directory' });
        }
      }
      for (const link of this.links.values()) {
        const parent = link.path.segments.slice(0, -1).join('/').toLocaleLowerCase('en-US');
        if (parent === path.key) result.set(link.path.key, { name: link.path.segments[link.path.segments.length - 1], kind: 'symlink', target: link.target.win32 });
      }
      return Array.from(result.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  Porthole.FallbackVFS = FallbackVFS;
})(typeof window !== 'undefined' ? window : globalThis);
