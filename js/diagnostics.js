/* ==========================================================================
   diagnostics.js — System Diagnostics & Benchmarks (Modo Desenvolvedor)

   Cinco testes com veredito Pass/Fail, métricas em ms/FPS/bytes, e a
   validação visual E2E ("Capture UI State") que gera um PNG Base64 da
   interface real do WebOS.

   (a) Instanciação de um módulo WebAssembly
   (b) Contextos Canvas 2D/WebGL dentro de uma janela do WebOS
   (c) Download do .wad (status 200, tamanho, magic IWAD)
   (d) Benchmark sintético de CPU ("estilo Windows"): JS + Wasm
   (e) Benchmark DOOM: FPS reais por 5 segundos
   ⊕  Captura de tela E2E com html2canvas (vendoreado) + fallback nativo
   ========================================================================== */
(function () {
  'use strict';

  const WebOS = (window.WebOS = window.WebOS || {});

  // Módulo Wasm mínimo artesanal (41 bytes): função exportada add(i32,i32)->i32.
  // Validado em tests/node/inline-wasm-test.mjs.
  const INLINE_WASM = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
  ]);

  const WAD_URL = 'vendor/doom/DOOM1.WAD';

  // Definição declarativa dos testes (a execução vem depois, em runTest)
  const TESTS = [
    { id: 'wasm',  name: 'a) Instanciação do módulo WebAssembly' },
    { id: 'ctx',   name: 'b) Contexto Canvas 2D / WebGL na janela' },
    { id: 'wad',   name: 'c) Download do DOOM1.WAD (fetch → ArrayBuffer)' },
    { id: 'cpu',   name: 'd) Benchmark de CPU — 100k ops JS + 100k Wasm' },
    { id: 'doom',  name: 'e) Benchmark DOOM — FPS real por 5 segundos' },
  ];

  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MiB';
    return (n / 1024).toFixed(1) + ' KiB';
  }

  WebOS.diagnostics = {
    mount(win) {
      const root = document.createElement('div');
      root.className = 'diag-root';
      root.innerHTML = `
        <h1>System Diagnostics &amp; Benchmarks</h1>
        <p class="subtitle">Modo Desenvolvedor · validação do runtime WebAssembly, gráficos,
           rede do WAD e desempenho real do motor DOOM.</p>
        <div class="diag-actions">
          <button id="diag-run-all">▶ Executar todos os testes</button>
          <button id="diag-capture" class="secondary">📷 Capture UI State (E2E)</button>
        </div>
        <table class="diag-table">
          <thead><tr><th style="width:34%">Teste</th><th style="width:15%">Status</th>
          <th style="width:20%">Métrica</th><th>Detalhe</th></tr></thead>
          <tbody>${TESTS.map((t) => `
            <tr data-test="${t.id}">
              <td>${t.name}</td>
              <td><span class="badge pending">pendente</span></td>
              <td class="diag-metric">—</td>
              <td class="diag-detail">Aguardando execução.</td>
            </tr>`).join('')}
          </tbody>
        </table>

        <div class="diag-capture">
          <h2>Validação visual E2E — Capture UI State</h2>
          <p class="diag-detail">Gera um PNG (Base64) da área de trabalho renderizada, simulando a
             evidência de um teste end-to-end de navegador real. Usa <b>html2canvas</b> vendoreado;
             se falhar, cai no <b>canvas.toDataURL()</b> nativo.</p>
          <div class="capture-frame" id="capture-frame" hidden>
            <img id="capture-img" alt="Captura da UI do WebOS" />
          </div>
          <p class="capture-meta" id="capture-meta">Nenhuma captura ainda.</p>
        </div>

        <div id="bench-host"></div>
      `;
      win.body.appendChild(root);

      const setRow = (id, status, metric, detail) => {
        const row = root.querySelector(`tr[data-test="${id}"]`);
        const badge = row.querySelector('.badge');
        badge.className = 'badge ' + status;
        badge.textContent = { pass: 'PASSOU', fail: 'FALHOU', running: 'executando', pending: 'pendente' }[status];
        row.querySelector('.diag-metric').textContent = metric;
        row.querySelector('.diag-detail').innerHTML = detail;
      };

      /* ----------------------------------------------------------------
       * Executores individuais
       * ---------------------------------------------------------------- */
      const runners = {
        // (a) WebAssembly: instanciar módulo artesanal e conferir add(2,3)=5
        async wasm() {
          const t0 = performance.now();
          const { instance } = await WebAssembly.instantiate(INLINE_WASM, {});
          const r1 = instance.exports.add(2, 3);
          const r2 = instance.exports.add(40, 2);
          const ms = performance.now() - t0;
          if (r1 !== 5 || r2 !== 42) throw new Error(`add() inesperado: ${r1}, ${r2}`);
          return {
            pass: true, metric: ms.toFixed(2) + ' ms',
            detail: `Módulo de 41 bytes instanciado; <code>add(2,3)=${r1}</code>,
                     <code>add(40,2)=${r2}</code>. Runtime Wasm do navegador operante.`,
          };
        },

        // (b) Canvas: 2D com readback de pixel + probe WebGL/debug_renderer
        async ctx() {
          const t0 = performance.now();
          const c = document.createElement('canvas');
          c.width = c.height = 64;
          const ctx2d = c.getContext('2d');
          if (!ctx2d) throw new Error('Canvas 2D indisponível');
          ctx2d.fillStyle = '#d02020';
          ctx2d.fillRect(0, 0, 64, 64);
          const px = ctx2d.getImageData(10, 10, 1, 1).data;
          const pixelOk = px[0] > 180 && px[1] < 60 && px[2] < 60;
          const gpu = WebOS.diagnostics._gpu || (WebOS.diagnostics._gpu = WebOS.gpu.detect());
          const ms = performance.now() - t0;
          if (!pixelOk) throw new Error('Readback do Canvas 2D não bateu com a cor desenhada');
          const glLine = gpu.supported
            ? `${gpu.version.toUpperCase()} · <b>${gpu.renderer}</b> (${gpu.vendor}) · shader: ${gpu.shaderOk ? 'ok' : 'falhou'}`
            : 'WebGL indisponível — pipeline 100% software';
          return {
            pass: true, metric: ms.toFixed(2) + ' ms',
            detail: `Canvas 2D: desenho + readback OK. WebGL: ${glLine}. Classificação: <b>${gpu.mode}</b>.`,
          };
        },

        // (c) WAD: fetch same-origin, status 200, tamanho e magic IWAD
        async wad() {
          const t0 = performance.now();
          const res = await fetch(WAD_URL);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const buf = await res.arrayBuffer();
          const ms = performance.now() - t0;
          const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
          if (magic !== 'IWAD') throw new Error('Magic inválido: ' + magic);
          if (buf.byteLength < 1_000_000) throw new Error('Tamanho suspeito: ' + buf.byteLength);
          return {
            pass: true,
            metric: `${ms.toFixed(0)} ms · ${fmtBytes(buf.byteLength)}`,
            detail: `GET <code>${WAD_URL}</code> → status <b>${res.status}</b>, ArrayBuffer de
                     ${buf.byteLength.toLocaleString('pt-BR')} bytes, magic <b>${magic}</b> ✓
                     (pronto para ser copiado à memória Wasm via <code>readWads</code>).`,
          };
        },

        // (d) CPU: 100k operações matemáticas em JS + 100k chamadas Wasm
        async cpu() {
          const t0 = performance.now();
          let acc = 0;
          for (let i = 0; i < 100_000; i++) {
            acc += Math.sin(i * 0.001) * Math.cos(i * 0.0007) + Math.sqrt(i + 1);
          }
          const { instance } = await WebAssembly.instantiate(INLINE_WASM, {});
          let sum = 0;
          for (let i = 0; i < 100_000; i++) sum = instance.exports.add(sum, i & 255);
          const ms = performance.now() - t0;
          const opsPerSec = Math.round(200_000 / (ms / 1000));
          if (!Number.isFinite(acc) || !Number.isFinite(sum)) throw new Error('Resultado não numérico');
          return {
            pass: ms < 10_000,
            metric: `${ms.toFixed(2)} ms · ${opsPerSec.toLocaleString('pt-BR')} ops/s`,
            detail: `100k ops trig/raiz em JS + 100k chamadas de função Wasm (ponte JS↔Wasm
                     exercitada). Soma final Wasm: <code>${sum}</code>. Limite: 10 s.`,
          };
        },

        // (e) DOOM: sobe um runtime real (WAD embutido p/ isolar rede), 5 s de FPS
        async doom(onLog) {
          const host = root.querySelector('#bench-host');
          host.innerHTML = `
            <p class="diag-detail" style="margin-top:12px">Motor DOOM alocado para o benchmark
               (canvas temporário, WAD embutido do .wasm):</p>`;
          const canvas = document.createElement('canvas');
          canvas.className = 'diag-bench-canvas';
          canvas.width = 320; canvas.height = 200;
          canvas.style.width = '320px'; canvas.style.height = '200px';
          host.appendChild(canvas);

          const samples = [];
          const runtime = new WebOS.DoomRuntime(canvas, {
            wadUrl: null, // isola o benchmark de rede: usa o WAD de fábrica
            onLog: (msg, level) => onLog && onLog(msg, level),
            onStatus: () => {},
            onFps: (fps) => samples.push(fps),
          });
          const t0 = performance.now();
          await runtime.init();
          const initMs = performance.now() - t0;

          return await new Promise((resolve) => {
            setTimeout(() => {
              runtime.stop();
              runtime.destroy();
              canvas.remove();
              const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
              const min = samples.length ? Math.min(...samples) : 0;
              const max = samples.length ? Math.max(...samples) : 0;
              resolve({
                pass: avg >= 15,
                metric: `avg ${avg.toFixed(1)} FPS`,
                detail: `5 s de execução · init em ${initMs.toFixed(0)} ms ·
                         amostras de 1 s: [${samples.join(', ')}] ·
                         min ${min} / max ${max} FPS. Meta: média ≥ 15 FPS.`,
              });
            }, 5000);
          });
        },
      };

      async function runTest(id) {
        setRow(id, 'running', '…', 'Em execução…');
        try {
          const r = await runners[id]();
          setRow(id, r.pass ? 'pass' : 'fail', r.metric, r.detail);
          return r.pass;
        } catch (err) {
          setRow(id, 'fail', 'erro', String(err.message || err));
          return false;
        }
      }

      root.querySelector('#diag-run-all').addEventListener('click', async (btn) => {
        btn.target.disabled = true;
        for (const t of TESTS) {
          await runTest(t.id);
        }
        btn.target.disabled = false;
        WebOS.toast && WebOS.toast('Suíte de diagnósticos concluída.');
      });

      /* ----------------------------------------------------------------
       * Captura visual E2E
       * ---------------------------------------------------------------- */
      root.querySelector('#diag-capture').addEventListener('click', async () => {
        const meta = root.querySelector('#capture-meta');
        const frame = root.querySelector('#capture-frame');
        const img = root.querySelector('#capture-img');
        meta.textContent = 'Capturando interface…';
        const t0 = performance.now();
        try {
          let dataUrl;
          let method;
          let width;
          let height;
          if (window.html2canvas) {
            // Tira um print da área de trabalho completa (ícones + janelas)
            const shot = await window.html2canvas(document.getElementById('desktop'), {
              backgroundColor: '#0b3b6b',
              logging: false,
              useCORS: true,
            });
            dataUrl = shot.toDataURL('image/png');
            method = 'html2canvas (vendoreado em vendor/html2canvas/)';
            width = shot.width; height = shot.height;
          } else {
            throw new Error('html2canvas ausente');
          }
          img.src = dataUrl;
          frame.hidden = false;
          const kb = (dataUrl.length * 0.75) / 1024; // Base64 ≈ 4/3 do binário
          meta.textContent = `✓ ${method} · ${width}×${height}px · ${kb.toFixed(1)} KiB em Base64 · ${(performance.now() - t0).toFixed(0)} ms`;
        } catch (err) {
          // Fallback nativo: usa o canvas do DOOM (se existir) ou um canvas sintético
          try {
            const gameCanvas = document.querySelector('.doom-canvas');
            let c;
            if (gameCanvas) {
              c = gameCanvas;
            } else {
              c = document.createElement('canvas');
              c.width = 320; c.height = 200;
              const g = c.getContext('2d');
              g.fillStyle = '#0b3b6b'; g.fillRect(0, 0, 320, 200);
              g.fillStyle = '#fff'; g.font = '16px sans-serif';
              g.fillText('Porthole WebOS — fallback nativo', 12, 100);
            }
            const dataUrl = c.toDataURL('image/png');
            img.src = dataUrl;
            frame.hidden = false;
            meta.textContent = `✓ Fallback nativo canvas.toDataURL() (html2canvas: ${err.message}) · ${c.width}×${c.height}px`;
          } catch (err2) {
            meta.textContent = '✗ Captura impossível: ' + err2.message;
          }
        }
      });
    },
  };
})();
