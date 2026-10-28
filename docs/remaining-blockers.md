> **Atualização:** o estado vigente está em [Common Controls](common-controls.md). Os resultados abaixo são históricos; o bloqueio atual é CreateDialogParamA, não comctl32 ordinal 17. Gameplay continua reprovado.

# Três bloqueios — evidência de 2026-10-28

## Estado: dois contratos resolvidos; DOOM95 bloqueado; NÃO PROMOVIDO

Fonte testada: `6eb2c0eb6207111a5b38c952aa7c1f0bf57b07c1` na branch `arena/6a52f3cb-porthole`.
[CI remoto 40727092030](https://github.com/710862-beep/porthole/actions/runs/40727092030) terminou **failure**, não verde.
[Evidência versionada](evidence/remote-candidate-40727092030.json).
Não considero o candidato pronto: a regra de resolver os três bloqueios permanece vigente.

| Gate | Resultado e alcance |
|---|---|
| Build Rust/Wasm | PASS; 10 testes Rust; binding inicializado e Wasm compilado pelo validador |
| Cinco PEs sintéticos | **5/5 PASS**, executados no núcleo x86/Wasm, exit 0 e flush sem erro |
| Input sem DOM | PASS: RegisterRawInputDevices → WM_INPUT → GetRawInputData; deltas `(10,5)`, `(-5,15)`, `(20,-10)`, contagem 3. **Injeção sintética, não mouse físico** |
| Rede guest ws2_32 | PASS: TCP/HTTP loopback Node real, requisição recebida pelo servidor, corpo e EOF conferidos; gethostbyname/localhost exercitado |
| Registro/instalação | PASS nos contratos artificiais, com releitura em disco Node; não prova instaladores comerciais |
| Probes originais | 6/15 PASS no runner; exit 0 não prova conformidade de cada aplicativo |
| DOOM95 Chromium real | **BACKEND_FAILURE**: `comctl32.dll!17`, identificado no operando/IAT; 1 janela, 2 presents, **gameplayValidated=false** |
| Regressões | npm test e 66 syntax checks locais PASS; regressões JS/DOM no CI PASS |
| Promoção | **PROIBIDA pelo gate atual**, `promotable=false`; vendor estável preservado |

## Artefato e integridade

- Candidato: **1,796,309 bytes**, SHA-256 `fd259a13df684bc64ac6f7dfbaccf9c93933830bde0f8d1e1b27784f0821f1a8`.
- Binding: SHA-256 `cbdfdabdeed9d007a4938a05cf09c05499d3964ae6440f314f85e7aa8907cfdb`; 42 exports, 65 imports.
- Download por API com verificação de run/source, Git blob e SHA-256; WebAssembly.compile e inicialização do binding conferidos.
- Estável intocado: Wasm SHA-256 `5dc271886ebd68f2ba682099e71415bae7e40a457b3819d165484ffec0e1be41`; glue `529f6a7acefe8a674cb9cc7a5829720dda8c670ee054088e3c774128cf559147`.
- Patch Rust regenerado: 29 arquivos sobre baseline `00d8809d579fb7baf8fecb2c0118abe72a91bd6c`; `git apply --check` aprovado contra arquivo upstream com SHA validado. Nenhum candidato foi copiado sobre vendor.

## DOOM95: causas reais, correções e próximo bloqueio

As correções foram feitas no núcleo Rust e testadas remotamente, não apenas em SHIMs JS:

1. GetAsyncKeyState: estado consultável; teste de SHIFT e chamadas reais do jogo.
2. SystemParametersInfoA/SPI_GETWORKAREA: retângulo do desktop virtual 640×480, ponteiros e ação suportada validados.
3. IsWindow: consulta handles existentes e desktop virtual; NULL e handle inexistente retornam falso. DestroyWindow legado ainda não completa o ciclo de remoção do mapa.
4. SearchPathA: busca readonly em arquivos autorizados/precarregados, extensão opcional, diretórios, tamanho/buffer/filePart e erro FILE_NOT_FOUND. Teste guest positivo, consulta de tamanho e caso inexistente passam. Perfil ASCII, sem PATH de ambiente completo.
5. Corrigidos panics de estilos, mensagens numéricas e retângulos/desktop. SendMessageA mantém retorno EAX do callback; controles EDIT ainda não implementados (erro 1407 explícito).

O run 40726026560 terminou o processo com exit 0, mas o stdout dizia:
`MessageBox: Error / Unable to locate 'doomlnch.dll'.`
Seu antigo `validation-report.json` marcou indevidamente promotable=true: **esse resultado é invalidado**. Corrigi o agregador para exigir gameplayValidated=true, acrescentei regressão que rejeita exit 0 sem gameplay e deixei o probe de startup como GAMEPLAY_NOT_VALIDATED quando não há crash. Não se promove por janela, presents ou exit code.

Não tratei a falta da DLL como impossibilidade: adquiri do mesmo mirror cinco DLLs x86 e DOOM1.WAD. O downloader verifica encoding, tamanho, hash Git blob, SHA-256, estrutura PE/machine e estrutura IWAD. Origens e hashes estão na evidência. São dados de mirror público, **não uma distribuição oficialmente autenticada**, e não foram adicionados ao Git.

No run atual, o cache contém **7 arquivos / 5.264.001 bytes**, sem skips: EXE, cinco DLLs e IWAD. SearchPathA encontra a DLL, LoadLibraryA a carrega e GetProcAddress é chamado. O próximo salto nulo é:

```text
NULL_INDIRECT_CALL ip=32ab7 operand=Some(291604) target=0
causal_import=Some("comctl32.dll!17@IAT")
```

O [spec do Wine](https://github.com/wine-mirror/wine/blob/master/dlls/comctl32/comctl32.spec) identifica ordinal 17 como **InitCommonControls()**. A última API registrada, GetProcAddress, **não** é apontada como causa: o slot IAT demonstra comctl32 ordinal 17. Não houve Rust panic neste probe. As últimas 20 chamadas, argumentos, logs e resultado estão na evidência versionada.

**Próximo trabalho necessário:** implementar comctl32/registro e comportamento dos controles necessários (não um InitCommonControls vazio), acrescentar regressão guest e repetir Actions. Depois seguir as chamadas reais até uma sessão jogável verificável. O controle EDIT, APIs GDI/paleta, multimídia e outros imports continuam lacunas; import listado mas não chamado não é prova causal. O runner ainda não tem um verificador positivo de gameplay; seu marcador permanece falso.

## Limitações que não foram escondidas

- Raw Input físico/Pointer Lock não foi validado por injeção headless.
- ws2_32 é um subset IPv4/WSA 2.2; transporte Node autorizado/deny-by-default. Browser sem bridge retorna WSAEOPNOTSUPP (10045), não TCP fictício. Sem UDP/IPv6/select/TLS; LastError ainda é global ao processo.
- Wine e .kkrieger seguem sem validação completa; os sintéticos são explicitamente sintéticos e não contam como Wine nem apps comerciais.
- Outros probes e aquisição ainda fazem o workflow falhar; artifacts e agregado são publicados com always().
- A promoção continua bloqueada. Este relatório documenta progresso e uma falha reproduzível, não conclusão dos três bloqueios.

## Reprodução das evidências

```bash
python3 scripts/download-ci-blobs.py 40727092030
node scripts/validate-wasm.mjs artifacts/remote/40727092030/retrowin32-candidate-wasm
npm test
npm run check:syntax
```

O workflow rust-wasm-candidate.yml reproduz build, aquisição dos acompanhantes, execução dos PEs, Chromium e agregado. A ausência de Wine não impede que os acompanhantes do DOOM sejam adquiridos primeiro. Logs/JSON completos ficam em Actions e os JSON essenciais também na evidência versionada acima.
