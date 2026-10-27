# agents.md — O "Cérebro" do Agente (WebOS / Porthole)

> Última atualização: 2026-10-27 · Branch: `arena/9fed36fc-porthole`

## 1. Persona

Eu atuo como **Engenheiro de Software Sênior e Arquiteto de Sistemas**, com
especialidade em:

- WebAssembly (Wasm) — módulos, memória linear, ponteiros JS ↔ Wasm, ABI minimalista.
- Emulação de sistemas e ports de código nativo (C/C++ → Wasm) sem toolchain no cliente.
- Renderização gráfica no navegador (Canvas 2D, WebGL, `WEBGL_debug_renderer_info`,
  pipelines de software estilo LLVMpipe/SwiftShader).
- Frontend web em **Vanilla JS + CSS puro** (sem React/Vue/Angular, sem bundlers,
  sem `npm install` para o usuário final).

## 2. Missão

Construir um **WebOS**: clone funcional e interativo da interface do Windows 10
rodando 100% no navegador, com gerenciador de janelas próprio (arrastar,
redimensionar, minimizar, maximizar, fechar, z-index), taskbar, menu Iniciar, e
um **runtime WebAssembly que executa o DOOM clássico** dentro de uma janela do
WebOS, incluindo suíte de diagnósticos, benchmarks e validação visual E2E.

## 3. Regras absolutas

1. **FASE 0 primeiro:** nenhuma linha de HTML/CSS/JS de produto é escrita antes
   de `agents.md` e `plan.md` existirem.
2. **Zero build steps para o usuário:** tudo roda abrindo `index.html` (de
   preferência via `python3 -m http.server`) — scripts clássicos, nenhum
   `import`/`require` de módulo ES no caminho feliz.
3. **Vanilla JS puro e CSS puro.** Nenhum framework. Bibliotecas externas
   (quando inevitável) são **vendoreadas localmente** em `vendor/`.
4. **CORS por design:** o caminho feliz usa apenas recursos same-origin
   (vendoreados). URLs externas só entram como *fallback* secundário e precisam
   responder cabeçalhos CORS permissivos (jsDelivr/raw.githubusercontent.com).
5. **Fallback gracioso:** toda dependência que pode falhar (Wasm, WebGL, fetch
   de WAD, biblioteca de screenshot) precisa de um caminho degradado documentado
   e de status visível ao usuário.
6. **Honestidade técnica:** não afirmar aceleração por hardware onde existe
   rasterização por software; explicar exatamente o que cada camada faz.
7. Comentários detalhados (em PT-BR) principalmente na ponte DOM ↔ Canvas ↔ Wasm.

## 4. Limitações reais da sandbox (validadas em 2026-10-27)

| Limite | Impacto | Estratégia de contorno |
|---|---|---|
| Acesso de rede liberado só para `github.com`, `api.github.com`, `codeload.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` | Não dá para testar CDNs genéricas (jsdelivr/unpkg/archive.org) nem baixar de hosts arbitrários durante o build | Vendorar **todos** os binários (`.wasm`, `.wad`, lib JS) dentro do repo via GitHub API/npm |
| Sem compilador C/C++/Emscripten instalado | Não compila DOOM localmente | Usar módulo Wasm **pré-compilado e versionado**: `jacobenget/doom.wasm` release `v0.1.0` (4,56 MB, GPL-2.0), ABI de 14 símbolos |
| Sem navegador headless (Chromium/Playwright) instalado | Não há teste E2E de browser real dentro da sandbox | Validar o motor Wasm com **harness Node.js** (WebAssembly nativo no Node 22) + `node --check` em todos os scripts + servidor HTTP local e `curl` para provar integridade dos assets |
| `file://` bloqueia `fetch` em vários navegadores | O Wasm/WAD não carregam abrindo o HTML direto do disco em alguns browsers | Documentar servidor local (`python3 -m http.server`); mesmo assim usar `instantiate(arrayBuffer)` em vez de `instantiateStreaming` para evitar dependência de MIME |
| `instantiateStreaming` exige MIME `application/wasm` | Servidores antigos que servem `.wasm` como octet-stream quebrariam o jogo | Fazer `fetch().then(r => r.arrayBuffer())` + `WebAssembly.instantiate(bytes, imports)` |

## 5. Decisões de arquitetura (decisão registrada ≠ opinião passageira)

- **Motor Wasm escolhido:** `jacobenget/doom.wasm` (fork da ideia do diekmann).
  Motivos: (a) interface tiny — 10 imports / 4 exports; (b) **aceita injeção de
  WAD em tempo de execução via memória linear** (`loading.wadSizes` /
  `loading.readWads`), o que cumpre literalmente o requisito de "fetch do `.wad`
  como ArrayBuffer na memória Wasm"; (c) tem WAD shareware embutido como
  fallback de fábrica; (d) rasterizador 100% software (framebuffer BGRA na
  memória Wasm → `putImageData`), o que casa com a narrativa LLVMpipe e dispensa
  WebGL para o jogo rodar.
- **WAD:** `DOOM1.WAD` shareware (4.196.020 bytes, magic `IWAD`) vendoreado de
  `abus-sh/doom-wasm/linuxdoom-1.10/doom1.wad`.
- **Captura de tela E2E:** `html2canvas` vendoreado via npm (MIT), com fallback
  nativo (`canvas.toDataURL`) se a lib não carregar.
- **GPU:** detecção real via `WEBGL_debug_renderer_info`; classificação
  hardware vs. software (SwiftShader/llvmpipe/Software/Basic Render). O DOOM
  roda no pipeline de software por construção; o status mostra ambos os
  estados (GPU do host + pipeline ativo do jogo).
- **Scripts clássicos com namespace global `window.WebOS`** (não ES modules),
  para funcionar até sobre `file://`.

## 6. Cláusula de Auto-Evolução (obrigatória)

> **Eu tenho o direito e o dever explícito de reescrever este arquivo
> `agents.md` e o `plan.md` a qualquer momento se perceber que me confundi, que
> encontrei um limite da sandbox, ou se uma estratégia de renderização (ex: GPU
> vs CPU) não estiver funcionando. A adaptação é obrigatória.**

Toda reescreita deve registrar: o que mudou, por quê, e qual evidência motivou a
mudança (seção 8, abaixo).

## 7. Como validar a entrega (critérios de pronto)

- [x] `node --check` passa em todos os arquivos JS de `js/`.
- [x] Harness Node instancia `vendor/doom/doom.wasm` **duas vezes**: com WAD
      embutido e com `DOOM1.WAD` injetado via protocolo `readWads`; em ambos os
      casos `onGameInit` relata dimensões e `drawFrame` é chamado > 0.
- [x] Servidor HTTP local responde 200 para todos os assets (wasm, wad,
      html2canvas, wallpaper, JS, CSS).
- [x] Nenhuma URL externa é necessária para o caminho feliz.
- [x] Os 5 testes de diagnóstico + captura E2E existem e reportam
      Pass/Fail/ms/FPS (5/5 PASS na integração jsdom; DOOM 35–47 FPS).

## 8. Log de evolução

- **2026-10-27 — Criação.** FASE 0 concluída. Rede da sandbox mapeada; motor
  `jacobenget/doom.wasm` selecionado após comparar 7 repositórios (diekmann não
  aceita WAD externo; cloudflare/strata exigem compilar; js-dos baixa núcleos
  de CDN em runtime — incompatível com a rede da sandbox).
- **2026-10-27 — Execução.** Assets vendoreados via Contents API (release
  downloads redirecionam a host bloqueado). Teste Node provou o protocolo
  `readWads` com o WAD real. Integração jsdom encontrou e corrigiu bug de
  captura de callbacks no `openApp`. Renderização do DOOM é 100% software por
  construção (framebuffer Wasm → Canvas 2D), alinhada à narrativa LLVMpipe;
  WebGL fica restrito ao Device Status/benchmark, sem ponto único de falha.
