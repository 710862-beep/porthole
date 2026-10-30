/*
 * x64-nvme-vfs.js — NVMe-backed storage bridge for the pure-browser x86-64 emulator.
 *
 * Three responsibilities, all best-effort and fully observable:
 *   1. `showDirectoryPicker()` mount so `C:\Game` maps to a real folder on the external SSD.
 *   2. Sharded swap files (`.porthole_vmem/shard_XXXXX.bin`, 64 MB each = 16 384 pages) used to
 *      persist pages evicted from the Wasm RAM LRU window.
 *   3. `.porthole_jit_cache/` persistence for hybrid AOT/JIT WebAssembly blocks.
 *
 * Nothing here ever fakes durability: every failed write is surfaced through `stats` and the
 * returned promise so callers can report the real state.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});

  const PAGE_SIZE = 4096;
  const SHARD_PAGES = 16384;            // 64 MB per shard
  const SHARD_BYTES = SHARD_PAGES * PAGE_SIZE;

  class NvmeVfs {
    constructor(options) {
      const opts = options || {};
      this.window = opts.window || global;
      this.logger = opts.logger || function () {};
      this.root = null;
      this.vmemDir = null;
      this.jitDir = null;
      this.gameDir = null;
      this.stats = {
        mounted: false,
        pagesWritten: 0,
        pagesRead: 0,
        bytesWritten: 0,
        bytesRead: 0,
        writeErrors: 0,
        readErrors: 0,
        jitModulesSaved: 0,
        jitModulesLoaded: 0,
        lastError: null,
      };
      this.queue = Promise.resolve();
    }

    get supported() {
      const w = this.window;
      return Boolean(w && typeof w.showDirectoryPicker === 'function');
    }

    async pickDirectory() {
      if (!this.supported) throw new Error('File System Access API indisponível neste navegador.');
      // `showDirectoryPicker` requires a user gesture; the caller must invoke this from a click.
      const handle = await this.window.showDirectoryPicker({ id: 'porthole-x64', mode: 'readwrite' });
      await this.mount(handle);
      return handle;
    }

    async mount(handle, options) {
      const opts = options || {};
      this.root = handle;
      this.vmemDir = await handle.getDirectoryHandle('.porthole_vmem', { create: true });
      this.jitDir = await handle.getDirectoryHandle('.porthole_jit_cache', { create: true });
      try {
        this.gameDir = await handle.getDirectoryHandle('Game', { create: true });
      } catch (error) {
        this.gameDir = null;
        this.stats.lastError = `Game/: ${error.message}`;
      }
      this.stats.mounted = true;
      this.logger(`NVMe montado: ${handle.name} (${opts.label || 'mount'})`);
      return this.describe();
    }

    describe() {
      return {
        mounted: this.stats.mounted,
        rootName: this.root ? this.root.name : null,
        hasGameDir: Boolean(this.gameDir),
        stats: { ...this.stats },
      };
    }

    // ------------------------------------------------------------- swap files

    async shardHandle(pageBase) {
      if (!this.vmemDir) return null;
      const shardIndex = Math.floor(pageBase / PAGE_SIZE / SHARD_PAGES);
      const name = `shard_${String(shardIndex).padStart(5, '0')}.bin`;
      return this.vmemDir.getFileHandle(name, { create: true });
    }

    /** Serializes NVMe writes so concurrent page flushes cannot interleave inside a shard. */
    enqueue(task) {
      const run = this.queue.then(task, task);
      this.queue = run.catch(() => {});
      return run;
    }

    /**
     * Persists a batch of evicted pages. `records` is the `[u64 page][4096 bytes]` blob produced
     * by `BrowserX64Emulator::drain_evicted_pages()`.
     */
    persistPages(records) {
      return this.enqueue(async () => {
        if (!this.stats.mounted) return { written: 0, skipped: 'not-mounted' };
        const view = records instanceof Uint8Array ? records : new Uint8Array(records);
        const stride = 8 + PAGE_SIZE;
        if (view.byteLength % stride !== 0) {
          throw new Error(`Buffer de páginas inválido: ${view.byteLength} bytes`);
        }
        const count = view.byteLength / stride;
        if (!count) return { written: 0 };
        let written = 0;
        for (let i = 0; i < count; i += 1) {
          const offset = i * stride;
          const pageBase = Number(new DataView(view.buffer, view.byteOffset + offset, 8).getBigUint64(0, true));
          const handle = await this.shardHandle(pageBase);
          if (!handle) break;
          const byteOffset = (pageBase % SHARD_BYTES);
          try {
            const writable = await handle.createWritable({ keepExistingData: true });
            await writable.write({ type: 'write', position: byteOffset, data: view.subarray(offset + 8, offset + 8 + PAGE_SIZE) });
            await writable.close();
            written += 1;
            this.stats.pagesWritten += 1;
            this.stats.bytesWritten += PAGE_SIZE;
          } catch (error) {
            this.stats.writeErrors += 1;
            this.stats.lastError = error.message;
            throw error;
          }
        }
        return { written };
      });
    }

    /** Reads a single 4 KB page back from its shard after a guest page fault. */
    fetchPage(pageBase) {
      return this.enqueue(async () => {
        if (!this.stats.mounted) throw new Error('NVMe não montado: page fault não resolvível.');
        const handle = await this.shardHandle(pageBase);
        const byteOffset = pageBase % SHARD_BYTES;
        try {
          const file = await handle.getFile();
          const buffer = new Uint8Array(PAGE_SIZE);
          if (byteOffset >= file.size) {
            // Never previously written: the page is demand-zero.
            return { pageBase, bytes: buffer, zeroFilled: true };
          }
          const slice = await file.slice(byteOffset, byteOffset + PAGE_SIZE).arrayBuffer();
          buffer.set(new Uint8Array(slice).subarray(0, PAGE_SIZE));
          this.stats.pagesRead += 1;
          this.stats.bytesRead += PAGE_SIZE;
          return { pageBase, bytes: buffer, zeroFilled: slice.byteLength < PAGE_SIZE };
        } catch (error) {
          this.stats.readErrors += 1;
          this.stats.lastError = error.message;
          throw error;
        }
      });
    }

    // ------------------------------------------------------------ JIT cache

    async saveJitModule(entryRip, wasmBytes, meta) {
      return this.enqueue(async () => {
        if (!this.jitDir) return null;
        const name = `block_${entryRip.toString(16).padStart(16, '0')}.wasm`;
        const handle = await this.jitDir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(wasmBytes);
        await writable.close();
        if (meta) {
          const metaHandle = await this.jitDir.getFileHandle(`${name}.json`, { create: true });
          const metaWritable = await metaHandle.createWritable();
          await metaWritable.write(JSON.stringify(meta));
          await metaWritable.close();
        }
        this.stats.jitModulesSaved += 1;
        return name;
      });
    }

    async loadJitModules(limit) {
      return this.enqueue(async () => {
        const out = [];
        if (!this.jitDir) return out;
        for await (const [name, handle] of this.jitDir.entries()) {
          if (!name.endsWith('.wasm') || handle.kind !== 'file') continue;
          if (limit && out.length >= limit) break;
          const file = await handle.getFile();
          const wasmBytes = new Uint8Array(await file.arrayBuffer());
          let meta = null;
          try {
            const metaFile = await (await this.jitDir.getFileHandle(`${name}.json`)).getFile();
            meta = JSON.parse(await metaFile.text());
          } catch (error) {
            meta = null;
          }
          out.push({ name, wasmBytes, meta });
          this.stats.jitModulesLoaded += 1;
        }
        return out;
      });
    }

    // ------------------------------------------------------------- game tree

    /** Recursively loads `Game/**` into the guest VFS so `CreateFileW("C:\\Game\\...")` works. */
    async readGameTree(limitBytes) {
      const max = limitBytes || 512 * 1024 * 1024;
      const files = [];
      if (!this.gameDir) return files;
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          const path = prefix ? `${prefix}\\${name}` : name;
          if (handle.kind === 'directory') {
            await walk(handle, path);
            continue;
          }
          const file = await handle.getFile();
          if (file.size > max) {
            this.logger(`Ignorando ${path}: ${file.size} bytes excede o limite`);
            continue;
          }
          files.push({ path: `C:\\Game\\${path}`, bytes: new Uint8Array(await file.arrayBuffer()) });
        }
      };
      await walk(this.gameDir, '');
      return files;
    }
  }

  Porthole.NvmeVfs = NvmeVfs;
  Porthole.NVME_PAGE_SIZE = PAGE_SIZE;
})(typeof globalThis !== 'undefined' ? globalThis : this);
