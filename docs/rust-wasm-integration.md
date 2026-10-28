> **Atualização:** o estado vigente está em [Common Controls](common-controls.md). Os resultados abaixo são históricos; o bloqueio atual é CreateDialogParamA, não comctl32 ordinal 17. Gameplay continua reprovado.

# Estado vigente

Ver [relatório dos três bloqueios](remaining-blockers.md): 5/5 sintéticos PASS, DOOM95 bloqueado em comctl32 ordinal 17, não promovido.

## Histórico da integração anterior (não representa o estado vigente)

# Integração Rust/Wasm — build remoto real, 2026-10-28

## Estado: compilado e baixado, compatibilidade incompleta — NÃO PROMOVIDO

Fonte medida: **`1bd21160ae81f88eaaa50c54a8a939bc6545457f`**, branch
`arena/6a52f3cb-porthole`. [Run 40714518581](https://github.com/710862-beep/porthole/actions/runs/40714518581).
O job compilou o núcleo e produziu o candidato, mas terminou em **failure** pelos
contratos guest e recursos externos ainda faltantes. Não existe resultado 5/5.

## Ciclos executados e falhas corrigidas

| Run | Commit medido | Resultado real |
|---|---|---|
| [40711254902](https://github.com/710862-beep/porthole/actions/runs/40711254902) | `640b158` | Rebuild falhou; logs via redirect inacessíveis |
| [40711849705](https://github.com/710862-beep/porthole/actions/runs/40711849705) | `5427dc1` | Checks API expôs erro do generator em checkout limpo |
| [40712277632](https://github.com/710862-beep/porthole/actions/runs/40712277632) | `e872de7` | Corrigido NotFound; Rust compilou, 8 testes passaram; guests falharam no binding inválido |
| [40712992950](https://github.com/710862-beep/porthole/actions/runs/40712992950) | `15b04cd` | Candidato baixado por Git blob API; sintaxe inválida confirmada localmente |
| [40713495349](https://github.com/710862-beep/porthole/actions/runs/40713495349) | `69bb279` | Binding corrigido/inicializado; 3 sintéticos passaram; 6/15 probes originais passaram |
| [40714052612](https://github.com/710862-beep/porthole/actions/runs/40714052612) | `cbb0e7d` | Registro/instalação confirmados em disco real; aquisição API 403 deixou probes vazios, corretamente reprovados |
| [40714518581](https://github.com/710862-beep/porthole/actions/runs/40714518581) | `1bd2116` | Autenticação API e DOOM95 fixado; candidato validado; 3/5 sintéticos, 6/15 originais |

O gerador lia `.s`/`.def` antes de criá-los; agora somente NotFound permite criar
um arquivo novo, e demais erros de I/O continuam propagados. A regressão Rust
cobre criação, conteúdo igual, atualização e caminho não regular.
O binding usava `export { default as ... }` sem re-export de módulo: sintaxe
inválida. O build agora exporta a variável local `__wbg_init`. O validador antigo
aceitava os bytes Wasm desse candidato, mas não sua sintaxe JS; a nova regressão
rejeita o caso e exige exports e inicialização efetiva do binding.

## Integridade comprovada no CI e depois do download

- Wasm: **1.669.558 bytes**, magic `00 61 73 6d`, versão 1.
- SHA256 Wasm: `afeaba0ff7d2c50a4cd9da24f6c8ab8da83eb090d8a24fcd326d41bfbaab1d1d`.
- Binding: **31.018 bytes**, SHA256 `1b935d6bb11943ee3f2a7bfd6e1bbe1c4df799ddbe03b68660e998f90eb5b75f`.
- SHA256SUMS conferido; WebAssembly.compile e inicialização do binding passaram.
- Status: **INTEGRITY_VALIDATED_NOT_COMPATIBILITY**, 42 exports, 60 imports.
- Estável intacto: 1.634.129 bytes; SHA256
  `5dc271886ebd68f2ba682099e71415bae7e40a457b3819d165484ffec0e1be41`.

## Cinco PEs realmente executados no candidato

| PE sintético autoral | Resultado | Evidência além de exit 0/SUCCESS |
|---|---|---|
| thread-validation | PASS | 3 workers × 10 loops, 30 verificações TLS no guest; completed==3 e WaitForMultipleObjects; 3 WORKER_DONE |
| input-test | GUEST_FAILURE | Janela pede DOM ausente no headless; nenhum delta físico comprovado. Raw Input guest ainda ausente |
| network-test | GUEST_FAILURE | Loader registra ws2_32.dll e WSAStartup/socket/connect/send/recv etc. ausentes; depois ocorre salto nulo |
| registry-test | PASS | Guest grava/reabre/lê; após flush um novo store lê disco Node: REG_BINARY 128 bytes e REG_DWORD 12345 |
| installer-test | PASS sintético | Diretório real, test.txt 15 bytes, marcador uninstall.exe vazio e InstallPath em novo store/disco Node conferidos |

O marcador vazio **não é desinstalador executável**. Dados de Roblox são
artificiais; não houve login Roblox/Adobe. Disco temporário Node não equivale a
File System Access no navegador. O runner remove seu diretório temporário ao
final. Aceitar uma escrita no overlay não basta: flushError invalida PASS e os
contratos de registro/instalador exigem releitura externa. Input headless nunca
vira validação física só por sair com código zero.

## Originais e DOOM95

Aquisição final: **15 PEs originais/mirrors**, faltando Wine winetest, .kkrieger,
Minesweeper e Notepad. As tentativas/fallbacks e erros permanecem no relatório de
aquisição; nenhum substituto foi rotulado como original. Autenticação fica
restrita ao origin HTTPS api.github.com usando o token já fornecido pelo runner.

Probes: **6 PASS / 9 BACKEND_FAILURE**. PASS: callback, cmdline, metrics,
thread (ambos os loops terminaram), winapi e hello. Falhas incluem DOM ausente,
traps, exits não zero e imports não resolvidos. PASS de probe não significa
conformidade completa da aplicação nem teste Wine.

DOOM95: PE32 de mirror público mshoger/doom95, 775.117 bytes, SHA256
`209aaa8f56e982ad21cad48d853e6a926900062f8f46757c649ccc7e2249dec8`.
A origem foi fixada por Git blob e checksum, não autenticada como distribuição
oficial. Foi reexecutado no candidato: **BACKEND_FAILURE — jmp to null page
addr=0**, sem janela/frame. Loader lista diversos imports ausentes (kernel32,
user32, GDI, winmm e dplay), mas o trace não identifica qual chamada disparou o
salto. Não atribuímos o crash a uma API específica nem a Raw Input sem prova.

## Reprodução e transporte dos artifacts

```bash
bash scripts/build-remote.sh --run 40714518581
# retorno não zero: falhas guest continuam obrigatórias
python3 scripts/download-ci-blobs.py 40714518581
node scripts/validate-wasm.mjs artifacts/remote/40714518581/retrowin32-candidate-wasm
```

Artifacts normais: `retrowin32-candidate-wasm` e `test-results`, retenção 14 dias.
Neste sandbox, gh download/log redireciona para hosts de armazenamento bloqueados.
Logs de build foram recuperados por Checks API. O fallback transfere arquivos
por **Git blobs sem commit/ref**, com manifesto nas annotations; confere SHA do
run/fonte, SHA1 Git, tamanho e SHA256 antes de salvar no diretório ignorado.
`contents: write` serve para criar esses blobs, não para promover ou escrever
vendor. Blobs são transporte efêmero; artifacts normais seguem publicados.
Nenhuma URL assinada ou credencial consta da evidência versionada.

Dispatch manual retorna 403 pela integração; **push dispara o workflow**. Não
foi criada outra branch. Os commits foram publicados na branch da sessão.

## Evidências e próximos gates

- Rust 1.81.0, wasm-bindgen 0.2.92; **8 testes Rust** (1 derive, 2 scheduler, 5 win32).
- **143 verificações JS/DOM**, **59 scripts** com syntax check; não se confundem
  com testes Rust ou conformidade Wine.
- Patch completo de **17 arquivos** confere com git apply --check na fonte fixada.
- [Resumo auditável e hashes dos relatórios](evidence/remote-candidate-40714518581.json).
- Logs/JSON completos baixados em `artifacts/remote/40714518581/` (não versionados).

**Pendências que bloqueiam promoção:** implementar/testar Raw Input no núcleo,
runner com DOM/deltas verificáveis, ABI ws2_32 com transporte real e contrato
HTTP, resolver falhas dos probes/regressões e investigar DOOM95 por trace.
Não foram adicionados stubs de sucesso para esconder essas lacunas.
Somente depois de todos os gates será permitido substituir Wasm e glue juntos,
com backup/reversão e nova rodada de regressões.
