# Porthole Runtime

Camada experimental de compatibilidade **Win32 → Web** em Vanilla JS: dynamic linker com SHIMs de DLL, Virtual Filesystem mapeado como `C:\`, parser PE/COFF, Graphics Translation Layer Direct3D para WebGL/CPU e um backend **retrowin32/Wasm** para executar PE32 x86 em user mode.

> **Escopo sem marketing:** o workload D3D9 integrado produz frames/FPS reais. PEs podem ser apenas inspecionados ou executados pelo backend local; estados, stdout, instruções e exit codes são medidos separadamente. DOOM95, .kkrieger, Adobe e Roblox não são apresentados como rodando. Nenhum kernel Windows, BIOS ou imagem de sistema operacional é emulado. Compatibilidade total e suporte a anti-cheat não são alegados; evasão de VM/Wine/anti-cheat não faz parte do projeto.

> **Estado vigente — 2026-10-28:** fonte `6eb2c0eb6207111a5b38c952aa7c1f0bf57b07c1`, [run 40727092030](https://github.com/710862-beep/porthole/actions/runs/40727092030). Build/integridade PASS; **5/5 PEs sintéticos PASS**; input headless injetado e TCP/HTTP/DNS guest Node comprovados. **DOOM95 falha em `comctl32.dll!17` (InitCommonControls), sem gameplay. Workflow vermelho, promotable=false, estável intacto.** [Relatório atual](docs/remaining-blockers.md).

## Executar

Não há build nem dependências de runtime. Sirva a raiz por HTTP:

```bash
python3 -m http.server 8000 --bind 0.0.0.0
# ou: npm run serve
```

Abra `http://localhost:8000` (ou o preview HTTPS da Arena). O seletor nativo de pastas exige contexto seguro (`localhost` ou HTTPS). Todos os recursos do caminho feliz, incluindo Wasm, glue, fixtures e html2canvas, são locais.

## Fluxo na interface

1. **Mapear pasta:** escolha uma pasta do host para ser `C:\`.
2. **Iniciar runtime:** carrega os SHIMs JavaScript do workload integrado e inicia o pipeline D3D9.
3. **Benchmark 5 s:** mede somente `Present()` concluídos nessa janela, usando `performance.now()`.
4. **Inspecionar PE:** informe, por exemplo, `C:\Games\Doom\DOOM95.exe`. O Porthole lê os bytes, valida PE/COFF e resolve os imports que seus SHIMs JavaScript conhecem. Isso não executa o entry point.
5. **Executar x86:** relê o mesmo arquivo e o entrega ao retrowin32. O botão aceita somente PE32 x86 executável; PE64 e DLLs são rejeitados explicitamente. A pasta do PE é pré-carregada antes do primeiro lote para adaptar o host de arquivos síncrono ao VFS assíncrono.
6. **Parar convidado:** interrompe o processo e aguarda a fila de escritas. Iniciar o workload integrado também encerra um convidado ativo, evitando misturar frames e FPS das duas origens.
7. **PE real / retrowin32:** execute `hello.exe` ou `callback.exe`, fixtures Apache-2.0 locais, sem mapear uma pasta. O resultado verifica stdout, instruções e exit code; não é um vídeo ou uma simulação de Windows.
8. **Capture Runtime State:** captura a superfície ativa e a UI. Um programa de console não ganha um framebuffer fictício: os metadados continuam distinguindo o canvas integrado da ausência de janela do convidado.
9. No workload integrado, clique no canvas e use **WASD/setas/mouse** para alterar a cena por mensagens do SHIM `user32`.

Durante a execução de um PE, o painel mostra `retrowin32-wasm-x86`, instruções, stdout e estado (`EXECUTANDO`, `BLOQUEADO`, `ENCERRADO`, `ERRO`). FPS não é calculado a partir de stdout nem atribuído a um PE de console.

## Duas camadas de compatibilidade, sem confundir autoria

### SHIMs JavaScript do Porthole

- **`porthole-linker.js`:** registro case-insensitive, `LoadLibrary`, `GetProcAddress`, `FreeLibrary`, refcounts, resolução da import table e ring buffer de chamadas.
- **`kernel32.dll`:** `VirtualAlloc/Free/Protect`, memória endereçável, handles e I/O assíncrona pelo VFS, `GetFileAttributesExW/W`, `LoadLibraryA/W`, `GetProcAddress`, `GetTickCount[64]` e QPC/QPF monotônicos.
- **`advapi32.dll`:** HKCU/HKLM/HKU/HKCR, handles, criação/abertura, enumeração, valores SZ/EXPAND_SZ/MULTI_SZ/DWORD/QWORD/BINARY e snapshot persistente em `C:\Porthole\Registry\hives.json`. Valores não são enviados ao tracer.
- **`user32.dll`:** `CreateWindowExA/W` → `<div>`, janelas, `WndProc` JS, fila `Post/Peek/Get/DispatchMessage`, teclado, pointer/mouse, `RegisterRawInputDevices`, `ClipCursor`, `SetCapture` e `WM_INPUT` com Pointer Lock.
- **`gdi32.dll`:** DCs Canvas 2D, `BitBlt(SRCCOPY)`, `FillRect`, `SetPixel` e objetos básicos.
- **`d3d9.dll`:** dispositivo, vertex/index buffers, `Lock/Unlock`, FVF `XYZ/XYZRHW + DIFFUSE`, streams, `Clear`, draws, shaders triviais e `Present`.
- **`d3d11.dll`:** subconjunto de vertex/index/constant buffers, `UpdateSubresource`, slots VS/PS, topology, draws, clear e swap chain sobre o GTL compartilhado. Constant buffers possuem storage/estado reais; upload arbitrário de uniforms para qualquer shader ainda não é alegado.

Esses SHIMs são usados pelo workload integrado e pelo relatório de imports. Métodos fora do subconjunto falham com `NOT_IMPLEMENTED` ou mensagem equivalente; não há stubs que retornam sucesso para pipelines inteiros inexistentes. Raw Input foi validado na fila desse `user32` JS, não em um jogo retrowin32. `GetRawInputData` devolve objetos JS; o layout binário completo de `RAWINPUT` ainda não está implementado.

### Backend retrowin32

`js/retrowin32-backend.js` é um adaptador Vanilla JS para o núcleo Apache-2.0 em `vendor/retrowin32/`. O núcleo executa instruções x86, relocations, IAT, memória, stack, calling conventions e seus próprios módulos Win32 HLE. O adaptador fornece:

- cache de arquivos e paths Win32 relativos ao diretório do PE;
- `open/read/seek/write` síncronos sobre esse cache, com criação/truncamento e overlay coerente para reaberturas;
- fila de persistência assíncrona no VFS e `flushWrites()` com erros reais;
- stdout UTF-8, timers, bloqueio/desbloqueio e eventos de mouse;
- janelas e superfícies Canvas 2D em um canvas separado do canvas WebGL integrado;
- lotes de `emu.run()` que cedem ao event loop, contagem de instruções e estados de processo;
- uma instância Wasm nova por processo, pois o artefato possui logger/host globais que não podem ser reinicializados na mesma instância.

As chamadas internas do retrowin32 **não são atribuídas aos SHIMs JavaScript do Porthole**. A UI e os metadados identificam qual caminho produziu cada evidência. Se uma exceção Rust deixar o getter `instr_count` indisponível, o painel preserva somente o último contador válido e informa essa limitação; stdout/janelas/exit permanecem evidências separadas, sem inventar instruções.

O artefato Wasm foi obtido do branch `pages` do upstream; o `web/wasm.wasm` do branch principal é apenas um placeholder e não é usado. A UI Preact/depurador upstream não foi incluída. Consulte `vendor/retrowin32/README.md` para commits, hashes e escopo.

## VFS multiplataforma

A detecção combina `navigator.userAgentData.platform`, `navigator.userAgent` e `navigator.platform`. ChromeOS é verificado antes de Linux. O caminho do host é apenas uma sugestão: o navegador nunca abre `Documents` automaticamente.

| Plataforma | Caminho sugerido | Método de acesso |
|---|---|---|
| Linux | `~/Documents` ou pasta escolhida | FS Access quando disponível; fallback caso contrário |
| Windows | `C:\Users\<usuário>\Documents` ou pasta escolhida | Capacidades do browser; não há acesso automático ao disco |
| ChromeOS | `/home/chronos/u-<hash>/MyFiles/Downloads` ou pasta escolhida | Mesmo modelo de handles/fallback |

| Navegador/capacidade | Leitura | Escrita |
|---|---|---|
| Chrome/Edge com File System Access API | Handles da pasta real | `createWritable()` na pasta real, após permissão |
| Firefox | `<input type="file" webkitdirectory>` + referências `Blob` | Overlay em memória, não persistente |
| Safari | `<input type="file" webkitdirectory>` + referências `Blob` | Overlay em memória, não persistente |

Paths Win32 são case-insensitive. `C:\Games\..\Save\config.ini` é normalizado; `..` não pode escapar da raiz, e UNC/outros drives são rejeitados. Nenhum arquivo é enviado pela rede.

### Persistência e edge cases

`vfs-persist.js` adiciona overlay imediato, ordem last-write-wins por arquivo, filas independentes para paths diferentes, estado dirty e `flush()` com erros de durabilidade. No FS Access, o Promise da escrita só termina após `createWritable/close`; no fallback, durabilidade continua `false`. Estatísticas expõem escritas pendentes e falhas sem incluir o conteúdo dos arquivos.

- Prefixo `\\?\C:\...` é aceito para long paths e canonicalizado para a mesma chave de `C:\`; `\\?\UNC\...`, outros drives e escapes continuam bloqueados.
- Links simbólicos relativos/absolutos existem somente como objetos virtuais do fallback, com limite de 16 resoluções e `ELOOP` para ciclos. Nenhum symlink é criado no host; FS Access retorna `NOT_IMPLEMENTED` para essa operação.
- `stat` fornece tipo, tamanho e `lastModified` quando o backend os possui. `GetFileAttributesExW` devolve esses dados e marca creation/access time como indisponíveis, em vez de inventá-los.
- ACLs NTFS, atomicidade completa e `fsync` durable não são simulados como se existissem na API web. Instaladores Inno/NSIS reais ainda não foram validados.

### Por que existe pré-carregamento?

`Blob.arrayBuffer()` e File System Access API são assíncronos, enquanto o host retrowin32 chama `open/read/write` durante a execução síncrona do núcleo. Por isso, o PE e sua árvore são lidos antes de `run()`. Há limites de quantidade/bytes para não copiar uma pasta inteira sem controle; itens omitidos são reportados e podem causar erro de arquivo no convidado, nunca sucesso fingido.

Escritas alteram primeiro o overlay visível ao convidado. A persistência no VFS entra numa fila e é aguardada no término/captura. No fallback, a escrita é somente em memória; no FS Access, falhas de permissão são exibidas.

## Graphics Translation Layer

| D3D9 | WebGL |
|---|---|
| `CreateVertexBuffer` | `gl.createBuffer()` |
| `Unlock` | `gl.bufferData()` |
| `SetStreamSource` / `SetFVF` | `gl.vertexAttribPointer()` |
| `DrawPrimitive` | `gl.drawArrays()` |
| `DrawIndexedPrimitive` | `gl.drawElements()` |
| `Present` | swap chain simulada: superfície WebGL → canvas visível |

`Present()` não serializa PNG a cada frame. `canvas.toDataURL()` é usado somente na captura. O benchmark usa mapeamento manual GLSL do pipeline fixo. Além dos shaders triviais originais, `shims/d3d_translate.js` implementa packing de constant buffers, vertex declarations multi-stream e parser de expressões com swizzles, precedence e funções conhecidas. Não é um compilador HLSL completo: texturas, statements e gramática desconhecida são rejeitados até haver backend equivalente.

### Detecção e fallback

`WEBGL_debug_renderer_info` identifica vendor/renderer quando permitido. SwiftShader, llvmpipe, lavapipe, softpipe e Microsoft Basic Render são classificados como software.

- **Hardware WebGL (GPU detectada):** contexto WebGL e renderer não classificado como software.
- **WebGL software:** WebGL funciona, mas o renderer é SwiftShader/llvmpipe etc.
- **Software llvmpipe-style:** fallback próprio em JS/CPU com framebuffer RGBA, barycentric fill, interpolação de cor e `putImageData()`.

O fallback CPU **não é o LLVMpipe do Mesa**. Falha de contexto, shader ou draw WebGL aciona recuperação para CPU; a opção “Forçar rasterizador CPU” permite validá-lo manualmente. O GTL D3D9/D3D11 do Porthole não deve ser interpretado como prova de que um PE externo possui suporte completo a Direct3D.

## PE/COFF, execução e limites

`pe-loader.js` valida MZ, NT headers, PE32/PE32+, machine, seções, RVAs, entry point e import directory com limites contra arquivos malformados. O linker resolve DLLs/funções disponíveis e lista imports pendentes.

**Carregar bytes ≠ executar instruções.** A ação de inspeção termina em `INSPECIONADO / NÃO EXECUTADO`. Somente o backend retrowin32, depois de `emu.run()` e evidência de instruções/saída/estado, pode mudar o resultado para executando/encerrado.

Os fixtures locais têm evidências reproduzíveis no artefato pinned:

| Fixture | Resultado verificado |
|---|---|
| `hello.exe` | `Hello, world!\n`, 57 instruções, exit code 0 |
| `callback.exe` | `callback0 invoked: 1234` e `retrowin32_callback1 returned: 1`, 477 instruções, exit code 0 |

O callback usa a DLL especial `retrowin32_test.dll` do upstream. O retorno `1` é o comportamento intencional desse SHIM de teste, que não propaga o valor `0x4567` retornado pela função callback. Esses testes não provam compatibilidade geral.

Para DOOM95/.kkrieger ainda podem faltar APIs, arquivos, GDI/DirectDraw, Direct3D 9.0c, texturas, render states e shaders. O usuário pode fornecer os binários e observar a tentativa real, mas qualquer falha será mostrada como falha. O artefato de execução é x86; PE64 não é executado.

Sondagens com outros PEs upstream confirmaram o limite: `cmdline.exe` retorna `TODO.exe` em `GetModuleFileNameA`, `gdi.exe` falha em `GetStockObject`, e `ddraw.exe` chega a criar uma janela antes de outra falha. `thread.exe` imprimiu somente sua primeira linha e terminou em `RuntimeError: unreachable`; portanto threads Win32 continuam pendentes. Esses programas não foram promovidos a fixtures de sucesso.

O host de input do artifact pinned expõe eventos de mouse no glue. Teclado e mensagens `user32` são validados no workload Porthole; suporte de teclado para um convidado retrowin32 não é declarado sem um artifact/adapter que o forneça.

O **v86 não foi integrado**: é um emulador de máquina x86, não um loader PE user-mode, e inicializar Windows nele contrariaria o requisito de não emular o kernel Windows.

## Estrutura

```text
index.html
styles.css
js/
  platform-detector.js
  porthole-linker.js / pe-loader.js
  vfs.js / vfs-fs-access.js / vfs-fallback.js
  shim-kernel32.js / shim-user32.js / shim-gdi32.js
  shim-d3d9.js / shim-d3d11.js
  graphics-device.js / graphics-webgl.js / graphics-fallback.js
  hlsl-translator.js
  retrowin32-backend.js       # host Vanilla JS do executor x86
  runtime.js / app.js
vendor/
  html2canvas/                # MIT, vendoreado
  retrowin32/                 # Apache-2.0, Wasm + glue + fixtures
shims/registry.js             # advapi32 + hives persistentes
shims/d3d_translate.js        # cbuffer, vertex declarations e expressões
vfs-persist.js                # overlay, filas e flush
input-raw.js                  # Raw Input/Pointer Lock do SHIM JS
spoof-hardware.js             # identidade virtual não enganosa + clocks
.github/workflows/            # CI de push e autofix opt-in
ci-autofix.sh / ci/           # classificador, receitas e relatórios
tests/node/                   # testes unitários, contrato WebGL, Wasm, estresse e DOM
tests/wine/                   # manifesto/adaptador PE e referências
agents.md / plan.md           # regras e arquitetura vivas
```

## Testes e CI

```bash
npm ci
npm run check:syntax
npm test
npm run test:wine
```

A execução final desta revisão concluiu **97 verificações**: **86 unitárias/contrato/estresse** e **11 DOM**, além de 41 scripts aprovados por `node --check`. O benchmark CPU mediu **302 frames em 5,009 s (60,29 FPS)** nesta sandbox; não é uma promessa de desempenho em outros dispositivos.

A suíte cobre:

- plataforma, VFS nativo/fallback, long paths, links, `stat`, concorrência, dirty state e recuperação de persistência;
- PE32, imports, linker, memória, arquivos, janelas, GDI e atributos Win32;
- hives/tipos de registro e recarga por nova instância sem registrar valores no tracer;
- Raw Input de mouse/teclado, deltas relativos, grant/loss/negação de Pointer Lock em mocks;
- pixels CPU, draws D3D9/D3D11, constant buffers, layouts de vértices e expressões HLSL;
- contrato WebGL com mock rigoroso, **não apresentado como teste de GPU**;
- benchmark de 5 segundos e execução Wasm real dos fixtures, incluindo quatro processos independentes;
- classificador/sanitizador de CI e a regressão gerada pela receita de autofix;
- integração com `index.html` via jsdom, incluindo clique no fixture com stdout/exit code reais.

### Adaptador Wine

`tests/wine/run-winetests.mjs` aceita um manifesto com binários PE32/x86, SHA-256, timeout e expectativas, gerando JSON + JUnit. Nesta revisão o manifesto está vazio e o resultado é **NOT_RUN**. As regressões JS relacionadas às referências Wine não são chamadas de `winetest.exe`. Consulte `tests/wine/REFERENCES.md` para commits e a sondagem de threads.

### Auto-correção

`.github/workflows/porthole-ci.yml` executa os comandos em todo push e publica relatórios. `ci-autofix.sh` isola `dll!API`, sanitiza evidências e consulta `ci/shim-recipes.json`. APIs desconhecidas ficam `Upstream Missing`; não é gerado um stub de sucesso.

Uma receita real para `kernel32!GetTickCount64` foi exercitada localmente: implementação + regressão foram geradas, o teste isolado passou e `npm test` inteiro passou. Nenhum `--commit` local foi feito. Em GitHub, o auto-commit exige a variável de repositório `PORTHOLE_AUTOFIX=true`, worktree limpo, branch `arena/6a52f3cb-porthole`, receita verde e contexto não bot/fork. O workflow ainda não foi executado em um runner hospedado.

### Limites da validação nesta sandbox

Não há Chromium/Firefox instalado nem acesso a Windows/ChromeOS físicos. A execução Wasm foi validada em Node e no DOM jsdom, não em um navegador físico. Ainda são necessários testes manuais para File System Access API persistente, WebGL em GPU, html2canvas, Pointer Lock real, input do convidado e matriz visual cross-browser. Os testes de plataforma usam UAs controlados; não equivalem a executar nesses sistemas. Nenhum binário DOOM95/.kkrieger, Adobe, Roblox ou instalador Inno/NSIS foi fornecido/testado. ICM, GDI+ complexo, DirectWrite, networking completo, ACLs NTFS e threads Win32 permanecem lacunas. O projeto não implementa spoofing de PC físico, ocultação de Wine/VM ou bypass de anti-cheat.

## Captura E2E

“Capture Runtime State” retorna:

- framebuffer da superfície ativa via `canvas.toDataURL('image/png')`;
- UI via `vendor/html2canvas/html2canvas.min.js`;
- timestamp, plataforma, VFS, renderer, backend, instruções, resultado do benchmark e origem dos frames.

Se html2canvas falhar, o framebuffer continua disponível e o erro da UI é mostrado separadamente. Não é gerada uma captura de substituição fingindo ser a interface.

## Licenças

Código do projeto: GPL-3.0 (`LICENSE`). html2canvas: MIT (`vendor/html2canvas/LICENSE`). retrowin32, seu glue e fixtures: Apache-2.0 (`vendor/retrowin32/LICENSE`), com procedência em `vendor/retrowin32/README.md`. Nenhum jogo, WAD ou executável proprietário acompanha esta versão.

### Aquisição ativa e probes PE

`npm run fetch:assets` tenta aquisição pública, valida MZ/PE e gera hashes/procedência em `tests/assets/MANIFEST.json`. Requer curl e unzip; os downloads não são redistribuídos pelo Git. Falhas obrigatórias retornam exit 1 e preservam URLs/códigos/erros em `artifacts/asset-acquisition.json`. `npm run test:assets` executa os PEs retrowin32 adquiridos, separadamente de Wine.

Nesta revisão: **105 verificações locais**, **45 scripts** com sintaxe válida; 12 PEs adquiridos/provados, dos quais 5 encerram normalmente, 6 falham e threads termina prematuramente. O panic inicial de threads foi localizado no relógio dependente de Window e corrigido para Node; o término individual de threads continua incorreto no núcleo. Aquisição Wine/jogos/apps falhou com diagnósticos de rede/404; `test:wine` agora falha explicitamente em vez de permitir CI verde sem fixtures. Detalhes e limites: [relatório de aquisição](docs/asset-validation-2026-10-27.md).

### Alternativas, PEs sintéticos e estado atual

Veja [COMPATIBILITY_REPORT.md](COMPATIBILITY_REPORT.md) e [análise de threads](docs/threading-analysis.md).

- `npm run fetch:fallbacks`: tentativas normais + Release Asset API + buscas/árvores/blobs GitHub e compilação de substitutos. Mantém falha explícita para originais obrigatórios ausentes.
- `npm run build:synthetic`: compila cinco fontes C em PE32 com Zig **0.13.0**; configure `PORTHOLE_ZIG` conforme [instruções](tests/synthetic/README.md).
- `npm run test:synthetic`: executa os cinco PEs no Wasm em processos Node separados com timeout externo.

Estado atual: **126 verificações locais**, **53 scripts** com sintaxe válida. Foi adquirido DOOM95 de um mirror público e houve tentativa real, mas falhou no backend. Todos os cinco PEs sintéticos falham seus contratos guest. O early exit de thread foi localizado em machine.exit(0) no trampoline de worker; o scheduler Wasm ainda não foi corrigido. Novos módulos thread-sync/ws2_32 são modelos JS testados, não uma ponte de ABI para essas DLLs no Wasm. HTTP TCP loopback e IO físico Node validados não equivalem a rede/input/File System Access do navegador.

### Candidato Rust/Wasm (2026-10-28)

A fonte histórica foi integrada em `rust/retrowin32`, com alterações candidatas
no scheduler, waits, TEB/handles e pontes de registro ANSI/diretórios. Veja
[rust/README.md](rust/README.md) e [estado da integração](docs/rust-wasm-integration.md).
`npm run build:wasm` regenera as DLLs, executa testes Rust e produz um candidato
fora de vendor. O build remoto agora **compilou**: [run 40714518581](https://github.com/710862-beep/porthole/actions/runs/40714518581),
commit `1bd21160ae81f88eaaa50c54a8a939bc6545457f`. O Wasm/binding foi baixado pela
API e validado, inclusive inicialização. **8 testes Rust passaram**; contratos
sintéticos: **3/5** (threads, registro e instalação em disco Node); input e rede
falham. Probes originais: **6/15**, DOOM95 ainda falha. O workflow continua vermelho,
**não houve promoção** e o estável está intacto. Raw Input/ws2_32 continuam lacunas.
Suíte local: **143 verificações JS/DOM**, **59 scripts** sintaticamente válidos.
