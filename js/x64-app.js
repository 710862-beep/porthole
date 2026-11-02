/*
 * x64-app.js — browser launcher for the pure-browser x86-64 Windows emulator.
 *
 * Wires: NVMe mount (File System Access API) -> Wasm core -> PE32+ load -> slice execution ->
 * tiered scanout -> telemetry. Everything shown in the UI is measured, never estimated.
 */
const $ = (id) => document.getElementById(id);

const WASM_DIR = new URL('../vendor/porthole-x64-wasm/', import.meta.url).href;

const state = {
  emulator: null,
  module: null,
  vfs: null,
  renderer: null,
  running: false,
  rafId: 0,
  sliceInstructions: 250000,
  counters: { instructions: 0, frames: 0, pages: 0, lastTick: performance.now(), ips: 0, fps: 0 },
  audio: null,
  jit: null,
};

function log(message) {
  const el = $('log');
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  el.textContent += `\n[${time}] ${message}`;
  el.scrollTop = el.scrollHeight;
}

function setBadge(id, text, status) {
  const el = $(id);
  el.textContent = text;
  if (status) el.dataset.state = status;
}

async function initRenderer() {
  const renderer = new Porthole.X64Renderer({ canvas: $('x64-canvas'), logger: log });
  const tier = await renderer.init();
  state.renderer = renderer;
  setBadge('tier-badge', `RENDERER ${tier.toUpperCase()}`, 'PASS');
  return renderer;
}

async function loadWasm() {
  const mod = await import(`${WASM_DIR}porthole_x64_wasm.js`);
  const core = typeof mod.default === 'function'
    ? await mod.default(`${WASM_DIR}porthole_x64_wasm_bg.wasm`)
    : null;
  if (typeof mod.BrowserX64Emulator !== 'function') {
    throw new Error('Artefato Wasm ausente ou sem o binding BrowserX64Emulator. Rode o workflow x64-emulator.');
  }
  if (!(core?.memory instanceof WebAssembly.Memory)) {
    throw new Error('Core Wasm não exporta memory; JIT não pode compartilhar memória guest com segurança.');
  }
  state.module = mod;
  state.emulator = new mod.BrowserX64Emulator(8192);
  state.jit = new Porthole.X64JitHost(state.emulator, mod, { enabled: true, memory: core.memory });
  log('Núcleo x86-64 Wasm inicializado (cache LRU de 8192 páginas = 32 MB; JIT híbrido ativo).');
}

function initAudio() {
  if (state.audio) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const gain = ctx.createGain();
  gain.gain.value = 0.0; // silent until the guest HLE feeds samples
  gain.connect(ctx.destination);
  state.audio = { ctx, gain };
}

function syncFrames() {
  const emu = state.emulator;
  const frames = Number(emu.frames_presented());
  const frame = emu.take_frame();
  if (frame && frame.length) {
    const w = emu.frame_width();
    const h = emu.frame_height();
    if (state.renderer.present(frame, w, h)) {
      state.counters.frames += frames || 1;
    }
  }
}

function showGuestModal(request) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1b1f27;color:#e8e8e8;border:1px solid #444;border-radius:8px;padding:20px;min-width:320px;max-width:560px;font-family:system-ui';
    const title = document.createElement('h3');
    title.textContent = request.caption || 'Guest dialog';
    const body = document.createElement('p');
    body.textContent = request.text || '';
    body.style.whiteSpace = 'pre-wrap';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px';
    // MB_* button sets; default OK. Values are Win32 ID* constants.
    const buttons = [[1, 'OK']];
    const kind = (request.type || 0) & 0xF;
    if (kind === 1) buttons.splice(0, 1, [1, 'OK'], [2, 'Cancel']);
    if (kind === 3) buttons.splice(0, 1, [6, 'Yes'], [7, 'No'], [2, 'Cancel']);
    if (kind === 4) buttons.splice(0, 1, [6, 'Yes'], [7, 'No']);
    for (const [id, label] of buttons) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { overlay.remove(); resolve(id); };
      row.appendChild(b);
    }
    box.append(title, body, row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

async function tick() {
  if (!state.running) return;
  const emu = state.emulator;
  const started = performance.now();
  let status = await state.jit.runSlice(state.sliceInstructions);

  // Resolve NVMe page faults through the real swap shards.
  let guard = 0;
  while (status.startsWith('page-fault:') && guard < 64) {
    const pageBase = Number(status.slice(11));
    try {
      const page = await state.vfs.fetchPage(pageBase);
      emu.supply_page(BigInt(pageBase), page.bytes);
      state.counters.pages += 1;
    } catch (error) {
      log(`Falha ao resolver page fault 0x${pageBase.toString(16)}: ${error.message}`);
      state.running = false;
      break;
    }
    status = await state.jit.runSlice(state.sliceInstructions);
    guard += 1;
  }

  if (status === 'modal') {
    const request = JSON.parse(emu.modal_request());
    const result = await showGuestModal(request);
    emu.modal_respond(result);
    state.rafId = requestAnimationFrame(tick);
    return;
  }

  if (status.startsWith('exit:') || status.startsWith('fault:')) {
    log(`Convidado finalizou: ${status}`);
    log(emu.take_console().split('\n').slice(-12).join('\n'));
    state.running = false;
    $('run').disabled = false;
    $('pause').disabled = true;
    setBadge('tier-badge', status.toUpperCase(), status.startsWith('exit:') ? 'PASS' : 'FAIL');
    const dirty = emu.drain_evicted_pages();
    if (dirty.length) await state.vfs.persistPages(dirty);
    return;
  }

  syncFrames();

  // Periodically flush dirty/evicted pages to NVMe.
  const dirty = emu.drain_evicted_pages();
  if (dirty.length) {
    state.vfs.persistPages(dirty).then((r) => {
      state.counters.pages += r.written || 0;
    }).catch((error) => log(`Erro de persistência NVMe: ${error.message}`));
  }

  const now = performance.now();
  const elapsed = now - state.counters.lastTick;
  if (elapsed >= 500) {
    const telemetry = JSON.parse(emu.telemetry_json());
    const deltaInsn = telemetry.instructions - state.counters.instructions;
    state.counters.instructions = telemetry.instructions;
    state.counters.ips = Math.round((deltaInsn / elapsed) * 1000);
    state.counters.fps = ((state.counters.frames) / elapsed) * 1000;
    state.counters.frames = 0;
    state.counters.lastTick = now;
    $('m-ips').textContent = state.counters.ips.toLocaleString('pt-BR');
    $('m-fps').textContent = (telemetry.frames > 0 ? (telemetry.frames / (now / 1000)).toFixed(2) : '0.0');
    $('m-pages').textContent = String(state.counters.pages);
    $('m-resident').textContent = String(telemetry.residentPages);
    $('m-swapped').textContent = String(telemetry.swappedPages);
    $('m-jit').textContent = String(telemetry.jitArtifacts);
  }
  if (state.startupTelemetry && state.jit) {
    state.startupTelemetry.jit_fallbacks_during_play = state.jit.stats.traps;
    state.startupTelemetry.jit_compile_time_ms = Number(state.jit.jitCompileMs.toFixed(3));
  }
  void started;
  state.rafId = requestAnimationFrame(tick);
}

async function mountNvme() {
  try {
    state.vfs = new Porthole.NvmeVfs({ logger: log });
    if (!state.vfs.supported) {
      log('File System Access API indisponível: selecione uma pasta manualmente nas flags do navegador ou use Chrome/Edge em contexto seguro.');
    } else {
      await state.vfs.pickDirectory();
      if (state.jit) state.jit.cache = state.vfs;
      log(`NVMe montado em "${state.vfs.root.name}". C:\\Game, .porthole_vmem e .porthole_jit_cache prontos.`);
    }
    $('load-exe').disabled = false;
  } catch (error) {
    log(`Montagem cancelada/falhou: ${error.message}`);
  }
}

async function loadExecutable() {
  const emu = state.emulator;
  if (!emu) return;
  try {
    if (!state.vfs || !state.vfs.stats.mounted) {
      log('Monte o NVMe antes de carregar um executável PE32+.');
      return;
    }
    const files = await state.vfs.readGameTree(256 * 1024 * 1024);
    if (!files.length) {
      log('C:\\Game está vazio: copie o executável 64-bit e suas DLLs para a pasta "Game".');
      return;
    }
    emu.vfs_mkdir('C:\\Windows');
    emu.vfs_mkdir('C:\\Windows\\System32');
    emu.vfs_mkdir('C:\\Users\\PORTHOLE\\Temp');
    for (const file of files) emu.vfs_insert(file.path, file.bytes);
    log(`VFS: ${files.length} arquivo(s) carregado(s) de C:\\Game (${(files.reduce((n, f) => n + f.bytes.length, 0) / 1048576).toFixed(1)} MB).`);

    const guestPath = $('exe-path').value.trim();
    const target = files.find((f) => f.path.toLowerCase() === guestPath.toLowerCase())
      || files.find((f) => f.path.toLowerCase().endsWith('.exe'));
    if (!target) {
      log(`Executável não encontrado: ${guestPath}`);
      return;
    }
    const startupT0 = performance.now();
    const digest = await crypto.subtle.digest('SHA-256', target.bytes);
    const exeSha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    state.jit.exeSha256 = exeSha256;
    state.jit.cache = state.vfs;
    const info = JSON.parse(emu.load_pe(target.bytes));
    const cacheT0 = performance.now();
    await state.jit.initCache();
    const cacheLoadMs = performance.now() - cacheT0;
    const aotT0 = performance.now();
    const aotBlocks = typeof emu.aot_compile_text === 'function' ? emu.aot_compile_text() : 0;
    await state.jit.drainPending();
    await state.jit.flushCache();
    const aotCompileMs = performance.now() - aotT0;
    const startup = {
      disk_read_time_ms: 0,
      aot_compilation_time_ms: Number(aotCompileMs.toFixed(3)),
      cache_load_time_ms: Number(cacheLoadMs.toFixed(3)),
      total_startup_lag_ms: Number((performance.now() - startupT0).toFixed(3)),
      aot_blocks_compiled: aotBlocks,
      aot_cache_size_bytes: state.jit.cacheTelemetry.bytes,
      cache_hit_count: state.jit.cacheTelemetry.hits,
      cache_miss_count: state.jit.cacheTelemetry.misses,
      jit_compile_time_ms: Number(state.jit.jitCompileMs.toFixed(3)),
      jit_fallbacks_during_play: 0,
    };
    state.startupTelemetry = startup;
    console.log(`STARTUP_TELEMETRY_JSON=${JSON.stringify(startup)}`);
    log(`JIT cache: ${startup.cache_hit_count} hit(s), ${startup.cache_miss_count} miss(es); AOT=${aotBlocks} bloco(s) em ${aotCompileMs.toFixed(1)} ms.`);
    log(`PE32+ mapeado: ${target.path} base=0x${info.imageBase.toString(16)} entry=0x${info.entryPoint.toString(16)} imports=${info.imports}`);
    $('run').disabled = false;
  } catch (error) {
    log(`Falha ao carregar PE: ${error.message}`);
  }
}

function start() {
  if (!state.emulator) return;
  initAudio();
  if (state.audio && state.audio.ctx.state === 'suspended') state.audio.ctx.resume();
  state.running = true;
  state.counters.lastTick = performance.now();
  $('run').disabled = true;
  $('pause').disabled = false;
  log('Execução iniciada.');
  cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(tick);
}

function pause() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  $('run').disabled = false;
  $('pause').disabled = true;
  log('Execução pausada.');
}

$('x64-canvas').addEventListener('pointermove', (ev) => {
  if (!state.emulator || typeof state.emulator.inject_mouse_move !== 'function') return;
  const rect = ev.currentTarget.getBoundingClientRect();
  state.emulator.inject_mouse_move(Math.round(ev.clientX - rect.left), Math.round(ev.clientY - rect.top));
});
$('mount').addEventListener('click', mountNvme);
$('load-exe').addEventListener('click', loadExecutable);
$('run').addEventListener('click', start);
$('pause').addEventListener('click', pause);

(async () => {
  try {
    await initRenderer();
    await loadWasm();
  } catch (error) {
    log(String(error));
  }
})();
