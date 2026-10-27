# plan.md — Arquitetura e Plano de Execução do WebOS "Porthole"

> Versão 1.0 · 2026-10-27 · Branch `arena/9fed36fc-porthole`
> Regra: este documento é vivo. Toda mudança de estratégia entra no log do fim.

---

## 1. Visão geral

WebOS que imita o Windows 10 no navegador. Uma única página (`index.html`)
monta desktop, ícones, taskbar e menu Iniciar. Um **Window Manager** em
Vanilla JS cria janelas arrastáveis/redimensionáveis. Uma dessas janelas hospeda
um `<canvas>` onde um módulo **WebAssembly roda DOOM**, com o WAD carregado via
`fetch` → `ArrayBuffer` → cópia para a memória linear do Wasm. Um app de
diagnóstico executa benchmarks e captura a UI como imagem Base64.

```
┌──────────────────────────────────────────────────────────────────────┐
│                            index.html (DOM)                          │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐  │
│  │ window-manager.js            │  │ apps (Notepad, About, Diag.) │  │
│  │  Window {drag,resize,z,min,  │  │           │                  │  │
│  │          max,close,focus}    │  │           ▼                  │  │
│  └──────────────┬───────────────┘  │  diagnostics.js              │  │
│                 │ abre app         │  (5 testes + html2canvas)    │  │
│                 ▼                  └──────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Janela "DOOM"                                                │    │
│  │  Device Status (gpu.js: WebGL? SwiftShader? LLVMpipe sim.)   │    │
│  │  ┌────────────────────────────────────────────────────────┐  │    │
│  │  │ <canvas>  ◀── putImageData ◀── framebuffer BGRA (Wasm)  │  │    │
│  │  └────────────────────────────────────────────────────────┘  │    │
│  │  doom-runtime.js (host ABI: 10 imports / 4 exports)          │    │
│  └──────────────┬───────────────────────────┬───────────────────┘    │
│                 ▼                           ▼                        │
│      vendor/doom/doom.wasm          vendor/doom/DOOM1.WAD            │
│      (motor pré-compilado)          (fetch → ArrayBuffer → memória) │
└──────────────────────────────────────────────────────────────────────┘
```

## 2. Mapeamento das fases × arquivos

| Fase | Entrega | Arquivos |
|---|---|---|
| 0 | Documentação do agente e plano | `agents.md`, `plan.md` |
| 1 | Desktop Win10, taskbar, menu Iniciar, ícones, Window Manager | `index.html`, `styles.css`, `js/webos.js`, `js/window-manager.js`, `assets/wallpaper.jpg` |
| 2 | Runtime Wasm, injeção de WAD, ponte de input, GPU/CPU fallback | `js/doom-runtime.js`, `js/gpu.js`, `vendor/doom/*` |
| 3 | Diagnósticos, benchmarks, captura E2E | `js/diagnostics.js`, `vendor/html2canvas/*` |
| 4 | Organização, comentários, testes Node, README | `tests/node/*`, `README.md`, `vendor/doom/ATTRIBUTION.md` |

## 3. Contratos técnicos

### 3.1 ABI do módulo `doom.wasm` (release v0.1.0, jacobenget)

**Imports que o host JS precisa implementar:**

| Módulo.função | Assinatura | Responsabilidade do host |
|---|---|---|
| `loading.onGameInit` | `(i32 w, i32 h)` | Dimensionar canvas e alocar `ImageData` |
| `loading.wadSizes` | `(i32 ptrN, i32 ptrTotal)` | Escrever 2 × `i32` LE: nº de WADs e bytes totais. `0` = usar WAD shareware embutido |
| `loading.readWads` | `(i32 dstPtr, i32 sizesPtr)` | Copiar bytes de todos os WADs (fim-a-fim) e um `i32` LE com o tamanho de cada um |
| `ui.drawFrame` | `(i32 fbPtr)` | Ler framebuffer BGRA da memória Wasm, converter para RGBA e `putImageData` |
| `runtimeControl.timeInMilliseconds` | `() -> i64` | `BigInt(performance.now())` |
| `console.onInfoMessage` / `onErrorMessage` | `(i32 ptr, i32 len)` | Ler UTF-8 da memória e logar no painel do jogo |
| `gameSaving.sizeOfSaveGame/readSaveGame/writeSaveGame` | vários | Stubs retornando `0` (savegame desabilitado) |

**Exports consumidos:** `initGame()`, `reportKeyDown(i32)`, `reportKeyUp(i32)`,
`tickGame()`, `memory`, e os globais `KEY_*` (ENTER, ESCAPE, FIRE, USE,
SHIFT, ALT, TAB, BACKSPACE, setas, strafe L/R).

**Loop:** `tickGame()` a 35 Hz (temporizador com acumulador dentro de
`requestAnimationFrame`). Quando a janela do WebOS perde foco, o host para de
invocar `tickGame` e deixa de encaminhar eventos — o jogo congela de fato.

### 3.2 Protocolo de injeção do WAD (requisito Fase 2)

1. `fetch('vendor/doom/DOOM1.WAD')` → validar `response.ok` (200) e magic
   `"IWAD"` nos 4 primeiros bytes → guardar `ArrayBuffer`.
2. No import `wadSizes`: escrever `[1, wad.byteLength]` em LE na memória do Wasm.
3. No import `readWads`: `new Uint8Array(memory.buffer).set(wadBytes, dstPtr)`
   e escrever `wad.byteLength` em `sizesPtr`.
4. Se o fetch falhar: escrever `[0, 0]` → o módulo usa o shareware embutido.
   O fallback é silencioso para o jogador e barulhento no log de diagnóstico.

### 3.3 Window Manager (`window-manager.js`)

API pública:
```js
WebOS.windows.create({ id, title, icon, width, height, mount(win), onClose, onFocus, onBlur })
           // retorna controller: {el, focus, minimize, toggleMaximize, close, setTitle}
```
- Pointer Events (mouse + touch) com `setPointerCapture` no titlebar e nos 8
  handles de resize (N, S, E, W, NE, NW, SE, SW).
- `z-index` por contador monotônico; foco destaca a janela e o botão da taskbar.
- Minimizar oculta e mantém estado; maximizar guarda o retângulo anterior.
- Taskbar sincroniza (botão por janela, clique alterna restaurar/minimizar).
- Ícones do desktop: duplo clique abre; se o app já está aberto, só foca.

### 3.4 Detecção GPU/software (`gpu.js`)

- Probe `webgl2` → `webgl` em canvas temporário; ler
  `UNMASKED_VENDOR_WEBGL` e `UNMASKED_RENDERER_WEBGL` via
  `WEBGL_debug_renderer_info`.
- Classificação por regex no renderer: `swiftshader|llvmpipe|software|basic
  render|lavapipe` → software; ausência total de WebGL → modo software.
- Teste de shader mínimo (compila+liga um triângulo) para confirmar contexto vivo.
- Resultado exposto em `WebOS.gpu.detect(forceSoftware?)` e exibido como
  "Device Status" na janela do DOOM e no Diagnostics.
- O DOOM usa rasterização CPU (framebuffer Wasm → Canvas 2D) em qualquer
  cenário; por isso ele **sempre tem fallback**, igual ao LLVMpipe do Mesa.

### 3.5 Suíte de diagnóstico (`diagnostics.js`)

| # | Teste | Critério de Pass | Métrica |
|---|---|---|---|
| a | Instanciação Wasm | montar módulo Wasm artesanal (bytes inline) e `add(2,3)=5` | ms |
| b | Contextos Canvas na janela | `2d` funciona (obrigatório); WebGL reportado mesmo que indisponível | ms + strings de renderer |
| c | Download do `.wad` | status 200, magic `IWAD`, tamanho > 1 MB | ms + bytes |
| d | Benchmark "estilo Windows" | 100k ops matemáticas JS + 100k chamadas Wasm, completar dentro do limite | ms + ops/s |
| e | Benchmark DOOM (FPS) | rodar 5 s e obter FPS médio > 15 (travamento = Fail) | FPS médio/min/max |
| ⊕ | Capture UI State | `html2canvas` gera PNG Base64 da área de trabalho; fallback `toDataURL` do canvas | dimensões + método |

## 4. Estratégia de CORS e offline

- **Caminho feliz 100% same-origin:** `vendor/` contém tudo (wasm, wad,
  html2canvas, wallpaper). Nenhum recurso externo é necessário para funcionar.
- Fallbacks remotos (opcionais, só se o arquivo local sumir): jsDelivr
  (`https://cdn.jsdelivr.net/gh/...`, responde `access-control-allow-origin: *`)
  e `raw.githubusercontent.com` (também CORS `*`). Cada tentativa remota é
  envolta em `try/catch` e nunca quebra o caminho local.
- `WebAssembly.instantiate(arrayBuffer)` substitui `instantiateStreaming` para
  não depender de MIME `application/wasm` do servidor.

## 5. Plano de testes (sem navegador na sandbox)

1. `node --check js/*.js` — sintaxe de todos os scripts.
2. `tests/node/smoke-wasm.mjs`:
   - instancia `vendor/doom/doom.wasm` com stubs dos 10 imports;
   - cenário A: `wadSizes` zera tudo → WAD embutido;
   - cenário B: injeta o `DOOM1.WAD` real via `readWads`;
   - em ambos: `initGame()` + 105× `tickGame()` (≈3 s a 35 Hz) e assert de que
     `drawFrame` foi chamado e relatou dimensões não nulas.
3. `tests/node/inline-wasm-test.mjs` — valida os bytes do módulo Wasm artesanal
   usado no teste (a).
4. Servidor local (`python3 -m http.server 0.0.0.0:8000`) + `curl -I` em cada
   asset — provar 200 e tamanhos esperados.
5. Revisão manual do fluxo de foco/input e da ausência de dependências externas.

## 6. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| WAD remoto bloqueado pela rede do usuário | WAD vendoreado; fallback secundário usa WAD embutido no próprio `.wasm` |
| WebGL bloqueado/headless | Jogo é CPU/Canvas2D; status vira "Software Fallback (LLVMpipe sim)" |
| `html2canvas` não carregar | Fallback nativo `HTMLCanvasElement.toDataURL()` no canvas do DOOM |
| Servidor servir MIME errado | `instantiate(arrayBuffer)` em vez de streaming |
| Janela sem foco continuar recebendo teclado | Gate explícito: listeners checam `runtime.inputEnabled`; WM avisa no focus/blur |
| Memory growth do Wasm estourar | Módulo exporta memória com `max = ∞`; host mantém referência viva e recria views (`Uint8Array`) a cada callback |

## 7. Checklist de execução

- [x] Fase 0 — `agents.md` + `plan.md`
- [x] Fase 1 — markup Win10, CSS, WM, taskbar, ícones
- [x] Fase 2 — `gpu.js`, `doom-runtime.js`, assets vendoreados
- [x] Fase 3 — diagnósticos, benchmarks, captura E2E
- [x] Fase 4 — testes Node, smoke test do Wasm, README e revisão final

### Resultados medidos na sandbox (2026-10-27)

- `smoke-wasm.mjs`: WAD embutido e WAD injetado, 640×400, frames reais, 0 erros.
- `dom-integration.mjs` (jsdom + Wasm real): 21 verificações, diagnósticos
  5/5 PASS, benchmark DOOM entre 35 e 47 FPS.
- Todos os assets respondem HTTP 200 no servidor estático local.

## 8. Log de evolução do plano

- **2026-10-27 v1.0:** plano inicial. Motor definido após comparar:
  diekmann (sem WAD externo), cloudflare/strata (só fonte, exigem Docker),
  gabrielbotandev (Emscripten, 28 MB de Freedoom), jacobenget (ABI mínima com
  injeção de WAD — vencedor).
- **2026-10-27 v1.1 (execução):**
  - Release assets do GitHub redirecionam para host fora da allowlist de rede;
    solução: baixar o `.wasm` da branch `gh-pages` via Contents API (byte
    idêntico ao release, hash registrado no ATTRIBUTION).
  - Harness Node inicial travava com relógio congelado (busy-wait do DOOM):
    `timeInMilliseconds` passou a usar `performance.now()` monotônico real.
  - Bug real encontrado pelos testes: `openApp` copiava callbacks antes do
    `mount` defini-los; wrappers lazy (`app.onFocus?.(w)`) resolveram.
  - jsdom não tem layout/PointerEvent/TextDecoder: o harness de teste ganhou
    shims documentados; nenhum shim existe no código de produção.
