/*
 * porthole-linker.js — interposição de DLLs e trilha de APIs.
 * LoadLibraryA/W, imports estáticos e GetProcAddress convergem para este
 * linker. Ele resolve SHIMs JavaScript; não executa instruções do PE.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const now = () => global.performance && performance.now ? performance.now() : Date.now();

  function shortValue(value) {
    if (typeof value === 'string') return JSON.stringify(value.length > 90 ? `${value.slice(0, 87)}...` : value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value);
    if (typeof value === 'function') return '[callback]';
    if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
    if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
    if (Array.isArray(value)) return `[Array ${value.length}]`;
    return '[object]';
  }

  class ApiTracer {
    constructor(limit) {
      this.limit = limit || 600;
      this.entries = [];
      this.listeners = new Set();
      this.sequence = 0;
    }

    record(entry) {
      const item = Object.assign({
        id: ++this.sequence,
        timestamp: now(),
        wallTime: new Date(),
        kind: 'info',
        source: 'runtime',
        message: '',
      }, entry);
      this.entries.push(item);
      if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
      for (const listener of this.listeners) {
        try { listener(item); } catch (_) { /* Um observador não pode parar o runtime. */ }
      }
      return item;
    }

    log(source, message, kind, details) {
      return this.record({ source, message, kind: kind || 'info', details });
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    clear() {
      this.entries.length = 0;
      this.record({ source: 'runtime', message: 'Trilha de API limpa.', kind: 'info' });
    }
  }

  class Shim {
    constructor(dllName, context) {
      this.dllName = dllName;
      this.context = context || {};
    }

    _call(method, args, operation) {
      const linker = this.context.linker;
      if (!linker) return operation();
      return linker._invokeShim(this, method, Array.from(args || []), operation);
    }

    _unsupported(method) {
      const error = new Error(`${this.dllName}!${method} não está implementado neste subconjunto.`);
      error.code = 'NOT_IMPLEMENTED';
      throw error;
    }
  }

  class DynamicLinker {
    constructor(options) {
      const opts = options || {};
      this.tracer = opts.tracer || new ApiTracer();
      this.context = Object.assign({}, opts.context);
      this.context.linker = this;
      this.context.tracer = this.tracer;
      this.factories = new Map();
      this.modules = new Map();
    }

    static canonicalName(name) {
      let value = String(name || '').trim().replace(/^.*[\\/]/, '').toLowerCase();
      if (value && !value.endsWith('.dll')) value += '.dll';
      return value;
    }

    register(name, factory) {
      const canonical = DynamicLinker.canonicalName(name);
      if (!canonical || typeof factory !== 'function') throw new TypeError('Registro de DLL inválido.');
      this.factories.set(canonical, factory);
      return this;
    }

    hasShim(name) { return this.factories.has(DynamicLinker.canonicalName(name)); }

    loadLibrary(name, caller) {
      const canonical = DynamicLinker.canonicalName(name);
      const existing = this.modules.get(canonical);
      if (existing) {
        existing.refs += 1;
        this.tracer.log('linker', `LoadLibrary(${shortValue(canonical)}) → SHIM ativo · refcount=${existing.refs}`, 'shim', { caller });
        return existing.instance;
      }
      const factory = this.factories.get(canonical);
      if (!factory) {
        this.tracer.log('linker', `LoadLibrary(${shortValue(canonical)}) → DLL sem SHIM`, 'error', { caller });
        const error = new Error(`Nenhum SHIM registrado para ${canonical || name}.`);
        error.code = 'DLL_NOT_FOUND';
        error.dll = canonical;
        throw error;
      }
      const instance = factory(this.context);
      if (!instance || (typeof instance !== 'object' && typeof instance !== 'function')) {
        throw new TypeError(`Factory de ${canonical} não retornou um módulo.`);
      }
      this.modules.set(canonical, { name: canonical, instance, refs: 1 });
      this.tracer.log('linker', `LoadLibrary(${shortValue(canonical)}) → SHIM ativo`, 'shim', { caller });
      return instance;
    }

    freeLibrary(nameOrInstance) {
      let canonical = typeof nameOrInstance === 'string' ? DynamicLinker.canonicalName(nameOrInstance) : nameOrInstance && nameOrInstance.dllName;
      canonical = DynamicLinker.canonicalName(canonical);
      const module = this.modules.get(canonical);
      if (!module) return false;
      module.refs -= 1;
      this.tracer.log('linker', `FreeLibrary(${shortValue(canonical)}) → refcount=${module.refs}`, 'shim');
      if (module.refs <= 0) {
        if (typeof module.instance.dispose === 'function') module.instance.dispose();
        this.modules.delete(canonical);
      }
      return true;
    }

    _exports(instance) { return instance.exports || instance; }

    findExport(moduleName, exportName) {
      let canonical = moduleName && typeof moduleName === 'object' ? moduleName.dllName : moduleName;
      if (moduleName && typeof moduleName === 'object' && !canonical) {
        const owner = Array.from(this.modules.values()).find((entry) => entry.instance === moduleName);
        canonical = owner && owner.name;
      }
      canonical = DynamicLinker.canonicalName(canonical);
      const module = this.modules.get(canonical);
      if (!module) return null;
      const exports = this._exports(module.instance);
      if (typeof exportName !== 'string') return null;
      if (typeof exports[exportName] === 'function') return { owner: exports, fn: exports[exportName], name: exportName };
      // Algumas import tables usam aliases A/W; nomes conhecidos podem ser
      // resolvidos sem diferenciar caixa, mas ordinals nunca viram nomes falsos.
      const actual = Object.keys(exports).find((key) => key.toLowerCase() === exportName.toLowerCase() && typeof exports[key] === 'function');
      return actual ? { owner: exports, fn: exports[actual], name: actual } : null;
    }

    getProcAddress(moduleNameOrInstance, exportName) {
      const moduleName = moduleNameOrInstance;
      const resolved = this.findExport(moduleName, exportName);
      if (!resolved) {
        this.tracer.log('linker', `GetProcAddress(${moduleName}, ${shortValue(exportName)}) → não resolvido`, 'warning');
        return null;
      }
      this.tracer.log('linker', `GetProcAddress(${moduleName}, ${resolved.name}) → SHIM`, 'shim');
      return resolved.fn.bind(resolved.owner);
    }

    _invokeShim(shim, method, args, operation) {
      const start = now();
      const source = shim.dllName;
      const signature = `${source}!${method}(${args.map(shortValue).join(', ')})`;
      const success = (result) => {
        this.tracer.record({ source, api: method, kind: 'api', message: `${signature} → OK`, duration: now() - start });
        return result;
      };
      const failure = (error) => {
        this.tracer.record({ source, api: method, kind: 'error', message: `${signature} → ${error.message}`, duration: now() - start, error });
        throw error;
      };
      try {
        const result = operation();
        if (result && typeof result.then === 'function') return result.then(success, failure);
        return success(result);
      } catch (error) { return failure(error); }
    }

    invoke(moduleName, exportName, args) {
      const resolved = this.findExport(moduleName, exportName);
      if (!resolved) {
        const error = new Error(`${moduleName}!${exportName} não resolvido.`);
        error.code = 'EXPORT_NOT_FOUND';
        throw error;
      }
      const start = now();
      try {
        const result = resolved.fn.apply(resolved.owner, args || []);
        // Métodos derivados de Shim já fazem tracing; este registro cobre exports simples.
        if (!(resolved.owner instanceof Shim)) {
          this.tracer.record({ source: moduleName, api: exportName, kind: 'api', message: `${moduleName}!${exportName} → OK`, duration: now() - start });
        }
        return result;
      } catch (error) {
        if (!(resolved.owner instanceof Shim)) {
          this.tracer.record({ source: moduleName, api: exportName, kind: 'error', message: `${moduleName}!${exportName} → ${error.message}`, duration: now() - start, error });
        }
        throw error;
      }
    }

    resolveImports(pe) {
      const report = {
        loadedDlls: [], unsupportedDlls: [], missingFunctions: [],
        resolvedFunctions: 0, totalFunctions: 0, importsComplete: true,
      };
      for (const descriptor of pe.imports || []) {
        const dll = DynamicLinker.canonicalName(descriptor.dll);
        const functions = descriptor.functions || [];
        report.totalFunctions += functions.length;
        if (!this.hasShim(dll)) {
          if (!report.unsupportedDlls.includes(dll)) report.unsupportedDlls.push(dll);
          report.importsComplete = false;
          for (const fn of functions) report.missingFunctions.push({ dll, name: fn.name || `ordinal_${fn.ordinal}` });
          this.tracer.log('linker', `Import ${dll} → nenhum SHIM (${functions.length} imports)`, 'warning');
          continue;
        }
        this.loadLibrary(dll, pe.name || 'PE imports');
        if (!report.loadedDlls.includes(dll)) report.loadedDlls.push(dll);
        for (const fn of functions) {
          if (fn.name && this.findExport(dll, fn.name)) report.resolvedFunctions += 1;
          else {
            report.importsComplete = false;
            report.missingFunctions.push({ dll, name: fn.name || `ordinal_${fn.ordinal}` });
          }
        }
        this.tracer.log('linker', `${dll}: ${functions.length} imports analisados`, 'shim');
      }
      return report;
    }

    loadedModules() {
      return Array.from(this.modules.values()).map((module) => ({
        name: module.name,
        refs: module.refs,
        exports: Object.keys(this._exports(module.instance)).filter((key) => typeof this._exports(module.instance)[key] === 'function').length,
      })).sort((a, b) => a.name.localeCompare(b.name));
    }

    dispose() {
      for (const module of this.modules.values()) {
        if (typeof module.instance.dispose === 'function') module.instance.dispose();
      }
      this.modules.clear();
    }
  }

  Porthole.ApiTracer = ApiTracer;
  Porthole.Shim = Shim;
  Porthole.DynamicLinker = DynamicLinker;
  Porthole.LinkerUtils = { shortValue };
})(typeof window !== 'undefined' ? window : globalThis);
