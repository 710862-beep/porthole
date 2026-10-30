/* Host-side executor for Porthole's emitted x86-64→Wasm blocks.
 * The Rust core owns guest state; this bridge owns WebAssembly.Module compilation/OPFS cache.
 * A trapped compiled block is discarded and the interpreter re-executes the same RIP, so a
 * Wasm trap never corrupts the core instance or fabricates guest progress. */
(function (global) {
  'use strict';
  const Porthole = (global.Porthole = global.Porthole || {});

  class X64JitHost {
    constructor(emu, binding, options = {}) {
      this.emu = emu;
      this.binding = binding;
      this.memory = options.memory || binding.memory || binding.__wasm?.memory;
      this.cache = options.cache || null;
      this.modules = new Map();
      this.instances = new Map();
      this.stats = { compiled: 0, executedBlocks: 0, executedInstructions: 0, traps: 0, cacheHits: 0, cacheMisses: 0, saved: 0, loaded: 0, fallbackInstructions: 0 };
      this.enabled = options.enabled !== false;
      if (typeof this.emu.set_jit_enabled === 'function') this.emu.set_jit_enabled(this.enabled);
    }

    async initCache() {
      if (!this.cache?.loadJitModules || typeof this.emu.jit_import_cached !== 'function') return;
      const entries = await this.cache.loadJitModules(4096);
      for (const { wasmBytes, meta } of entries) {
        if (!meta || !WebAssembly.validate(wasmBytes)) continue;
        const ok = this.emu.jit_import_cached(BigInt(meta.entryRip), meta.pageEpoch >>> 0, meta.byteLen >>> 0, meta.insnCount >>> 0, !!meta.endsWithRet, BigInt('0x' + meta.codeHash), wasmBytes);
        if (ok) { this.stats.loaded += 1; this.modules.set(meta.codeHash, await WebAssembly.compile(wasmBytes)); }
      }
    }

    async drainPending() {
      if (typeof this.emu.jit_pending_count !== 'function') return;
      const count = this.emu.jit_pending_count();
      for (let i = 0; i < count; i += 1) {
        const meta = JSON.parse(this.emu.jit_pending_meta(i));
        const bytes = this.emu.jit_pending_wasm(i);
        if (!this.modules.has(meta.codeHash)) {
          try {
            this.modules.set(meta.codeHash, await WebAssembly.compile(bytes));
            this.stats.compiled += 1;
            if (this.cache?.saveJitModule) { await this.cache.saveJitModule(BigInt(meta.entryRip), bytes, meta); this.stats.saved += 1; }
          } catch (error) { this.stats.traps += 1; }
        }
      }
      this.emu.jit_clear_pending();
    }

    async importCached(meta, wasmBytes) {
      if (!meta || !WebAssembly.validate(wasmBytes)) return false;
      const ok = this.emu.jit_import_cached(BigInt(meta.entryRip), meta.pageEpoch >>> 0, meta.byteLen >>> 0, meta.insnCount >>> 0, !!meta.endsWithRet, BigInt('0x' + meta.codeHash), wasmBytes);
      if (!ok) return false;
      this.stats.loaded += 1;
      if (!this.modules.has(meta.codeHash)) this.modules.set(meta.codeHash, await WebAssembly.compile(wasmBytes));
      return true;
    }

    async instanceFor(meta, mod) {
      let inst = this.instances.get(meta.codeHash);
      if (inst) return inst;
      if (!this.memory) throw new Error('Wasm memory export unavailable');
      inst = await WebAssembly.instantiate(mod, { env: { mem: this.memory } });
      this.instances.set(meta.codeHash, inst);
      return inst;
    }

    async moduleFor(meta) {
      let mod = this.modules.get(meta.codeHash);
      if (mod) { this.stats.cacheHits += 1; return mod; }
      this.stats.cacheMisses += 1;
      const bytes = this.emu.jit_active_wasm();
      if (!bytes.length) throw new Error('JIT artifact missing');
      mod = await WebAssembly.compile(bytes);
      this.modules.set(meta.codeHash, mod);
      this.stats.compiled += 1;
      if (this.cache?.saveJitModule) { await this.cache.saveJitModule(BigInt(meta.entryRip), bytes, meta); this.stats.saved += 1; }
      return mod;
    }

    async runSlice(maxInstructions) {
      if (!this.enabled || typeof this.emu.jit_enter_block !== 'function') return this.emu.run_slice(maxInstructions);
      let remaining = maxInstructions >>> 0;
      let status = 'next';
      while (remaining > 0) {
        const before = Number(this.emu.instructions_executed());
        status = this.emu.run_slice(remaining);
        const interpreted = Number(this.emu.instructions_executed()) - before;
        remaining = Math.max(0, remaining - interpreted);
        if (status !== 'jit') { await this.drainPending(); return status; }
        const meta = JSON.parse(this.emu.jit_enter_block());
        try {
          const mod = await this.moduleFor(meta);
          if (!this.memory) throw new Error('Wasm memory export unavailable');
          const instance = await this.instanceFor(meta, mod);
          const executed = instance.exports.run_block(meta.ctx >>> 0);
          if (Number(executed) !== meta.insnCount) throw new Error('JIT instruction count mismatch');
          const commit = this.emu.jit_commit_block();
          this.stats.executedBlocks += 1;
          this.stats.executedInstructions += meta.insnCount;
          remaining = Math.max(0, remaining - meta.insnCount);
          if (commit !== 'next') return commit;
        } catch (error) {
          this.stats.traps += 1;
          this.emu.jit_abort_block();
          // Precise fallback: re-execute the faulting block in the interpreter. If it faults,
          // the core reports the guest exception; if it succeeds, the compiled artifact was bad.
          const fallback = this.emu.run_slice(Math.min(remaining || 1, meta.insnCount));
          this.stats.fallbackInstructions += Number(this.emu.instructions_executed()) - before;
          if (fallback !== 'next') return fallback;
        }
      }
      return status;
    }
  }

  Porthole.X64JitHost = X64JitHost;
  if (typeof module !== 'undefined' && module.exports) module.exports = { X64JitHost };
})(typeof window !== 'undefined' ? window : globalThis);
