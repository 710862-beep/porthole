/*
 * shims/registry.js — advapi32 → hives case-insensitive + snapshot no VFS.
 * A representação JS devolve objetos com status/handle em vez de simular
 * ponteiros de saída. Valores nunca são enviados ao ApiTracer: o arquivo pode
 * conter credenciais e somente o VFS escolhido pelo usuário deve recebê-lo.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const Shim = Porthole.Shim;

  const ERROR = Object.freeze({ SUCCESS: 0, FILE_NOT_FOUND: 2, ACCESS_DENIED: 5, INVALID_HANDLE: 6, INVALID_PARAMETER: 87, NO_MORE_ITEMS: 259 });
  const TYPE = Object.freeze({ NONE: 0, SZ: 1, EXPAND_SZ: 2, BINARY: 3, DWORD: 4, MULTI_SZ: 7, QWORD: 11 });
  const ROOTS = Object.freeze({
    0x80000001: 'HKCU', // HKEY_CURRENT_USER
    0x80000002: 'HKLM', // HKEY_LOCAL_MACHINE
    0x80000003: 'HKU',
    0x80000005: 'HKCR',
  });
  const ROOT_ALIASES = Object.freeze({
    HKCU: 'HKCU', HKEY_CURRENT_USER: 'HKCU',
    HKLM: 'HKLM', HKEY_LOCAL_MACHINE: 'HKLM',
    HKU: 'HKU', HKEY_USERS: 'HKU',
    HKCR: 'HKCR', HKEY_CLASSES_ROOT: 'HKCR',
  });

  function rootName(root) {
    if (typeof root === 'number' || typeof root === 'bigint') return ROOTS[Number(root) >>> 0] || null;
    const name = String(root || '').replace(/^HKEY_/, 'HKEY_').toUpperCase();
    return ROOT_ALIASES[name] || null;
  }

  function cleanPath(path) {
    const text = String(path || '').replace(/\//g, '\\').replace(/^\\+|\\+$/g, '');
    if (text.includes('\0') || text.length > 4096) {
      const error = new Error('Caminho de registro inválido ou longo demais.');
      error.status = ERROR.INVALID_PARAMETER;
      throw error;
    }
    const pieces = text ? text.split('\\') : [];
    const first = pieces.shift();
    const root = ROOT_ALIASES[String(first || '').toUpperCase()];
    if (!root) {
      const error = new Error('Hive de registro não suportada.');
      error.status = ERROR.INVALID_PARAMETER;
      throw error;
    }
    const canonical = [root].concat(pieces).join('\\');
    return { root, pieces, path: canonical, key: canonical.toLocaleLowerCase('en-US') };
  }

  function joinPath(base, subkey) {
    const suffix = String(subkey == null ? '' : subkey).replace(/\//g, '\\').replace(/^\\+|\\+$/g, '');
    return cleanPath(suffix ? `${base}\\${suffix}` : base);
  }

  function bytesOf(data) {
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    if (data instanceof ArrayBuffer) return new Uint8Array(data).slice();
    if (typeof data === 'string') {
      if (!/^[0-9a-f]*$/i.test(data) || data.length % 2) throw new TypeError('REG_BINARY serializado deve ser hexadecimal.');
      const result = new Uint8Array(data.length / 2);
      for (let i = 0; i < result.length; i += 1) result[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
      return result;
    }
    throw new TypeError('Valor binário requer ArrayBuffer, TypedArray ou hexadecimal.');
  }

  function hex(bytes) { return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(''); }

  function normalizeValue(type, data) {
    const valueType = Number(type) >>> 0;
    switch (valueType) {
      case TYPE.SZ:
      case TYPE.EXPAND_SZ:
        return { type: valueType, data: String(data == null ? '' : data), size: (String(data == null ? '' : data).length + 1) * 2 };
      case TYPE.MULTI_SZ: {
        if (!Array.isArray(data)) throw new TypeError('REG_MULTI_SZ requer um array de strings.');
        const values = data.map(String);
        return { type: valueType, data: values, size: (values.join('\0').length + 2) * 2 };
      }
      case TYPE.DWORD: {
        const number = Number(data);
        if (!Number.isFinite(number)) throw new TypeError('REG_DWORD requer um número.');
        return { type: valueType, data: number >>> 0, size: 4 };
      }
      case TYPE.QWORD: {
        const number = BigInt(data == null ? 0 : data);
        if (number < 0 || number > 0xffffffffffffffffn) throw new TypeError('REG_QWORD fora de 64 bits.');
        return { type: valueType, data: number, size: 8 };
      }
      case TYPE.BINARY:
      case TYPE.NONE: {
        const bytes = bytesOf(data == null ? new Uint8Array(0) : data);
        return { type: valueType, data: bytes, size: bytes.byteLength };
      }
      default: {
        const error = new Error(`Tipo de registro não suportado: ${valueType}.`);
        error.status = ERROR.INVALID_PARAMETER;
        throw error;
      }
    }
  }

  function serializableValue(value) {
    const result = { name: value.name, type: value.type, size: value.size };
    if (value.type === TYPE.BINARY || value.type === TYPE.NONE) result.data = hex(value.data);
    else if (value.type === TYPE.QWORD) result.data = value.data.toString(10);
    else result.data = value.data;
    return result;
  }

  class RegistryStore {
    constructor(options) {
      const opts = options || {};
      if (!opts.vfs) throw new TypeError('RegistryStore requer VFS para persistência.');
      this.vfs = opts.vfs;
      this.path = opts.path || 'C:\\Porthole\\Registry\\hives.json';
      this.keys = new Map();
      this.writeChain = Promise.resolve();
      for (const root of ['HKCU', 'HKLM', 'HKU', 'HKCR']) this._createRecord(cleanPath(root));
      this.ready = this._load();
    }

    _createRecord(path) {
      const existing = this.keys.get(path.key);
      if (existing) return { record: existing, disposition: 2 };
      const record = { path: path.path, key: path.key, values: new Map() };
      this.keys.set(path.key, record);
      return { record, disposition: 1 };
    }

    async _load() {
      let bytes;
      try { bytes = await this.vfs.readFile(this.path); }
      catch (error) {
        if (error && error.code === 'NOT_FOUND') return;
        throw error;
      }
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Snapshot de registro excede 8 MiB.');
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.keys) || parsed.keys.length > 16384) {
        throw new Error('Snapshot de registro inválido ou versão não suportada.');
      }
      const loaded = new Map();
      for (const root of ['HKCU', 'HKLM', 'HKU', 'HKCR']) {
        const path = cleanPath(root);
        loaded.set(path.key, { path: path.path, key: path.key, values: new Map() });
      }
      for (const item of parsed.keys) {
        const path = cleanPath(item.path);
        if (loaded.has(path.key) || !Array.isArray(item.values) || item.values.length > 65536) throw new Error('Chave duplicada ou valores inválidos no registro.');
        const record = { path: path.path, key: path.key, values: new Map() };
        for (const saved of item.values) {
          const name = String(saved.name == null ? '' : saved.name);
          const value = normalizeValue(saved.type, saved.data);
          record.values.set(name.toLocaleLowerCase('en-US'), Object.assign(value, { name }));
        }
        loaded.set(path.key, record);
      }
      this.keys = loaded;
    }

    _record(path) { return this.keys.get(cleanPath(path).key) || null; }

    _save() {
      // Serializar antes de enfileirar preserva o snapshot desta mutação. O VFS
      // persistente também ordena por arquivo; esta cadeia cobre VFS sem wrapper.
      const payload = JSON.stringify({
        version: 1,
        keys: Array.from(this.keys.values())
          .filter((record) => !['hkcu', 'hklm', 'hku', 'hkcr'].includes(record.key) || record.values.size)
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((record) => ({
            path: record.path,
            values: Array.from(record.values.values()).sort((a, b) => a.name.localeCompare(b.name)).map(serializableValue),
          })),
      });
      const operation = this.writeChain.catch(() => {}).then(() => this.vfs.writeFile(this.path, payload));
      this.writeChain = operation;
      return operation;
    }

    // Caller must await ready before using the synchronous guest overlay API.
    createKeySync(path) {
      const normalized = cleanPath(path);
      let current = normalized.root;
      let disposition = 2;
      for (const piece of normalized.pieces) {
        current = `${current}\\${piece}`;
        const result = this._createRecord(cleanPath(current));
        if (result.disposition === 1) disposition = 1;
      }
      return { path: normalized.path, disposition };
    }
    async createKey(path) {
      await this.ready;
      const result = this.createKeySync(path);
      await this._save();
      return result;
    }

    async openKey(path) { await this.ready; return this._record(path); }
    async query(path, name) {
      await this.ready;
      const record = this._record(path);
      const value = record && record.values.get(String(name == null ? '' : name).toLocaleLowerCase('en-US'));
      return value || null;
    }

    setValueSync(path, name, type, data) {
      const record = this._record(path);
      if (!record) { const error = new Error('Chave não encontrada.'); error.status = ERROR.FILE_NOT_FOUND; throw error; }
      const value = normalizeValue(type, data);
      value.name = String(name == null ? '' : name);
      record.values.set(value.name.toLocaleLowerCase('en-US'), value);
    }
    async setValue(path, name, type, data) {
      await this.ready;
      this.setValueSync(path, name, type, data);
      await this._save();
    }

    async deleteKey(path) {
      await this.ready;
      const normalized = cleanPath(path);
      if (!normalized.pieces.length) return ERROR.ACCESS_DENIED;
      if (Array.from(this.keys.keys()).some((key) => key.startsWith(`${normalized.key}\\`))) return ERROR.ACCESS_DENIED;
      if (!this.keys.delete(normalized.key)) return ERROR.FILE_NOT_FOUND;
      await this._save();
      return ERROR.SUCCESS;
    }

    async enumKey(path, index) {
      await this.ready;
      const normalized = cleanPath(path);
      const prefix = `${normalized.key}\\`;
      const names = new Map();
      for (const record of this.keys.values()) {
        if (!record.key.startsWith(prefix)) continue;
        const rest = record.key.slice(prefix.length);
        if (!rest || rest.includes('\\')) continue;
        const name = record.path.slice(normalized.path.length + 1);
        names.set(name.toLocaleLowerCase('en-US'), name);
      }
      return Array.from(names.values()).sort((a, b) => a.localeCompare(b))[Number(index)] || null;
    }

    async flush() {
      await this.writeChain;
      if (typeof this.vfs.flush === 'function') await this.vfs.flush();
    }
  }

  class Advapi32Shim extends Shim {
    constructor(context) {
      super('advapi32.dll', context);
      this.store = context.registryStore || new RegistryStore({ vfs: context.vfs, path: context.registryPath });
      this.handles = new Map();
      this.nextHandle = 0x1000;
      this.lastError = 0;
    }

    _base(root) {
      const predefined = rootName(root);
      if (predefined) return predefined;
      const handle = this.handles.get(Number(root));
      return handle ? handle.path : null;
    }

    _failure(code) { this.lastError = code; return code; }

    async _open(root, subkey, create) {
      const base = this._base(root);
      if (!base) return { status: ERROR.INVALID_HANDLE, handle: 0 };
      try {
        const path = joinPath(base, subkey);
        const result = create ? await this.store.createKey(path.path) : await this.store.openKey(path.path);
        if (!result) return { status: ERROR.FILE_NOT_FOUND, handle: 0 };
        const handle = this.nextHandle++;
        this.handles.set(handle, { path: path.path });
        this.lastError = 0;
        return { status: 0, handle, disposition: result.disposition };
      } catch (error) { return { status: error.status || ERROR.ACCESS_DENIED, handle: 0, persistenceError: error.code === 'PERSISTENCE_FAILED' }; }
    }

    RegCreateKeyExW(root, subkey) { return this._open(root, subkey, true); }
    RegCreateKeyExA(root, subkey) { return this._open(root, subkey, true); }
    RegOpenKeyExW(root, subkey) { return this._open(root, subkey, false); }
    RegOpenKeyExA(root, subkey) { return this._open(root, subkey, false); }

    async RegSetValueExW(handle, name, type, data) {
      const key = this.handles.get(Number(handle));
      if (!key) return this._failure(ERROR.INVALID_HANDLE);
      try { await this.store.setValue(key.path, name, type, data); this.lastError = 0; return 0; }
      catch (error) { return this._failure(error.status || ERROR.ACCESS_DENIED); }
    }
    RegSetValueExA(handle, name, type, data) { return this.RegSetValueExW(handle, name, type, data); }

    async RegQueryValueExW(handle, name) {
      const key = this.handles.get(Number(handle));
      if (!key) return { status: ERROR.INVALID_HANDLE };
      const value = await this.store.query(key.path, name);
      if (!value) return { status: ERROR.FILE_NOT_FOUND };
      const data = value.data instanceof Uint8Array ? value.data.slice() : value.data;
      return { status: 0, type: value.type, data, size: value.size };
    }
    RegQueryValueExA(handle, name) { return this.RegQueryValueExW(handle, name); }

    async RegDeleteKeyW(root, subkey) {
      const base = this._base(root);
      if (!base) return this._failure(ERROR.INVALID_HANDLE);
      try { return this._failure(await this.store.deleteKey(joinPath(base, subkey).path)); }
      catch (error) { return this._failure(error.status || ERROR.ACCESS_DENIED); }
    }
    RegDeleteKeyA(root, subkey) { return this.RegDeleteKeyW(root, subkey); }

    async RegEnumKeyExW(handle, index) {
      const key = this.handles.get(Number(handle));
      if (!key) return { status: ERROR.INVALID_HANDLE };
      const name = await this.store.enumKey(key.path, index);
      return name == null ? { status: ERROR.NO_MORE_ITEMS } : { status: 0, name };
    }
    RegEnumKeyExA(handle, index) { return this.RegEnumKeyExW(handle, index); }

    RegCloseKey(handle) {
      if (rootName(handle)) return 0; // Hives predefinidas não são fechadas.
      return this._failure(this.handles.delete(Number(handle)) ? 0 : ERROR.INVALID_HANDLE);
    }

    async RegFlushKey(handle) {
      if (!rootName(handle) && !this.handles.has(Number(handle))) return this._failure(ERROR.INVALID_HANDLE);
      try { await this.store.flush(); return this._failure(0); }
      catch (_) { return this._failure(ERROR.ACCESS_DENIED); }
    }

    dispose() { this.handles.clear(); }
  }

  Porthole.Registry = { ERROR, TYPE, ROOTS, RegistryStore, Advapi32Shim, normalizeValue };
})(typeof window !== 'undefined' ? window : globalThis);
