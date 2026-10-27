/* ==========================================================================
   gpu.js — Detecção de aceleração gráfica (WebGL) e classificação do
   pipeline de renderização.

   Estratégia:
   1. Tenta criar contexto WebGL2 e, em seguida, WebGL 1.
   2. Usa a extensão WEBGL_debug_renderer_info para descobrir vendor/renderer
      reais do driver (em muitos navegadores esse dado é mascarado; tratei
      ambos os casos).
   3. Classifica o renderer: hardware vs. software (SwiftShader, llvmpipe,
      lavapipe, "Basic Render" etc.).
   4. Compila um shader mínimo como teste de sanidade do pipeline GL.
   5. O DOOM, por construção do módulo Wasm, rasteriza por CPU (framebuffer
      na memória linear -> Canvas 2D putImageData). Por isso ele funciona
      mesmo quando a GPU está bloqueada: é o análogo navegador do LLVMpipe.
   ========================================================================== */
(function () {
  'use strict';

  const WebOS = (window.WebOS = window.WebOS || {});

  // Marcadores de rasterizadores 100% software presentes no nome do renderer.
  const SOFTWARE_MARKERS = [
    'swiftshader', 'llvmpipe', 'lavapipe', 'softpipe', 'software',
    'basic render', 'microsoft basic', 'virtualbox', 'virgl',
  ];

  function detect() {
    const result = {
      supported: false,          // existe algum contexto GL utilizável?
      version: null,             // 'webgl2' | 'webgl' | null
      vendor: 'desconhecido',
      renderer: 'desconhecido',
      shaderOk: false,
      // 'hardware' = GPU real; 'software' = rasterizador por CPU;
      // 'unavailable' = sem WebGL (queda total para Canvas 2D)
      mode: 'unavailable',
      error: null,
      probeAt: new Date().toISOString(),
    };

    const probe = document.createElement('canvas');
    probe.width = probe.height = 64;

    let gl = probe.getContext('webgl2');
    if (gl) {
      result.version = 'webgl2';
    } else {
      gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
      if (gl) result.version = 'webgl';
    }

    if (!gl) {
      result.error = 'Nenhum contexto WebGL disponível (bloqueado pela sandbox/política).';
      return result;
    }
    result.supported = true;

    // Leitura do driver real via extensão de debug (quando permitida)
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        result.vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || result.vendor);
        result.renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || result.renderer);
      } else {
        result.vendor = String(gl.getParameter(gl.VENDOR) || result.vendor);
        result.renderer = String(gl.getParameter(gl.RENDERER) || result.renderer);
      }
    } catch (err) {
      result.error = 'Falha ao ler WEBGL_debug_renderer_info: ' + err.message;
    }

    const haystack = `${result.vendor} ${result.renderer}`.toLowerCase();
    result.mode = SOFTWARE_MARKERS.some((m) => haystack.includes(m)) ? 'software' : 'hardware';

    // Teste de shader: compila e liga um programa mínimo (triângulo).
    // Se falhar, a GPU existe mas o pipeline não é confiável → software.
    try {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }');
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, 'precision mediump float; void main(){ gl_FragColor = vec4(1.0); }');
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      result.shaderOk = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
      if (!result.shaderOk) {
        result.mode = 'software';
        result.error = 'Link do shader de teste falhou; fallback de software recomendado.';
      }
    } catch (err) {
      result.shaderOk = false;
      result.mode = 'software';
      result.error = (result.error ? result.error + ' | ' : '') + err.message;
    }

    // Libera o contexto de teste
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return result;
  }

  // Status do pipeline do jogo. O DOOM sempre rasteriza por CPU; esta função
  // traduz o estado da GPU + a flag de simulação em um rótulo de Device Status.
  function pipelineStatus(gpu, forceSoftware) {
    if (forceSoftware || !gpu.supported || gpu.mode !== 'hardware') {
      return {
        pipeline: 'software',
        label: 'Software Fallback (LLVMpipe-style: Wasm CPU → Canvas 2D)',
        reason: !gpu.supported
          ? 'WebGL indisponível'
          : forceSoftware
            ? 'Bloqueio de GPU simulado pelo usuário'
            : 'Renderer de software detectado (' + gpu.renderer + ')',
      };
    }
    return {
      pipeline: 'software', // o jogo em si continua sendo CPU, mesmo com GPU boa
      label: 'Software Rasterizer (Wasm CPU → Canvas 2D)',
      reason: 'GPU do host disponível (' + gpu.renderer + '); o motor DOOM usa framebuffer CPU por design',
    };
  }

  WebOS.gpu = { detect, pipelineStatus, SOFTWARE_MARKERS };
})();
