# Porthole WebOS

Um "sistema operacional" web que reproduz a interface do **Windows 10** no
navegador — desktop, taskbar, menu Iniciar e um gerenciador de janelas
completo em **Vanilla JS** — e que executa o **DOOM clássico compilado para
WebAssembly** dentro de uma janela arrastável, com o `DOOM1.WAD` baixado via
`fetch` e copiado para a memória linear do Wasm. Inclui suíte de
diagnósticos, benchmarks e validação visual E2E.

> Sem frameworks, sem bundlers, sem `npm install` para rodar o app.
> Todos os binários e bibliotecas estão vendoreados em `vendor/` — funciona
> **offline e same-origin**.

---

## Como executar

Qualquer servidor HTTP estático na raiz do projeto (o `fetch` de Wasm/WAD não
funciona de forma confiável via `file://`):

```bash
# opção 1 — Python (nada para instalar)
python3 -m http.server 8000
# abra http://localhost:8000

# opção 2 — npm script (apenas atalho, o app não depende de Node)
npm run serve
```

Duplo clique no ícone **DOOM** da área de trabalho (ou use o Menu Iniciar).
O primeiro carregamento busca ~9 MB de assets locais; depois disso tudo roda
no navegador.

---

## Mapa do projeto

```
porthole/
├── index.html               # Shell: boot, desktop, taskbar, menu Iniciar
├── styles.css               # Tema Windows 10 (janelas, taskbar, apps)
├── js/
│   ├── window-manager.js    # WM: drag, 8 alças de resize, z-index, min/max/close
│   ├── gpu.js               # Probe WebGL + WEBGL_debug_renderer_info, fallback SW
│   ├── doom-runtime.js      # Host da ABI Wasm (10 imports/4 exports), input, loop
│   ├── diagnostics.js       # 5 testes + benchmarks + captura E2E
│   └── webos.js             # Registro de apps, ícones, relógio, busca, energia
├── assets/
│   └── wallpaper.jpg        # Papel de parede em estilo Win10 (gerado)
├── vendor/
│   ├── doom/
│   │   ├── doom.wasm        # Motor DOOM (jacobenget/doom.wasm v0.1.0, GPL-2)
│   │   ├── DOOM1.WAD        # WAD shareware (magic IWAD, 4.196.020 bytes)
│   │   ├── ATTRIBUTION.md   # Procedência e licenças
│   │   └── LICENSE.jacobenget
│   └── html2canvas/         # html2canvas 1.4.1 (MIT) para a captura E2E
├── tests/node/
│   ├── smoke-wasm.mjs       # Motor real no Node: WAD embutido e WAD injetado
│   ├── inline-wasm-test.mjs# Valida o módulo Wasm artesanal do diagnóstico (a)
│   └── dom-integration.mjs  # Integração DOM completa com jsdom (21 verificações)
├── agents.md / plan.md      # Documentação viva do agente e da arquitetura
└── package.json             # Só devDeps de teste (jsdom); zero dependências de runtime
```

---

## Arquitetura

### 1. Window Manager (`js/window-manager.js`)

- API `WebOS.wm.create({ title, glyph, mount, onFocus, onBlur, onClose })`.
- Pointer Events com `setPointerCapture` (mouse e toque), 8 alças de resize
  (N/S/E/W + diagonais), arrasto pela titlebar com limites do desktop.
- `z-index` monotônico: focar sempre põe a janela no topo; janelas inativas
  perdem destaque e o botão correspondente da taskbar é atualizado.
- Minimizar preserva estado; maximizar guarda o retângulo anterior; duplo
  clique na titlebar alterna maximização.

### 2. Runtime WebAssembly (`js/doom-runtime.js`)

Motor [`jacobenget/doom.wasm`](https://github.com/jacobenget/doom.wasm),
escolhido pela ABI mínima (10 imports, 4 exports) e, principalmente, por
**aceitar injeção de WAD em memória** — o port clássico do diekmann não
aceita.

**Imports implementados pelo host:**

| Import | Papel |
|---|---|
| `loading.onGameInit(w,h)` | Dimensiona o canvas (640×400) e cria o `ImageData` |
| `loading.wadSizes(ptrN, ptrTotal)` | Escreve `1, tamanho` em i32-LE (ou `0,0` → WAD embutido) |
| `loading.readWads(dstPtr, sizesPtr)` | Copia o `ArrayBuffer` do WAD para a memória linear do Wasm |
| `ui.drawFrame(fbPtr)` | Converte BGRA→RGBA e `putImageData` no canvas |
| `runtimeControl.timeInMilliseconds()` | `BigInt(performance.now())`, monotônico |
| `console.onInfo/ErrorMessage` | Strings UTF-8 lidas da memória → console do jogo |
| `gameSaving.*` | Stubs (savegames desabilitados) |

**Exports consumidos:** `initGame`, `tickGame` (35 Hz via acumulador dentro de
`requestAnimationFrame`), `reportKeyDown/Up`, `memory` e os globais `KEY_*`.

**Ponte de input DOM → Wasm:** teclas nomeadas (setas, Enter, Esc, Ctrl,
Espaço…) e WASD mapeiam para os códigos DOOM; o mouse traduz clique
esquerdo→`KEY_FIRE` e direito→`KEY_USE`. A ABI mínima não expõe eixos de
mouse, então o movimento do cursor não gira a visão (limitação honesta da
interface de 14 símbolos). O jogo **só recebe entrada quando a janela do
WebOS está ativa**; perder o foco solta todas as teclas pressionadas.

### 3. WAD: fetch → ArrayBuffer → memória Wasm

1. `fetch('vendor/doom/DOOM1.WAD')` (same-origin) → valida HTTP 200, tamanho
   e magic `IWAD`.
2. `wadSizes` informa contagem e bytes; `readWads` faz
   `new Uint8Array(memory.buffer).set(wadBytes, dstPtr)`.
3. Se tudo falhar, `wadSizes` devolve `0/0` e o módulo usa o shareware
   embutido no próprio `.wasm` — fallback duplo.
4. `WebAssembly.instantiate(arrayBuffer)` (não `instantiateStreaming`) para
   não depender do MIME `application/wasm` do servidor.

### 4. GPU vs. software (`js/gpu.js`)

- Probe WebGL2/WebGL + extensão `WEBGL_debug_renderer_info`, com regex de
  rasterizadores software (SwiftShader, llvmpipe, lavapipe, Basic Render…).
- Um shader mínimo é compilado e linkado como teste de sanidade.
- O DOOM rasteriza **por CPU por design** (framebuffer na memória Wasm →
  Canvas 2D): é o análogo navegador do **LLVMpipe**, e funciona mesmo com a
  GPU totalmente bloqueada. O "Device Status" na janela mostra o estado real
  do host e inclui um botão **"Simular bloqueio de GPU"**.

### 5. Diagnostics & Benchmarks (`js/diagnostics.js`)

Acesso pelo Menu Iniciar → seção **Modo Desenvolvedor**.

| Teste | Verificação |
|---|---|
| a | Instancia módulo Wasm artesanal (41 bytes) e confere `add(2,3)=5` |
| b | Cria contextos Canvas 2D/WebGL dentro da janela, com readback de pixel |
| c | Download do WAD: status 200, tamanho e magic `IWAD` |
| d | 100k ops matemáticas JS + 100k chamadas Wasm (ms e ops/s) |
| e | Instância real do DOOM por 5 s: FPS médio/min/máx (meta ≥ 15) |
| ⊕ | **Capture UI State**: `html2canvas` gera PNG Base64 do desktop; fallback `canvas.toDataURL()` |

---

## Testes automatizados

```bash
# Requer Node 18+ (WebAssembly nativo). O jsdom é devDependency:
npm install
npm test
```

- `smoke-wasm.mjs` (zero dependências): sobe o motor real duas vezes — com o
  WAD embutido e com o `DOOM1.WAD` injetado via `readWads` — e valida frames
  desenhados e framebuffer não vazio.
- `dom-integration.mjs` (jsdom): 21 verificações do shell, Window Manager,
  runtime DOOM real (via servidor HTTP), gate de foco, suíte de diagnóstico
  (5/5 PASS) e captura E2E. Resultado medido na sandbox: **DOOM ≈ 35–47 FPS**.

---

## Estratégia de CORS e offline

- O caminho feliz é **100% same-origin**: nenhum recurso externo é exigido.
- Espelhos remotos (jsDelivr/raw.githubusercontent, ambos com
  `Access-Control-Allow-Origin: *`) existem apenas como fallback de emergência
  e nunca bloqueiam o caminho local.
- A captura E2E usa biblioteca vendoreada; se ela falhar, a API nativa de
  canvas assume.

## Limitações conhecidas

- Sem áudio (a ABI mínima do módulo não cobre som).
- Savegames desabilitados (stubs da ABI).
- Movimento do mouse não gira a visão (só botões); teclado/WASD completos.
- `html2canvas` pode divergir em efeitos modernos de CSS em navegadores
  específicos; o fallback nativo cobre a falha.

## Licenças de terceiros

Ver [`vendor/doom/ATTRIBUTION.md`](vendor/doom/ATTRIBUTION.md). Resumo:
`doom.wasm` GPL-2.0, `DOOM1.WAD` shareware da id Software, `html2canvas` MIT.
O código próprio deste repositório é GPL-3.0 (`LICENSE`).
