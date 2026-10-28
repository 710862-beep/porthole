# Aquisição e execução real — 2026-10-27

## Comandos e resultados

- `node scripts/fetch-test-assets.mjs`: exit 1, `ACQUISITION_FAILED`; 12 PEs retrowin32 adquiridos via GitHub Git Blobs API, com MZ/PE e SHA-256. Revisão `7c9243072755da54054bcaa9e1351371af638ded`.
- `node scripts/probe-test-assets.mjs`: exit 1; 12 executáveis tentados, 5 encerramentos normais com exit 0, 6 falhas de backend e 1 execução de threads incompleta. Encerramento normal não significa conformidade das APIs: cmdline.exe ainda imprime `TODO.exe`.
- `npm run test:wine`: exit 1, `ACQUISITION_FAILED`; zero asserts Wine executados. Não há resultado Wine PASS.
- `npm test`: 105 verificações (94 unitárias/contrato + 11 DOM).
- `npm run check:syntax`: 45 scripts; `git diff --check` limpo.

Relatórios locais: `tests/assets/MANIFEST.json`, `artifacts/asset-acquisition.json`, `artifacts/guest-probes.json`, `tests/reports/wine-test-results.json`. Os downloads e relatórios são ignorados pelo Git; o CI publica diagnósticos em artifacts.

## Falhas concretas de aquisição

- `https://api.github.com/repos/ArtifexSoftware/wine/releases?per_page=10`: HTTP 404. wine-mirror/wine não anunciou winetest.exe nas releases consultadas.
- WineHQ e Wayback: curl 35 / SSL_ERROR_SYSCALL, hosts fora da allowlist.
- archive.org e theprodukkt: curl 35 / SSL_ERROR_SYSCALL, hosts fora da allowlist. Os caminhos candidatos não foram confirmados como arquivos válidos; não há alegação de mirror verificado.
- `https://api.github.com/repos/Abel0424/abandons`: HTTP 404. Não foi possível descobrir executáveis de jogos/Windows nesse mirror.
- Dependencies x86 v1.11.1 e instalador NSIS Notepad++ v8.9.8.1: releases descobertas com sucesso, download falha no redirect para `release-assets.githubusercontent.com` (não autorizado).

Não foram obtidos DOOM95, .kkrieger, Wine, Notepad/Minesweeper Windows, Dependencies ou instalador. Isso é falha de aquisição diagnosticada, não solicitação para o usuário fornecer arquivos. O downloader ainda precisa de mirrors adicionais verificados e descoberta de arquivos compactados para os jogos. Não foi implementada aquisição via GitLab CI.

## Causa real do panic de threads e correção parcial

Antes: `thread.exe` hash `b68adf92c4412d485c62e2ab406d8e06952a4c8d9683a1c56f4ca453dcc785f8` imprime uma linha e lança unreachable.

Com tracer ativado, o panic foi identificado:

```
panicked at web/glue/src/host.rs:278:27:
called `Option::unwrap()` on a `None` value
```

A revisão histórica `00d8809d579fb7baf8fecb2c0118abe72a91bd6c` (última main antes da publicação pages de 2024-09-26) contém nessa linha:

```rust
web_sys::window().unwrap().performance().unwrap().now() as u32
```

Fonte: https://github.com/evmar/retrowin32/blob/00d8809d579fb7baf8fecb2c0118abe72a91bd6c/web/glue/src/host.rs#L278

A revisão histórica é evidência compatível com o log, não prova reproduzível da build Wasm publicada. A main atual tem arquitetura diferente do artefato pages.

Correção: adaptador explícito de relógio headless nos imports do glue, ativado pelo backend somente fora de Window. Usa performance.now real, sem instalar Window global nem fingir DOM. Wasm permanece inalterado.

Depois:

```
thread_id=0 name=main tls=1 i=0
thread_id=1 short_thread_proc exiting
TODO: thread exiting, but we don't have a way to stop a single thread yet
```

Exit 0 prematuro. O probe exige término dos loops main/TLS=1 e i_am_thread/TLS=2, e reporta `INCOMPLETE_THREAD_EXECUTION`. O trap imediato foi corrigido; isolamento de término de thread e scheduler do artefato continuam abertos. Não foram acrescentados SHIMs JS desconectados nem declarado suporte completo a sincronização.

## Pendências explícitas

- Fases 3/4: Wine real, input em jogo, instalador, persistência física, cenários adicionais de registro e WinSock não foram concluídos.
- DOOM95 é anterior a Raw Input: não se deve exigir que esse executável importe RegisterRawInputDevices como critério universal.
- Browser não fornece TCP arbitrário; WinSock exigirá contrato de transporte/proxy, sem falsear connect/send/recv como fetch equivalente.
- CI hospedado, mouse físico e GPU não foram validados nesta execução. Sem commit/push remoto.
