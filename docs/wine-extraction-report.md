# Wine extraction and adaptation report

Wine commit: `0738d528db522f52d9d75f2aec712688dd31d1d2`; acquired 2026-10-28 from https://github.com/wine-mirror/wine.

License: **LGPL-2.1-or-later**, Copyright 1993, 1994, 1996 Alexandre Julliard. LICENSE.Wine is an exact copy of COPYING.LIB.

Original dialog.c SHA-256: `cc1f6752bdb875e98a30b3f77acd73e42688740653ea8a574686612e89f42268`.

## Extracted lexical same-file closure

| Function | dialog.c lines | Direct calls |
|---|---|---|
| CreateDialogParamA | 719–728 | CreateDialogIndirectParamA, FindResourceA, LoadResource |
| CreateDialogIndirectParamA | 759–763 | CreateDialogIndirectParamAorW |
| CreateDialogIndirectParamAorW | 749–754 | DIALOG_CreateIndirect |
| DIALOG_CreateIndirect | 443–713 | AdjustWindowRectEx, ClientToScreen, CreateFontIndirectW, CreateFontW, CreateWindowExA, CreateWindowExW, DIALOG_CreateControls32, DIALOG_ParseTemplate32, DIALOG_get_info, DeleteObject, GdiGetCharDimensions, GetActiveWindow, GetCapture, GetCursorPos, GetDesktopWindow, GetDeviceCaps, GetDialogBaseUnits, GetMonitorInfoW, GetNextDlgGroupItem, GetNextDlgTabItem, GetParent, GetProcessHeap, GetSystemMetrics, GetWindowLongW, HIWORD, HeapAlloc, HeapFree, IS_INTRESOURCE, IsWindow, IsWindowEnabled, LOWORD, LoadMenuW, MonitorFromPoint, MonitorFromRect, MonitorFromWindow, MulDiv, NtUserDestroyMenu, NtUserDestroyWindow, NtUserEnableWindow, NtUserGetDC, NtUserReleaseDC, NtUserSetFocus, NtUserSetWindowContextHelpId, NtUserShowWindow, SelectObject, SendMessageW, SetRect, SetWindowLongPtrA, SetWindowLongPtrW, SystemParametersInfoW, TRACE, UpdateWindow, WideCharToMultiByte |
| DIALOG_CreateControls32 | 191–301 | CreateWindowExA, CreateWindowExW, DIALOG_GetControl32, DIALOG_get_info, GetProcessHeap, GetWindowLongPtrA, HeapAlloc, HeapFree, IS_INTRESOURCE, MulDiv, PtrToUlong, SendMessageW, SetLastError, TRACE, WARN, WideCharToMultiByte, debugstr_w |
| DIALOG_ParseTemplate32 | 310–432 | GET_DWORD, GET_WORD, LOBYTE, LOWORD, MAKEINTRESOURCEW, TRACE, debugstr_w, lstrlenW |
| GetDialogBaseUnits | 1498–1501 | NtUserGetDialogBaseUnits |
| GetNextDlgGroupItem | 1528–1627 | GetParent, GetWindow, GetWindowLongW, IsChild, WIN_GetFullHandle |
| GetNextDlgTabItem | 1696–1712 | DIALOG_GetNextTabItem, WIN_GetFullHandle |
| DIALOG_GetControl32 | 87–183 | ERR, GET_DWORD, GET_LONG, GET_WORD, MAKEINTRESOURCEW, TRACE, TRACE_ON, debugstr_w, lstrlenW |
| DIALOG_GetNextTabItem | 1635–1691 | DIALOG_GetNextTabItem, GetParent, GetWindow, GetWindowLongA, IsChild |

## External/macro boundaries — NOT a complete semantic transitive extraction

AdjustWindowRectEx, ClientToScreen, CreateFontIndirectW, CreateFontW, CreateWindowExA, CreateWindowExW, DIALOG_get_info, DeleteObject, ERR, FindResourceA, GET_DWORD, GET_LONG, GET_WORD, GdiGetCharDimensions, GetActiveWindow, GetCapture, GetCursorPos, GetDesktopWindow, GetDeviceCaps, GetMonitorInfoW, GetParent, GetProcessHeap, GetSystemMetrics, GetWindow, GetWindowLongA, GetWindowLongPtrA, GetWindowLongW, HIWORD, HeapAlloc, HeapFree, IS_INTRESOURCE, IsChild, IsWindow, IsWindowEnabled, LOBYTE, LOWORD, LoadMenuW, LoadResource, MAKEINTRESOURCEW, MonitorFromPoint, MonitorFromRect, MonitorFromWindow, MulDiv, NtUserDestroyMenu, NtUserDestroyWindow, NtUserEnableWindow, NtUserGetDC, NtUserGetDialogBaseUnits, NtUserReleaseDC, NtUserSetFocus, NtUserSetWindowContextHelpId, NtUserShowWindow, PtrToUlong, SelectObject, SendMessageW, SetLastError, SetRect, SetWindowLongPtrA, SetWindowLongPtrW, SystemParametersInfoW, TRACE, TRACE_ON, UpdateWindow, WARN, WIN_GetFullHandle, WideCharToMultiByte, debugstr_w, lstrlenW

The original complete dialog.c and COPYING.LIB are retained in artifacts/wine-extraction. Static direct-call analysis cannot resolve macro expansion, callback targets, Wine server protocols or drivers. The requested complete transitive Wine dependency port is **not complete**. No unsupported boundary is silently marked adapted.

## Reviewed Rust subset

- `dialog_template.rs`: DIALOG_ParseTemplate32/DIALOG_GetControl32 layouts, DWORD alignment, ordinals, UTF-16 strings, normal/extended headers; safe bounded cursor instead of C pointer arithmetic.
- `dialog_helpers.rs`: CreateDialogParamA/indirect, subset DIALOG_CreateIndirect/CreateControls32; local HWND creation and guest DLGPROC callback; WM_INITDIALOG, basic tab focus, text/check/command helpers.
- Structs mapped to owned Template/Item/Name and per-HWND DialogInfo, not casts of packed guest DLGTEMPLATE/DLGITEMTEMPLATE; DLGPROC is a guest address.
- Manual review: signed 16-bit coordinates, 32-bit IDs for extended templates, callback borrow release across await, partial-child cleanup, checked pointers, TEB errors and logging reviewed. Source headers include pinned SHA and original copyright.
- Driver/server/window creation uses existing retrowin32/Canvas; not a translation of NtUserCreateWindowEx/wine_server_call or the complete USER_Driver stack.
- GDI font choice is a logged fixed 8x8 fallback; menus/custom dialog classes/ordinal images/creation data return unsupported. Full Unicode W, dialog result rules, modal lifetime, nested tab groups/Shift+Tab remain incomplete.

## Validation state

Source acquired and verified. Same-file closure extracted. Manual Rust subset integrated. No automatic C→Rust translation claimed; translation script emits review inventory. New authored PE assertions cover indirect creation, WM_INITDIALOG param/focus/IDs, text, click notification, Tab/Enter routing, destruction and missing/NULL templates.

**Remote compile and DOOM95 execution pending for this new candidate.** Historical five-PE/controls results are not reused as proof. Stable is not promoted.

See [porting guide](wine-porting-guide.md) and [attribution](../vendor/ATTRIBUTION.md).

## Primeiro resultado remoto: 40749913520

Fonte Porthole `5eda61b7b03d8786b66be45cfdf2dabd1ea694b9`:
https://github.com/710862-beep/porthole/actions/runs/40749913520

- Build Rust/Wasm PASS; cinco PEs PASS.
- DOOM95 resolveu a API e começou criação real do launcher (RT_DIALOG em
  297884..300556). 14 presents/11 mudanças; exit 0 após falha de criação do filho
  `msctls_updown32`. **Não gameplay**, workflow vermelho e promoção bloqueada.
- Controles chegaram às novas asserções, mas o teste de recurso inexistente
  encontrou panic no parser PE preexistente quando .rsrc era vazio. Correção:
  leitura bounds-checked e erros None, com regressões de seção ausente/truncada e
  contagem maliciosa. Este run não valida o fixture completo de diálogos.
- Próxima dependência causal: classe comctl32 `msctls_updown32`, código em
  `dlls/comctl32/updown.c`, Copyright 1997, 2002 Dimitrie O. Paun,
  LGPL-2.1-or-later no mesmo SHA Wine. Extração adicional em
  `wine-comctl32-extraction.json`; código original/corpus preservados em artifacts.
- Subset manual adaptado: estado por HWND, range invertido/32-bit, posição,
  buddy edit/base 10/16, ação por seta/click com NM_UPDOWN guest mutável e
  notificação scroll, raster básico. Não equivale ao controle completo:
  faltam timers, aceleração, subclassing, acessibilidade/tema e agrupamento local.
- Novo candidato exige outro CI; não reutilizar o primeiro como prova de correção.

## Segundo resultado remoto: 40751078822

Fonte `b8d3e95bd9e2af756574c24c4b00f7a6d539a61d`:
https://github.com/710862-beep/porthole/actions/runs/40751078822

- Build PASS; **18 testes Rust PASS**, **5/5 PEs PASS**.
- Controles + novo fixture de diálogo/updown **PASS**: 52 presents sintéticos,
  pixels conferidos e nenhum panic. Isso valida o subset exercitado, não todos
  os ramos de Wine nem gameplay.
- DOOM95 criou os filhos, entrou em WM_INITDIALOG e avançou até outro salto nulo:
  `ip=0x37967`, `call esi`. Foram **48 presents**, 45 mudanças; sem input/loop
  comprovados, gameplay=false, workflow vermelho, estável intocado.
- Última API RegOpenKeyA **não é a causa**. Disassembly identifica
  `mov esi,[0x100172f8]`; import table do DLL verificado identifica
  **ADVAPI32!GetUserNameA**. Prova: evidence/wine-dialog-next-blocker-40751078822.json.
- Wine `dlls/advapi32/advapi.c:45-56` consulta WINEUSERNAME. A dependência real
  GetEnvironmentVariableA está em kernelbase/process.c:1656-1687, não em um
  syscall copiado para Wasm. Adaptação usa um ambiente virtual por processo,
  nunca o nome/ambiente do host. GetUserNameA/W preservam buffer/size/error;
  getters/setters de ambiente e blocos A/W têm armazenamento e liberação reais.
- Inicialmente WINEUSERNAME/USERNAME=Porthole; fixture altera para Miner, verifica
  buffer curto, tamanho incluindo NUL, busca case-insensitive, remoção/ausência,
  restauração e free/double-free de bloco. ANSI genérico permanece parcial.
- Inventários adicionais: wine-advapi32-extraction.json e
  wine-kernelbase-extraction.json. RtlQueryEnvironmentVariable_U, conversão ACP,
  lock do PEB e outras dependências são fronteiras adaptadas/pendentes, não um
  grafo completo de ntdll traduzido.

Candidato seguinte ainda precisa compilar/executar remotamente; não atribuir
estes novos resultados ao run anterior.

## Terceiro resultado remoto: 40752178802

Fonte `9f491e9ca6adc1998617401ad32ee27bc0a42849`:
https://github.com/710862-beep/porthole/actions/runs/40752178802

- Build, cinco PEs (incluindo novos contratos GetUserName/ambiente A/W) e
  controles/diálogos/updown PASS. Isso não significa execução bem-sucedida do jogo.
- Disponibilizar GetEnvironmentStringsW expôs dependência no CRT antes do
  launcher: **WideCharToMultiByte**, panic real em kernel32/nls.rs:93.
  5 presents; gameplay=false. A regressão de progresso foi analisada, não ocultada
  voltando a fingir ausência do ambiente Unicode.
- Wine locale.c:7426-7472 e wcstombs_utf8 dão validação e dispatch reais. A ABI
  anterior de retrowin32 tinha sete parâmetros; corrigida para os oito exigidos,
  incluindo lpDefaultChar. Subset revisado: CP_ACP/1252 e UTF8, tamanho/query/NUL,
  flags, buffer curto, default/used e surrogate inválido. Outras codepages e
  tabelas completas de best-fit/composição continuam não portadas.
- Corpus em wine-kernelbase-locale-extraction.json (19 funções alcançáveis nesse
  arquivo); demais conversores/tabelas e callbacks não são anunciados como um
  port completo. Novos testes Rust e PE conferem euro CP1252, emoji UTF8, consulta
  de tamanho, buffer curto e erro de surrogate inválido.
- Novo candidato precisa de outra execução remota. Sem promoção.

## Quarto resultado remoto: 40753064900

Fonte `e58574dd3bf33e6338cec3195679eeb9f56286ea`:
https://github.com/710862-beep/porthole/actions/runs/40753064900

- Build, **20 testes Rust**, **5/5 PEs** e controles/diálogos/updown PASS.
  Conversão de caracteres e ABI corrigida foram efetivamente executadas no guest.
- DOOM95 voltou ao launcher, chamou GetUserNameA duas vezes com sucesso e avançou
  para **kernel32!SetCurrentDirectoryA**, salto nulo direto pela IAT em 0x33825.
  48 presents, sem gameplay; último GetDlgItem não foi atribuído como causa.
- Extraída a implementação real em Wine kernelbase/file.c:2964-2972, que chama
  RtlSetCurrentDirectory_U. Adaptação revisada: novo método Host e ponte Rust/JS
  atualizam diretório do processo virtual validando diretórios do VFS autorizado.
  A mesma base passa a resolver opens/stat relativos; não é sucesso vazio nem
  alteração do diretório do sandbox/host OS.
- Fixture input adiciona criação de diretório, mudança relativa, arquivo relativo,
  erro em arquivo/nome ausente, restauração e verificação pelo caminho antigo.
  Unitário host verifica erro sem alteração de cwd e rejeita drive não autorizado.
- Próximo candidato ainda depende de ensaio remoto. Sem promoção.

## Portabilidade: fronteiras e tipos

| Família | Dependência Wine | Adaptação / limite |
|---|---|---|
| Recurso | FindResourceA/LoadResource | Range RT_DIALOG existente; handle retrowin32 não confundido com ponteiro Wine |
| Template | DLGTEMPLATE, DLGITEMTEMPLATE (include/winuser.h:2152–2179), DLGPROC (linha 43) | Cursor LE checked; objetos owned não são structs ABI sobrepostas à memória guest |
| Estado | DIALOGINFO (dlls/user32/controls.h:139–148), DIALOG_get_info (defdlg.c:291–313) | Option por HWND; somente subset de campos, sem font/menu/contexto completo |
| Janela | CreateWindowExA/W → win32u/NtUserCreateWindowEx | Mecanismo nativo HWND/Canvas já existente; não copiado syscall NT |
| Callback | SendMessageW e DWLP_DLGPROC | Endereço guest/call_x86, sem borrow mutável atravessando await; W e DWLP completos pendentes |
| Fontes | NtUserGetDC, CreateFont*, SelectObject, GdiGetCharDimensions | Não portados; fallback 8x8 explicitamente registrado |
| Menu/tema | LoadMenuW/NtUserDestroyMenu; updown uxtheme | Menu template rejeitado; temas e sysmenu completo não portados |
| Posicionamento | MonitorFrom*/GetMonitorInfo/ClientToScreen | Monitor/DPI/centralização não equivalentes ao Wine; subset de geometria local |
| Estado global | NtUserSetFocus/ShowWindow/EnableWindow/GetCapture | Parte mapeada ao núcleo; captura, modal owner, thread input não completos |
| Identidade | GetEnvironmentVariableA/W → RtlQueryEnvironmentVariable_U/PEB | Map virtual por processo e blocos owned; não token/conta real do host |
| Encoding | WideCharToMultiByte → codepage tables/RtlUnicodeToUTF8N | CP1252/UTF8 subset; sem todas tabelas best-fit/composição |
| Diretório | RtlSetCurrentDirectory_U | Operação Host/JS no VFS autorizado; sem chdir do host, UNC e drives independentes |

O grafo completo cruza user32/win32u, kernelbase/kernel32, gdi32/gdi32full, ntdll e drivers/servidor Wine; controles adicionais usam comctl32/uxtheme. Isso não é uma lista de DLLs de que o Wasm candidato depende em runtime. Não houve tradução integral desses componentes.

### Revisão manual por grupo de funções adaptadas

| Grupo | ABI/tipos | Ponteiros/memória | Driver/erros | Licença/SHA | Estado de cobertura |
|---|---|---|---|---|---|
| CreateDialogParamA/indirect | HWND/proc/LPARAM 32-bit revisados | Range de recurso limitado; Vec owned; rollback de filhos | Host existente + TEB | Preservados | Subset executado nos fixtures e DOOM |
| ParseTemplate/GetControl | Layout normal/estendido, ID32, alinhamento revisados | Cursor checked; truncamento testado | Erro de dados inválidos | Preservados | Vários ramos, não fuzz/conformidade completa |
| Dispatch/init/tab/text/check | Callback x86 e mensagens revisados | Handles lidos novamente após await | Foco/comandos locais; W/default result incompletos | Preservados | Fixtures de IDs/param/foco/Tab/Enter/texto |
| Updown mensagens/ação | Range invertido, ID/header32 revisados | Buffer NM_UPDOWN no heap liberado após callback | Parent pode cancelar/modificar delta; timers pendentes | Preservados | Range/buddy/tecla testados; não todos os ramos |
| GetUserNameA/W | DWORD tamanho inclui NUL; BOOL revisado | DWORD e buffers checked | TEB/buffer curto/ausência; conta virtual | Preservados | Fixture A/W aprovado |
| Ambiente A/W | Query length/UTF16 e duração revisados | Blocos heap rastreados; double-free rejeitado | Mapa por processo, não lock/PEB Wine | Preservados | ANSI e casefold Unicode parciais |
| WideCharToMultiByte | Corrigida ABI de 7 para 8 argumentos | Offsets/len/default/used checked | 87/122/1004/1113; codepages limitadas | Preservados | Rust+PE de subset aprovados |
| Set/GetCurrentDirectory | Assinatura/recurso Host revisados | Adapter de strings existente; getter checked | VFS autorizado/TEB; testes novos | Preservados | Depende do último CI; não marcar PASS antecipado |

As revisões foram semânticas/manuais com referência ao C real. `translate-c-to-rust.mjs` emite inventário de revisão, **não** Rust executável. Não houve primeira passagem automática declarada como tradução válida. A segurança dos novos parsers não prova segurança de todos os adapters raw do emulador preexistente.

## Quinto/sexto resultados remotos: diretório e enumeração

- Run **40753946252**, fonte edc383a: build falhou no gerador de exports, que não
  aceita o tipo qualificado `crate::str16::AnsiString` na assinatura. Corrigido
  com import do tipo reconhecido, sem substituir export por stub.
- Run **40754153859**, fonte `e6c93719493860b0a7b8311a75e1b0759c4de669`:
  build/20 testes Rust e controles PASS; **4/5 PEs PASS**. O guest input chegou a
  SUCCESS com deltas corretos, mas o flush em disco FALHOU: harness não havia
  materializado C:\Synthetic antes de criar cwd-probe. O gate corretamente
  rejeitou exit 0 com erro de persistência. Setup corrigido para criar a pasta
  declarada, mantendo o gate e adicionando releitura de diretório/marker em disco.
- DOOM95 passou por SetCurrentDirectoryA, chegou a FindFirstFileA e encontrou
  panic **Host.read_dir** (web/glue/src/host.rs:356). 48 presents, gameplay=false.
- Lida/extraída referência Wine FindFirstFileA → FindFirstFileExA/W →
  NtQueryDirectoryFile, arquivo kernelbase/file.c; inventário
  wine-kernelbase-find-extraction.json. Não copiei chamadas NT para Wasm.
- A API Win32 de enumeração continua a implementação existente de retrowin32;
  o trabalho novo é sua **fronteira de plataforma**: snapshot dos filhos imediatos
  do cache VFS autorizado via JSON tipado para ReadDir Rust, com limites/erros,
  nomes e tamanhos reais do overlay. Não é scan do disco arbitrário do host e não
  é uma tradução integral de FindFirstFileExW/NtQueryDirectoryFile.
- FindNextFileA agora usa ERROR_NO_MORE_FILES no fim do iterator; fixture verifica
  criação relativa, enumeração, término, FindClose, restauração e persistência.
  Timestamps virtuais continuam desconhecidos/zero, sem inventar metadados reais.
- Novo ensaio remoto ainda necessário; não marcar cinco PEs novamente aprovados
  até ele terminar.

## Sétimo resultado remoto: 40755132096

Fonte `faf0fb8ab63b0a1a0727fe7022ba8db06151a4c0`:
https://github.com/710862-beep/porthole/actions/runs/40755132096

- Build, 20 testes Rust, **5/5 PEs novamente PASS**, controles/diálogo/updown PASS.
  Input inclui agora flush e releitura reais do cwd-probe/marker, além dos deltas.
- DOOM95 enumerou o WAD no cache autorizado e avançou para
  **kernel32!FileTimeToLocalFileTime**, IAT direta, ip=0x3a7f1.
  Ainda 48 presents/45 mudanças, sem input/loop comprovados; vermelho.
- Extraída a wrapper Wine kernelbase/file.c:4150-4153 e lido o auxiliar real
  ntdll/time.c:242-252: aplica o bias atual da informação de timezone. Adaptação
  usa offset atual do relógio Host existente, com ponteiros guest checked e
  aritmética de ticks; não retorna simplesmente sucesso copiando UTC.
- Helper inverso LocalFileTimeToFileTime incluído; teste verifica ida/volta,
  offsets positivos/negativos e ponteiros inválidos. FileTimeToSystemTime
  preexistente também foi corrigido para não transbordar nanos i64 em 1601:
  usa segundos + nanos via Chrono, sem portar RtlTimeToTimeFields/ReactOS.
- Epoch 1601 é metadado virtual desconhecido/zero; a conversão correta não o
  transforma em timestamp histórico verdadeiro do arquivo DOOM.
- Próximo candidato ainda deve executar remotamente. Não promover.

## Oitavo resultado remoto: 40755999854

https://github.com/710862-beep/porthole/actions/runs/40755999854
Fonte `892c06f655309f6ece309a8754c1319aff2b793d`: build/21 Rust tests PASS,
5/5 PEs PASS e controles PASS. FileTimeToLocalFileTime passou; DOOM95 avançou
para 51 presents/47 mudanças e panic EnableWindow em window.rs:1129.

A adaptação seguinte vem de NtUserEnableWindow/is_window_enabled em
win32u/window.c, não de um retorno TRUE incondicional: WS_DISABLED, valor de
retorno **estado disabled anterior**, WM_CANCELMODE/WM_ENABLE síncronos,
limpeza de foco e repaint cinza dos controles, validação/revalidação do HWND
após callback. Revisão manual: não reter referências Rust durante guest calls;
NULL/broadcast/inválido devem falhar; WM_ENABLE só quando estado muda;
nenhuma notificação de acessibilidade foi inventada. Fixture exercita
false/true/repetição, foco/estado observável e handle inválido. Ainda falta
conformidade completa de foco/capture/WinEvents e ownership entre threads.
Novo build remoto necessário; gameplay continua não validado.

## Nono resultado remoto: 40756848168

https://github.com/710862-beep/porthole/actions/runs/40756848168
Fonte `941c6d1577d10606285d2d267752699c413e054c`: build, 21 Rust tests,
5/5 PEs, controles/diálogo/updown PASS (**58 presents**). EnableWindow passou.
DOOM95 chegou a 57 presents e call EBX=0 em ip=0x34456, sem causalImport
porque o target fora carregado antes do call register. Desassemblagem real de
DOOMLNCH.DLL: RVA 0x4456, EBX carregado de IAT RVA 0x17348; lookup PE dessa
entrada identifica **KERNEL32!CreateMutexA**, não GetDlgItem (último trace).

Mineração seguinte: CreateMutexA/ExA/ExW em kernelbase/sync.c, fronteira NT em
ntdll/unix/sync.c, objeto/ownership em server/mutex.c. Adaptação revisada por
função: `create` compartilha objeto por nome e retorna ERROR_ALREADY_EXISTS;
`ready` compara CPU/thread real; `acquire` incrementa recursão; `release`
valida owner e só libera em zero; `abandon` trata CPUs terminadas e entrega
WAIT_ABANDONED; `close` fecha handle sem soltar referência do owner vivo.
Wait-all consome apenas após todos prontos, cooperativamente, sem await entre
teste e aquisição. ANSI usa o adaptador CP1252 existente, W usa UTF16; nenhum
ponteiro host é exposto ao guest. Nomes são deliberadamente isolados por
processo/Machine; security attributes retornam NOT_SUPPORTED, não sucesso.
Fixtures novas exercitam aliases nomeados, recursão, contenção entre CPUs,
release por não-owner, fechamento e abandono com thread real emulada.
Dois testes Rust de estado/vida complementam, não substituem, o PE remoto.
Novo candidato ainda precisa compilar/executar remotamente. Gameplay não
validado; enumeração Combo 0x14a/0x14c também permanece parcial e diagnosticada.

Run 40757211811 (477a8c1) repetiu 5/5 PEs/controles PASS e o mesmo mutex
faltante; tar de fontes e LICENSE.Wine foram baixados/verificados (464 entradas,
SOURCE_COMMIT correto, licença byte-idêntica). validate-wasm local PASS:
1.989.372 bytes, SHA256 607bf084fc9e627aebb4d12da64aa19ff40ba788d856cff8bc7884f0317fde73,
42 exports/68 imports. Isso valida integridade, não gameplay.

Run 40758473786 (7436bdb) falhou no build nativo: módulo novo mutex.rs omitiu
TRACE_CONTEXT exigido pelo macro dllexport (E0425). Corrigido o contexto de
tracing; nenhuma semântica de mutex foi removida para fazer o build passar.

## Décimo segundo resultado: 40758905273

https://github.com/710862-beep/porthole/actions/runs/40758905273
Fonte b71a3cd: build/23 Rust tests, 5/5 PEs e controles PASS. Mutexes agora
comprovados no PE com contenção/owner/recursão/abandono. DOOM95 passou pelos
mutexes e chegou a **62 presents**, falhando em **dplay.dll ordinal 2**.
Wine dplay/dplay.spec e dplayx/dplayx.spec mapeiam a enumeração ANSI (2).

Adaptação seguinte: DirectPlayEnumerateA/W consulta a chave real do registro
virtual Service Providers, valida GUID/reserved/path e entrega GUID/nome/6/0/
context via callback stdcall real no guest; libera scratch após retorno e
respeita FALSE. Sem chave, lista vazia/DP_OK segue o ramo real Wine
DP_ReadConnections; não lista transportes fictícios. Havendo provedores,
eles geram callbacks (fixture registra **metadados sintéticos**, não DLLs de
transportes). DirectPlayCreate explicitamente falha DPERR_UNAVAILABLE, output
NULL; multiplayer NÃO suportado. UTF16 é aplicado no callback W; nomes A/W
separados; perfil de strings do registro ainda ASCII, non-ASCII indisponível.
Semântica de cache é snapshot por chamada, diferente do InitOnce Wine.

Revisão manual por helper: `reg/status/text` validam retorno Host/tipo/bytes;
`guid` valida formato/tamanho/endian; `providers` fecha handles e rejeita
metadados inválidos; `enumerate` não retém borrow de memória/registro durante
call_x86 e honra parada; `DirectPlayCreate` não fabrica COM/vtable/sucesso.
Callback ABI: 5 DWORDs/stdcall, GUID 16 bytes, string ANSI ou UTF16 terminada.
Regressão usa 2 provedores, callback A/W, parada no primeiro e failure COM.
Nenhum stub de rede bem-sucedido foi introduzido.

Logs também mostravam CB_INSERTSTRING/CB_FINDSTRING não suportados: adaptado
roteamento combo→listbox e busca circular do Wine, com índice/erro, deslocamento
da seleção e retorno do texto selecionado. Fixtures testam início/fim, prefixo
case-insensitive ASCII, exact miss, seleção e índice inválido. Owner-draw,
collation por locale e dropdown interativo completo continuam pendentes.
Extrações são inventários/limites, não declaração de closure integral validada.
Novo build/execução remoto ainda necessário para este candidato.

Run 40760294171 (45e2bf7) detectou dois erros de integração Rust antes de
produzir Wasm: HeapAlloc recebe Result<HeapAllocFlags,u32>, não um inteiro C;
e Mem::as_slice requer o trait Extensions no escopo. Corrigidos seguindo as
chamadas já existentes em updown/env; testes não foram pulados/relaxados.
