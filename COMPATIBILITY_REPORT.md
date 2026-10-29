# Porthole — relatório de compatibilidade real

> **Estado vigente — Common Controls, 2026-10-28:** fonte `757abeba1c995af55a2cd7eab689483cabb943df`, [run 40736781228](https://github.com/710862-beep/porthole/actions/runs/40736781228). Build, 12 testes Rust, **5/5 PEs sintéticos** e **controle guest com pixels reais em Chromium PASS**. Gameplay **FAIL**: 5 presents antes de `user32!CreateDialogParamA`, sem input/loop comprovados. **Workflow vermelho, promotable=false; estável intacto. Implementação de controles parcial, pedido completo não concluído.** [Relatório atual](docs/common-controls.md).

## Histórico — resultados anteriores abaixo


> **Estado vigente — 2026-10-28:** fonte `6eb2c0eb6207111a5b38c952aa7c1f0bf57b07c1`, [run 40727092030](https://github.com/710862-beep/porthole/actions/runs/40727092030). Build/integridade PASS; **5/5 PEs sintéticos PASS**; input headless injetado e TCP/HTTP/DNS guest Node comprovados. **DOOM95 falha em `comctl32.dll!17` (InitCommonControls), sem gameplay. Workflow vermelho, promotable=false, estável intacto.** [Relatório atual](docs/remaining-blockers.md).

## Histórico — resultados abaixo foram substituídos pelo estado vigente acima


> **Atualização 2026-10-28 — CI remoto real:** fonte `1bd21160ae81f88eaaa50c54a8a939bc6545457f`, [run 40714518581](https://github.com/710862-beep/porthole/actions/runs/40714518581). **Wasm produzido, baixado e validado**, inclusive binding. 8 testes Rust passaram; 143 verificações JS/DOM e 59 syntax checks locais. **3/5 contratos sintéticos passaram** (threads, registro e instalação com confirmação em disco Node); input e ws2_32 falham. Probes originais: **6/15**; DOOM95 falha em salto nulo, sem API causal comprovada. **Workflow vermelho; não promovido.** [Relatório atualizado](docs/rust-wasm-integration.md) e [evidência versionada](docs/evidence/remote-candidate-40714518581.json). As seções abaixo são **histórico da etapa anterior**, não o estado atual do candidato.


Data: 2026-10-27 (data local da sessão). Branch: `arena/6a52f3cb-porthole`.

## Resumo executivo

A aquisição alternativa obteve **um PE identificado pelo mirror como DOOM95**, além dos 12 PEs retrowin32. Os cinco testes sintéticos foram **compilados e efetivamente tentados no Wasm**, mas nenhum concluiu seu contrato. O scheduler **não foi corrigido**: sua causa de término prematuro foi localizada no código Rust histórico. Modelos JS de sincronização e sockets foram implementados/testados separadamente, sem alegar integração guest.

**Não há validação de Wine, Raw Input físico, rede de convidado, instalador real ou Roblox/Adobe reais.** Os estados abaixo não reproduzem a tabela ilustrativa do pedido, pois seus “VALIDADO” não seriam sustentados pelas medições.

## Matriz de evidências

| Componente | Binário original | Substituto sintético | Status medido | Notas |
|---|---|---|---|---|
| Threads | upstream thread.exe | thread-validation.exe | PARCIAL / FALHA GUEST | Original termina cedo; sintético falha em WaitForMultipleObjects ausente. Modelo JS passa 10 testes, não é scheduler Wasm. |
| Input | DOOM95.EXE de mirror GitHub | input-test.exe | NÃO VALIDADO FISICAMENTE / FALHA GUEST | Jogo falha em salto nulo; sintético pede janela, mas falta DOM e há imports Raw Input ausentes. Nenhum delta físico comprovado. |
| Network | nenhum launcher real | network-test.exe | JS TCP LOCAL VALIDADO / FALHA GUEST | GET HTTP real por transporte Node injetado para loopback. ws2_32 ausente no guest. Não é TCP no navegador. |
| Registry | Roblox/Adobe não executados | registry-test.exe | JS/DISCO VALIDADO / FALHA GUEST | Dados artificiais de 128 bytes e DWORD persistem entre novas instâncias JS em diretório real Node. Guest falha em RegCreateKeyExA. |
| VFS/instalação | instalador Notepad++ não adquirido | installer-test.exe | JS/DISCO VALIDADO / FALHA GUEST | Gravação e releitura física via adaptador de teste Node funcionam. Guest chega a panic create_dir do host Rust. Não prova NSIS nem File System Access. |
| Wine | winetest.exe não adquirido | PEs retrowin32 e testes JS separados | ACQUISITION_FAILED | Zero asserts Wine executados; substitutos não contam como Wine. |
| .kkrieger | não adquirido validamente | nenhum equivalente gráfico completo | NÃO VALIDADO | Encontrada fonte pública; candidato .exe rejeitado por PE inválido. |

## Medições locais

- `npm test`: **126 verificações** (115 unitárias/contrato + 11 DOM), incluindo 21 novos casos Node nesta etapa: 10 sincronização, 8 sockets, 3 persistência física JS.
- `npm run check:syntax`: **53 scripts**.
- YAML lint e `git diff --check`: aprovados.
- Aquisição: **13 PEs**, todos com hash e origem registrados; mais **5 PEs sintéticos compilados de fontes locais**.
- Probes adquiridos: **13 tentativas**, 5 encerramentos normais, 7 falhas backend e 1 thread incompleta. Exit 0 não significa conformidade: cmdline.exe ainda imprime TODO.exe.
- Probes sintéticos: **5 tentativas, 5 falhas guest**. O runner usa processo Node filho por PE e timeout externo de 15 segundos.
- Dois builds sintéticos consecutivos com fontes iguais produziram hashes iguais após normalização do timestamp COFF dos fixtures próprios. Sem promessa de reprodutibilidade entre máquinas.
- Benchmark gráfico não foi reexecutado nesta etapa; números anteriores não são novas medições.

Relatórios gerados: `tests/assets/MANIFEST.json`, `tests/synthetic/BUILD.json`, `artifacts/asset-acquisition.json`, `artifacts/guest-probes.json`, `artifacts/synthetic-all.json` e `tests/reports/wine-test-results.json`. Downloads/artefatos são ignorados no Git; fontes, ferramentas e este relatório são persistidos.

## DOOM95: procedência e resultado

- Mirror: `mshoger/doom95`, árvore `bbd1b4d96986ba6351ae2012697ae3a5a0153a08`, caminho `DOOM95.EXE`.
- Blob: https://api.github.com/repos/mshoger/doom95/git/blobs/650051f2ec90a61385acb8fec4ce57444b7e4d94
- PE x86, 775117 bytes.
- SHA-256: `209aaa8f56e982ad21cad48d853e6a926900062f8f46757c649ccc7e2249dec8`.
- Não é uma autenticação contra hash publicado pelo fabricante; é identificação do mirror mais hash dos bytes obtidos. Não redistribuído no Git.
- Execução: `jmp to null page addr=0`. Imports faltantes incluem ClipCursor, DeviceIoControl, GetSystemInfo, APIs GDI/paleta, hooks/janelas, MIDI/joystick e dplay.dll ordinal 1. Import ausente no loader **não comprova chamada efetiva** da API.
- RegisterRawInputDevices não apareceu nas evidências desse jogo. DOOM95 antecede Raw Input; não seria correto exigir essa API de todo jogo.

## APIs implementadas nesta etapa: escopo JS independente

`shims/thread-sync.js`: CreateEvent, SetEvent, ResetEvent, CreateSemaphore, ReleaseSemaphore, WaitForSingleObject, WaitForMultipleObjects (any/all), CloseHandle, Initialize/Enter/Leave/DeleteCriticalSection, TlsAlloc/GetValue/SetValue/Free e limpeza. Assinaturas são JS, não ABI Win32 binária. Não implementa criação de CPUs, ExitThread, suspensão/resume, TerminateThread, named objects ou segurança de handles.

`shims/ws2_32.js`: WSAStartup, WSACleanup, WSAGetLastError, socket, connect, send, recv, closesocket, getaddrinfo/gethostbyname e liberação JS de resultados. Métodos assíncronos, transporte de bytes injetado, política síncrona de autorização **deny-by-default**. Sem proxy implícito, UDP, IPv6, select, eventos WSA, TLS, DNS nativo browser ou layout binário sockaddr/addrinfo. O transporte/host é responsável por DNS, timeouts, filas e autorização do destino resolvido; não deve aceitar destinos não autorizados ou rebinding.

Esses módulos não são carregados no index nem registrados automaticamente como DLLs do Wasm: falta a ponte de ABI/suspensão. Os testes do contrato JS não resolvem imports do guest por mágica.

## Lacunas comprovadas pelo guest

- `kernel32.dll!WaitForMultipleObjects`: ausente; o teste de três threads não conclui.
- `user32.dll!RegisterRawInputDevices`, `GetRawInputData`, `ClipCursor`: ausentes no artefato; modelos JS existentes não contam como implementação Rust.
- `ws2_32.dll`: DLL indisponível, incluindo WSAStartup/cleanup, DNS, socket/connect/send/recv/close.
- `advapi32.dll!RegCreateKeyExA`: ausente no artefato, apesar do registro JS persistente existente.
- `web/glue/src/host.rs`: create_dir ainda usa todo! na build publicada.
- Término de worker chama machine.exit(0), encerrando a máquina inteira. [Análise detalhada](docs/threading-analysis.md).

Estas lacunas são de implementação/integração do artefato, não impossibilidades inerentes do Wasm. Não foram “corrigidas” com stubs de sucesso.

## Alternativas exploradas e limites

1. Download normal de release e **GitHub Release Asset API com Accept: application/octet-stream**: ambos redirecionaram para release-assets.githubusercontent.com, bloqueado.
2. GitHub repository search + árvores + Git Blobs API base64: funcionou para DOOM95 e os PEs retrowin32. Hashes e revisão registradas; rejeição de PE inválido testada.
3. Buscas limitadas aos três primeiros repositórios de winetest/doom95/kkrieger por nome, mais winetest em Shell, wine-builds e wine-staging com inspeção de até duas releases por repositório. **Isso não esgota todos os forks públicos.** WineTest nos resultados não implica WineHQ; nenhum foi contado como Wine conformance.
4. Compilação from source: Zig 0.13.0 obtido por PyPI e cinco fontes C transformadas em PEs. Não foi compilado Wine nem retrowin32/Rust; toolchain completo Rust/wasm continua pendente.
5. jsDelivr/unpkg/proxies externos estão fora da allowlist. Não foi desabilitado TLS, tentado proxy não autorizado nem chamado certificado inválido de solução para um bloqueio de host.
6. Nenhuma pretensão de equivalência funcional de um pequeno probe com DOOM95, .kkrieger, launcher ou instalador completo.

## CI

Workflow inclui compilador fixado, fetch-with-fallbacks, thread/input/network/registry/installer validations, probes adquiridos, suíte JS, Wine e upload dos diagnósticos. Etapas posteriores executam com `if: always()`; falhas obrigatórias não são escondidas com continue-on-error. Com as lacunas atuais, esses gates de compatibilidade devem falhar. Nenhuma execução hospedada/commit/push foi feita nesta sessão.

## Revisão solicitada

- Explorei todas as alternativas? **Não todas as existentes no mundo**; explorei as rotas autorizadas descritas, buscas limitadas e compilação de substitutos. Forks adicionais, archives de jogos e build Wine/Rust continuam trabalho aberto.
- Investiguei o scheduler? **Sim**, com log de panic, fonte histórica e reprodução do exit prematuro. **Não o corrigi no Wasm.**
- Criei substitutos válidos? **Sim, cinco PEs x86 compilados com fontes e imports reais**, mas são probes parciais e seus contratos ainda falham no guest.
- Fui honesto? **Nenhum dos cinco foi marcado VALIDADO no guest**, e testes JS/disco/TCP local estão identificados como tais.

## Binários originais ainda não adquiridos

- `wine/winetest.exe`
- `games/kkrieger.exe`
- `windows/Minesweeper.exe`
- `windows/notepad.exe`
- `windows/Dependencies.exe`
- `installers/notepad-plus-plus.exe`

### Buscas e repositórios inspecionados

- `winetest in:name`: Gryzly73/WineTest, Pierl0/winetest, itsmecevi/winetest.
- `doom95 in:name`: mshoger/doom95, marcofurtado-hub/doom95, ScoobyDouche/DOOM95.
- `kkrieger in:name`: jaromil/kkrieger-werkkzeug3, steven-schronk/Kkrieger-Werkkzeug3, willianchanlovegithub/kkrieger.
- `winetest in:name language:shell`: Ajara-Oh/winetest, qqqZXzz123/pterodactyl-winetest.
- `wine-builds in:name`: Kron4ek/Wine-Builds, Gcenx/macOS_Wine_builds, Castro-Fidel/wine_builds.
- `wine-staging in:name`: wine-compholio/wine-staging, Jebaitedneko/wine-staging, alesliehughes/alesliehughes-wine-staging.

### Tentativas que retornaram erro (snapshot real desta execução)

- `https://api.github.com/repos/ArtifexSoftware/wine/releases?per_page=10` — HTTP `404` — curl: (22) The requested URL returned error: 404
- `https://test.winehq.org/builds/winetest-latest.exe` — HTTP `sem resposta` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to test.winehq.org:443
- `https://web.archive.org/web/2024/https://winehq.org/winetest.exe` — HTTP `sem resposta` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to web.archive.org:443
- `https://archive.org/download/doom95/doom95.exe` — HTTP `sem resposta` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to archive.org:443
- `https://www.theprodukkt.com/files/kkrieger.exe` — HTTP `sem resposta` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to www.theprodukkt.com:443
- `https://archive.org/download/kkrieger/kkrieger.exe` — HTTP `sem resposta` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to archive.org:443
- `https://api.github.com/repos/Abel0424/abandons` — HTTP `404` — curl: (22) The requested URL returned error: 404
- `https://github.com/lucasg/Dependencies/releases/download/v1.11.1/Dependencies_x86_Release.zip` — HTTP `302` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to release-assets.githubusercontent.com:443
- `https://github.com/notepad-plus-plus/notepad-plus-plus/releases/download/v8.9.8.1/npp.8.9.8.1.Installer.exe` — HTTP `302` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to release-assets.githubusercontent.com:443
- `https://api.github.com/repos/lucasg/Dependencies/releases/assets/47845850` — HTTP `302` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to release-assets.githubusercontent.com:443
- `release asset API lucasg/Dependencies` — HTTP `sem resposta` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to release-assets.githubusercontent.com:443
- `https://api.github.com/repos/notepad-plus-plus/notepad-plus-plus/releases/assets/586237299` — HTTP `302` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to release-assets.githubusercontent.com:443
- `release asset API notepad-plus-plus/notepad-plus-plus` — HTTP `sem resposta` — curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to release-assets.githubusercontent.com:443
- `tree Gryzly73/WineTest` — HTTP `sem resposta` — No matching standalone PE (archives/source require separate build)
- `tree Pierl0/winetest` — HTTP `sem resposta` — No matching standalone PE (archives/source require separate build)
- `tree itsmecevi/winetest` — HTTP `sem resposta` — No matching standalone PE (archives/source require separate build)
- `tree jaromil/kkrieger-werkkzeug3` — HTTP `sem resposta` — No matching standalone PE (archives/source require separate build)
- `tree steven-schronk/Kkrieger-Werkkzeug3` — HTTP `sem resposta` — No matching standalone PE (archives/source require separate build)
- `tree willianchanlovegithub/kkrieger` — HTTP `sem resposta` — Invalid PE signature/offset
- `Wine fork releases Ajara-Oh/winetest` — HTTP `sem resposta` — No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures
- `Wine fork releases qqqZXzz123/pterodactyl-winetest` — HTTP `sem resposta` — No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures
- `Wine fork releases Kron4ek/Wine-Builds` — HTTP `sem resposta` — No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures
- `Wine fork releases Gcenx/macOS_Wine_builds` — HTTP `sem resposta` — No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures
- `Wine fork releases Castro-Fidel/wine_builds` — HTTP `sem resposta` — No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures
- `Wine fork releases wine-compholio/wine-staging` — HTTP `sem resposta` — No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures
- `Wine fork releases Jebaitedneko/wine-staging` — HTTP `sem resposta` — No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures
- `Wine fork releases alesliehughes/alesliehughes-wine-staging` — HTTP `sem resposta` — No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures
