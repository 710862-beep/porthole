/* Host-side executor for Porthole's emitted x86-64→Wasm basic blocks (ABI v2).
 * The Rust core owns guest state; this bridge owns WebAssembly.Module compilation/OPFS cache.
 * A trapped compiled block is discarded and the interpreter re-executes the same RIP, so a
 * Wasm trap never corrupts the core instance or fabricates guest progress. */
(function (global) {
  'use strict';
  const Porthole = (global.Porthole = global.Porthole || {});

  // Minimal module exporting a function that return_calls itself. Used only as a runtime
  // feature probe; Rust +tail-call does not imply the browser validator accepts opcode 0x12.
  const TAIL_CALL_PROBE = new Uint8Array([
    0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,3,2,0,0,
    10,11,2, 5,0,18,1,11, 4,0,65,7,11,
  ]);

  class X64JitHost {
    constructor(emu, binding, options = {}) {
      this.emu = emu;
      this.binding = binding;
      this.memory = options.memory || binding.memory || binding.__wasm?.memory;
      this.cache = options.cache || null;
      this.modules = new Map();
      this.instances = new Map();
      this.artifacts = new Map(); // entryRip string -> meta
      this.stats = { compiled: 0, executedBlocks: 0, executedInstructions: 0, traps: 0, cacheHits: 0, cacheMisses: 0, saved: 0, loaded: 0, fallbackInstructions: 0, discarded: 0, compileErrors: 0, cacheErrors: 0, commitPageFaults: 0, tailCalls: false };
      this.diagnosticsEnabled = options.diagnostics === true;
      this.diagnostics = { validation: 0, traps: 0, unsupported: 0, byReason: Object.create(null), byOpcode: Object.create(null), samples: [], droppedSamples: 0 };
      this.enabled = options.enabled !== false;
      if (typeof this.emu.set_jit_enabled === 'function') this.emu.set_jit_enabled(this.enabled);
      try {
        this.stats.tailCalls = WebAssembly.validate(TAIL_CALL_PROBE);
        if (typeof this.emu.set_jit_tail_calls === 'function') this.emu.set_jit_tail_calls(this.stats.tailCalls);
      } catch { this.stats.tailCalls = false; }
    }

    recordFallback(meta, reason, commit) {
      const d = this.diagnostics;
      if (reason.startsWith('fault:jit-validation')) d.validation += 1;
      else if (reason === 'unsupported') d.unsupported += 1;
      else d.traps += 1;
      d.byReason[reason] = (d.byReason[reason] || 0) + 1;
      if (!this.diagnosticsEnabled || !meta) return;
      let detail = null;
      try { if (typeof this.emu.jit_failure_json === 'function') detail = JSON.parse(this.emu.jit_failure_json() || 'null'); } catch { /* diagnostics never change guest execution */ }
      let bytes = '';
      try {
        if (typeof this.emu.peek_qwords === 'function') {
          const text = this.emu.peek_qwords(BigInt(meta.entryRip), 4);
          bytes = [...text.matchAll(/0x([0-9a-f]{16})/g)].map(m => {
            const v = BigInt('0x' + m[1]); let s = '';
            for (let i = 0n; i < 8n; i++) s += Number((v >> (i * 8n)) & 255n).toString(16).padStart(2, '0');
            return s;
          }).join('');
        }
      } catch { /* unavailable in host-contract fakes */ }
      const opcode = detail?.opcode || bytes.slice(0, 4) || 'unknown';
      d.byOpcode[opcode] = (d.byOpcode[opcode] || 0) + 1;
      if (d.samples.length < 256) {
        let ctx = null;
        try {
          const dv = new DataView(this.memory.buffer); const out = [];
          for (let i = 0; i < 22; i++) out.push(dv.getBigUint64((meta.ctx >>> 0) + i * 8, true).toString());
          ctx = out;
        } catch { /* memory unavailable */ }
        d.samples.push({ reason, commit, entryRip: String(meta.entryRip), codeHash: meta.codeHash, opcode, bytes, ctx, detail });
      } else d.droppedSamples += 1;
    }

    diagnosticReport() {
      let unsupported = null;
      try { if (typeof this.emu.jit_unsupported_json === 'function') unsupported = JSON.parse(this.emu.jit_unsupported_json() || 'null'); } catch { /* optional core export */ }
      return { ...this.diagnostics, byOpcode: { ...this.diagnostics.byOpcode }, byReason: { ...this.diagnostics.byReason }, unsupported };
    }

    async initCache() {
      if (!this.cache?.loadJitModules || typeof this.emu.jit_import_cached !== 'function') return;
      const entries = await this.cache.loadJitModules(4096);
      for (const { wasmBytes, meta } of entries) {
        if (!meta || meta.abi !== 2 || (meta.links || []).length || !WebAssembly.validate(wasmBytes)) continue;
        const ok = this.emu.jit_import_cached(BigInt(meta.entryRip), meta.pageEpoch >>> 0, meta.byteLen >>> 0, meta.insnCount >>> 0, !!meta.endsWithRet, !!meta.selfLoop, BigInt('0x' + meta.codeHash), wasmBytes);
        if (ok) {
          this.stats.loaded += 1;
          this.artifacts.set(String(meta.entryRip), meta);
          this.modules.set(meta.codeHash, await WebAssembly.compile(wasmBytes));
        }
      }
    }

    async drainPending() {
      if (typeof this.emu.jit_pending_count !== 'function') return;
      const count = this.emu.jit_pending_count();
      for (let i = 0; i < count; i += 1) {
        const raw = this.emu.jit_pending_meta(i);
        if (!raw) { this.stats.discarded += 1; continue; }
        const meta = JSON.parse(raw);
        const bytes = this.emu.jit_pending_wasm(i);
        if (!bytes.length) {
          this.stats.discarded += 1;
          this.emu.jit_invalidate_entry?.(BigInt(meta.entryRip));
          continue;
        }
        this.artifacts.set(String(meta.entryRip), meta);
        if (!this.modules.has(meta.codeHash)) {
          try {
            this.modules.set(meta.codeHash, await WebAssembly.compile(bytes));
            this.stats.compiled += 1;
          } catch (error) {
            this.stats.compileErrors += 1;
            this.stats.lastError = String(error?.message || error);
            this.emu.jit_invalidate_entry?.(BigInt(meta.entryRip));
            continue;
          }
          // Linked modules are host-runtime specializations; persist only portable unlinked code.
          if (this.cache?.saveJitModule && !(meta.links || []).length) {
            try {
              await this.cache.saveJitModule(BigInt(meta.entryRip), bytes, meta);
              this.stats.saved += 1;
            } catch (error) {
              this.stats.cacheErrors += 1;
              this.stats.lastCacheError = String(error?.message || error);
            }
          }
        }
      }
      this.emu.jit_clear_pending();
    }

    async importCached(meta, wasmBytes) {
      if (!meta || meta.abi !== 2 || (meta.links || []).length || !WebAssembly.validate(wasmBytes)) return false;
      const ok = this.emu.jit_import_cached(BigInt(meta.entryRip), meta.pageEpoch >>> 0, meta.byteLen >>> 0, meta.insnCount >>> 0, !!meta.endsWithRet, !!meta.selfLoop, BigInt('0x' + meta.codeHash), wasmBytes);
      if (!ok) return false;
      this.stats.loaded += 1;
      this.artifacts.set(String(meta.entryRip), meta);
      if (!this.modules.has(meta.codeHash)) this.modules.set(meta.codeHash, await WebAssembly.compile(wasmBytes));
      return true;
    }

    async instanceFor(meta, mod, visiting = new Set()) {
      let inst = this.instances.get(meta.codeHash);
      if (inst) return inst;
      if (!this.memory) throw new Error('Wasm memory export unavailable');
      if (visiting.has(meta.codeHash)) throw new Error('JIT tail-call cycle');
      visiting.add(meta.codeHash);
      const env = { mem: this.memory };
      for (const link of meta.links || []) {
        const targetMeta = this.artifacts.get(String(link.targetRip));
        if (!targetMeta) throw new Error(`JIT link target missing: ${link.targetRip}`);
        let targetMod = this.modules.get(targetMeta.codeHash);
        if (!targetMod) throw new Error(`JIT link module missing: ${link.targetRip}`);
        const targetInst = await this.instanceFor(targetMeta, targetMod, visiting);
        env[link.importName] = targetInst.exports.run_block;
      }
      inst = await WebAssembly.instantiate(mod, { env });
      visiting.delete(meta.codeHash);
      this.instances.set(meta.codeHash, inst);
      return inst;
    }

    async moduleFor(meta) {
      this.artifacts.set(String(meta.entryRip), meta);
      let mod = this.modules.get(meta.codeHash);
      if (mod) { this.stats.cacheHits += 1; return mod; }
      this.stats.cacheMisses += 1;
      const bytes = this.emu.jit_active_wasm();
      if (!bytes.length) throw new Error('JIT artifact missing');
      mod = await WebAssembly.compile(bytes);
      this.modules.set(meta.codeHash, mod);
      this.stats.compiled += 1;
      if (this.cache?.saveJitModule && !(meta.links || []).length) {
        try {
          await this.cache.saveJitModule(BigInt(meta.entryRip), bytes, meta);
          this.stats.saved += 1;
        } catch (error) {
          this.stats.cacheErrors += 1;
          this.stats.lastCacheError = String(error?.message || error);
        }
      }
      return mod;
    }

    writeBudget(ctx, remaining) {
      const buffer = this.memory?.buffer;
      if (!buffer) throw new Error('Wasm memory export unavailable');
      new DataView(buffer).setBigUint64((ctx >>> 0) + 20 * 8, BigInt(remaining), true);
    }

    interpretWithJitDisabled(budget) {
      const had = this.enabled;
      if (typeof this.emu.set_jit_enabled === 'function') this.emu.set_jit_enabled(false);
      try { return this.emu.run_slice(budget); }
      finally { if (typeof this.emu.set_jit_enabled === 'function') this.emu.set_jit_enabled(had); }
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
        if (remaining === 0) { await this.drainPending(); return 'next'; }
        const raw = this.emu.jit_enter_block();
        if (!raw) { this.stats.discarded += 1; status = 'next'; continue; }
        const meta = JSON.parse(raw);
        try {
          const mod = await this.moduleFor(meta);
          const instance = await this.instanceFor(meta, mod);
          this.writeBudget(meta.ctx, remaining);
          const executedBig = instance.exports.run_block(meta.ctx >>> 0);
          const executed = Number(executedBig);
          if (!Number.isSafeInteger(executed) || executed < 0 || executed > remaining) throw new Error('JIT instruction count mismatch');
          const commit = this.emu.jit_commit_block();
          if (commit === 'next') {
            this.stats.executedBlocks += 1;
            this.stats.executedInstructions += executed;
            remaining = Math.max(0, remaining - executed);
            status = 'next';
            if (remaining > 0 && (executed === 0 || remaining < meta.insnCount)) {
              // Whole-block budget granularity left a remainder smaller than the artifact.
              const beforeFallback = Number(this.emu.instructions_executed());
              const fallback = this.interpretWithJitDisabled(remaining);
              this.stats.fallbackInstructions += Number(this.emu.instructions_executed()) - beforeFallback;
              await this.drainPending();
              return fallback;
            }
          } else if (commit.startsWith('page-fault:')) {
            this.stats.commitPageFaults += 1;
            await this.drainPending();
            return commit;
          } else {
            this.stats.traps += 1;
            this.stats.lastTrap = commit;
            this.recordFallback(meta, commit.startsWith('fault:jit-validation') ? 'validation' : 'commit', commit);
            this.emu.jit_abort_block();
            const beforeFallback = Number(this.emu.instructions_executed());
            const fallbackBudget = Math.max(1, Math.min(remaining || 1, meta.insnCount));
            const fallback = this.interpretWithJitDisabled(fallbackBudget);
            this.stats.fallbackInstructions += Number(this.emu.instructions_executed()) - beforeFallback;
            await this.drainPending();
            if (fallback !== 'next') return fallback;
            remaining = Math.max(0, remaining - (Number(this.emu.instructions_executed()) - beforeFallback));
            status = 'next';
          }
        } catch (error) {
          this.stats.traps += 1;
          this.stats.lastTrap = String(error?.message || error);
          this.recordFallback(meta, 'trap', this.stats.lastTrap);
          this.emu.jit_abort_block();
          const beforeFallback = Number(this.emu.instructions_executed());
          const fallbackBudget = Math.max(1, Math.min(remaining || 1, meta.insnCount));
          const fallback = this.interpretWithJitDisabled(fallbackBudget);
          this.stats.fallbackInstructions += Number(this.emu.instructions_executed()) - beforeFallback;
          await this.drainPending();
          if (fallback !== 'next') return fallback;
          remaining = Math.max(0, remaining - (Number(this.emu.instructions_executed()) - beforeFallback));
          status = 'next';
        }
      }
      await this.drainPending();
      return status;
    }
  }

  Porthole.X64JitHost = X64JitHost;
  if (typeof module !== 'undefined' && module.exports) module.exports = { X64JitHost };
})(typeof window !== 'undefined' ? window : globalThis);
