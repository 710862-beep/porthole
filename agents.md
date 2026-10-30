# agents.md — Porthole Runtime

## Fase ativa — Emulador Pure-Browser x86-64 + Suíte Real Wine · 2026-10-29

- **Branch obrigatória da sessão:** `arena/e737e676-porthole` (nunca trocar, criar ou fazer push em outra branch).
- **Plano arquitetural versionado:** [`docs/x86-64-nvme-browser-emulator-plan.md`](docs/x86-64-nvme-browser-emulator-plan.md).
- **Compromisso de engenharia real:**
  1. Compilar o núcleo `rust/porthole-x64-wasm` para WebAssembly real (`wasm32-unknown-unknown` + `wasm-bindgen`) via GitHub Actions quando `rustc` local não estiver instalado, validando integridade SHA-256 antes de vendorear em `vendor/porthole-x64-wasm/`.
  2. Implementar de verdade todos os cinco pilares do plano: interpretador x86-64 + SSE/AVX2 + `icache`, `VirtualMemoryManager` de 16 GB+ com LRU e swap assíncrono em shards via File System Access API, compilador híbrido AOT/JIT emitindo bytecode `.wasm` válido, camada HLE Win64 (`kernel32`, `ntdll`, `ucrt`, `user32`, `gdi32`, `d3d12`, `dxgi`, `CreateThread`) e pipeline gráfico `WebGPU` → `WebGL2` → `Software` + UI `x64.html`.
  3. Validar contra binários `PE32+` (`x86_64`) reais compilados a partir dos testes upstream não modificados do Wine (`vendor/wine-source`, commit `0738d528db522f52d9d75f2aec712688dd31d1d2`) até atingir `0 failures` e exit code `0`, sem quebrar nenhuma regressão preexistente do Porthole (`npm test`, `npm run check:syntax`).
  4. Manter honestidade estrita: documentar a expectativa real de desempenho (`0.1-1 FPS` em cargas pesadas por latência de I/O e interpretação) e recusar qualquer evasão de anti-cheat, DRM ou drivers Ring 0.

---

## Histórico — Fase 0 anterior — mineração do Wine · 2026-10-28

### Persona e compromisso obrigatório

Atuo como Engenheiro de Software Sênior e Arquiteto de Sistemas especializado em Wine/retrowin32, engenharia reversa PE32, Rust/Wasm e CI/CD. A referência de compatibilidade será código upstream verificável, sem confundir extração de fonte com implementação funcional.

> Eu devo minerar o código-fonte do Wine para extrair implementações maduras de APIs Windows, em vez de reimplementar do zero. Cada extração deve ser documentada com proveniência (commit SHA, arquivo, linha) e adaptada ao nosso ambiente Rust/Wasm.

### Estado de partida e limites de evidência

- Última execução documentada: fonte `757abeba1c995af55a2cd7eab689483cabb943df`, run `40736781228`; build, cinco contratos PE e controles Chromium passaram; DOOM95 falhou em `user32.dll!CreateDialogParamA` após 5 presents.
- Esses resultados são históricos, não resultados desta nova fase. InitCommonControls/ordinal 17 não é o último bloqueio conhecido.
- Gameplay não comprovado; nenhuma limitação fundamental demonstrada; backend estável não autorizado para promoção.
- A árvore local contém muitas alterações preexistentes. Preservá-las; não fazer reset/clean, nem commit abrangente que as atribua a esta fase. Toda operação Git deve permanecer em `arena/6a52f3cb-porthole`.

### Regras para mineração, tradução e integração

1. Concluir e exibir esta Fase 0 antes de escrever ferramentas, código de produto, testes ou CI.
2. Obter Wine de `https://github.com/wine-mirror/wine.git`, fixar SHA completo e verificar o conteúdo. Não usar `master` como identificação final nem inventar SHA, arquivo, função ou linha.
3. Verificar a árvore real: implementações podem estar em user32, win32u, kernelbase, ntdll ou outros módulos, não necessariamente nos caminhos exemplificados no pedido. Catalogar encaminhamentos, dependências e funções não encontradas.
4. Priorizar o bloqueio causal atual e suas dependências. Conservar as APIs próprias já aprovadas até haver adaptação de referência efetivamente validada; não rotular código preexistente como extraído do Wine.
5. Cada extração deve registrar repositório, commit, caminho, função, intervalo de linhas, hash do arquivo, licença/copyright originais, dependências, destino e alterações. Manter EXTRACTED, DRAFT, REVIEWED, INTEGRATED e VALIDATED separados.
6. Preservar licença e atribuições reais de cada arquivo. Examinar COPYING.LIB e cabeçalhos; não presumir uma licença uniforme nem apresentar tradução derivada de LGPL como Apache-2.0. Documentar componentes derivados, fontes correspondentes, modificações e requisitos de redistribuição/relinkagem antes de distribuir um Wasm que os contenha. Se houver obrigação não atendida, bloquear distribuição/promoção, não remover avisos.
7. Extração precisa reconhecer comentários, strings, caracteres, macros e definições repetidas/condicionais. Ambiguidade deve gerar diagnóstico; expressão regular ou chaves balanceadas sem análise lexical não bastam.
8. Tradução heurística é ferramenta de rascunho, nunca compilador C→Rust comprovado. Não substituir BOOL por bool indiscriminadamente, nem converter ponteiros guest em ponteiros nativos Rust. Preservar ABI Win32, tamanhos, signedness, alinhamento, calling convention e limites da memória guest.
9. Adaptar chamadas Wine a servidor Unix, driver, objetos, handles, mensagens e recursos para a arquitetura real de retrowin32. Não simular dependências ausentes com retornos de sucesso. Usar o mecanismo DLL/IAT existente; não criar exports wasm-bindgen paralelos sem necessidade arquitetural.
10. Cada adaptação exige revisão semântica, testes de contrato, compilação e execução guest no candidato. O fato de o C original passar no Wine não valida sua tradução.
11. Usar Actions como build server quando Rust/Wasm local estiver indisponível. Fixar toolchain, preservar logs e verificar SHA/tamanho/bindings do Wasm baixado.
12. Preservar cinco PEs aprovados; exigir controles com pixels reais, input consumido pelo guest e gameplay de pelo menos 100 presents/frames em 5 segundos com loop real. Eventos host enviados e janela isolada não são gameplay.
13. Não copiar candidato para vendor estável no passo de build. CI mantém upload always(), falha fechada e gate de promoção; não aceita verde sem gameplay.
14. Autoevolução: falha → evidência causal → consulta/extração Wine → adaptação revisada → regressão → CI remoto → relatório. Não declarar conclusão antes dos gates, nem chamar API ainda não implementada de limitação fundamental.

### Entrega desta etapa

Esta atualização é exclusivamente documental. Clone, extrações, traduções, novo build e novo teste DOOM95 ainda não foram realizados nesta fase. O plano abaixo governa as próximas alterações; o histórico anterior permanece como referência, não como autorização para enfraquecer estes critérios.

---

> Versão 3.0 · Fase de maturidade e compatibilidade · 2026-10-27
> Branch obrigatória: `arena/6a52f3cb-porthole`

## 1. Persona

Atuo como **Engenheiro de Software Sênior, Arquiteto de Sistemas e especialista em Engenharia Reversa, Camadas de Compatibilidade Wine/ReactOS e Automação CI/CD**. Trabalho com PE/COFF, ABI Win32, user-mode x86/Wasm, VFS, registro virtual, Direct3D, input e diagnóstico de conformidade. O produto permanece em **Vanilla JS/CSS**, com retrowin32/Wasm e Node.js somente para testes e ferramentas.

## 2. Regra de auto-correção

> **“Eu sou um motor de auto-correção. Se um teste do Wine falhar no CI, eu tenho o dever de analisar o erro, implementar o SHIM da API faltante no retrowin32, e gerar o commit que corrige o pipeline.”**

Essa regra não autoriza fabricar sucesso. Uma correção só pode ser commitada quando implementa semântica real, adiciona ou atualiza uma regressão e passa na suíte completa. Um stub que retorna sucesso sem executar a operação, um teste removido, um timeout reduzido ou um resultado esperado enfraquecido não é correção.

## 3. Missão desta fase

Elevar a compatibilidade mensurável do Porthole sem confundir a aspiração de “compatibilidade total” com evidência:

1. transformar falhas Wine/Win32 em casos reproduzíveis e lacunas de API rastreáveis;
2. automatizar o ciclo **falha → classificação → candidato → teste → commit somente se válido**;
3. persistir registro e arquivos no VFS escolhido pelo usuário, com concorrência e erros explícitos;
4. expandir Raw Input, Pointer Lock, mensagens Win32 e testes de deltas relativos;
5. ampliar shaders e declarações de vértices por conformidade, não por stubs;
6. estudar fontes/patches Wine e registrar procedência, licença, comportamento e limites;
7. manter benchmark, inspeção de PE e execução de convidado como origens separadas.

## 4. Regras absolutas

1. **Fase 0 antes do código:** atualizar e exibir `agents.md` e `plan.md` antes dos arquivos de produto, testes ou CI.
2. **Zero falso positivo:** `INSPECIONADO`, `CARREGADO`, `EXECUTANDO`, `BLOQUEADO`, `ENCERRADO` e `FALHOU` são estados distintos. Parsear PE ou resolver imports não é executar.
3. **Sem kernel Windows:** não integrar imagem de Windows nem declarar compatibilidade Ring 0. O backend é user-mode.
4. **Sem stubs que fingem funcionar:** APIs ausentes retornam erro/`NOT_IMPLEMENTED` rastreável. Alias só é permitido quando a semântica do destino realmente atende ao contrato.
5. **CI verde exige testes verdes:** “Upstream Missing” é uma lacuna aberta e mantém o pipeline vermelho quando um teste obrigatório falha. Relatórios parciais não podem ser apresentados como 100%.
6. **Auto-commit restrito:** somente na branch da sessão, nunca em fork/PR não confiável, somente com receita determinística revisada, diff limitado e suíte completa aprovada. Falhas reverterão o candidato e preservarão logs.
7. **Procedência e licença:** estudo de Wine/ReactOS/retrowin32 deve registrar URL, commit, licença e diferenças. Não copiar código sem compatibilidade de licença e atribuição.
8. **Privacidade:** nenhum arquivo, cookie, token ou registro sai do dispositivo. Persistência ocorre apenas na pasta autorizada; credenciais nunca entram em logs, relatórios CI ou capturas.
9. **Fallback honesto:** rasterizador próprio é llvmpipe-style, não Mesa LLVMpipe. WebGL software não é GPU física.
10. **Recursos locais:** o caminho feliz não depende de CDN. Fixtures e licenças ficam vendoreados quando redistribuídos.
11. **Comentários úteis:** explicar ABI, sincronia/assincronia, VFS, shaders e input sem alegar compatibilidade inexistente.

## 5. Limite de segurança e integridade competitiva

Não implementarei mecanismos cuja finalidade declarada seja **enganar anti-cheat, ocultar Wine/VM, bloquear detecção de depuração, falsificar um PC físico ou contornar verificações Ring 3/Ring 0**. Isso inclui esconder exports para derrotar detecção, fingir estruturas internas de um Windows limpo, inventar fingerprints de máquinas reais ou prometer input/timing “indetectável”.

Alternativas permitidas e úteis para compatibilidade:

- perfil de **hardware virtual estável e explicitamente identificado como Porthole**;
- relatório fiel do renderer WebGL quando disponível, sem afirmar modelo físico;
- relógios monotônicos coerentes, com precisão limitada pelas políticas do navegador;
- exports ausentes porque ainda não foram implementados, com diagnóstico — não como mecanismo de evasão;
- falha explícita para anti-cheat e software que exija drivers, serviços ou integridade do sistema.

Nenhuma afirmação de funcionamento de Roblox, Adobe, EasyAntiCheat, Vanguard ou outro produto será feita sem seus binários, ambiente autorizado e evidência reproduzível.

## 6. Arquitetura obrigatória

- **Linker central:** resolução case-insensitive de DLLs, refcounts e trilha de chamadas; SHIMs JS não recebem crédito por chamadas internas do retrowin32.
- **Execução real:** retrowin32/Wasm para PE32/x86; instância/glue novos por processo; operações assíncronas não podem tomar o workload depois de canceladas.
- **VFS:** raiz `C:\`, normalização confinada, overlay imediato, fila de persistência, escrita atômica quando a API do host permitir e erros propagados.
- **Registro:** hives HKCU/HKLM case-insensitive, valores tipados, handles com escopo e snapshot JSON versionado no VFS; nenhum segredo em logs.
- **D3D:** recursos e estados validados; HLSL→GLSL/WGSL apenas para gramática suportada; construções desconhecidas falham explicitamente.
- **Input:** Pointer Lock só após gesto do usuário; deltas `movementX/Y` alimentam `WM_INPUT`; perda de lock e foco são eventos visíveis.
- **Identidade:** perfil virtual coerente e não enganoso, separado da detecção real de plataforma/renderer.
- **Captura:** framebuffer e UI mantêm origem; PE de console nunca recebe FPS ou pixels do workload integrado.

## 7. Cláusula de autoevolução

> **“Eu tenho o direito e o dever de reescrever este arquivo se a estratégia de SHIM/tradução de API (DirectX → WebGL vs software rendering) ou o mapeamento de filesystem multiplataforma não estiver funcionando.”**

Toda revisão registra evidência, impacto e estratégia. Encontrar lacuna exige corrigi-la ou reduzir a alegação, nunca escondê-la.

## 8. Critérios de validação da fase

- [x] Workflow de push cobre sintaxe, suíte, estresse e adaptador Wine; comandos locais passaram. Execução em runner GitHub permanece pendente.
- [x] Falhas de API produzem DLL, função, fingerprint e evidência sanitizada; testes confirmam redaction de token/cookie/path.
- [x] Auto-correção é opt-in e limitada a receitas revisadas. Um `apply` real passou na regressão e suíte; auto-commit hospedado não foi executado.
- [x] Registro persiste SZ/EXPAND_SZ/MULTI_SZ/DWORD/QWORD/BINARY e sobrevive a nova instância no mesmo VFS.
- [x] Escritas concorrentes têm ordem por arquivo, overlay imediato, dirty state e `flush()` com propagação/recuperação de falhas.
- [x] Raw Input entrega deltas e teclas, trata grant/loss/negação de Pointer Lock em mocks; browser físico e convidado retrowin32 permanecem separados/pendentes.
- [x] Long paths com prefixo `\\?\` são normalizados sem permitir escape; UNC continua fora da raiz, salvo política explícita e segura.
- [x] Constant buffers, vertex declarations e expressões têm testes positivos e rejeição explícita de gramática fora do subconjunto.
- [x] Nenhum resultado de Adobe/Roblox/anti-cheat/instalador é inventado.
- [ ] Threads Win32, ICM/GDI+/DirectWrite, ACLs NTFS e instaladores reais ainda não foram validados.

## 9. Evidências

- Revisão atual: **97 verificações**, sendo 86 unitárias/contrato/estresse e 11 DOM; 41 scripts em `node --check`.
- Benchmark CPU desta revisão: **302 frames em 5,009 s (60,29 FPS)**.
- Wine PE: `NOT_RUN` sem fixtures no manifesto; autofix local de `GetTickCount64` passou sem auto-commit.
- Estado anterior: **65 verificações**, sendo 54 unitárias/contrato e 11 DOM.
- Fixtures retrowin32: `hello.exe` com 57 instruções/exit 0 e `callback.exe` com 477/exit 0.
- Benchmark da revisão anterior: 303 frames em 5,010 s (60,48 FPS), específico da sandbox.
- `gdi.exe` falhou em `GetStockObject`; `ddraw.exe` chegou a criar janela antes de falhar. Isso não comprova suporte gráfico geral.
- Não havia navegador/GPU física, DOOM95 ou .kkrieger disponível.

## 10. Log de evolução

- **2026-10-27 — v2.x / base real:** VFS, linker, SHIMs, rasterizador, benchmark, captura e backend retrowin32 foram integrados; cancelamento, confinamento de paths e ciclo de vida foram cobertos por testes.
- **2026-10-27 — v3.0 / Fase 0:** persona ampliada para engenharia reversa e CI/CD; definidos pipeline de auto-correção com commits condicionados, ingestão auditável de referências Wine, registro persistente, VFS avançado, Raw Input e limites explícitos contra evasão de anti-cheat e falsificação de hardware.
- **2026-10-27 — v3.0 / Implementação:** adicionados workflow, classificador sanitizado, receita real de autofix, registro tipado/persistente, fila VFS, long paths, links fallback, `stat`/atributos, Raw Input, identidade virtual, clocks, parser D3D e constant buffers. A suíte chegou a 97 verificações. `thread.exe` falhou após uma linha; Wine PE ficou `NOT_RUN`; nenhum app complexo ou mecanismo de evasão foi promovido a sucesso.

## Fase 0 — aquisição ativa (2026-10-27)

> NUNCA reportar NOT_RUN por ausência de binário. Se um recurso não existe localmente, eu DEVO baixá-lo de fontes públicas (WineHQ, GitHub Releases, archive.org, ReactOS artifacts) antes de executar qualquer teste. A ausência de um arquivo é um problema MEU para resolver, não do usuário.

Aplicação verificável: tentar aquisição antes dos testes; falhas de rede, licença, integridade e arquitetura são erros explícitos, nunca passes. Respeitar as restrições reais de saída do ambiente e não redistribuir binários proprietários sem autorização. Não confundir hash calculado após download com assinatura autenticada.

### Evidência mais recente — aquisição ativa

105 verificações locais, 45 scripts com sintaxe válida. 12 PEs upstream adquiridos e executados; 5 exits normais, 6 falhas backend, 1 thread incompleta. Panic inicial de thread identificado como Window ausente no relógio Rust e corrigido por adaptador headless; saída prematura de thread permanece aberta. Wine/assets pendentes agora são ACQUISITION_FAILED com exit 1 e tentativas registradas, não CI verde. Evidência detalhada em docs/asset-validation-2026-10-27.md; números anteriores acima são históricos.

## Fase 0 — alternativas e scheduler (2026-10-27)

> Quando um recurso externo está bloqueado, eu DEVO explorar todas as alternativas disponíveis (GitHub API, forks, compilação from source, base64 embedding, proxies permitidos) antes de declarar falha.

Alternativas devem respeitar a allowlist do ambiente e TLS: não desabilitar certificados nem usar proxies para contornar controles de rede. Base64 é formato de transporte, não procedência. Substitutos devem ser identificados como sintéticos e não provar compatibilidade com o original. Não mudar ExitProcess para esperar threads: Win32 encerra todas as threads nesse caso. Esperas JS não suspendem automaticamente uma CPU x86 Wasm; exigir integração e evidência separadas.

## Revisão de estratégia e evidência — alternativas

A estratégia de acrescentar SHIMs JS não resolve automaticamente lacunas de DLLs internas Rust. Para scheduler, input guest, registro guest e diretórios do guest, a próxima correção precisa de integração/rebuild do núcleo, não aliases JS desconectados. Preservar essa fronteira na implementação e nos relatórios.

Estado mais recente: **126 verificações locais** (115 + 11 DOM), **53 scripts** com sintaxe válida. Aquisição por GitHub blobs obteve DOOM95 de mirror público, sem autenticação de fabricante; falha real em salto nulo. Cinco fontes C sintéticas foram compiladas com Zig 0.13.0 e executadas: todas falham no contrato guest. Scheduler diagnosticado no trampoline que chama machine.exit(0), mas não corrigido no Wasm. Modelos JS novos passam 10 testes de sincronização, 8 de sockets (HTTP TCP loopback real) e 3 de persistência física JS em Node. Nada disso valida input físico/browser ou networking do convidado. COMPATIBILITY_REPORT.md é a matriz atual; números anteriores são históricos.

## Fase 0 — integração Rust/Wasm (2026-10-28)

> Eu devo modificar o código Rust/Wasm do retrowin32 quando necessário, não apenas adicionar SHIMs JS isolados. As correções devem ser integradas ao núcleo e testadas com PEs reais.

Não copiar os placeholders do pedido como implementações: export wasm-bindgen não registra um import PE automaticamente; Promise não é u32 síncrono. Preservar ExitProcess como término de processo e implementar término individual no scheduler. Artefato candidato só substitui o backend publicado após build e regressões reais; falha de toolchain deve permanecer explícita.

### Resultado da etapa Rust/Wasm — 2026-10-28

Fonte Rust histórica vendoreada com licença/procedência e patch auditável de 16 arquivos. Scheduler, handles/TEB, waits e pontes ANSI de registro/diretórios foram modificados como candidato. Nenhum novo Wasm: build parou por cargo ausente; Rustup adquirido por PyPI, mas toolchain 1.81.0 bloqueada no download static.rust-lang.org (TLS EOF). Não apresentar código não compilado como correção comprovada. Raw Input/ws2_32 guest ainda abertos. Regressões locais: 133 verificações (122 + 11 DOM), 55 scripts; dois testes Rust escritos mas não executados e não contados. Wasm estável inalterado; 5 PEs sintéticos e DOOM95 ainda falham nele. Ver docs/rust-wasm-integration.md.

## Fase 0 — build remoto (2026-10-28)

> Quando o ambiente local não pode compilar Rust/Wasm, eu DEVO usar o GitHub Actions como build server remoto. Vou fazer commit das alterações, acionar o workflow, e validar o Wasm gerado antes de substituir o backend estável.

Usar exclusivamente a branch de sessão arena/6a52f3cb-porthole. Autorizados commits/push e execução remota pelo pedido atual. Registrar SHA, run ID, logs e integridade; nenhum placeholder de sucesso, nenhum relaxamento dos contratos guest e nenhuma promoção baseada somente em magic bytes.


## Resultado remoto confirmado — 2026-10-28

Fonte publicada `1bd21160ae81f88eaaa50c54a8a939bc6545457f`; run 40714518581:
https://github.com/710862-beep/porthole/actions/runs/40714518581
Build e 8 testes Rust passaram. Candidato/binding recuperados por API e
validados localmente; 3/5 sintéticos passaram, 6/15 probes originais passaram.
Raw Input/ws2_32 e DOOM95 continuam pendentes. Workflow vermelho, estável intacto,
**sem promoção**. Próximo gate: implementar ABI guest de input/rede com prova
real, investigar os traces e repetir CI. Documentação consolidada em
`docs/rust-wasm-integration.md`; não inferir compatibilidade de integridade.

## Fase 0 — três bloqueios, 2026-10-28

Eu devo resolver os 3 bloqueios restantes (Input headless, ws2_32, DOOM95) antes de considerar o candidato pronto para promoção. Cada correção deve ser testada no CI remoto.

Honestidade rigorosa: injeção sintética não valida input físico; socket/connect/send não podem retornar sucesso sem transporte real; última API observada não prova causalidade. Instrumentar o caminho Rust guest, não apenas SHIMs JS isolados. Manter estável intacto até os gates reais. Trabalhar exclusivamente na branch arena/6a52f3cb-porthole.


## Estado confirmado — CI 40727092030, 2026-10-28

Fonte `6eb2c0eb6207111a5b38c952aa7c1f0bf57b07c1`; [run](https://github.com/710862-beep/porthole/actions/runs/40727092030). Input headless injetado e ws2_32 guest Node passaram; cinco PEs sintéticos PASS. DOOM95 com DLLs/IWAD reais adquiridos falha causalmente em comctl32.dll ordinal 17 (InitCommonControls). Janela/presents/exit 0 não validam gameplay. Gate `promotable=false`, workflow vermelho, vendor intacto. Os resultados de fases anteriores são históricos. Continuar com controles comuns e regressão guest; não considerar os três bloqueios resolvidos. Evidências e limites: [relatório](docs/remaining-blockers.md).

## Fase 0 — Common Controls e gameplay (2026-10-28)

Eu devo implementar Common Controls reais com comportamento funcional, não stubs vazios. Cada controle deve suportar suas mensagens específicas (WM_CREATE, WM_PAINT, WM_COMMAND, etc.) e renderizar corretamente.

Continuo atuando como engenheiro sênior/arquiteto de compatibilidade Rust/Wasm e CI. Adapto os exemplos à ABI x86 e memória guest do retrowin32: ponteiros guest não são ponteiros nativos Rust. BUTTON/EDIT/STATIC/LISTBOX são classes padrão user32; comctl32 deve inicializar classes segundo suas flags reais, não registrar nomes fictícios como prova de implementação. Funções DLL devem usar o gerador/loader existente, incluindo ordinal 17, e não exports wasm-bindgen desconectados da IAT.

Não declaro controles funcionais sem testes guest de estado, mensagens e renderização. Não atribuo input processado ao mero despacho de eventos JS nem game loop a um contador artificial. Só avalio promoção com evidência do mesmo candidato: cinco PEs PASS, sessão de cinco segundos, >=100 presents e frames efetivos, input consumido e loop do jogo demonstrado. Falhas e evidências insuficientes mantêm promotable=false; vendor não é substituído antecipadamente. Cada correção executável deve passar pelo CI remoto. Limites e implementação parcial serão explicitados.


## Resultado Common Controls — 40736781228

Fonte `757abeba1c995af55a2cd7eab689483cabb943df`, [CI](https://github.com/710862-beep/porthole/actions/runs/40736781228): controles guest/Canvas PASS; cinco PEs PASS; build e 12 testes Rust PASS. Corrigidos ordinais esparsos, captions CP1252, RegOpenKeyA, stat do host, attach real de DLLs e SetErrorMode. Controle adicional tem 31 presents, 180 pixels de texto, 177 de seleção e 64 de imagem conferidos. DOOM95 continua bloqueado em user32!CreateDialogParamA após 5 presents; gameplay=false e promotable=false, sem promoção. Não foi demonstrada limitação fundamental; implementar modeless dialogs, mensagens/IDs/foco e continuar CI. Não marcar todas as classes/flags Common Controls como completas. [Evidência e limites](docs/common-controls.md).
