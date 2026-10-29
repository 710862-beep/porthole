/*
 * runtime.js — orquestração do Porthole Runtime.
 * Frames/FPS pertencem exclusivamente ao workload D3D9 integrado. PEs podem
 * ser somente inspecionados ou entregues ao backend retrowin32 x86; stdout,
 * instruções, janelas e exit codes do convidado têm eventos/estados próprios.
 */
(function (global) {
  'use strict';

  const Porthole = (global.Porthole = global.Porthole || {});
  const clock = () => global.performance && performance.now ? performance.now() : Date.now();

  function hslColor(hue, saturation, lightness) {
    const h = ((hue % 1) + 1) % 1;
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    const channel = (t0) => {
      let t = t0;
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const r = Math.round(channel(h + 1 / 3) * 255);
    const g = Math.round(channel(h) * 255);
    const b = Math.round(channel(h - 1 / 3) * 255);
    return ((0xff000000 | (r << 16) | (g << 8) | b) >>> 0);
  }

  class PortholeRuntime {
    constructor(options) {
      const opts = options || {};
      this.canvas = opts.canvas;
      this.guestCanvas = opts.guestCanvas || null;
      this.windowLayer = opts.windowLayer || null;
      this.vfs = opts.vfs || null;
      this.platform = opts.platform || Porthole.platform;
      this.tracer = opts.tracer || new Porthole.ApiTracer(700);
      this.listeners = new Map();
      this.state = 'idle';
      this.running = false;
      this.forceSoftware = Boolean(opts.forceSoftware);
      this.linker = null;
      this.backend = null;
      this.device = null;
      this.user32 = null;
      this.d3d9 = null;
      this.vertexBuffer = null;
      this.triangleCount = 48;
      this.stride = 20;
      this.raf = 0;
      this.lastFrameTime = 0;
      this.sessionFrames = 0;
      this.live = { start: 0, frames: 0, fps: 0 };
      this.benchmark = null;
      this.lastBenchmark = null;
      this.loadedPE = null;
      this.peStatus = 'none';
      this.guestBackend = opts.guestBackend || null;
      this.guestProcess = null;
      this.guestOperation = 0;
      this.retiringGuests = new Set();
      this.guestStats = null;
      this.guestOutput = '';
      this.pipelineValidated = false;
      this.scene = { x: this.canvas.width / 2 || 320, y: this.canvas.height / 2 || 180 };
      this._boundFrame = (time) => this._frame(time);
    }

    on(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(listener);
      return () => this.listeners.get(name).delete(listener);
    }

    _emit(name, value) {
      for (const listener of this.listeners.get(name) || []) {
        try { listener(value); } catch (error) { console.error(`Porthole listener ${name}:`, error); }
      }
    }

    _setState(state) { this.state = state; this._emit('state', state); }

    _createStack(forceSoftware) {
      this.forceSoftware = Boolean(forceSoftware);
      this.backend = Porthole.GraphicsDevice.create(this.canvas, {
        forceSoftware: this.forceSoftware,
        logger: (message, kind) => this.tracer.log('graphics', message, kind),
      });
      this._emit('renderer', this.backend.getInfo());
      this.linker = new Porthole.DynamicLinker({
        tracer: this.tracer,
        context: {
          vfs: this.vfs,
          graphicsBackend: this.backend,
          canvas: this.canvas,
          windowLayer: this.windowLayer,
          document: global.document,
        },
      });
      this.linker
        .register('kernel32.dll', (context) => new Porthole.Kernel32Shim(context))
        .register('user32.dll', (context) => new Porthole.User32Shim(context))
        .register('gdi32.dll', (context) => new Porthole.GDI32Shim(context))
        .register('d3d9.dll', (context) => new Porthole.D3D9Shim(context))
        .register('d3d11.dll', (context) => new Porthole.D3D11Shim(context));
      if (Porthole.Registry && Porthole.Registry.Advapi32Shim) {
        this.linker.register('advapi32.dll', (context) => new Porthole.Registry.Advapi32Shim(context));
      }

      // Estas DLLs são carregadas pelo workload integrado, não atribuídas a um PE.
      const kernel32 = this.linker.loadLibrary('kernel32.dll', 'Porthole integrated workload');
      this.user32 = this.linker.loadLibrary('user32.dll', 'Porthole integrated workload');
      this.linker.loadLibrary('gdi32.dll', 'Porthole integrated workload');
      // O workload atravessa a export Win32, que por sua vez interpõe o linker.
      this.d3d9 = kernel32.LoadLibraryA('d3d9.dll');
      this.user32.attachInput(this.canvas);
      const d3d = this.d3d9.Direct3DCreate9(32);
      this.device = d3d.CreateDevice(0, 1, 0, 0, { BackBufferWidth: this.canvas.width, BackBufferHeight: this.canvas.height });
      const vertices = this.triangleCount * 3;
      this.vertexBuffer = this.device.CreateVertexBuffer(vertices * this.stride, 0, Porthole.D3D9.D3DFVF_XYZRHW | Porthole.D3D9.D3DFVF_DIFFUSE, 0);
      this.device.SetFVF(Porthole.D3D9.D3DFVF_XYZRHW | Porthole.D3D9.D3DFVF_DIFFUSE);
      this.device.SetStreamSource(0, this.vertexBuffer, 0, this.stride);
      this.pipelineValidated = false;
      this.scene.x = this.canvas.width / 2;
      this.scene.y = this.canvas.height / 2;
      this._emit('modules', this.linker.loadedModules());
    }

    _teardownStack() {
      if (this.linker) this.linker.dispose();
      if (this.backend) this.backend.dispose();
      this.linker = null;
      this.backend = null;
      this.device = null;
      this.user32 = null;
      this.d3d9 = null;
      this.vertexBuffer = null;
      this._emit('modules', []);
    }

    _assertGuestOperation(operation) {
      if (operation != null && operation !== this.guestOperation) {
        const error = new Error('Operação de convidado cancelada porque o runtime mudou de contexto.');
        error.code = 'CANCELLED';
        throw error;
      }
    }

    _hideGuestSurface() {
      if (this.guestCanvas) this.guestCanvas.hidden = true;
      if (this.windowLayer && this.windowLayer.querySelectorAll) {
        for (const frame of this.windowLayer.querySelectorAll('.retro-window')) frame.remove();
      }
      this._emit('guestsurface', { visible: false });
    }

    _releaseGuestForIntegrated(reason) {
      this.guestOperation += 1;
      const process = this.guestProcess;
      if (process && !process.finished) {
        // stop() marca running=false antes de aguardar a persistência. Removemos
        // a referência primeiro para que seu callback tardio não altere o estado
        // do workload integrado que está começando agora.
        this.guestProcess = null;
        const retiring = Promise.resolve(process.stop(reason || 'Convidado encerrado para iniciar o workload integrado.'));
        this.retiringGuests.add(retiring);
        retiring.then(() => this.retiringGuests.delete(retiring), () => this.retiringGuests.delete(retiring));
        if (this.loadedPE && ['loaded', 'executing', 'blocked'].includes(this.loadedPE.status)) {
          const stats = process.getStats();
          this.loadedPE.status = 'stopped';
          this.loadedPE.executed = stats.instructions > 0 || stats.stdoutBytes > 0 || stats.windows > 0;
          this.loadedPE.instructions = stats.instructions;
          this.loadedPE.executionReason = 'Convidado encerrado; a superfície ativa voltou ao workload integrado.';
          this._emit('pe', this.loadedPE);
        }
      } else if (this.loadedPE && this.loadedPE.status === 'loading-backend') {
        this.loadedPE.status = 'stopped';
        this.loadedPE.executed = false;
        this.loadedPE.executionReason = 'Carregamento do convidado cancelado antes da primeira instrução.';
        this._emit('pe', this.loadedPE);
      }
      this._hideGuestSurface();
    }

    start(options) {
      if (this.running) return this;
      this._releaseGuestForIntegrated();
      const force = options && Object.prototype.hasOwnProperty.call(options, 'forceSoftware') ? options.forceSoftware : this.forceSoftware;
      if (!this.device || (this.forceSoftware !== Boolean(force) && this.backend)) {
        if (this.device) this._teardownStack();
        this._createStack(force);
      } else if (!this.device) this._createStack(force);
      this.running = true;
      this.lastFrameTime = 0;
      this.live = { start: clock(), frames: 0, fps: 0 };
      this._setState(this.benchmark ? 'benchmark' : 'running');
      this.tracer.log('runtime', `Workload D3D9 integrado iniciado (${this.backend.getInfo().label}).`, 'success');
      this._requestFrame();
      return this;
    }

    pause() {
      if (!this.running) return;
      this.running = false;
      if (this.raf) {
        if (global.cancelAnimationFrame) global.cancelAnimationFrame(this.raf); else clearTimeout(this.raf);
        this.raf = 0;
      }
      if (this.benchmark) {
        this.benchmark.reject(new Error('Benchmark cancelado porque o runtime foi pausado.'));
        this.benchmark = null;
      }
      this._setState('paused');
      this.tracer.log('runtime', 'Workload pausado; nenhum frame será contado.', 'info');
    }

    stop() {
      this._releaseGuestForIntegrated('Runtime interrompido pelo usuário.');
      this.pause();
      this._teardownStack();
      this.sessionFrames = 0;
      this.live.fps = 0;
      this._setState('idle');
      this._emit('stats', { fps: 0, frames: 0, drawCalls: 0 });
    }

    _requestFrame() {
      if (global.requestAnimationFrame) this.raf = global.requestAnimationFrame(this._boundFrame);
      else this.raf = setTimeout(() => this._boundFrame(clock()), 16);
    }

    resize(width, height) {
      if (!this.backend) {
        this.canvas.width = Math.max(1, Math.floor(width));
        this.canvas.height = Math.max(1, Math.floor(height));
        return;
      }
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      if (this.canvas.width === w && this.canvas.height === h) return;
      this.backend.resize(w, h);
      if (!this.user32 || !this.user32.input.mouse.active) {
        this.scene.x = w / 2;
        this.scene.y = h / 2;
      }
      this.tracer.log('graphics', `Framebuffer redimensionado para ${w}×${h}.`, 'info');
      this._emit('resize', { width: w, height: h });
    }

    _writeScene(time, delta) {
      const width = this.canvas.width;
      const height = this.canvas.height;
      const input = this.user32.input;
      const speed = Math.min(width, height) * 0.7 * delta;
      let keyboard = false;
      if (this.user32.GetAsyncKeyState(Porthole.Win32.VK.LEFT) || this.user32.GetAsyncKeyState(65)) { this.scene.x -= speed; keyboard = true; }
      if (this.user32.GetAsyncKeyState(Porthole.Win32.VK.RIGHT) || this.user32.GetAsyncKeyState(68)) { this.scene.x += speed; keyboard = true; }
      if (this.user32.GetAsyncKeyState(Porthole.Win32.VK.UP) || this.user32.GetAsyncKeyState(87)) { this.scene.y -= speed; keyboard = true; }
      if (this.user32.GetAsyncKeyState(Porthole.Win32.VK.DOWN) || this.user32.GetAsyncKeyState(83)) { this.scene.y += speed; keyboard = true; }
      if (keyboard) input.mouse.active = false;
      else if (input.mouse.active) {
        this.scene.x += (input.mouse.x - this.scene.x) * Math.min(1, delta * 12);
        this.scene.y += (input.mouse.y - this.scene.y) * Math.min(1, delta * 12);
      }
      this.scene.x = Math.max(0, Math.min(width, this.scene.x));
      this.scene.y = Math.max(0, Math.min(height, this.scene.y));

      const data = new Uint8Array(this.triangleCount * 3 * this.stride);
      const view = new DataView(data.buffer);
      const radius = Math.min(width, height) * 0.34;
      const rotation = time * 0.00032;
      const step = Math.PI * 2 / this.triangleCount;
      let offset = 0;
      const vertex = (x, y, color) => {
        view.setFloat32(offset, x, true);
        view.setFloat32(offset + 4, y, true);
        view.setFloat32(offset + 8, 0, true);
        view.setFloat32(offset + 12, 1, true);
        view.setUint32(offset + 16, color >>> 0, true);
        offset += this.stride;
      };
      for (let index = 0; index < this.triangleCount; index += 1) {
        const a0 = rotation + index * step;
        const a1 = rotation + (index + 1) * step;
        const pulse0 = 0.82 + 0.18 * Math.sin(a0 * 3 + time * 0.001);
        const pulse1 = 0.82 + 0.18 * Math.sin(a1 * 3 + time * 0.001);
        const x0 = this.scene.x + Math.cos(a0) * radius * pulse0;
        const y0 = this.scene.y + Math.sin(a0) * radius * pulse0;
        const x1 = this.scene.x + Math.cos(a1) * radius * pulse1;
        const y1 = this.scene.y + Math.sin(a1) * radius * pulse1;
        const centerColor = hslColor(index / this.triangleCount + time * 0.000025, 0.42, 0.86);
        vertex(this.scene.x, this.scene.y, centerColor);
        vertex(x0, y0, hslColor(index / this.triangleCount + time * 0.00004, 0.82, 0.58));
        vertex(x1, y1, hslColor((index + 1) / this.triangleCount + time * 0.00004, 0.82, 0.42));
      }
      this.device.WriteVertices(this.vertexBuffer, data, 0);
    }

    _render(time) {
      const delta = this.lastFrameTime ? Math.min(0.05, Math.max(0, (time - this.lastFrameTime) / 1000)) : 1 / 60;
      this.lastFrameTime = time;
      this._writeScene(time, delta);
      this.device.Clear(0, null, 1, 0xff09121e, 1, 0);
      this.device.BeginScene();
      this.device.DrawPrimitive(4, 0, this.triangleCount); // D3DPT_TRIANGLELIST
      this.device.EndScene();
      this.device.Present();
      this.sessionFrames += 1;
      if (this.benchmark) this.benchmark.frames += 1;

      if (!this.pipelineValidated) {
        const pixel = this.backend.readCenterPixel();
        if (!pixel || pixel.length < 4 || pixel[3] === 0) throw new Error('Validação do framebuffer falhou: pixel central sem cobertura.');
        this.pipelineValidated = true;
        this.tracer.log('runtime', `Pipeline validado por readback RGBA [${Array.from(pixel).join(', ')}] · origem: workload integrado.`, 'success');
        this._emit('pipeline', { valid: true, pixel: Array.from(pixel), origin: 'integrated-d3d9-workload' });
      }
    }

    _frame(time) {
      if (!this.running) return;
      try {
        this._render(time);
      } catch (error) {
        if (this.backend && this.backend.getInfo().kind !== 'software-cpu') {
          this.tracer.log('graphics', `Falha no pipeline WebGL (${error.message}) → recuperação CPU.`, 'error');
          this._teardownStack();
          try {
            this._createStack(true);
            this._render(time);
            this._emit('renderer', this.backend.getInfo());
          } catch (fatal) {
            this.tracer.log('runtime', `Fallback CPU também falhou: ${fatal.message}`, 'error');
            this.pause();
            this._setState('error');
            return;
          }
        } else {
          this.tracer.log('runtime', `Rasterizador CPU falhou: ${error.message}`, 'error');
          this.pause();
          this._setState('error');
          return;
        }
      }

      this.live.frames += 1;
      const liveElapsed = time - this.live.start;
      if (liveElapsed >= 500) {
        this.live.fps = this.live.frames * 1000 / liveElapsed;
        this.live.frames = 0;
        this.live.start = time;
        this._emit('stats', {
          fps: this.live.fps, frames: this.sessionFrames,
          drawCalls: this.device ? this.device.drawCalls : 0,
          width: this.canvas.width, height: this.canvas.height,
        });
      }

      if (this.benchmark) {
        const elapsed = clock() - this.benchmark.start;
        if (elapsed >= this.benchmark.duration) {
          const done = this.benchmark;
          const result = {
            workload: 'integrated-d3d9-workload',
            origin: 'Benchmark D3D9 integrado (não é um PE externo)',
            durationMs: elapsed,
            frames: done.frames,
            fps: done.frames * 1000 / elapsed,
            drawCalls: done.frames,
            renderer: this.backend.getInfo(),
            platform: this.platform.label,
            vfs: this.vfs ? this.vfs.getInfo() : null,
            pixelValidated: this.pipelineValidated,
            finishedAt: new Date().toISOString(),
          };
          this.benchmark = null;
          this.lastBenchmark = result;
          done.resolve(result);
          this._setState(this.running ? 'running' : 'paused');
          this._emit('benchmark', result);
          this.tracer.log('runtime', `Benchmark integrado: ${result.fps.toFixed(2)} FPS · ${result.frames} frames em ${(elapsed / 1000).toFixed(3)} s.`, 'success');
        }
      }
      if (this.running) this._requestFrame();
    }

    runBenchmark(duration) {
      if (this.benchmark) return Promise.reject(new Error('Já existe um benchmark em execução.'));
      if (!this.running) this.start();
      const milliseconds = duration == null ? 5000 : Number(duration);
      if (!Number.isFinite(milliseconds) || milliseconds < 1000 || milliseconds > 30000) {
        return Promise.reject(new Error('Duração do benchmark deve ficar entre 1 e 30 segundos.'));
      }
      return new Promise((resolve, reject) => {
        this.benchmark = { start: clock(), duration: milliseconds, frames: 0, resolve, reject };
        this._setState('benchmark');
        this._emit('benchmarkstart', { duration: milliseconds, workload: 'integrated-d3d9-workload' });
        this.tracer.log('runtime', `Benchmark D3D9 integrado iniciado; janela solicitada: ${milliseconds} ms.`, 'info');
      });
    }

    async _sha256(bytes) {
      try {
        if (!global.crypto || !global.crypto.subtle) return null;
        const digest = await global.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
      } catch (_) { return null; }
    }

    async _inspectExecutableBytes(path, bytes, options) {
      const opts = options || {};
      this._assertGuestOperation(opts._operation);
      if (this.guestProcess && !this.guestProcess.finished) {
        await this.stopGuest('Convidado encerrado para inspecionar outro PE.');
      }
      this._assertGuestOperation(opts._operation);
      this._hideGuestSurface();
      if (!this.device) this._createStack(this.forceSoftware);
      this.peStatus = 'loading';
      this._emit('pestatus', this.peStatus);
      try {
        if (bytes.byteLength < 64) throw new Error('Arquivo pequeno demais para conter um PE.');
        const normalized = Porthole.VFSUtils.normalizePath(path);
        const name = String(path).replace(/^.*[\\/]/, '');
        const info = Porthole.PELoader.parse(bytes, { name });
        const imports = this.linker.resolveImports(info);
        const sha256 = await this._sha256(bytes);
        this._assertGuestOperation(opts._operation);
        this.loadedPE = {
          path: normalized.win32,
          name,
          info,
          imports,
          sha256,
          source: opts.source || 'vfs',
          status: 'inspected-not-executed',
          executed: false,
          backend: null,
          instructions: 0,
          exitCode: null,
          executionReason: 'PE inspecionado e imports resolvidos pelos SHIMs Porthole. Nenhuma instrução executada; use “Executar x86” para iniciar o backend retrowin32.',
          loadedAt: new Date().toISOString(),
        };
        this.guestOutput = '';
        this.guestStats = null;
        this.peStatus = 'inspected';
        if (!this.running) this._setState('ready');
        this.tracer.log('pe-loader', `${name}: ${info.format} ${info.architecture}, ${info.imports.length} DLLs, ${bytes.byteLength} bytes → INSPECIONADO, NÃO EXECUTADO.`, 'warning');
        this._emit('pe', this.loadedPE);
        this._emit('pestatus', this.peStatus);
        this._emit('guestoutput', { text: '', output: '', process: null });
        this._emit('modules', this.linker.loadedModules());
        return this.loadedPE;
      } catch (error) {
        this.peStatus = 'error';
        this._emit('pestatus', this.peStatus);
        this.tracer.log('pe-loader', `${path}: ${error.message}`, 'error');
        throw error;
      }
    }

    async loadExecutable(path) {
      if (!this.vfs) throw new Error('VFS não configurado.');
      const operation = ++this.guestOperation;
      const bytes = await this.vfs.readFile(path);
      this._assertGuestOperation(operation);
      return this._inspectExecutableBytes(path, bytes, { source: 'vfs', _operation: operation });
    }

    _ensureGuestBackend() {
      if (!this.guestBackend) {
        if (!Porthole.Retrowin32Backend) throw new Error('Backend retrowin32 não foi carregado.');
        this.guestBackend = new Porthole.Retrowin32Backend({ tracer: this.tracer });
      }
      return this.guestBackend;
    }

    async executeExecutable(path, options) {
      if (!this.vfs) throw new Error('VFS não configurado.');
      const operation = ++this.guestOperation;
      // Relê e reinspeciona para que hash/imports e bytes executados coincidam.
      const bytes = await this.vfs.readFile(path);
      this._assertGuestOperation(operation);
      await this._inspectExecutableBytes(path, bytes, { source: 'vfs', _operation: operation });
      return this._executeInspected(bytes, Object.assign({}, options, { _operation: operation }));
    }

    async executeBytes(path, bytes, options) {
      const opts = options || {};
      const operation = opts._operation == null ? ++this.guestOperation : opts._operation;
      this._assertGuestOperation(operation);
      await this._inspectExecutableBytes(path, bytes, { source: opts.source || 'bytes', _operation: operation });
      return this._executeInspected(bytes, Object.assign({}, opts, { _operation: operation }));
    }

    async runBundledFixture(name, options) {
      if (!['hello.exe', 'callback.exe'].includes(name)) throw new Error('Fixture retrowin32 desconhecido.');
      if (typeof global.fetch !== 'function') throw new Error('fetch indisponível para ler o fixture local.');
      const operation = ++this.guestOperation;
      const url = `vendor/retrowin32/fixtures/${name}`;
      const response = await global.fetch(url);
      if (!response.ok) throw new Error(`Falha HTTP ${response.status} ao carregar ${url}.`);
      const bytes = await response.arrayBuffer();
      this._assertGuestOperation(operation);
      return this.executeBytes(`C:\\Tests\\${name}`, bytes, Object.assign({}, options, {
        source: 'bundled-retrowin32-test',
        preload: false,
        _operation: operation,
      }));
    }

    async _executeInspected(bytes, options) {
      const opts = options || {};
      const operation = opts._operation;
      this._assertGuestOperation(operation);
      let process = null;
      const loaded = this.loadedPE;
      if (!loaded) throw new Error('Nenhum PE inspecionado.');
      if (loaded.info.machine !== 0x14c || loaded.info.format !== 'PE32' || loaded.info.isDLL) {
        const error = new Error('O backend vendoreado executa somente imagens PE32 x86; PE64 e DLLs não são aceitos nesta ação.');
        loaded.status = 'error';
        loaded.executionReason = error.message;
        this._emit('pe', loaded);
        throw error;
      }
      if (this.running) this.pause();
      loaded.status = 'loading-backend';
      loaded.executionReason = 'Carregando o núcleo retrowin32 e preparando o cache de arquivos; nenhuma instrução executada ainda.';
      this.peStatus = 'guest-loading';
      this._setState('guest-loading');
      this._emit('pe', loaded);
      this._emit('pestatus', this.peStatus);

      try {
        if (this.retiringGuests.size) await Promise.all(Array.from(this.retiringGuests));
        this._assertGuestOperation(operation);
        const backend = this._ensureGuestBackend();
        const useVFS = loaded.source === 'vfs';
        process = await backend.createProcess({
          path: loaded.path,
          name: loaded.name,
          bytes,
          vfs: useVFS ? this.vfs : null,
          preload: opts.preload == null ? useVFS : Boolean(opts.preload),
          trace: opts.trace === true,
          relocate: Boolean(opts.relocate),
          commandLine: opts.commandLine,
          document: global.document,
          canvas: this.guestCanvas,
          windowLayer: this.windowLayer,
          maxPreloadFiles: opts.maxPreloadFiles,
          maxPreloadBytes: opts.maxPreloadBytes,
        });
        this._assertGuestOperation(operation);
        this.guestProcess = process;
        this.guestOutput = '';
        loaded.backend = 'retrowin32-wasm-x86';
        loaded.status = 'loaded';
        loaded.executed = false;
        loaded.instructions = 0;
        loaded.executionReason = 'PE carregado pelo retrowin32; aguardando o primeiro lote de instruções.';

        process.on('stdout', ({ text }) => {
          if (this.guestProcess !== process) return;
          this.guestOutput = process.output;
          if (this.loadedPE === loaded) this.loadedPE.stdout = this.guestOutput;
          this._emit('guestoutput', { text, output: this.guestOutput, process });
        });
        process.on('window', () => {
          if (this.guestProcess !== process) return;
          if (this.guestCanvas && process.canvas === this.guestCanvas) this.guestCanvas.hidden = false;
          this._emit('guestsurface', { visible: true, canvas: process.canvas, process });
          this._emit('gueststats', process.getStats());
        });
        process.on('stats', (stats) => {
          if (this.guestProcess !== process) return;
          this._updateGuestStats(stats);
        });
        process.on('state', (stats) => {
          if (this.guestProcess !== process) return;
          this._updateGuestState(stats);
        });
        process.on('error', (error) => {
          if (this.guestProcess !== process) return;
          if (this.loadedPE === loaded) this.loadedPE.ioError = error.message;
          this._emit('guesterror', { error, process });
        });

        this._updateGuestState(process.getStats());
        process.start();
        this.tracer.log('retrowin32', `${loaded.name}: emu.run() agendado; origem PE32 x86 real, não workload integrado.`, 'success');
        return process;
      } catch (error) {
        if (process && !process.finished) {
          this.guestProcess = null;
          await process.stop('Inicialização cancelada ou falhou.');
        }
        const stale = error.code === 'CANCELLED' && operation !== this.guestOperation;
        if (!stale && this.loadedPE === loaded) {
          loaded.status = 'error';
          loaded.executed = false;
          loaded.executionReason = error.message;
          this.peStatus = 'error';
          this._setState('error');
          this.tracer.log('retrowin32', `${loaded.name}: falha antes/durante inicialização: ${error.message}`, 'error');
          this._emit('pe', loaded);
          this._emit('pestatus', this.peStatus);
        }
        throw error;
      }
    }

    _updateGuestStats(stats) {
      this.guestStats = stats;
      const loaded = this.loadedPE;
      if (loaded && loaded.name === stats.name) {
        loaded.instructions = stats.instructions;
        loaded.presents = stats.presents;
        loaded.windows = stats.windows;
        loaded.stdout = stats.stdout;
        loaded.executed = stats.instructions > 0 || stats.stdoutBytes > 0 || stats.windows > 0 || stats.status === 'exited';
        loaded.instructionCounterValid = stats.instructionCounterValid !== false;
        loaded.runBatches = stats.runBatches || 0;
        loaded.preload = stats.preload;
        loaded.writeErrors = stats.writeErrors;
        loaded.info.execution = {
          executed: loaded.executed,
          backend: stats.backend,
          reason: loaded.executionReason,
        };
      }
      this._emit('gueststats', stats);
      this._emit('pe', loaded);
    }

    _updateGuestState(stats) {
      this._updateGuestStats(stats);
      const loaded = this.loadedPE;
      const states = { loading: 'loading-backend', loaded: 'loaded', running: 'executing', blocked: 'blocked', exited: 'exited', error: 'error', stopped: 'stopped' };
      if (loaded && loaded.name === stats.name) {
        loaded.status = states[stats.status] || stats.status;
        loaded.exitCode = stats.exitCode;
        loaded.error = stats.error;
        const reasons = {
          loaded: 'PE carregado pelo retrowin32; nenhuma instrução executada ainda.',
          running: 'retrowin32 executando instruções PE32 x86. Win32 HLE e frames do convidado pertencem ao backend, não ao workload integrado.',
          blocked: 'Processo bloqueado em espera; timers/eventos do host podem desbloqueá-lo.',
          exited: `Processo encerrado após ${stats.instructions} instruções; exit code ${stats.exitCode}.`,
          stopped: stats.error ? stats.error.message : 'Processo interrompido pelo usuário.',
          error: stats.error || 'O backend retrowin32 reportou um erro de execução.',
        };
        loaded.executionReason = reasons[stats.status] || loaded.executionReason;
        if (stats.instructionCounterValid === false) loaded.executionReason += ' O contador pós-exceção está indisponível; o valor exibido é o último contador válido.';
        if (stats.flushError) loaded.executionReason += ` Persistência: ${stats.flushError}`;
      }
      this.peStatus = `guest-${stats.status}`;
      this._setState(`guest-${stats.status}`);
      this._emit('pe', loaded);
      this._emit('pestatus', this.peStatus);
    }

    async stopGuest(reason) {
      const process = this.guestProcess;
      if (!process || process.finished) return process ? process.getStats() : null;
      const result = await process.stop(reason || 'Processo interrompido pelo usuário.');
      if (this.guestProcess === process) this._updateGuestState(result);
      return result;
    }

    async captureState(uiElement) {
      const candidate = this.guestCanvas || (this.guestStats && this.guestStats.canvas);
      const guestSurface = Boolean(candidate && this.guestStats && this.guestStats.windows > 0 && (this.guestCanvas ? !this.guestCanvas.hidden : this.state.startsWith('guest-')));
      const surface = guestSurface ? candidate : this.canvas;
      if (!surface || !surface.toDataURL) throw new Error('Canvas não suporta captura.');
      let writeFlushError = null;
      if (this.guestProcess && !this.guestProcess.finished) {
        try { await this.guestProcess.flushWrites(); } catch (error) { writeFlushError = error.message; }
      }
      const framebuffer = surface.toDataURL('image/png');
      let ui = null;
      let uiError = null;
      if (typeof global.html2canvas === 'function' && uiElement) {
        try {
          const capture = await global.html2canvas(uiElement, { backgroundColor: '#070b12', logging: false, useCORS: true, scale: 1 });
          ui = capture.toDataURL('image/png');
        } catch (error) {
          uiError = error.message;
          this.tracer.log('capture', `Captura da UI falhou: ${error.message}`, 'error');
        }
      } else uiError = 'html2canvas indisponível.';
      const result = {
        framebuffer,
        ui,
        uiError,
        capturedAt: new Date().toISOString(),
        metadata: {
          platform: this.platform,
          renderer: guestSurface ? { kind: 'retrowin32-canvas2d', label: 'retrowin32 guest Canvas 2D', api: 'Canvas 2D / Win32 HLE' } : this.backend ? this.backend.getInfo() : null,
          integratedRenderer: this.backend ? this.backend.getInfo() : null,
          vfs: this.vfs ? this.vfs.getInfo() : null,
          runtimeState: this.state,
          pipelineValidated: this.pipelineValidated,
          frameOrigin: guestSurface ? 'retrowin32-guest-window' : this.device ? 'integrated-d3d9-workload' : 'idle-canvas',
          pe: this.loadedPE ? {
            name: this.loadedPE.name,
            status: this.loadedPE.status,
            executed: Boolean(this.loadedPE.executed),
            backend: this.loadedPE.backend,
            instructions: this.loadedPE.instructions || 0,
            exitCode: this.loadedPE.exitCode,
          } : null,
          guest: this.guestStats ? {
            backend: this.guestStats.backend,
            status: this.guestStats.status,
            instructions: this.guestStats.instructions,
            presents: this.guestStats.presents,
            stdoutBytes: this.guestStats.stdoutBytes,
            writeFlushError,
          } : null,
          benchmark: this.lastBenchmark,
        },
      };
      this.tracer.log('capture', `Capture Runtime State: framebuffer PNG ${framebuffer.length} chars; UI ${ui ? 'capturada' : 'indisponível'}.`, ui ? 'success' : 'warning');
      this._emit('capture', result);
      return result;
    }

    getStatus() {
      return {
        state: this.state,
        running: this.running,
        renderer: this.backend ? this.backend.getInfo() : null,
        modules: this.linker ? this.linker.loadedModules() : [],
        platform: this.platform,
        vfs: this.vfs ? this.vfs.getInfo() : null,
        pe: this.loadedPE,
        guest: this.guestStats,
        guestOutput: this.guestOutput,
        benchmark: this.lastBenchmark,
        pipelineValidated: this.pipelineValidated,
      };
    }
  }

  Porthole.PortholeRuntime = PortholeRuntime;
  Porthole.RuntimeUtils = { hslColor };
})(typeof window !== 'undefined' ? window : globalThis);
