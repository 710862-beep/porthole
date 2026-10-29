# Referências Wine e limites do adaptador

Consulta realizada em 2026-10-27 no mirror `wine-mirror/wine`, commit `0738d528db522f52d9d75f2aec712688dd31d1d2`:

- `dlls/kernel32/tests/file.c`, blob `877f9e99cab9a347280b9626d9c19d03ce179ae4`: referência para caminhos, atributos, criação e I/O.
- `dlls/advapi32/tests/registry.c`, blob `cc9c0bff2c67aaf5b2466a94ebd476410b18b93d`: referência para hives, tipos, enumeração e erros.

Esses arquivos foram usados como referência de comportamento; **não foram compilados nem apresentados como winetest.exe executado**. As regressões JS em `tests/node/maturity.test.mjs` são Wine-derived somente no sentido de cobrir contratos relacionados, com implementação e ambiente diferentes.

Para executar PEs de conformidade reais, adicione entradas a `manifest.json` com path interno, SHA-256, origem e expectativa. Não inclua binários proprietários. O runner executa somente PE32/x86 suportado pelo artifact retrowin32 vendoreado e registra NOT_RUN/TIMEOUT/BACKEND_ERROR separadamente.

## Sondagem de threads retrowin32

`evmar/retrowin32` `exe/cpp/thread.exe`, commit `7c9243072755da54054bcaa9e1351371af638ded`, SHA-256 `b68adf92c4412d485c62e2ab406d8e06952a4c8d9683a1c56f4ca453dcc785f8`, foi executado fora da suíte em 2026-10-27. Produziu `thread_id=0 name=main tls=1 i=0` e terminou em `RuntimeError: unreachable`. O binário não foi vendoreado nem marcado como aprovado; suporte a threads Win32 permanece uma lacuna.
