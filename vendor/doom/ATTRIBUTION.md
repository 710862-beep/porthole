# Atribuições de terceiros — `vendor/doom/`

## `doom.wasm` — módulo WebAssembly do DOOM

- Origem: repositório [`jacobenget/doom.wasm`](https://github.com/jacobenget/doom.wasm),
  branch `gh-pages`, caminho `examples/browser/assets/doom.wasm`
  (byte-idêntico ao asset da release `v0.1.0`, 4.559.928 bytes,
  SHA-256 `8edfe49a7583fd975199969302d8e9adcf8e714d0af72bf3e672f991fd810faa`).
- Licença: **GNU GPL v2** (ver `LICENSE.jacobenget`). O módulo compila o
  linuxdoom-1.10 (id Software, GPL-2) com uma camada de hospedagem Wasm
  minimalista (10 imports / 4 exports).
- Interface utilizada: `initGame`, `tickGame`, `reportKeyDown`, `reportKeyUp`,
  `memory`, globais `KEY_*` e os imports `loading.*`, `ui.drawFrame`,
  `runtimeControl.timeInMilliseconds`, `console.*`, `gameSaving.*`.

## `DOOM1.WAD` — conteúdo shareware

- Origem: repositório [`abus-sh/doom-wasm`](https://github.com/abus-sh/doom-wasm),
  caminho `linuxdoom-1.10/doom1.wad` (4.196.020 bytes,
  SHA-256 `1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771`).
- `DOOM1.WAD` é o WAD shareware oficial do DOOM (1993), distribuído
  gratuitamente pela id Software; o magic header `IWAD` é verificado em runtime.
- O módulo `doom.wasm` também traz esse WAD **embutido** como fallback de
  fábrica; a injeção via `loading.readWads` apenas usa a cópia vendoreada.

## Compatibilidade de licenças

Este projeto é GPL-3.0; o motor é GPL-2.0. A combinação é permitida porque a
GPL-2 pode ser relicenciada para GPL-3 em obras combinadas ("upgradable").
Todo o código-fonte próprio deste repositório permanece GPL-3.0 conforme
`LICENSE` na raiz.
