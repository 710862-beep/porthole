# Integração Rust/Wasm — 2026-10-28

## Estado: candidato de fonte, não backend validado

A etapa deixou de ser apenas diagnóstico/SHIM JS: há alterações efetivas em
`rust/retrowin32` e uma ponte Rust Host → wasm-bindgen → JS para registro ANSI e
diretórios. O build local foi tentado e bloqueou por falta de cargo. A aquisição
ativa de Rustup por PyPI funcionou, mas o download da toolchain Rust falhou no
host static.rust-lang.org. Não há novo .wasm e não há resultado guest novo.

| Item | Estado desta etapa |
|---|---|
| Scheduler e waits | Fonte Rust alterada; sem compilação/execução comprovadas |
| Registro ANSI | Fonte Rust + host JS integrado no runner; 4 testes JS aprovados |
| Diretórios/relógio | Fonte host Rust delegada + overlay JS; 3 testes JS aprovados |
| Raw Input guest | Não implementado nesta etapa; continua lacuna |
| ws2_32 guest | Não integrado nesta etapa; continua lacuna |
| Rebuild | Script/CI adicionados; tentativa local BUILD_BLOCKED |
| Cinco PEs contra novo Wasm | Não executados: nenhum novo artefato foi produzido |
| Cinco PEs contra Wasm estável | Reexecutados: 5 GUEST_FAILURE |
| DOOM95 contra estável | Reexecutado: salto nulo; não atribuído a uma API específica |
| DOOM95 contra candidato | Sem execução; candidato não foi compilado |

## ABI e persistência

O guest é x86 em um buffer dentro da memória linear Wasm; um ponteiro x86 **não**
é automaticamente um offset absoluto do memory.buffer do Wasm. A ponte Rust
valida faixas guest, copia bytes e usa slices wasm-bindgen. Não consulta
Emulator.memory() reentrantemente dentro de uma chamada Rust já emprestada.

APIs de espera ficam no núcleo cooperativo e suspende-se a CPU via Sleep; não
se retorna uma Promise como DWORD. O gerador win32-derive cria wrappers/PE DLLs
para as novas assinaturas. O pacote de build correto é glue, não um presumido
retrowin32.wasm na raiz do workspace.

Registro usa métodos síncronos de overlay do mesmo RegistryStore já existente;
o host aguarda ready antes de iniciar o guest e flush no término. Uma escrita
aceita não é confirmação durável. Falha de persistência aparece em flushError
e invalida PASS no runner. O teste guest do runner usa store volátil; os testes
Node de disco são uma evidência separada, não login Roblox nem instalação real.

Diretórios têm overlay síncrono e fila de confirmação; snapshot de diretórios
preexistentes no host ainda é parcial. Também faltam validação física de FS
Access, recuperação de erros e cobertura completa dos erros Win32 nesse caminho.

## Evidência local

- npm test: **133 verificações** (122 unitárias/contrato + 11 DOM).
- node --check: **55 scripts**.
- bash -n no script de rebuild, YAML lint e git diff --check: aprovados.
- Patch de fonte: 16 arquivos alterados/novos em relação ao upstream fixado;
  aplicação sobre fonte pristine conferida com git apply --check.
- Dois testes Rust de scheduler foram escritos, mas não executados. Não entram
  na contagem 133.
- Hash do Wasm estável permanece
  `5dc271886ebd68f2ba682099e71415bae7e40a457b3819d165484ffec0e1be41`.

Ver [instruções/procedência](../rust/README.md) e
[patch auditável](../rust/patches/porthole-core.patch). Os resultados anteriores
continuam válidos somente para o artefato antigo. Nenhum commit/push nem workflow
remoto foi executado nesta etapa.
