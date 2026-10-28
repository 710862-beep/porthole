# plan.md — Porthole Runtime v3.0

> Fase de maturidade, compatibilidade e automação · 2026-10-27
> Branch: `arena/6a52f3cb-porthole`

## 1. Objetivo e critério de verdade

Transformar o Porthole em uma camada de compatibilidade progressivamente mais ampla, medindo cada avanço por binários e testes reproduzíveis. **“100% dos testes” significa 100% dos testes declarados e executados, não compatibilidade universal com Windows.** Adobe, Roblox e anti-cheats não serão marcados como suportados sem evidência.

A base preservada contém retrowin32/Wasm para PE32/x86, VFS confinado, linker/SHIMs JS, renderização WebGL/CPU e 65 verificações anteriores. Benchmark, inspeção e execução continuam separados.

### Limite de escopo

Não serão implementadas evasão de anti-cheat, ocultação de Wine/VM, falsificação de hardware físico ou mecanismos “indetectáveis”. O trabalho de identidade será um perfil virtual coerente e explícito; timing será monotônico e documentado. Software que dependa de driver/Ring 0 ou integridade de Windows permanece fora do escopo.

## 2. Arquitetura de CI/CD de auto-correção

### 2.1 Pipeline obrigatório em todo push

Workflow: `.github/workflows/porthole-ci.yml`.

1. checkout com histórico suficiente para diff e procedência;
2. Node.js LTS e `npm ci`;
3. `node --check` em todos os scripts de produto/ferramentas;
4. suíte unitária, contratos WebGL, DOM e regressões existentes;
5. testes de estresse de memória, VFS concorrente e threads/tarefas independentes;
6. adaptador Wine: executa fixtures PE Win32 disponíveis e/ou testes semânticos derivados, registrando exatamente quais binários foram executados;
7. relatório JUnit/JSON com duração, ambiente, falhas e APIs ausentes;
8. upload de logs sanitizados e relatório de lacunas.

Nenhum passo opcional pode ser apresentado como uma suíte Wine completa. Se `winetest.exe` ou DLLs de teste não estiverem disponíveis, o relatório dirá `NOT_RUN` e explicará como fornecê-los. Testes obrigatórios ausentes não serão convertidos em `PASS`.

### 2.2 Adaptação de testes Wine

Ferramentas propostas:

- `tests/wine/run-winetests.mjs`: descoberta de manifesto, execução pelo `PortholeRuntime`/retrowin32, timeout, stdout/stderr, exit code e contador de instruções;
- `tests/wine/manifest.json`: binário, SHA-256, licença, origem, argumentos, timeout e subtestes esperados;
- `tests/node/maturity.test.mjs` e demais regressões identificadas nas referências: comportamento Win32 **Wine-derived**, não `winetest.exe`;
- `ci/report-wine.mjs`: JUnit/JSON e fingerprints estáveis, sem conteúdo de arquivos ou valores de registro.

O adaptador deve distinguir `PASS`, `FAIL`, `TIMEOUT`, `UNSUPPORTED_PE`, `MISSING_API`, `BACKEND_ERROR` e `NOT_RUN`.

### 2.3 Classificação e auto-correção

`ci-autofix.sh` e módulos em `ci/` implementam:

1. **Isolar API:** reconhecer formatos como `missing DLL!Function`, `GetProcAddress failed` e `NOT_IMPLEMENTED`; normalizar `kernel32!GetFileAttributesExW` sem aceitar texto arbitrário como código.
2. **Fingerprint:** agrupar por teste + DLL + função + categoria, evitando commits duplicados.
3. **Candidato:** consultar receitas determinísticas revisadas em `ci/shim-recipes.json`. Uma receita só pode gerar implementação real para um contrato já suportado pelas primitivas do host.
4. **Scaffold não executável:** para API desconhecida, gerar somente relatório/template fora do caminho de produção, marcado `Upstream Missing`; nunca um retorno de sucesso fictício.
5. **Regressão:** toda receita exige teste específico antes de ser elegível a commit.
6. **Reexecutar:** rodar primeiro o caso isolado e depois `npm test` + estresse. Se falhar, restaurar o diff do candidato e manter logs.
7. **Commit:** somente se verde, opt-in por variável de repositório, push não oriundo de bot/fork, branch permitida e diff restrito. Commit identifica API, teste e origem. A suíte verde é executada antes do commit; uma nova execução causada pelo push depende das políticas de token do GitHub. Autofix é bloqueado por ator bot e pela marca `[autofix]` para evitar loop.
8. **Falha restante:** classificar `Upstream Missing`, abrir relatório e falhar o pipeline se o teste era obrigatório. “Continuar” significa testar os demais casos, não esconder a falha.

Shell não tentará inferir semântica arbitrária de Win32. Correções novas e complexas continuam exigindo análise de engenharia/agente e revisão.

### 2.4 Proteções do pipeline

- permissões mínimas por job; `contents: write` somente no job opt-in de autofix;
- nenhum autofix em pull requests de fork ou código não confiável;
- paths e identificadores validados antes de criar arquivos;
- logs sem valores de registro, cookies, tokens, arquivos do usuário ou variáveis secretas;
- concorrência por branch para impedir dois bots commitando simultaneamente;
- nenhum teste deletado/relaxado pelo gerador;
- artifacts de candidato separados dos artefatos de release.

## 3. Ingestão de patches e conhecimento Wine

### 3.1 Processo de engenharia reversa

Para cada lacuna:

1. reproduzir com PE/fixture e registrar a chamada observada;
2. consultar documentação Win32 e código Wine/ReactOS/retrowin32 em commit fixado;
3. identificar estruturas, calling convention, Unicode/ANSI, `SetLastError`, handles e efeitos colaterais;
4. verificar licença antes de portar código; preferir reimplementação baseada em contrato quando necessário;
5. implementar no nível correto: SHIM JS para workload integrado ou patch upstream/adaptador para retrowin32;
6. adicionar teste positivo, erro e regressão de ABI;
7. atualizar matriz de compatibilidade.

Fontes de referência não equivalem a código já portado. Nenhum patch será atribuído ao Wine sem link/commit.

### 3.2 Adobe: ICM, fontes e GDI+

Matriz inicial de lacunas, sem promessa de Photoshop/Illustrator:

- **mscms/ICM:** perfis ICC, `OpenColorProfile`, `CreateColorTransform`, `TranslateColors`, intents e prova de cor; fallback deve informar perda de fidelidade.
- **GDI+:** bitmaps, graphics paths, brushes, texturas, fontes, métricas e status codes; Canvas 2D não cobre todo o modelo.
- **DirectWrite/GDI fontes:** coleções, family fallback, métricas, hinting e shaping; browser expõe outra semântica e pode exigir engine adicional.
- **Memória:** heaps, alignment, large-address-aware e pressão de memória; não criar comportamentos “específicos da Adobe” sem trace reproduzível.

A implementação será orientada por testes de API e arquivos fornecidos legalmente. Compatibilidade de instalador não implica compatibilidade do aplicativo.

### 3.3 Roblox/launchers: registro, arquivos e rede

- `advapi32`: HKCU/HKLM, subchaves, valores `REG_SZ`, `REG_EXPAND_SZ`, `REG_DWORD`, `REG_QWORD`, `REG_BINARY`, enums e erros Win32;
- snapshot JSON versionado dentro de `C:\`, escrito por fila persistente e recarregado por nova instância;
- arquivos de sessão são persistidos genericamente se o programa os gravar no VFS autorizado;
- cookies/tokens não recebem tratamento especial, não são lidos pelo Porthole e nunca aparecem em logs;
- networking usa somente APIs do navegador e políticas CORS/origem; não há promessa de compatibilidade com WinHTTP/WinSock completo;
- login/launcher/anti-cheat permanecem não validados até teste real autorizado.

### 3.4 DirectX e shaders

Módulo `shims/d3d_translate.js` com front-end incremental:

- tokens HLSL e rejeição de sintaxe desconhecida;
- `cbuffer`/constant registers, packing explícito e alinhamento documentado;
- semantics de entrada/saída e vertex declarations, incluindo tipos normalizados;
- operações vetoriais/matriciais suportadas e swizzles;
- texturas/samplers somente quando o backend tiver recursos equivalentes;
- GLSL inicialmente; WGSL somente com backend WebGPU correspondente, sem gerar WGSL inutilizado;
- golden tests e erros com linha/coluna.

O tradutor limitado atual permanece como referência; não será substituído por regex que aceite shaders incorretos silenciosamente.

## 4. Identidade de hardware e timing compatíveis

Arquivo `spoof-hardware.js`, apesar do nome solicitado, implementará somente `HardwareIdentity` não enganosa:

- perfil versionado e estável por instalação, com fabricante/modelo virtuais Porthole;
- arquitetura e recursos coerentes com o backend;
- renderer real separado do perfil virtual;
- nenhuma string ASUS/NVIDIA/GenuineIntel apresentada como evidência de hardware físico;
- nenhuma alteração destinada a derrotar WMI, `cpuid`, anti-debug ou detecção Wine;
- `QueryPerformanceCounter`/`GetTickCount` baseados em relógio monotônico, wraparound documentado e resolução real do navegador.

Testes verificam coerência e não repúdio de resultados falsos, não “indetectabilidade”.

## 5. Persistência avançada de VFS

### 5.1 Modelo de escrita

Arquivo `vfs-persist.js`:

1. normalizar e confinar path antes de qualquer handle;
2. atualizar overlay/cache imediatamente para leituras subsequentes;
3. atribuir sequência por arquivo e enfileirar persistência;
4. serializar operações que colidem; ordenar operações independentes quando seguro;
5. FS Access: criar pais, `createWritable`, escrever e fechar; estratégia temporário+substituição quando suportada;
6. fallback: escrita somente em memória, claramente identificada;
7. `flush()` aguarda toda a fila e devolve o primeiro erro sem perder erros posteriores;
8. falha de host mantém overlay marcado como não persistido e nunca reporta sucesso durável.

A API web não oferece todas as garantias de NTFS. Atomicidade, ACLs e durable sync serão descritas pelo que realmente existe.

### 5.2 Edge cases

- prefixo `\\?\` convertido para forma interna sem permitir UNC ou escape;
- componentes longos e paths >260 caracteres, com limites do host explícitos;
- links simbólicos virtuais com grafo, profundidade máxima e detecção de ciclos; nenhum link pode sair de `C:\`;
- atributos/ACLs simulados separados das permissões reais do navegador;
- colisões de case, trailing dots/spaces e nomes reservados documentados;
- instaladores Inno/NSIS somente com fixtures reais: criar árvore, gravar arquivos/registro e entrada de desinstalação não basta para marcar todos os instaladores como suportados.

## 6. Raw Input, cursor e mensagens

Arquivo `input-raw.js`, integrado a `shim-user32.js`:

- `RegisterRawInputDevices`: validar usage page/usage, target window e flags;
- `ClipCursor`: restringir movimento absoluto ao retângulo do canvas enquanto houver foco;
- Pointer Lock somente em gesto do usuário e somente quando o convidado solicitar captura;
- `mousemove`: usar `movementX/Y` para `WM_INPUT`; acumular deltas sem depender da posição absoluta;
- `keydown/keyup`: `WM_KEYDOWN/WM_KEYUP`, respeitando foco e prevenindo default apenas quando apropriado;
- `pointerlockchange`, `blur` e `visibilitychange`: liberar estado, publicar perda de captura e impedir deltas fantasmas;
- `GetRawInputData`: header e payload como objetos JS; o layout binário completo de `RAWINPUT` permanece fora do subconjunto;
- mocks de Pointer Lock em Node/jsdom não serão apresentados como teste físico de cursor.

Teste obrigatório: sequência de movimentos `(+5,-2)`, `(-3,+7)` produz deltas e soma `(+2,+5)`, sem eventos após perda de lock.

## 7. Estrutura de arquivos desta fase

```text
.github/workflows/porthole-ci.yml  Pipeline de testes e autofix opt-in
ci-autofix.sh                      Entrada segura do classificador/corretor
ci/                                Parser, receitas, relatórios e sanitização
shims/registry.js                  advapi32 e hives persistentes
shims/d3d_translate.js             Front-end HLSL incremental
vfs-persist.js                     Fila e política de persistência
spoof-hardware.js                  Identidade virtual não enganosa
input-raw.js                       Raw Input, ClipCursor e Pointer Lock
tests/wine/                        Adaptador e casos Wine-derived
tests/node/                        Regressões, DOM e estresse
```

## 8. Fases de execução

| Fase | Estado nesta revisão | Evidência e pendência |
|---|---|---|
| 0 | Concluída | `agents.md` + `plan.md` atualizados/exibidos antes do código |
| 1 | Implementada localmente | Workflow, parser, sanitização, estresse e relatórios criados; autofix real aprovado para `GetTickCount64`. Runner GitHub/commit automático hospedado ainda não executado; Wine PE `NOT_RUN` sem fixtures |
| 2 | Parcial | HKCU/HKLM/HKU/HKCR, valores tipados, recarga, referências Wine, packing de cbuffer, layouts e parser de expressões. Adobe/GDI+/ICM/DirectWrite, networking e apps reais continuam lacunas |
| 3 | Alternativa segura concluída | Identidade explicitamente virtual e clocks monotônicos; nenhuma evasão de anti-cheat/VM/Wine implementada |
| 4 | SHIM JS implementado | Deltas/mensagens/perda/negação de lock testados com mocks. Browser físico e Raw Input de convidado retrowin32 continuam pendentes |
| 5 | Parcial avançado | Concorrência, flush/erro, long paths, `stat` e links fallback testados. ACLs NTFS, persistência física e instaladores Inno/NSIS reais pendentes |
| 6 | Não validada | Nenhum instalador, Adobe ou Roblox real foi fornecido/executado; não há alegação de compatibilidade total |

## 9. Riscos e resposta

| Risco | Resposta |
|---|---|
| CI gerar stubs e ficar artificialmente verde | Receitas revisadas, regressões obrigatórias, suíte completa e diff restrito |
| Ausência de binários Wine ser confundida com PASS | Estado `NOT_RUN` explícito e matriz separada para Wine-derived |
| Commit recursivo de bot | Autofix bloqueado por ator bot + marca `[autofix]` e concorrência por branch |
| VFS assíncrono contradizer leitura Win32 síncrona | Overlay imediato + preload + fila + flush e erro de durabilidade |
| Registro/credenciais vazarem em logs | Sanitização estrutural; nunca registrar valores |
| Pointer Lock exigir gesto/foco | Estado `blocked` visível e requisição apenas no evento permitido |
| Canvas/WebGL não cobrir DirectX/GDI+ | Falha explícita e matriz por API |
| “Perfil de hardware” virar evasão | Identidade virtual explícita, sem fingerprints reais ou ocultação |
| Compatibilidade total virar marketing | Somente resultados reproduzíveis e limites publicados |

## 10. Definition of done incremental

Uma etapa só termina quando:

- implementação e testes estão na branch `arena/6a52f3cb-porthole`;
- a suíte existente continua verde;
- novos testes cobrem sucesso e falha;
- README e matriz de compatibilidade refletem o que realmente executou;
- nenhum segredo ou binário proprietário foi adicionado;
- nenhuma pendência física foi convertida em validação por mock;
- mudanças e contagens finais são registradas neste plano.

## 11. Resultado medido desta revisão

- `npm run check:syntax`: **41 scripts** aprovados.
- `npm test`: **97 verificações** aprovadas, sendo **86 unitárias/contrato/estresse** e **11 DOM**.
- Benchmark CPU: **302 frames em 5,009 s (60,29 FPS)**; medida local, não promessa para outros dispositivos.
- `npm run test:wine`: **NOT_RUN**, pois o manifesto não contém binários Wine; JSON e JUnit foram gerados sem converter ausência em PASS.
- Autofix: falha controlada de `kernel32!GetTickCount64` foi isolada, a receita gerou implementação + regressão, e o candidato passou na regressão isolada e na suíte completa. Não foi usado `--commit` localmente.
- Estresse: 96 blocos de memória, 88 escritas/65 arquivos e quatro processos Wasm independentes; o último caso não é apresentado como threads Win32.
- Sondagem `thread.exe`: uma linha de stdout seguida de `RuntimeError: unreachable`; threads Win32 permanecem pendentes.
- Nenhum teste em navegador/GPU física, GitHub Actions hospedado, Adobe, Roblox, anti-cheat ou instalador Inno/NSIS foi realizado.

## Fase 0 — aquisição, diagnóstico e validação real

1. Criar downloader com descoberta de releases/árvore GitHub, fallbacks, validação MZ/PE, hashes SHA-256 e manifesto auditável. Manter downloads fora do Git. Falhar explicitamente quando qualquer asset obrigatório não puder ser obtido; salvar tentativas mesmo com falha parcial.
2. Buscar Wine PE32, jogos, executáveis upstream retrowin32, aplicações abertas e instalador. Não substituir Minesweeper/Notepad proprietários por outro produto sem identificá-lo. Hosts externos bloqueados serão documentados como restrição de aquisição.
3. Inspecionar CreateThread/TLS/sincronização no commit exato upstream e reproduzir thread.exe com saída, hash e erro. Só corrigir o backend se houver acesso ao estado CPU/scheduler e ferramenta de rebuild; adicionar SHIM JS isolado não corrige automaticamente o Wasm.
4. Executar Wine somente com binário real e registrar falhas de loader separadas de asserts Wine. Não contar cinco invocações que falham no loader como cinco suítes concluídas.
5. Validar input de convidado com rastros reais; DOOM95 antecede Raw Input e pode não importar RegisterRawInputDevices. Exigir browser real para captura física e persistência autorizada no host.
6. Registro Roblox/Adobe será cenário sintético com tokens artificiais, não login real. WinSock no browser requer transporte explícito (proxy/WebSocket/HTTP); não prometer TCP arbitrário via fetch.
7. CI fará aquisição antes dos testes e preservará relatórios inclusive quando downloads falharem. Sem commits/push remotos implícitos.

## Resultado da etapa de aquisição ativa

- Fase 0 concluída antes do código; downloader e probes reais implementados, CI integrado.
- Aquisição parcial: 12 PEs retrowin32; Wine/jogos/Windows/apps/instalador bloqueados por 404, hosts e redirects não autorizados. Manifesto detalha tentativas. Descoberta de mirrors/arquivos compactados e Wine GitLab ainda pendentes.
- Identificada causa do trap imediato: ticks() faz unwrap de Window em Node. Adaptador explícito de clock corrige o panic sem alterar Wasm; novo probe detecta exit 0 prematuro como INCOMPLETE_THREAD_EXECUTION, não PASS.
- 105 verificações locais (94 + 11 DOM), 45 scripts sintaticamente válidos. Probes: 5 exits normais, 6 falhas, 1 thread incompleta. Wine retorna exit 1 / ACQUISITION_FAILED com zero asserts executados.
- Fases 2–4 não concluídas; não há alegação de suporte a threads completas, jogos, instaladores ou WinSock. Ver docs/asset-validation-2026-10-27.md.

## Fase 0 — alternativas e scheduler: plano da próxima implementação

1. Explorar GitHub Release Asset API com Accept application/octet-stream e downloads de blobs versionados; registrar redirects e resultados. jsDelivr está fora da allowlist, portanto registrar indisponibilidade sem usar proxy não autorizado. Manter verificação TLS.
2. Inspecionar ferramentas de compilação locais e disponibilizar fontes C de PEs sintéticos com build PE32 reproduzível. CI pode instalar MinGW/NSIS, mas a execução local só será declarada quando realmente ocorrer. Substitutos não equivalem a Wine nem jogos originais.
3. Investigar revisão histórica do Wasm, criação/término de CPU e semântica de esperas. Instrumentar logs existentes sem atribuir chamadas Rust a SHIMs JS. Não transformar ExitProcess em join implícito.
4. Separar modelo JS de sincronização e transporte de rede da ABI guest. Adicionar testes de semântica, timeout e falhas; nunca declarar TCP browser com fetch. Networking depende de transporte autorizado injetado.
5. Acrescentar validações PE sintéticas, workflow e relatório com estados distintos: compilado, executado, incompleto, falhou e não integrado. Preservar falhas obrigatórias em CI e artefatos diagnósticos.

## Resultado — alternativas e scheduler

- Fallbacks implementados e exercitados: Release Asset API octet-stream (redirect ainda bloqueado), buscas Wine/forks/builds e árvores/blobs GitHub. DOOM95 de mirror público obtido, hash/árvore registrados. Fontes/proxies/CDNs fora da allowlist não foram usados para evasão de rede.
- Zig 0.13.0 obtido por PyPI; cinco PEs sintéticos x86 compilados e tentados em processos Node isolados. Removido SSE da compilação para não exigir xorps do artefato. Timestamp COFF normalizado nos fixtures próprios; dois builds consecutivos conferidos por hash.
- Fonte histórica inspecionada: retorno de thread chama machine.exit(0), CreateThread usa id fixo, WaitForSingleObject é todo! e WaitForMultipleObjects não é resolvido. Causa do early exit demonstrada; nenhum scheduler Rust/Wasm corrigido ou rebuildado.
- Sincronização e sockets JS independentes implementados e testados; não registrados como implementações guest. Três testes novos validam dados artificiais Roblox/Adobe e cenário de instalação JS com IO físico Node e releitura por novas instâncias.
- Workflow inclui compiler, fetch-with-fallbacks e gates guest separados thread/input/network/registry/installer, todos preservando falhas. Não foi rodado em GitHub Actions hospedado.
- Validação: npm test 126 verificações (115 + 11 DOM), sintaxe 53 scripts, YAML e diff limpos. Wine ACQUISITION_FAILED; 13 PEs adquiridos com 5 exits normais, 7 falhas backend e 1 thread incompleta; 5/5 sintéticos falham no guest. Faltam Wine, .kkrieger, Windows Notepad/Minesweeper, Dependencies e instalador real.
- Próximo bloqueio técnico: preparar toolchain Rust/wasm e uma build auditável com término individual, handles, TEB/TLS e waits reais. Fontes, hipóteses e plano de correção estão em docs/threading-analysis.md. Matriz completa em COMPATIBILITY_REPORT.md. Não declarar todas as alternativas esgotadas nem a fase toda concluída.

## Fase 0 — integração Rust/Wasm (2026-10-28)

1. Inspecionar a fonte histórica correlacionada ao Wasm publicado, suas ferramentas e Cargo.lock; adquirir toolchain por rotas autorizadas ou executar build reproduzível no CI. Registrar revisão, patches, versão rustc/wasm-bindgen e hashes.
2. Implementar término de CPU separado do término de processo, handles de threads e waits com timeout compartilhado/consumo atômico. Retorno de worker não deve simplesmente continuar executando endereço de retorno inválido.
3. Registrar APIs guest no mecanismo dllexport/shims do núcleo; exports wasm-bindgen isolados não resolvem DLL!API. Integrar buffers/pointers e operações do host respeitando memória x86 versus memória Wasm.
4. Diretórios e registro requerem ponte síncrona/overlay com persistência assíncrona confirmada. Input requer layout RAWINPUT e eventos reais; rede exige transporte autorizado, não fetch fingindo TCP.
5. Criar pipeline de rebuild candidato (pacote correto glue, target wasm32, binding com versão coincidente), sem sobrescrever o artefato estável quando build/testes falharem. Executar cinco PEs e DOOM95 contra o candidato, preservando logs e falhas.
6. Atualizar relatório com resultado medido; não alegar sucesso do scheduler nem 5/5 sem saída/estado e persistência comprovados.

## Resultado da integração Rust/Wasm — 2026-10-28

- Fonte histórica correlacionada ao artefato pages foi incorporada em rust/retrowin32 (Apache-2.0), com procedência, lockfile, toolchain 1.81.0 e patch local auditável de 16 arquivos.
- Candidato implementa CPUState::Terminated, handles de thread distintos, TEB/FS por CPU, waits thread/event com deadline único, término individual, validação básica de TLS e clock do host. Registro ANSI usa ponte ao RegistryStore JS; create_dir usa overlay/fila do VFS em vez de panic no host.
- Script rebuild-wasm.sh força regeneração win32-derive + PE DLLs antes de compilar pacote glue e gerar binding 0.2.92. CI ganhou job de rebuild/validação candidato, sem copiar para vendor nem promover automaticamente.
- Build local tentado: BUILD_BLOCKED por cargo ausente. Rustup foi adquirido por PyPI; instalação real de Rust/target falhou em static.rust-lang.org com TLS EOF. Não houve compilação nem execução dos testes Rust (dois escritos), nem produção de novo Wasm.
- 133 verificações locais JS/DOM (122 + 11), 55 scripts; YAML/bash/diff aprovados. PEs sintéticos e DOOM95 reexecutados contra artefato estável, ainda falhando. Raw Input e rede guest continuam não integrados, assim como validação durável entre processos guest.
- Próxima gate obrigatória: executar job rust-wasm-candidate em runner com toolchain/dependências disponíveis, corrigir erros de rustc se houver, validar os cinco contratos sem relaxá-los e somente então avaliar promoção. Documentação detalha limitações; a fase não foi declarada concluída.

## Fase 0 — ciclo remoto (2026-10-28)

1. Auditar o working tree acumulado e registrar a integração na branch obrigatória da sessão; não criar feature/rust-wasm-integration.
2. Criar workflow dedicado com Rust/LLVM/bindgen fixados, geração das DLLs, build candidato, testes guest e artifacts sempre publicados. Criar acionador remoto e validador de integridade.
3. Commit → push da branch da sessão → identificar/acionar run por SHA exato → acompanhar conclusão → capturar logs completos, inclusive falhas de infraestrutura.
4. Corrigir erros concretos e repetir com novo SHA quando possível. Baixar artifacts pelo run ID e verificar SHA256, magic/version e WebAssembly.compile antes dos testes locais.
5. Reexecutar PEs/DOOM95 com Wasm e binding correspondentes, preservar falhas e atualizar relatório com URLs reais. Só promover com contratos completos e regressões aprovados; Raw Input/rede ausentes não serão substituídos por success stubs.


## Resultado remoto confirmado — 2026-10-28

Fonte publicada `1bd21160ae81f88eaaa50c54a8a939bc6545457f`; run 40714518581:
https://github.com/710862-beep/porthole/actions/runs/40714518581
Build e 8 testes Rust passaram. Candidato/binding recuperados por API e
validados localmente; 3/5 sintéticos passaram, 6/15 probes originais passaram.
Raw Input/ws2_32 e DOOM95 continuam pendentes. Workflow vermelho, estável intacto,
**sem promoção**. Próximo gate: implementar ABI guest de input/rede com prova
real, investigar os traces e repetir CI. Documentação consolidada em
`docs/rust-wasm-integration.md`; não inferir compatibilidade de integridade.
