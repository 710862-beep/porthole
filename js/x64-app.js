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
  if (typeof mod.default === 'function') await mod.default(`${WASM_DIR}porthole_x64_wasm_bg.wasm`);
  if (typeof mod.BrowserX64Emulator !== 'function') {
    throw new Error('Artefato Wasm ausente ou sem o binding BrowserX64Emulator. Rode o workflow x64-emulator.');
  }
  state.module = mod;
  state.emulator = new mod.BrowserX64Emulator(2048);
  log('Núcleo x86-64 Wasm inicializado (cache LRU de 2048 páginas = 8 MB).');
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

async function tick() {
  if (!state.running) return;
  const emu = state.emulator;
  const started = performance.now();
  let status = emu.run_slice(state.sliceInstructions);

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
    status = emu.run_slice(state.sliceInstructions);
    guard += 1;
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

    // Restore persisted JIT blocks before loading the image.
    const cached = await state.vfs.loadJitModules(256);
    log(`JIT cache: ${cached.length} módulo(s) WebAssembly recuperado(s) do NVMe.`);

    const guestPath = $('exe-path').value.trim();
    const target = files.find((f) => f.path.toLowerCase() === guestPath.toLowerCase())
      || files.find((f) => f.path.toLowerCase().endsWith('.exe'));
    if (!target) {
      log(`Executável não encontrado: ${guestPath}`);
      return;
    }
    const info = JSON.parse(emu.load_pe(target.bytes));
    log(`PE32+ mapeado: ${target.path} base=0x${info.imageBase.toString(16)} entry=0x${info.entryPoint.toString(16)} imports=${info.imports} AOT=${info.aotBlocks}`);
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
