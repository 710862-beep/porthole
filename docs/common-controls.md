# Candidato com Common Controls — 2026-10-28

## Resultado: implementação funcional parcial; gameplay FALHOU; NÃO PROMOVIDO

- Fonte executada: **`757abeba1c995af55a2cd7eab689483cabb943df`**, branch `arena/6a52f3cb-porthole`.
- [Workflow 40736781228](https://github.com/710862-beep/porthole/actions/runs/40736781228): **VERMELHO**, `promotable=false`.
- [Evidência completa versionada](evidence/common-controls-40736781228.json).
- Build Rust/Wasm: **PASS**; **12 testes Rust PASS** (1 derive, 2 x86, 9 win32).
- Candidato: **1,882,946 bytes**; SHA-256 `a5d7bd798966b2bf499481d30184e93d46c89ba7df887db53877e30a5ce791f6`.
- Glue SHA-256 `0f963888aa5e90c69d5d7db73f44517ffb75ea989c79552def00c1753725fc27`; 42 exports Wasm, 66 imports; binding inicializado e WebAssembly.compile aprovado após download verificado.
- Regressões JS/DOM PASS, **69 syntax checks PASS** locais e no workflow.
- Patch Rust: **37 arquivos**, baseline e arquivo upstream identificados em `rust/PROVENANCE.json`; regenerado e `git apply --check` aprovado.

**O pedido completo NÃO foi concluído.** Não há gameplay funcional nem comprovação de limitação fundamental: há implementação pendente de diálogos e outros subsistemas. Não considero o candidato pronto para promoção e não marco suporte completo a Common Controls.

## Common Controls e procedimentos nativos

| Componente | Subset implementado; cobertura não exaustiva | Limite explícito |
|---|---|---|
| InitCommonControls | Export DLL no **ordinal 17**, registro idempotente real de classes/procedimentos; chamado pelo DOOM95 | Registro legado parcial: standard + progress, não todas as classes Win95 |
| InitCommonControlsEx | Estrutura guest validada, tamanho 8; flags ICC_STANDARD_CLASSES=0x4000 e ICC_PROGRESS_CLASS=0x20 | Outras flags retornam falso; não alego ICC_WIN95_CLASSES=0xff completo |
| BUTTON | Estado por HWND, CREATE/PAINT, press/release, hover armazenado, BM_GET/SETCHECK, BM_GET/SETSTATE, BM_SETSTYLE, BM_CLICK; WM_COMMAND ao parent | Perfil básico, não todos os estilos/temas, radio groups e acessibilidade |
| EDIT | Buffer, texto/gettext/length, seleção, replace, caractere, backspace/delete/arrows/home/end, limite, readonly, caret; EN_CHANGE | Single-line/basic Latin; não edição Unicode completa, clipboard, IME, multiline nem caret blinking completo |
| STATIC | WM_SETTEXT/GETTEXT, STM_SETIMAGE/GETIMAGE e desenho real de bitmap mono/RGBA | Teste visual de mono; RGBA implementado, não coberto por esta imagem de regressão; ícones não suportados |
| LISTBOX | Add/delete/reset/get count/text/selection, seleção única e pintura destacada; notificação de seleção | Não owner-draw, multi-select e todas as mensagens LB_* |
| SCROLLBAR | Range/posição SBM_*, pintura do thumb e notificação de click | Subset básico horizontal; não interação completa de scrollbar Windows |
| COMBOBOX | Itens CB_ADD/DELETE/RESET, count/text/selection e pintura do item selecionado | **Parcial**: não dropdown interativo completo nem todos os estilos CBS_* |
| Classes Win95 adicionais | Não anunciadas como disponíveis | List/tree views, toolbar, tooltip, statusbar, hotkey, tabs e outras ainda pendentes |

As classes padrão ficam no **núcleo user32**, como na arquitetura Win32; comctl32 inicializa o subset disponível. Arquivos reais: `win32/src/winapi/comctl32.rs`, `user32/controls.rs`, `user32/control_font.rs`, `window.rs` e `message.rs`, sob `rust/retrowin32/`. O dispatch de mensagens encaminha para procedimentos Rust com estado por HWND e desenho no backing buffer da janela pai, apresentado pelo host Canvas existente. Há roteamento de mouse para filhos, foco e transporte de eventos de teclado. O teste atual comprova mensagens guest e pixels, **não uma sessão de input físico em todos os controles**.

Não criei exports wasm-bindgen ou SHIMs JS desconectados da IAT: os exports DLL são gerados pelo mecanismo real e compilados no Wasm. O número de exports Wasm não corresponde ao número de exports Win32. O texto de STATIC usa **WM_SETTEXT**; não inventei uma mensagem STM_SETTEXT. O raster usa fonte bitmap basic Latin de domínio público, com origem/hash documentados no arquivo; não é uma reprodução pixel-perfect dos temas Windows.

## Teste guest dos controles em Chromium real

`tests/synthetic/controls-test.c` é um PE próprio, **não Wine nem DOOM**. É compilado por Zig 0.13.0 e executado pelo mesmo Wasm candidato em `tests/run-controls-browser.mjs`.

- **PASS**, exit **0**, stdout `SUCCESS COMMON_CONTROLS_STATE_MESSAGES_NOTIFICATIONS`.
- Mensagens e retorno de callbacks parent, seleção/edição, checkboxes, list/combo/scroll/progress, handles vivos/destruídos, GetParent/GetDlgCtrlID e foco conferidos.
- Cp1252 em captions e FindWindowA/SetWindowTextA exercitado sem panic.
- **31 presents sintéticos**, **180 pixels de glyph**, **177 pixels da seleção** e **64 pixels da imagem mono** conferidos por getImageData do Canvas real. Screenshot PNG embutido na evidência JSON.
- Duas DLLs próprias provam DllMain: attach único, recarga sem repetir attach e rejeição com ERROR_DLL_INIT_FAILED quando o entry point retorna FALSE.
- O teste não foi transformado em sucesso headless por canvas falso. A primeira tentativa Node sem DOM falhou honestamente; a regressão gráfica é executada em Chromium real após sua instalação no CI.

## Cinco contratos sintéticos preservados

| PE | Exit | Status | Evidência |
|---|---|---|---|
| thread-validation.exe | 0 | PASS | 3 workers, 10 loops, TLS |
| input-test.exe | 0 | PASS | 3 deltas assinados exatos; também regressões de stat e error mode |
| network-test.exe | 0 | PASS | TCP/HTTP loopback real + DNS localhost |
| registry-test.exe | 0 | PASS | 128 bytes + DWORD em disco, reopen Ex e legado RegOpenKeyA |
| installer-test.exe | 0 | PASS | Diretório, arquivo, marcador e metadados relidos em disco |

O PE de controles e as duas DLLs são **adicionais**, não substituem nem inflam o gate dos cinco. Input headless é injetado, não físico. Rede browser sem transporte autorizado permanece limitada; o contrato de TCP é Node.

## Ciclo DOOM95 e causas corrigidas nesta rodada

| Run | Resultado observado e correção subsequente |
|---|---|
| 40730936515 | Macro comctl32 sem TRACE_CONTEXT: erro de compilação analisado e corrigido |
| 40731293079 | Loader associava SHIMs por posição em exports esparsos: corrigido para usar ordinais explícitos |
| 40732337987 | Registros de progress usavam offsets incorretos; corrigidos. Caption ANSI causava panic; corrigidos CP1252/UTF-16 e busca real de janela |
| 40733408035 | Controles PASS; DOOM chamou InitCommonControls e bloqueou em **advapi32!RegOpenKeyA**; API implementada sobre a ponte real de registro |
| 40734213603 | Controles/imagem PASS; DOOM chegou a **GetFileAttributesA → Host.stat TODO**; implementado stat dos arquivos/diretórios autorizados do overlay |
| 40734923458 | Erros de CRT/TLS/heap após DLL dinâmica: identificado LoadLibrary sem execução de DllMain; attach real implementado e testado com DLLs próprias |
| 40736001546 | DLLs/controles PASS; salto por registrador identificado como **kernel32!SetErrorMode** por disassembly + import table, não pela última API; implementado estado do processo e regressão |
| 40736781228 | Build/controles/cinco PEs PASS; próximo salto nulo comprovado: **user32!CreateDialogParamA** |

[Análise reproduzível da chamada por registrador](evidence/doom95-register-call-40736001546.json): o `mov edi,[0x47354]; call edi` vem do slot SetErrorMode no PE verificado. A última chamada RegisterClassA não foi rotulada como causa.

LoadLibraryA/ExW agora executam DllMain(DLL_PROCESS_ATTACH) em ordem de carga das dependências, antes de devolver o módulo ao guest, sem repetir attach. Falha de DllMain devolve NULL/1114. Isso **não** implementa loader lock, contagem de referências, FreeLibrary/detach ou notificações completas de threads. O CRT do DOOM avançou de TLS inválido/heap 0 para TLS/heap inicializados; não ocultei esse problema apenas decodificando bytes de código como texto de MessageBox.

Stat consulta o cache autorizado real e os diretórios carregados/criados; não pesquisa o disco arbitrário do host. Empty path, ausência e acesso não autorizado têm erros explícitos. Timestamps do perfil virtual continuam zero/desconhecidos, não metadados reais do sistema operacional. O registro do probe browser é um overlay **efêmero inicialmente vazio**, não instalação Windows nem persistência em disco; a persistência real é verificada pelo contrato Node separado.

## Resultado de gameplay — FALHOU

| Critério | Medido |
|---|---|
| Janela criada | Sim, 1 |
| Presents | **5**, antes do erro |
| Frames Canvas capturados | **5**, apenas **2 mudanças** entre hashes adjacentes |
| Observação de 5 segundos concluída | **Não**; erro após aproximadamente **50.7 ms**, com timeout máximo de 5 s |
| Meta >=100 presents/frames em 5 s | **Não atingida** |
| Input processado pelo guest no ensaio | **Não comprovado**; falhou antes da injeção agendada |
| Loop do jogo | **Não comprovado**; sem sequência de frames/DirectDraw suficiente |
| Exit code | null, falha do backend |
| Gameplay functional | **false** |

```text
NULL_INDIRECT_CALL ip=32dd8 operand=Some(292068) target=0
causal_import=Some("user32.dll!CreateDialogParamA@IAT")
```

Não houve Rust panic no último ensaio. Não atribuí a causa à última API GetLastError. **Ainda falta implementar CreateDialogParamA/modeless dialogs de verdade**, incluindo parsing de RT_DIALOG, criação dos filhos e IDs, WM_INITDIALOG, procedimentos/callbacks, foco e roteamento IsDialogMessage, além dos métodos GetDlgItem/SetDlgItem e demais APIs que o trace demonstrar. Não vou devolver HWND falso ou sucesso vazio para remover o erro. Isso é trabalho pendente, não uma limitação fundamental demonstrada.

## Gameplay e CI: o que foi implementado

- `scripts/validate-gameplay.mjs`: fail-closed; janela, observação 5 s, >=100 presents/frames Canvas efetivos, mudanças de imagem, input lido pelo guest e loop atestado por chamadas DirectDraw do guest ao longo do tempo ou PC calibrado. Host timers/RAF e eventos enviados sozinhos não comprovam loop/input. Os fixtures positivos do teste de política são artificiais e **não** evidência de DOOM rodando.
- Probe Chromium captura hashes de pixels, leitura real de key_state e callbacks do trace Rust; não incrementa frames por timer.
- `scripts/check-promotion.mjs`: exige agregado, gameplay e controles com pixels; **não copia binários para vendor**.
- Candidate workflow compila toolchain fixada, executa cinco PEs, controles/DLLs, DOOM, gameplay e promoção; publica resultados com always().
- `porthole-ci.yml` testa a política e consulta evidências do candidate run do **mesmo SHA** antes de autorizar promoção; ausência, falha ou run pendente não viram verde. Não duplica a compilação Rust.
- Último agregado: **14/15 checks PASS**; gameplay/DOOM permanece FAIL. Originais: 6 PASS / 9 falhas, sem equivaler exit 0 a conformidade.

## Promoção e limitações

**Não promovido.** Vendor preservado:

- Wasm: `5dc271886ebd68f2ba682099e71415bae7e40a457b3819d165484ffec0e1be41`.
- Glue: `529f6a7acefe8a674cb9cc7a5829720dda8c670ee054088e3c774128cf559147`.

Além dos controles parciais e diálogos, permanecem lacunas em GDI/fontes/paletas, multimídia, APIs de janela/subclassing, Unicode de todos os A/W, descarregamento de DLLs e conformidade geral. GetModuleFileNameA legado ainda escreve TODO.exe em outro caminho do núcleo: não o apresento como fiel. Raw Input físico, Wine completo, .kkrieger e aplicativos comerciais não foram validados por esses testes.

## Reproduzir

```bash
python3 scripts/download-ci-blobs.py 40736781228
node scripts/validate-wasm.mjs artifacts/remote/40736781228/retrowin32-candidate-wasm
npm test
npm run check:syntax
# Com Zig 0.13.0: compila cinco PEs, controle extra e DLLs próprias
node scripts/build-synthetic.mjs
# Com candidato em artifacts/wasm-candidate e Chromium instalado:
node tests/run-controls-browser.mjs
node tests/run-doom95-browser.mjs
node scripts/validate-gameplay.mjs
node scripts/validate-all-tests.mjs
node scripts/check-promotion.mjs
```

As últimas três verificações devem continuar vermelhas para este candidato. A fase seguinte precisa continuar a implementação e os ensaios; este documento não declara os 13 passos concluídos.
