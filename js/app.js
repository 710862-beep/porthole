/* app.js — ligação DOM ↔ Porthole Runtime (Vanilla JS, sem framework). */
(function (global) {
  'use strict';

  const Porthole = global.Porthole;
  const document = global.document;
  if (!document) return;
  const $ = (id) => document.getElementById(id);
  const tracer = new Porthole.ApiTracer(700);
  const platform = Porthole.platform;
  const logVFS = (message) => tracer.log('vfs', message, 'info');

  const native = platform.capabilities.fileSystemAccess ? new Porthole.FileSystemAccessVFS({ window: global, logger: logVFS }) : null;
  const fallback = new Porthole.FallbackVFS({ document, logger: logVFS });
  const baseVFS = new Porthole.VirtualFileSystem({ native, fallback, onChange: updateVFS });
  const vfs = new Porthole.VFSPersistence({ vfs: baseVFS });
  const runtime = new Porthole.PortholeRuntime({
    canvas: $('render-canvas'),
    guestCanvas: $('guest-canvas'),
    windowLayer: $('window-layer'),
    platform,
    tracer,
    vfs,
  });

  let logRenderPending = false;
  let resizePending = false;
  let benchmarkTimer = null;
  let benchmarkStarted = 0;
  let benchmarkDuration = 5000;

  function toast(message, kind) {
    const item = document.createElement('div');
    item.className = `toast ${kind || ''}`;
    item.textContent = message;
    $('toast-region').appendChild(item);
    setTimeout(() => item.remove(), 4800);
  }

  function formatTime(date) {
    const value = date instanceof Date ? date : new Date(date);
    return value.toLocaleTimeString('pt-BR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + `.${String(value.getMilliseconds()).padStart(3, '0')}`;
  }

  function renderLogs() {
    logRenderPending = false;
    const container = $('api-log');
    const stickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    const entries = tracer.entries.slice(-180);
    const fragment = document.createDocumentFragment();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = 'Nenhuma chamada interceptada.';
      fragment.appendChild(empty);
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'log-entry';
      row.dataset.kind = entry.kind || 'info';
      const values = [
        ['log-time', formatTime(entry.wallTime)],
        ['log-source', entry.source || 'runtime'],
        ['log-message', entry.message || ''],
        ['log-duration', Number.isFinite(entry.duration) ? entry.duration.toFixed(2) : '—'],
      ];
      for (const [className, text] of values) {
        const cell = document.createElement('span');
        cell.className = className;
        cell.textContent = text;
        cell.title = className === 'log-message' ? text : '';
        row.appendChild(cell);
      }
      fragment.appendChild(row);
    }
    container.replaceChildren(fragment);
    if (stickToBottom) container.scrollTop = container.scrollHeight;
  }

  tracer.subscribe(() => {
    if (logRenderPending) return;
    logRenderPending = true;
    setTimeout(renderLogs, 120);
  });

  function updateVFS(info) {
    const details = info || vfs.getInfo();
    if (!details.mapped) {
      $('status-vfs').textContent = native ? 'FS Access disponível' : 'Fallback disponível';
      $('status-vfs-detail').textContent = 'Nenhuma pasta mapeada para C:\\';
      $('vfs-mode').textContent = 'UNMAPPED';
      $('mapping-info').hidden = true;
      $('load-pe').disabled = true;
      $('execute-pe').disabled = true;
      return;
    }
    $('status-vfs').textContent = `C:\\ → ${details.rootName}`;
    $('status-vfs').title = details.label;
    $('status-vfs-detail').textContent = details.persistent ? 'Persistente · File System Access API' : 'Overlay em memória · não persistente';
    $('vfs-mode').textContent = details.persistent ? 'READ / WRITE' : 'MEMORY';
    $('mapping-info').hidden = false;
    $('mapping-root').textContent = `C:\\ → ${details.rootName}`;
    $('mapping-detail').textContent = `${details.label}${Number.isFinite(details.fileCount) ? ` · ${details.fileCount} arquivos` : ''}`;
    $('map-directory').textContent = 'Remapear pasta';
    $('load-pe').disabled = false;
    $('execute-pe').disabled = false;
  }

  function updateModules(modules) {
    $('dll-count').textContent = String(modules.length);
    const list = $('dll-list');
    list.replaceChildren();
    if (!modules.length) {
      const empty = document.createElement('span');
      empty.className = 'empty-inline';
      empty.textContent = 'Nenhuma DLL carregada';
      list.appendChild(empty);
      return;
    }
    for (const module of modules) {
      const chip = document.createElement('span');
      chip.className = 'dll-chip';
      chip.textContent = module.name;
      const refs = document.createElement('small');
      refs.textContent = `×${module.refs}`;
      chip.appendChild(refs);
      chip.title = `${module.exports} exports JS disponíveis`;
      list.appendChild(chip);
    }
  }

  function updateState(state) {
    const names = {
      idle: 'Em espera', ready: 'Pronto', running: 'Workload ativo', paused: 'Pausado', benchmark: 'Medindo 5 s', error: 'Erro no runtime',
      'guest-loading': 'Carregando convidado', 'guest-loaded': 'Convidado carregado', 'guest-running': 'PE x86 executando',
      'guest-blocked': 'PE bloqueado', 'guest-exited': 'PE encerrado', 'guest-stopped': 'PE interrompido', 'guest-error': 'Erro no convidado',
    };
    const guest = state.startsWith('guest-');
    const stats = runtime.guestStats;
    $('status-runtime').textContent = names[state] || state;
    $('status-runtime-detail').textContent = guest && stats
      ? `retrowin32 · ${stats.instructions.toLocaleString('pt-BR')} instruções${stats.exitCode == null ? '' : ` · exit ${stats.exitCode}`}`
      : runtime.device ? 'Origem: workload D3D9 integrado' : 'Nenhum frame apresentado';
    $('runtime-state').textContent = state.toUpperCase();
    $('runtime-state').dataset.state = state;
    $('start-button').querySelector('span:last-child').textContent = runtime.running ? 'Pausar runtime' : runtime.device ? 'Retomar runtime' : 'Iniciar runtime';
    $('benchmark-button').disabled = !runtime.running || Boolean(runtime.benchmark);
    const guestActive = ['guest-loading', 'guest-loaded', 'guest-running', 'guest-blocked'].includes(state);
    $('stop-pe').hidden = !(guestActive && runtime.guestProcess && !runtime.guestProcess.finished);
    $('map-directory').disabled = guestActive;
    $('fallback-directory').disabled = guestActive;
    $('start-button').disabled = state === 'guest-loading';
    $('load-pe').disabled = !vfs.isMapped || guestActive;
    $('execute-pe').disabled = !vfs.isMapped || guestActive;
    $('run-hello').disabled = guestActive;
    $('run-callback').disabled = guestActive;
    $('canvas-idle').hidden = Boolean(runtime.device) || guest;
    $('frame-origin').textContent = guest
      ? stats && stats.windows > 0 ? 'RETROWIN32 GUEST SURFACE' : 'GUEST CONSOLE / NO FRAMEBUFFER'
      : runtime.device ? 'INTEGRATED D3D9 WORKLOAD' : 'IDLE CANVAS';
    if (guest) {
      $('fps-counter').innerHTML = '— <small>PE</small>';
      $('draw-counter').textContent = stats ? `${stats.instructions.toLocaleString('pt-BR')} INSTR` : 'BACKEND';
      $('pipeline-status').innerHTML = '<i class="status-dot"></i> retrowin32 x86 user-mode · origem separada do benchmark';
      if (stats && stats.windows > 0) $('resolution-counter').textContent = `${runtime.guestCanvas.width} × ${runtime.guestCanvas.height}`;
    } else if (state === 'idle') {
      $('fps-counter').innerHTML = '0 <small>FPS</small>';
      $('draw-counter').textContent = '0 DRAWS';
      $('pipeline-status').innerHTML = '<i class="status-dot muted"></i> Pipeline aguardando inicialização';
      drawIdle();
    }
  }

  function updateRenderer(info) {
    $('status-renderer').textContent = info.label;
    $('status-renderer').title = `${info.vendor} / ${info.renderer}`;
    $('status-renderer-detail').textContent = `${info.api} · ${info.renderer}`;
    scheduleResize();
  }

  function updateBenchmarkProgress() {
    if (!runtime.benchmark) return;
    const elapsed = Math.max(0, performance.now() - benchmarkStarted);
    const ratio = Math.min(1, elapsed / benchmarkDuration);
    $('benchmark-progress').style.width = `${ratio * 100}%`;
    $('benchmark-remaining').textContent = `${Math.max(0, (benchmarkDuration - elapsed) / 1000).toFixed(1)} s`;
  }

  function finishBenchmarkUI() {
    if (benchmarkTimer) clearInterval(benchmarkTimer);
    benchmarkTimer = null;
    $('benchmark-overlay').hidden = true;
    $('benchmark-button').textContent = 'Benchmark 5 s';
    $('benchmark-button').disabled = !runtime.running;
  }

  function renderPE(loaded) {
    if (!loaded) return;
    const { info, imports } = loaded;
    $('pe-error').hidden = true;
    $('pe-result').hidden = false;
    $('pe-name').textContent = loaded.name;
    $('pe-name').title = loaded.path;
    $('pe-architecture').textContent = `${info.format} · ${info.architecture}`;
    $('pe-imports').textContent = `${imports.resolvedFunctions}/${imports.totalFunctions} funções · ${imports.unsupportedDlls.length} DLLs pendentes`;
    $('pe-imports').title = imports.missingFunctions.map((item) => `${item.dll}!${item.name}`).join('\n') || 'Todos os imports nomeados foram resolvidos.';
    $('pe-hash').textContent = loaded.sha256 ? `${loaded.sha256.slice(0, 16)}…${loaded.sha256.slice(-8)}` : 'Indisponível neste contexto';
    $('pe-hash').title = loaded.sha256 || '';
    const labels = {
      'inspected-not-executed': 'INSPECIONADO / NÃO EXECUTADO',
      'loading-backend': 'CARREGANDO BACKEND', loaded: 'CARREGADO / AGUARDANDO RUN',
      executing: 'EXECUTANDO / PE32 x86', blocked: 'BLOQUEADO / AGUARDANDO HOST',
      exited: `ENCERRADO / EXIT ${loaded.exitCode == null ? '—' : loaded.exitCode}`,
      stopped: 'INTERROMPIDO', error: 'ERRO DE EXECUÇÃO',
    };
    $('pe-execution').textContent = labels[loaded.status] || loaded.status;
    $('pe-execution').dataset.state = loaded.status;
    $('pe-backend').textContent = loaded.backend || 'Porthole JS · somente inspeção';
    $('pe-instructions').textContent = (loaded.instructions || 0).toLocaleString('pt-BR');
    $('pe-instructions').title = loaded.instructionCounterValid === false ? 'Último contador válido; o getter falhou após a exceção Rust.' : 'Contador instr_count do núcleo retrowin32.';
    $('pe-reason').textContent = loaded.executionReason || '';
    $('guest-output').textContent = loaded.stdout || '';
    $('guest-output').hidden = !loaded.stdout;

    const lower = loaded.name.toLowerCase();
    for (const [id, statusId, matches] of [
      ['test-doom95', 'doom95-status', lower.includes('doom95')],
      ['test-kkrieger', 'kkrieger-status', lower.includes('kkrieger')],
    ]) {
      const status = $(statusId);
      if (matches) {
        const matrixLabels = { 'loading-backend': 'LOADING', loaded: 'LOADED', executing: 'RUNNING', blocked: 'BLOCKED', stopped: 'STOPPED', error: 'ERROR' };
        status.textContent = loaded.status === 'exited' ? `EXIT ${loaded.exitCode}` : matrixLabels[loaded.status] || (loaded.executed ? 'EXECUTED' : 'INSPECTED');
        status.className = `test-status${['executing', 'blocked'].includes(loaded.status) ? ' running' : loaded.status === 'exited' || loaded.executed ? '' : ' warning'}`;
        document.querySelector(`#${id} .test-copy small`).textContent = loaded.backend
          ? `${loaded.backend} · ${(loaded.instructions || 0).toLocaleString('pt-BR')} instruções`
          : `${imports.loadedDlls.length} SHIMs ativos · entry point não executado`;
      } else {
        status.textContent = 'AWAITING PE';
        status.className = 'test-status neutral';
      }
    }
  }

  function drawIdle() {
    const canvas = $('render-canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.width, height = canvas.height;
    context.fillStyle = '#080f19';
    context.fillRect(0, 0, width, height);
    context.strokeStyle = 'rgba(61, 98, 119, .13)';
    context.lineWidth = 1;
    const step = Math.max(28, Math.round(Math.min(width, height) / 12));
    context.beginPath();
    for (let x = 0; x < width; x += step) { context.moveTo(x + .5, 0); context.lineTo(x + .5, height); }
    for (let y = 0; y < height; y += step) { context.moveTo(0, y + .5); context.lineTo(width, y + .5); }
    context.stroke();
    context.strokeStyle = 'rgba(94, 234, 212, .11)';
    context.beginPath();
    context.arc(width / 2, height / 2, Math.min(width, height) * .29, 0, Math.PI * 2);
    context.stroke();
  }

  function resizeCanvas() {
    resizePending = false;
    const shell = $('canvas-shell');
    const rect = shell.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cpu = runtime.backend && runtime.backend.getInfo().kind === 'software-cpu';
    const ratio = Math.min(global.devicePixelRatio || 1, cpu ? 1 : 1.5);
    let width = rect.width * ratio;
    let height = rect.height * ratio;
    const maxPixels = cpu ? 520000 : 1800000;
    if (width * height > maxPixels) {
      const scale = Math.sqrt(maxPixels / (width * height));
      width *= scale;
      height *= scale;
    }
    runtime.resize(Math.round(width), Math.round(height));
    const guestVisible = runtime.guestCanvas && !runtime.guestCanvas.hidden && runtime.guestStats && runtime.guestStats.windows > 0;
    $('resolution-counter').textContent = guestVisible ? `${runtime.guestCanvas.width} × ${runtime.guestCanvas.height}` : `${canvasWidth()} × ${canvasHeight()}`;
    if (!runtime.device) drawIdle();
  }

  function canvasWidth() { return $('render-canvas').width; }
  function canvasHeight() { return $('render-canvas').height; }
  function scheduleResize() {
    if (resizePending) return;
    resizePending = true;
    if (global.requestAnimationFrame) global.requestAnimationFrame(resizeCanvas);
    else setTimeout(resizeCanvas, 16);
  }

  async function mapDirectory(forceFallback) {
    if (['guest-loading', 'guest-loaded', 'guest-running', 'guest-blocked'].includes(runtime.state)) {
      toast('Pare o convidado antes de remapear C:\\\\.', 'warning');
      return;
    }
    $('map-directory').disabled = true;
    $('fallback-directory').disabled = true;
    try {
      const info = await vfs.mapDirectory({ forceFallback });
      updateVFS(info);
      toast(`C:\\ mapeado via ${info.label}.`, 'success');
    } catch (error) {
      if (error.name !== 'AbortError' && error.code !== 'CANCELLED') {
        tracer.log('vfs', error.message, 'error');
        toast(`Não foi possível mapear C:\\: ${error.message}`, 'error');
      }
    } finally {
      updateState(runtime.state);
    }
  }

  $('map-directory').addEventListener('click', () => mapDirectory(!native));
  $('fallback-directory').hidden = !native;
  $('fallback-directory').addEventListener('click', () => mapDirectory(true));

  $('start-button').addEventListener('click', () => {
    try {
      if (runtime.running) runtime.pause();
      else runtime.start({ forceSoftware: $('force-software').checked });
      $('render-canvas').focus({ preventScroll: true });
    } catch (error) {
      tracer.log('runtime', error.message, 'error');
      toast(error.message, 'error');
    }
  });

  $('force-software').addEventListener('change', (event) => {
    const force = event.target.checked;
    if (!runtime.device) {
      runtime.forceSoftware = force;
      return;
    }
    const resume = runtime.running;
    try {
      runtime.stop();
      runtime.start({ forceSoftware: force });
      if (!resume) runtime.pause();
      if (runtime.loadedPE) {
        runtime.loadedPE.imports = runtime.linker.resolveImports(runtime.loadedPE.info);
        updateModules(runtime.linker.loadedModules());
      }
      toast(force ? 'Rasterizador CPU ativo.' : 'WebGL solicitado; fallback automático continua ativo.', 'warning');
    } catch (error) { toast(error.message, 'error'); }
  });

  $('benchmark-button').addEventListener('click', async () => {
    try {
      benchmarkStarted = performance.now();
      benchmarkDuration = 5000;
      $('benchmark-overlay').hidden = false;
      $('benchmark-progress').style.width = '0%';
      $('benchmark-status').textContent = 'RUNNING';
      $('benchmark-status').className = 'test-status running';
      $('benchmark-detail').textContent = 'Contando Present() concluídos…';
      $('benchmark-button').textContent = 'Medindo…';
      $('benchmark-button').disabled = true;
      benchmarkTimer = setInterval(updateBenchmarkProgress, 100);
      const result = await runtime.runBenchmark(5000);
      $('benchmark-status').textContent = result.frames > 0 && result.pixelValidated ? 'PASS' : 'FAIL';
      $('benchmark-status').className = 'test-status';
      $('benchmark-detail').textContent = `${result.fps.toFixed(2)} FPS · ${result.frames} frames · ${(result.durationMs / 1000).toFixed(3)} s`;
      toast(`Benchmark integrado: ${result.fps.toFixed(2)} FPS.`, 'success');
    } catch (error) {
      $('benchmark-status').textContent = 'CANCELLED';
      $('benchmark-status').className = 'test-status warning';
      $('benchmark-detail').textContent = error.message;
    } finally { finishBenchmarkUI(); }
  });

  $('load-pe').addEventListener('click', async () => {
    const button = $('load-pe');
    button.disabled = true;
    button.textContent = 'Lendo PE…';
    $('pe-error').hidden = true;
    try {
      const loaded = await runtime.loadExecutable($('exe-path').value);
      renderPE(loaded);
      toast(`${loaded.name}: PE inspecionado; entry point não executado.`, 'warning');
    } catch (error) {
      $('pe-result').hidden = true;
      $('pe-error').textContent = error.message;
      $('pe-error').hidden = false;
      toast(`Falha ao carregar PE: ${error.message}`, 'error');
    } finally {
      button.textContent = 'Inspecionar PE';
      button.disabled = !vfs.isMapped || ['guest-loading', 'guest-loaded', 'guest-running', 'guest-blocked'].includes(runtime.state);
    }
  });

  $('execute-pe').addEventListener('click', async () => {
    const button = $('execute-pe');
    button.disabled = true;
    button.textContent = 'Preparando…';
    $('pe-error').hidden = true;
    try {
      const process = await runtime.executeExecutable($('exe-path').value);
      button.textContent = 'Executar x86';
      toast(`${runtime.loadedPE.name}: backend x86 iniciado; aguarde evidências do processo.`, 'success');
      process.done.then((result) => {
        if (result.status === 'exited') toast(`${result.name}: exit ${result.exitCode} · ${result.instructions} instruções.`, 'success');
        else if (result.status === 'error') toast(`${result.name}: ${result.error || 'erro no convidado'}`, 'error');
      });
    } catch (error) {
      button.textContent = 'Executar x86';
      $('pe-error').textContent = error.message;
      $('pe-error').hidden = false;
      toast(`Falha ao executar PE: ${error.message}`, 'error');
    } finally {
      button.disabled = !vfs.isMapped || ['guest-loading', 'guest-loaded', 'guest-running', 'guest-blocked'].includes(runtime.state);
    }
  });

  $('stop-pe').addEventListener('click', async () => {
    $('stop-pe').disabled = true;
    try {
      const result = await runtime.stopGuest('Interrompido pelo usuário na interface.');
      if (result) toast(`${result.name}: ${result.status}.`, 'warning');
    } catch (error) { toast(`Falha ao parar convidado: ${error.message}`, 'error'); }
    finally { $('stop-pe').disabled = false; }
  });

  async function runFixture(name) {
    const expected = name === 'hello.exe' ? 'Hello, world!\n' : 'callback0 invoked: 1234\nretrowin32_callback1 returned: 1\n';
    $('run-hello').disabled = true;
    $('run-callback').disabled = true;
    $('retro-status').textContent = 'RUNNING';
    $('retro-status').className = 'test-status running';
    $('retro-detail').textContent = `${name}: carregando PE32 x86 real…`;
    try {
      const process = await runtime.runBundledFixture(name);
      const result = await process.done;
      const pass = result.status === 'exited' && result.exitCode === 0 && result.stdout === expected && result.instructions > 0;
      $('retro-status').textContent = pass ? 'PASS' : 'FAIL';
      $('retro-status').className = `test-status${pass ? '' : ' warning'}`;
      $('retro-detail').textContent = `${name}: ${result.instructions} instruções · exit ${result.exitCode} · stdout verificado: ${pass ? 'sim' : 'não'}`;
      toast(pass ? `${name}: execução real validada.` : `${name}: resultado inesperado; inspecione o log.`, pass ? 'success' : 'warning');
    } catch (error) {
      $('retro-status').textContent = 'ERROR';
      $('retro-status').className = 'test-status warning';
      $('retro-detail').textContent = `${name}: ${error.message}`;
      toast(`Fixture falhou: ${error.message}`, 'error');
    } finally {
      updateState(runtime.state);
    }
  }

  $('run-hello').addEventListener('click', () => runFixture('hello.exe'));
  $('run-callback').addEventListener('click', () => runFixture('callback.exe'));

  $('capture-button').addEventListener('click', async () => {
    const button = $('capture-button');
    button.disabled = true;
    button.textContent = 'Capturando…';
    try {
      const result = await runtime.captureState($('app'));
      $('capture-panel').hidden = false;
      $('framebuffer-capture').src = result.framebuffer;
      $('ui-capture').hidden = !result.ui;
      $('ui-capture-error').hidden = !result.uiError;
      $('ui-capture-error').textContent = result.uiError || '';
      if (result.ui) $('ui-capture').src = result.ui;
      else $('ui-capture').removeAttribute('src');
      $('capture-time').textContent = formatTime(result.capturedAt);
      $('capture-metadata').textContent = JSON.stringify(result.metadata, null, 2);
      $('capture-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      toast(result.ui ? 'Framebuffer e UI capturados.' : 'Framebuffer capturado; UI indisponível.', result.ui ? 'success' : 'warning');
    } catch (error) { toast(`Captura falhou: ${error.message}`, 'error'); }
    finally { button.disabled = false; button.textContent = 'Capturar'; }
  });

  $('clear-logs').addEventListener('click', () => { tracer.clear(); renderLogs(); });
  $('render-canvas').addEventListener('click', () => $('render-canvas').focus({ preventScroll: true }));

  runtime.on('state', updateState);
  runtime.on('renderer', updateRenderer);
  runtime.on('modules', updateModules);
  runtime.on('stats', (stats) => {
    $('fps-counter').innerHTML = `${stats.fps.toFixed(1)} <small>FPS</small>`;
    $('draw-counter').textContent = `${stats.drawCalls.toLocaleString('pt-BR')} DRAWS`;
    $('resolution-counter').textContent = `${stats.width} × ${stats.height}`;
  });
  runtime.on('pipeline', () => {
    $('pipeline-status').innerHTML = '<i class="status-dot"></i> LoadLibrary → D3D9 SHIM → GTL → Canvas · validado';
  });
  runtime.on('pe', renderPE);
  runtime.on('guestoutput', ({ output }) => {
    $('guest-output').textContent = output || '';
    $('guest-output').hidden = !output;
    $('guest-output').scrollTop = $('guest-output').scrollHeight;
  });
  runtime.on('gueststats', (stats) => {
    if (!stats) return;
    $('status-runtime-detail').textContent = `retrowin32 · ${stats.instructions.toLocaleString('pt-BR')} instruções${stats.exitCode == null ? '' : ` · exit ${stats.exitCode}`}`;
    if (stats.windows > 0 && runtime.guestCanvas && !runtime.guestCanvas.hidden) {
      $('resolution-counter').textContent = `${runtime.guestCanvas.width} × ${runtime.guestCanvas.height}`;
    }
  });
  runtime.on('guestsurface', ({ visible }) => {
    if (visible) {
      $('canvas-idle').hidden = true;
      $('frame-origin').textContent = 'RETROWIN32 GUEST SURFACE';
    }
  });
  runtime.on('guesterror', ({ error }) => {
    tracer.log('retrowin32-host', error.message, 'error');
  });
  runtime.on('benchmarkstart', () => { $('benchmark-overlay').hidden = false; });
  runtime.on('benchmark', finishBenchmarkUI);
  runtime.on('resize', ({ width, height }) => {
    const guestVisible = runtime.guestCanvas && !runtime.guestCanvas.hidden && runtime.guestStats && runtime.guestStats.windows > 0;
    $('resolution-counter').textContent = guestVisible ? `${runtime.guestCanvas.width} × ${runtime.guestCanvas.height}` : `${width} × ${height}`;
  });

  // Detected platform/capabilities são exibidos antes de qualquer operação.
  $('platform-badge').textContent = `${platform.label} · ${platform.browser}`;
  $('status-platform').textContent = platform.label;
  $('status-browser').textContent = `${platform.browser} · ${platform.capabilities.secureContext ? 'secure context' : 'contexto não seguro'}`;
  $('host-path').textContent = platform.hostPath;
  if (!native) {
    $('map-directory').textContent = 'Selecionar pasta (fallback)';
    $('status-vfs-detail').textContent = 'Input directory + overlay em memória';
  }
  updateVFS(vfs.getInfo());
  updateState('idle');
  renderLogs();
  scheduleResize();

  if (global.ResizeObserver) new global.ResizeObserver(scheduleResize).observe($('canvas-shell'));
  global.addEventListener('resize', scheduleResize);
  global.addEventListener('beforeunload', () => runtime.stop());

  tracer.log('runtime', `Plataforma detectada: ${platform.label} / ${platform.browser}.`, 'info');
  tracer.log('vfs', native ? 'File System Access API disponível; aguardando gesto do usuário.' : 'File System Access API indisponível; fallback webkitdirectory ativo.', native ? 'success' : 'warning');

  // API pública para testes E2E e integrações; nenhum resultado é pré-fabricado.
  Porthole.runtime = runtime;
  Porthole.vfs = vfs;
  Porthole.tracer = tracer;
  Porthole.app = { resizeCanvas, renderLogs, updateVFS, toast };
  global.dispatchEvent(new CustomEvent('porthole-ready'));
})(typeof window !== 'undefined' ? window : globalThis);
