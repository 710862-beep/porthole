/*
 * retrowin32-backend.js — execução PE32 x86 user-mode, sem BIOS/kernel Windows.
 *
 * O núcleo Apache-2.0 em vendor/retrowin32 faz relocations, IAT, memória, stack,
 * stdcall e Win32 HLE. Este arquivo é somente o host Vanilla JS: VFS síncrono
 * sobre cache pré-carregado, overlay/persistência de escritas, console, timers,
 * mouse e superfícies Canvas. Não atribui essas chamadas aos SHIMs JS Porthole.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const STATUS = Object.freeze({ RUNNING: 0, BLOCKED: 1, ERROR: 2, DEBUG_BREAK: 3, EXIT: 4 });
  const now = () => global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now();

  function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Bytes do executável/arquivo devem ser ArrayBuffer ou TypedArray.');
  }

  function copyBytes(data) {
    const source = bytesOf(data);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  }

  function dirname(path) {
    const segments = path.segments.slice(0, -1);
    return Porthole.VFSUtils.normalizePath(segments.length ? `C:\\${segments.join('\\')}` : 'C:\\');
  }

  class RetroFile {
    constructor(process, record, options) {
      this.process = process;
      this.record = record;
      this.path = record.path.win32;
      this.ofs = 0;
      this.readable = options.read !== false;
      this.writable = Boolean(options.write);
    }

    info() { return this.record.bytes.byteLength; }

    // O binding Wasm pinned usa seek absoluto; o núcleo resolve SEEK_* antes.
    seek(offset) {
      if (!Number.isFinite(offset) || offset < 0 || offset > 0xffffffff) return false;
      this.ofs = Math.floor(offset);
      return true;
    }

    read(target) {
      if (!this.readable || this.ofs >= this.record.bytes.byteLength) return 0;
      const length = Math.min(target.byteLength, this.record.bytes.byteLength - this.ofs);
      target.set(this.record.bytes.subarray(this.ofs, this.ofs + length));
      this.ofs += length;
      return length;
    }

    write(source) {
      if (!this.writable) return 0;
      const length = source.byteLength;
      if (!length) return 0;
      const end = this.ofs + length;
      if (!Number.isSafeInteger(end) || end > this.process.maxFileBytes) {
        throw new Error(`WriteFile excede o limite do overlay (${this.process.maxFileBytes} bytes).`);
      }
      if (end > this.record.bytes.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(this.record.bytes);
        this.record.bytes = grown;
      }
      this.record.bytes.set(source, this.ofs);
      this.ofs = end;
      this.process._markDirty(this.record);
      return length;
    }
  }

  class Retrowin32Process {
    constructor(backend, options) {
      const opts = options || {};
      this.backend = backend;
      this.module = opts.module;
      this.vfs = opts.vfs || null;
      this.registryBridge = opts.registryBridge || null;
      this.networkBridge = opts.networkBridge || null;
      this.guestApiTail = [];
      this.rawInputQueue = [];
      this.heldKeys = new Set();
      this.pressedKeys = new Set();
      this.directories = new Set(['']);
      this.directoryNames = new Map();
      this.path = Porthole.VFSUtils.normalizePath(opts.path || opts.name || 'C:\\program.exe');
      this.name = opts.name || this.path.segments[this.path.segments.length - 1] || 'program.exe';
      this.commandLine = opts.commandLine || this.name;
      this.mainBytes = copyBytes(opts.bytes);
      this.relocate = Boolean(opts.relocate);
      this.preload = opts.preload !== false;
      this.currentDirectory = dirname(this.path);
      this.document = opts.document || global.document || null;
      this.canvas = opts.canvas || null;
      this.windowLayer = opts.windowLayer || null;
      this.trace = opts.trace === true;
      this.maxPreloadFiles = Math.max(1, opts.maxPreloadFiles || 4096);
      this.maxPreloadBytes = Math.max(1024, opts.maxPreloadBytes || 256 * 1024 * 1024);
      this.maxFileBytes = Math.max(1024, opts.maxFileBytes || 512 * 1024 * 1024);
      this.files = new Map();
      this.events = [];
      this.windows = [];
      this.output = '';
      this.stdoutBytes = 0;
      this.outputTruncatedBytes = 0;
      this.outputTruncated = false;
      this.maxOutputChars = 256 * 1024;
      this.decoder = new TextDecoder();
      this.emu = null;
      this.status = 'loading';
      this.running = false;
      this.started = false;
      this.exitCode = null;
      this.error = null;
      this.stepSize = 5000;
      this.instructions = 0;
      this.lastInstructionCounter = 0;
      this.instructionCounterValid = true;
      this.runBatches = 0;
      this.presents = 0;
      this.timer = 0;
      this.channel = null;
      this.scheduled = false;
      this.finishing = false;
      this.finished = false;
      this.hostExitRequested = false;
      this.preloadReport = { files: 0, bytes: 0, skipped: 0, complete: true };
      this.writeChain = Promise.resolve();
      this.writeErrors = [];
      this.pendingWrites = 0;
      this.listeners = new Map();
      this.done = new Promise((resolve) => { this.resolveDone = resolve; });
      this.callbacks = {
        stdout: opts.onStdout,
        state: opts.onState,
        stats: opts.onStats,
        window: opts.onWindow,
        error: opts.onError,
        exit: opts.onExit,
      };
      this.lastStatsEmit = 0;
      this._boundTick = () => {
        this.scheduled = false;
        this._tick();
      };
    }

    on(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(listener);
      return () => this.listeners.get(name).delete(listener);
    }

    _emit(name, value) {
      const callback = this.callbacks[name];
      if (typeof callback === 'function') {
        try { callback(value); } catch (error) { console.error(`retrowin32 on${name}:`, error); }
      }
      for (const listener of this.listeners.get(name) || []) {
        try { listener(value); } catch (error) { console.error(`retrowin32 listener ${name}:`, error); }
      }
    }

    _log(message, kind) {
      if (this.backend.tracer) this.backend.tracer.log('retrowin32-host', message, kind || 'info');
    }

    async _initialize() {
      this._registerFile(this.path, this.mainBytes);
      if (this.registryBridge) await this.registryBridge.ready();
      if (this.preload && this.vfs) await this._preloadDirectory(this.currentDirectory);
      this._log(`${this.name}: cache de ${this.preloadReport.files} arquivo(s), ${this.preloadReport.bytes} bytes${this.preloadReport.complete ? '' : `; ${this.preloadReport.skipped} item(ns) omitidos pelos limites`}.`, this.preloadReport.complete ? 'info' : 'warning');

      // Cada processo recebe uma instância Wasm própria: o logger Rust global
      // do artefato pinned não pode ser inicializado duas vezes na mesma.
      this.emu = this.module.createRetrowin32Emulator(this, this.commandLine);
      try {
        this.emu.load_exe(this.path.win32, this.mainBytes, this.relocate);
        this.emu.set_tracing_scheme(this.trace ? '*' : '-');
        this.labels = JSON.parse(this.emu.labels());
        this.lastInstructionCounter = this.emu.instr_count >>> 0;
        this.status = 'loaded';
        this._emit('state', this.getStats());
        return this;
      } catch (error) {
        if (this.emu) {
          const emulator = this.emu;
          this.emu = null;
          try { emulator.free(); } catch (cleanupError) { this._log(`Cleanup após load_exe falhou: ${cleanupError.message}`, 'warning'); }
        }
        this.status = 'error';
        this.error = error;
        throw error;
      }
    }

    _normalizeGuestPath(input) {
      let raw = String(input || '').trim();
      if (!raw || raw.includes('\0') || /^(?:\\\\|\\\\\?|\\\\\.)/.test(raw)) return null;
      raw = raw.replace(/\//g, '\\');
      try {
        // C:foo é drive-relative no Win32, diferente de C:\foo.
        if (/^[A-Za-z]:(?!\\)/.test(raw)) {
          if (raw[0].toUpperCase() !== 'C') return null;
          raw = raw.slice(2);
        }
        if (/^[A-Za-z]:/.test(raw) || raw.startsWith('\\')) {
          if (/^[A-Za-z]:/.test(raw) && raw[0].toUpperCase() !== 'C') return null;
          return Porthole.VFSUtils.normalizePath(raw.startsWith('\\') ? `C:${raw}` : raw);
        }
        const base = this.currentDirectory.segments.slice();
        const suffix = raw ? `\\${raw}` : '';
        return Porthole.VFSUtils.normalizePath(`C:\\${base.join('\\')}${suffix}`);
      } catch (_) {
        return null;
      }
    }

    _registerFile(path, data) {
      const normalized = typeof path === 'string' ? Porthole.VFSUtils.normalizePath(path) : path;
      const record = { path: normalized, bytes: copyBytes(data), dirty: false, version: 0 };
      this.files.set(normalized.key, record);
      for (let i = 1; i < normalized.segments.length; i++) {
        const key=normalized.segments.slice(0,i).join('/').toLocaleLowerCase('en-US');this.directories.add(key);this.directoryNames.set(key,normalized.segments[i-1]);
      }
      this.preloadReport.files += 1;
      this.preloadReport.bytes += record.bytes.byteLength;
      return record;
    }

    async _preloadDirectory(directory) {
      const visit = async (path, depth) => {
        if (depth > 32) {
          this.preloadReport.skipped += 1;
          this.preloadReport.complete = false;
          return;
        }
        const entries = await this.vfs.listDirectory(path.win32);
        this.directories.add(path.key);
        this.directoryNames.set(path.key,path.segments.at(-1)||'');
        for (const entry of entries) {
          const child = Porthole.VFSUtils.normalizePath(`C:\\${path.segments.concat(entry.name).join('\\')}`);
          if (entry.kind === 'directory') {
            await visit(child, depth + 1);
            continue;
          }
          if (entry.kind !== 'file' || this.files.has(child.key)) continue;
          if (this.preloadReport.files >= this.maxPreloadFiles || this.preloadReport.bytes >= this.maxPreloadBytes) {
            this.preloadReport.skipped += 1;
            this.preloadReport.complete = false;
            continue;
          }
          const data = await this.vfs.readFile(child.win32);
          if (this.preloadReport.bytes + data.byteLength > this.maxPreloadBytes) {
            this.preloadReport.skipped += 1;
            this.preloadReport.complete = false;
            continue;
          }
          this._registerFile(child, data);
        }
      };
      await visit(directory, 0);
    }

    // Candidate Rust Host ABI: pointers are decoded in Rust, not by reentrant
    // calls to Emulator.memory() while the emulator is borrowed.
    ticks() { return now() >>> 0; }
    current_dir() {return this.currentDirectory.win32;}
    set_current_dir(request) {
      if (typeof request !== 'string' || !request || request.includes('\0')) return 123;
      const path = this._normalizeGuestPath(request);
      if (!path) return 5;
      if (this.files.has(path.key)) return 267;
      if (!this.directories.has(path.key)) return 3;
      this.currentDirectory = path;
      return 0;
    }
    api_trace(entry) {this.guestApiTail.push(String(entry).slice(0,512));if(this.guestApiTail.length>20)this.guestApiTail.shift();}
    injectKey(key, down) {
      if (!Number.isInteger(key) || key<0 || key>255 || typeof down!=='boolean') throw new RangeError('Invalid virtual key');
      if(down){if(!this.heldKeys.has(key))this.pressedKeys.add(key);this.heldKeys.add(key);}else this.heldKeys.delete(key);
    }
    key_state(key) {const result=(this.heldKeys.has(key)?0x8000:0)|(this.pressedKeys.has(key)?1:0);this.pressedKeys.delete(key);return result;}
    injectRawInput(dx, dy) {
      if (!Number.isInteger(dx) || !Number.isInteger(dy) || dx < -2147483648 || dx > 2147483647 || dy < -2147483648 || dy > 2147483647 || this.rawInputQueue.length >= 256) throw new RangeError('Invalid/bounded raw mouse delta');
      this.rawInputQueue.push([dx,dy]);
    }
    raw_input_events() { return JSON.stringify(this.rawInputQueue.splice(0)); }
    network_call(request) { return this.networkBridge ? this.networkBridge.call(request) : '{"error":10045}'; }
    registry_call(op, handle, name, type, data) {
      return this.registryBridge ? this.registryBridge.call(op, handle, name, type, data) : '{"status":50}';
    }
    create_dir(input) {
      const path = this._normalizeGuestPath(input);
      if (!path) return 5;
      if (this.directories.has(path.key)) return 183;
      const parent = path.segments.slice(0, -1).join('/').toLocaleLowerCase('en-US');
      if (!this.directories.has(parent)) return 3;
      if (this.files.has(path.key)) return 183;
      if (this.vfs && typeof this.vfs.createDirectory !== 'function') return 50;
      this.directories.add(path.key);
        this.directoryNames.set(path.key,path.segments.at(-1)||'');
      if (this.vfs) {
        this.pendingWrites++;
        this.writeChain = this.writeChain.then(() => this.vfs.createDirectory(path.win32))
          .catch(error => this._recordWriteError({ path }, error))
          .finally(() => { this.pendingWrites--; });
      }
      return 0; // Directory is visible in the overlay; durable status requires flush.
    }

    // Métodos abaixo são chamados diretamente pelo glue Wasm (host síncrono).
    log(level, message) {
      const kind = level === 1 ? 'error' : level === 2 ? 'warning' : 'info';
      if (this.backend.tracer) this.backend.tracer.log('retrowin32', message, kind);
    }

    exit(code) {
      this.hostExitRequested = true;
      this.exitCode = code >>> 0;
      if (!this.running && !this.finished) queueMicrotask(() => this._finish('exited'));
    }

    stdout(buffer) {
      const text = this.decoder.decode(buffer, { stream: true });
      this.stdoutBytes += buffer.byteLength;
      const remaining = Math.max(0, this.maxOutputChars - this.output.length);
      this.output += text.slice(0, remaining);
      if (text.length > remaining) {
        this.outputTruncatedBytes += buffer.byteLength;
        this.outputTruncated = true;
      }
      this._emit('stdout', { text, process: this });
    }

    read_dir(request) {
      if (typeof request !== 'string' || request.includes('\0')) return JSON.stringify({status:123});
      const dir=this._normalizeGuestPath(request||'.');
      if(!dir)return JSON.stringify({status:5});
      if(!this.directories.has(dir.key))return JSON.stringify({status:this.files.has(dir.key)?267:3});
      const prefix=dir.key?dir.key+'/':'';const entries=[];
      for(const key of this.directories){if(!key.startsWith(prefix))continue;const tail=key.slice(prefix.length);if(tail&&!tail.includes('/'))entries.push({name:this.directoryNames.get(key)||tail,kind:'directory',size:0});}
      for(const record of this.files.values()){if(record.path.segments.slice(0,-1).join('/').toLocaleLowerCase('en-US')===dir.key)entries.push({name:record.path.segments.at(-1),kind:'file',size:record.bytes.byteLength});}
      if(entries.length>4096)return JSON.stringify({status:13});
      entries.sort((a,b)=>a.name.toLowerCase().localeCompare(b.name.toLowerCase(),'en-US'));
      return JSON.stringify({status:0,entries});
    }
    file_info(request) {
      if (typeof request !== 'string' || !request.trim() || request.includes('\0')) return JSON.stringify({status:123});
      const path=this._normalizeGuestPath(request);
      if(!path)return JSON.stringify({status:5});
      const file=this.files.get(path.key);
      if(file)return JSON.stringify({status:0,kind:'file',size:file.bytes.byteLength});
      if(this.directories.has(path.key))return JSON.stringify({status:0,kind:'directory',size:0});
      const parent=path.segments.slice(0,-1).join('/').toLocaleLowerCase('en-US');
      return JSON.stringify({status:this.directories.has(parent)?2:3});
    }

    open(request, fileOptions) {
      const path = this._normalizeGuestPath(request);
      if (!path) return null;
      const options = fileOptions ? {
        read: fileOptions.read,
        write: fileOptions.write,
        truncate: fileOptions.truncate,
        create: fileOptions.create,
        create_new: fileOptions.create_new,
      } : { read: true, write: false };
      let record = this.files.get(path.key) || null;
      if (record && options.create_new) return null;
      if (!record) {
        if (!options.create && !options.create_new) return null;
        record = { path, bytes: new Uint8Array(0), dirty: false, version: 0 };
        this.files.set(path.key, record);
        this._markDirty(record);
      } else if (options.truncate && options.write && record.bytes.byteLength) {
        record.bytes = new Uint8Array(0);
        this._markDirty(record);
      }
      return new RetroFile(this, record, options);
    }

    _markDirty(record) {
      record.dirty = true;
      record.version += 1;
      if (!this.vfs) return; // Fixture/process sem VFS: overlay volátil explícito.
      const version = record.version;
      this.pendingWrites += 1;
      this.writeChain = this.writeChain.then(async () => {
        if (version !== record.version || !record.dirty) return;
        await this._persist(record);
      }).catch((error) => {
        // A cadeia continua para arquivos posteriores; flushWrites relata o erro.
        this._recordWriteError(record, error);
      }).finally(() => { this.pendingWrites = Math.max(0, this.pendingWrites - 1); });
    }

    async _persist(record) {
      if (!this.vfs || !record.dirty) return;
      const version = record.version;
      const snapshot = record.bytes.slice();
      await this.vfs.writeFile(record.path.win32, snapshot);
      if (record.version === version) record.dirty = false;
      // Se houve outra escrita durante o await, sua própria versão já está na
      // fila e persistirá o snapshot mais recente; não incremente novamente.
    }

    _recordWriteError(record, error) {
      this.writeErrors.push({ path: record.path.win32, message: error.message });
      this._log(`Falha ao persistir ${record.path.win32}: ${error.message}`, 'error');
      this._emit('error', error);
    }

    async flushWrites() {
      await this.writeChain;
      if (this.registryBridge) await this.registryBridge.flush();
      const unique = new Set(this.files.values());
      for (const record of unique) {
        if (record.dirty && this.vfs) {
          try { await this._persist(record); } catch (error) { this._recordWriteError(record, error); }
        }
      }
      await this.writeChain;
      if (this.writeErrors.length) {
        const latest = this.writeErrors[this.writeErrors.length - 1];
        throw new Error(`${this.writeErrors.length} escrita(s) falharam; última: ${latest.path}: ${latest.message}`);
      }
      return { pending: this.pendingWrites, errors: 0 };
    }

    ensure_timer(when) {
      if (this.finished) return;
      if (this.timer) clearTimeout(this.timer);
      const delay = Math.max(0, Math.min(0x7fffffff, when - now()));
      this.timer = setTimeout(() => {
        this.timer = 0;
        this.start();
      }, delay);
    }

    enqueueEvent(event) {
      if (this.finished) return;
      if (this.events.length >= 256) this.events.shift();
      this.events.push(event);
      this.start();
    }

    get_event() { return this.events.shift(); }

    create_window(hwnd) {
      if (!this.document) throw new Error('Janela Win32 solicitada, mas document/DOM não está disponível.');
      const first = this.windows.length === 0;
      const canvas = first && this.canvas ? this.canvas : this.document.createElement('canvas');
      let frame = null;
      if (!first || canvas !== this.canvas) {
        frame = this.document.createElement('div');
        frame.className = 'retro-window';
        const title = this.document.createElement('div');
        title.className = 'retro-window-title';
        frame.appendChild(title);
        frame.appendChild(canvas);
        (this.windowLayer || this.document.body).appendChild(frame);
        frame._title = title;
      }
      canvas.classList.add('retro-window-canvas');
      canvas.tabIndex = 0;
      const process = this;
      const record = {
        hwnd,
        canvas,
        frame,
        context: null,
        screenProxy: null,
        logicalWidth: canvas.width || 640,
        logicalHeight: canvas.height || 480,
        listeners: [],
        title: '',
      };
      const hostWindow = {
        canvas,
        set_position(x,y) {const element=frame||canvas;record.x=x;record.y=y;if(element.style){element.style.position='absolute';element.style.left=x+'px';element.style.top=y+'px';}},
        set_visible(visible) {record.visible=Boolean(visible);const element=frame||canvas;if(element.style)element.style.display=visible?'':'none';},
        get title() { return record.title; },
        set title(value) {
          record.title = String(value);
          if (frame && frame._title) frame._title.textContent = record.title;
        },
        set_size(width, height) {
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 67108864) {
            throw new Error(`Dimensões de janela inválidas: ${width}×${height}`);
          }
          const ratio = Math.min(2, Math.max(1, global.devicePixelRatio || 1));
          record.logicalWidth = width;
          record.logicalHeight = height;
          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(height * ratio);
          if (canvas !== process.canvas) {
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
          }
          record.context = canvas.getContext('2d');
          record.screenProxy = null;
          if (!record.context) throw new Error('Canvas 2D indisponível para a janela retrowin32.');
          if (typeof record.context.reset === 'function') record.context.reset();
          else record.context.setTransform(1, 0, 0, 1, 0, 0);
          record.context.scale(ratio, ratio);
          record.context.imageSmoothingEnabled = false;
          process._emit('window', { process, window: record });
        },
      };
      const stash = (event) => {
        const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: record.logicalWidth, height: record.logicalHeight };
        const x = Number.isFinite(event.clientX) && rect.width ? (event.clientX - rect.left) * record.logicalWidth / rect.width : event.offsetX;
        const y = Number.isFinite(event.clientY) && rect.height ? (event.clientY - rect.top) * record.logicalHeight / rect.height : event.offsetY;
        process.enqueueEvent({
          type: event.type,
          button: event.button || 0,
          offsetX: Number.isFinite(x) ? x : 0,
          offsetY: Number.isFinite(y) ? y : 0,
          timeStamp: event.timeStamp || now(),
          hwnd,
        });
        if (event.type === 'mousedown' && canvas.focus) canvas.focus({ preventScroll: true });
        return false;
      };
      canvas.tabIndex = 0;
      for (const type of ['keydown','keyup','blur']) {
        const listener=event=>{if(type==='blur'){process.heldKeys.clear();process.pressedKeys.clear();}else if(Number.isInteger(event.keyCode)&&event.keyCode>=0&&event.keyCode<=255){process.injectKey(event.keyCode,type==='keydown');process.enqueueEvent({type,hwnd,keyCode:event.keyCode,timeStamp:event.timeStamp||now()});if(type==='keydown'&&event.key?.length===1)process.enqueueEvent({type:'char',hwnd,keyCode:event.key.charCodeAt(0),timeStamp:event.timeStamp||now()});}};
        canvas.addEventListener(type,listener);record.listeners.push([type,listener]);
      }
      for (const type of ['mousedown', 'mouseup', 'mousemove']) {
        canvas.addEventListener(type, stash);
        record.listeners.push([type, stash]);
      }
      const contextMenu = (event) => event.preventDefault();
      canvas.addEventListener('contextmenu', contextMenu);
      record.listeners.push(['contextmenu', contextMenu]);
      this.windows.push(record);
      this._emit('window', { process: this, window: record });
      return hostWindow;
    }

    screen(hwnd=0) {
      const record = hwnd ? this.windows.find(w=>w.hwnd===hwnd) : this.windows[this.windows.length - 1];
      if (!record) throw new Error('DirectDraw/GDI solicitou surface para HWND desconhecido: '+hwnd);
      if (!record.context) {
        record.context = record.canvas.getContext('2d');
        if (!record.context) throw new Error('Canvas 2D indisponível para screen().');
      }
      if (!record.screenProxy && typeof Proxy === 'function') {
        const process = this;
        record.screenProxy = new Proxy(record.context, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property === 'drawImage') {
              return function (...args) {
                const result = value.apply(target, args);
                process.presents += 1;
                return result;
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set(target, property, value) { return Reflect.set(target, property, value, target); },
        });
      }
      return record.screenProxy || record.context;
    }

    start() {
      if (this.finished || this.finishing) return this;
      if (!this.emu) throw new Error('Emulador ainda não inicializado.');
      if (this.running) return this;
      this.emu.unblock();
      this.running = true;
      this.started = true;
      this.status = 'running';
      this._emit('state', this.getStats());
      this._schedule();
      return this;
    }

    _schedule() {
      if (this.scheduled || !this.running || this.finished) return;
      this.scheduled = true;
      if (!this.channel && typeof global.MessageChannel === 'function') {
        this.channel = new global.MessageChannel();
        this.channel.port2.onmessage = this._boundTick;
      }
      if (this.channel) this.channel.port1.postMessage(null);
      else setTimeout(this._boundTick, 0);
    }

    _tick() {
      if (!this.running || this.finished || !this.emu) return;
      const started = now();
      const before = this.emu.instr_count >>> 0;
      let status;
      try {
        this.runBatches += 1;
        status = this.emu.run(this.stepSize);
        const after = this.emu.instr_count >>> 0;
        this.instructions += (after - this.lastInstructionCounter) >>> 0;
        this.lastInstructionCounter = after;
        const steps = (after - before) >>> 0;
        const elapsed = now() - started;
        if (steps > 1000 && elapsed > 0) {
          if (elapsed < 8) this.stepSize = Math.min(2000000, Math.max(5000, Math.round(steps / elapsed * 8)));
          else if (elapsed > 16) this.stepSize = Math.max(1000, Math.round(this.stepSize * 0.75));
        }
      } catch (error) {
        // Após algumas exceções Rust, o wasm-bindgen mantém o borrow ativo:
        // até instr_count volta a lançar. Não faça outro getter neste caminho.
        // O último contador válido é preservado e a limitação fica explícita.
        this.instructionCounterValid = false;
        this.error = error;
        this._log(`Execução x86 falhou: ${error.stack || error.message}`, 'error');
        this._finish('error');
        return;
      }

      if (this.hostExitRequested) {
        this._finish('exited');
        return;
      }
      if (status === STATUS.RUNNING) {
        this.status = 'running';
        this._emitStatsThrottled();
        this._schedule();
      } else if (status === STATUS.BLOCKED) {
        this.running = false;
        this.status = 'blocked';
        this._emit('state', this.getStats());
        this._emitStatsThrottled(true);
      } else if (status === STATUS.EXIT) {
        this.exitCode = this.emu.exit_code >>> 0;
        this._finish('exited');
      } else if (status === STATUS.DEBUG_BREAK) {
        this.error = new Error(`DebugBreak em EIP 0x${this.emu.eip.toString(16).padStart(8, '0')}.`);
        this._finish('stopped');
      } else {
        this.error = new Error(`retrowin32 entrou em estado de erro (status ${status}, EIP 0x${this.emu.eip.toString(16).padStart(8, '0')}).`);
        this._finish('error');
      }
    }

    _emitStatsThrottled(force) {
      const time = now();
      if (!force && time - this.lastStatsEmit < 250) return;
      this.lastStatsEmit = time;
      this._emit('stats', this.getStats());
    }

    stop(reason) {
      if (this.finished || this.finishing) return this.done;
      this.error = reason ? new Error(String(reason)) : null;
      return this._finish('stopped');
    }

    async _finish(status) {
      if (this.finished || this.finishing) return this.done;
      this.finishing = true;
      this.running = false;
      if (this.timer) { clearTimeout(this.timer); this.timer = 0; }
      const decoderTail = this.decoder.decode();
      if (decoderTail) {
        const remaining = Math.max(0, this.maxOutputChars - this.output.length);
        this.output += decoderTail.slice(0, remaining);
        if (decoderTail.length > remaining) this.outputTruncated = true;
        this._emit('stdout', { text: decoderTail, process: this });
      }
      let flushError = null;
      try { await this.flushWrites(); } catch (error) { flushError = error; }
      this.status = status;
      this.finished = true;
      this.finishing = false;
      if (this.channel) {
        this.channel.port1.close();
        this.channel.port2.close();
        this.channel = null;
      }
      for (const record of this.windows) {
        for (const [type, listener] of record.listeners) record.canvas.removeEventListener(type, listener);
        record.listeners = [];
      }
      if (this.emu) {
        const emulator = this.emu;
        this.emu = null;
        try { emulator.free(); }
        catch (cleanupError) {
          // Uma falha de execução/import pode deixar o borrow do wasm-bindgen
          // ativo. Não mascare o erro original nem derrube o host; registre a
          // limpeza para diagnóstico e deixe o GC do módulo cuidar do restante.
          this._log(`Falha ao liberar Emulator durante cleanup: ${cleanupError.message}`, 'warning');
        }
      }
      if (this.backend.active === this) this.backend.active = null;
      const result = this.getStats();
      result.flushError = flushError ? flushError.message : null;
      this._emit('state', result);
      this._emit('stats', result);
      if (status === 'exited') this._emit('exit', result);
      this.resolveDone(result);
      return result;
    }

    getStats() {
      return {
        backend: 'retrowin32-wasm-x86',
        apiTrace: this.guestApiTail.slice(),
        name: this.name,
        path: this.path.win32,
        status: this.status,
        started: this.started,
        instructions: this.instructions,
        instructionCounterValid: this.instructionCounterValid,
        runBatches: this.runBatches,
        executionAttempted: this.runBatches > 0,
        exitCode: this.exitCode,
        error: this.error ? this.error.message : null,
        stdout: this.output,
        stdoutBytes: this.stdoutBytes,
        outputTruncatedBytes: this.outputTruncatedBytes,
        outputTruncated: this.outputTruncated,
        windows: this.windows.length,
        presents: this.presents,
        preload: Object.assign({}, this.preloadReport),
        volatileWrites: !this.vfs,
        pendingWrites: this.pendingWrites,
        writeErrors: this.writeErrors.slice(),
        canvas: this.canvas || (this.windows[0] && this.windows[0].canvas) || null,
      };
    }
  }

  class Retrowin32Backend {
    constructor(options) {
      const opts = options || {};
      this.tracer = opts.tracer || null;
      this.wasmBytes = opts.wasmBytes || null;
      this.wasmURL = opts.wasmURL || 'vendor/retrowin32/retrowin32.wasm';
      this.moduleURL = opts.moduleURL || '../vendor/retrowin32/glue.mjs';
      this.fetch = opts.fetch || (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
      this.wasmModule = null;
      this.ready = false;
      this.instanceCount = 0;
      this.loadPromise = null;
      this.creating = false;
      this.active = null;
    }

    async load() {
      if (this.ready) return this;
      if (this.loadPromise) return this.loadPromise;
      this.loadPromise = (async () => {
        let bytes = this.wasmBytes ? bytesOf(this.wasmBytes) : null;
        if (!bytes) {
          if (!this.fetch) throw new Error('fetch indisponível para carregar retrowin32.wasm.');
          const response = await this.fetch(this.wasmURL);
          if (!response.ok) throw new Error(`Falha HTTP ${response.status} ao carregar ${this.wasmURL}.`);
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        if (bytes.byteLength < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
          throw new Error('O backend retrowin32 não contém um módulo Wasm válido.');
        }
        this.wasmBytes = bytes;
        // Compila uma vez; cada processo instancia separadamente para isolar
        // memória, JS_HOST e o logger global do núcleo Rust.
        this.wasmModule = await WebAssembly.compile(bytes);
        this.ready = true;
        if (this.tracer) this.tracer.log('retrowin32', `Backend x86 user-mode carregado (${bytes.byteLength} bytes Wasm).`, 'success');
        return this;
      })();
      try { return await this.loadPromise; }
      catch (error) { this.loadPromise = null; throw error; }
    }

    async _instantiate() {
      // O contador é global ao namespace: dois adaptadores não podem gerar a
      // mesma URL e reutilizar acidentalmente o singleton `wasm` do glue.
      Porthole.__retrowin32GlueInstance = (Porthole.__retrowin32GlueInstance || 0) + 1;
      this.instanceCount = Porthole.__retrowin32GlueInstance;
      const separator = this.moduleURL.includes('?') ? '&' : '?';
      // A query cria um módulo JS de glue novo, cujo ponteiro `wasm` também é
      // independente. O servidor entrega o mesmo arquivo; não há CDN/build.
      const module = await import(`${this.moduleURL}${separator}portholeInstance=${this.instanceCount}`);
      await module.initRetrowin32(this.wasmModule, typeof window === 'undefined' ? { headlessClock: now } : {});
      return module;
    }

    async createProcess(options) {
      await this.load();
      if (this.creating || (this.active && !this.active.finished)) {
        throw new Error('O Porthole executa um convidado por vez; encerre o processo atual primeiro.');
      }
      this.creating = true;
      let process = null;
      try {
        const module = await this._instantiate();
        process = new Retrowin32Process(this, Object.assign({}, options, { module }));
        this.active = process;
        return await process._initialize();
      } catch (error) {
        if (this.active === process) this.active = null;
        throw error;
      } finally {
        this.creating = false;
      }
    }
  }

  Porthole.RETROWIN32_STATUS = STATUS;
  Porthole.Retrowin32Process = Retrowin32Process;
  Porthole.Retrowin32Backend = Retrowin32Backend;
})(typeof window !== 'undefined' ? window : globalThis);
