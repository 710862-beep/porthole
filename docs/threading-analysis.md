# Scheduler retrowin32: diagnóstico e fronteira da correção

## Revisões inspecionadas

- Wasm/glue publicados: `pages@eea2a62dad509d0e4bbde871abe88e483fbf4764`, SHA-256 Wasm `5dc271886ebd68f2ba682099e71415bae7e40a457b3819d165484ffec0e1be41`.
- Fonte histórica: `00d8809d579fb7baf8fecb2c0118abe72a91bd6c`, última main anterior à publicação pages. Correlação de fonte e linhas dos logs, não uma build reprodutível comprovada do Wasm publicado.
- Main moderna: `7c9243072755da54054bcaa9e1351371af638ded`. A arquitetura de `System`/handles de threads mudou; não presumir que sua implementação esteja presente no Wasm de 2024.
- A API de branches confirmou que pages continua na mesma revisão publicada; não foi localizado artefato pages mais novo nessa branch.

As fontes foram obtidas por GitHub Contents API e codeload; não dependem de raw.githubusercontent.com. Licença upstream Apache-2.0. Nenhum trecho copiado foi incorporado como implementação local de scheduler.

## Cadeia causal comprovada

1. `thread.exe` imprime main/TLS=1/i=0.
2. Antes da ponte headless, `Host::ticks` (`web/glue/src/host.rs:278`) executava `window().unwrap()`, causando panic em Node. O trap Wasm `unreachable` é o mecanismo de abort do panic Rust, não evidência de instrução x86 desconhecida neste caso.
3. O adaptador local fornece performance.now real para esse contrato, sem criar Window/DOM global. O teste passa pelo primeiro Sleep e executa `short_thread_proc`.
4. O log Rust informa `TODO: thread exiting, but we don't have a way to stop a single thread yet`.
5. Na fonte histórica, `retrowin32_thread_main` (`win32/src/winapi/kernel32/init.rs:503–507`) chama `machine.exit(0)` ao retornar de qualquer thread.
6. `Machine::exit`, em `win32/src/machine_emu.rs:273`, define **Status::Exit para o processo inteiro**, não apenas para uma CPU. O host JS observa esse estado terminal. Reiniciar start() não ressuscita as CPUs corretamente.

Logo: o segundo defeito não é o processo principal chamando ExitProcess cedo; é o trampoline de uma thread filha encerrando a máquina inteira. O programa upstream nem chama WaitForMultipleObjects; o novo teste sintético chama, e expõe a ausência desse export antes de concluir seu fluxo.

## Outros problemas encontrados na fonte histórica

- `CreateThread` em `win32/src/winapi/kernel32/thread.rs` cria uma CPU e pilha, mas usa handle/id fixo `1`, não preenche lpThreadId nem respeita integralmente dwCreationFlags. Não se pode declarar múltiplos handles funcionais.
- Criação de CPU não instala um TEB/FS independente nesse caminho; TLS não está demonstrado isoladamente entre três threads.
- `x86/src/x86.rs::schedule` escolhe a primeira CPU executável a partir da atual; não há quantum justo comprovado. Com todas bloqueadas, escolhe uma espera; seu estado precisa ser considerado junto aos timers.
- CPUState histórico não possui estado terminal de thread. Apenas Running, Blocked, DebugBreak, SysCall e Error. Acrescentar terminated requer atualizar todos os matches e o scheduler.
- WaitForSingleObject é `todo!()` no sync.rs histórico; WaitForMultipleObjects nem é resolvido pelo artefato.
- ResumeThread retorna um valor fixo na fonte histórica; não comprova suspensão/resume real. Join/detach e TerminateThread não foram validados.

## Correção necessária no núcleo (ainda não implementada)

1. Objetos/handles únicos de thread: CPU, TEB, pilha, exit code, suspend count e evento terminal.
2. Estado de CPU terminada, removido da seleção runnable, preservando metadados aguardáveis.
3. Retorno do worker/ExitThread encerra só essa CPU e sinaliza waiters. ExitProcess continua encerrando o processo todo conforme Win32, sem join implícito.
4. Implementar waits de handles no Rust, com seleção wait-any/wait-all e consumo atômico; temporizadores devem acordar a CPU certa. Uma Promise no host sem ponte de suspensão não implementa isso.
5. Integrar TLS/FS por CPU, criação suspensa, retomada e cleanup.
6. Compilar uma nova build Wasm e validar `thread-validation.exe`: três WORKER_DONE, SUCCESS somente após wait-all, TLS isolado e ausência de early exit. Depois repetir regressões e original thread.exe.

Não há Rust/Cargo/target wasm instalados neste ambiente; não foi realizada uma rebuild do núcleo. Obteve-se Zig 0.13.0 por PyPI para compilar PEs, mas isso **não compila Rust**. A compilação de Wine e a preparação de toolchain Rust completo continuam pendentes; não foram declaradas esgotadas todas as alternativas.

## O que o novo módulo JS faz, e o que não faz

`shims/thread-sync.js` implementa um modelo assíncrono independente: eventos auto/manual-reset, semáforos limitados, wait-any/all com timeout, critical sections recursivas e TLS identificado pelo chamador. Dez testes cobrem esses contratos.

Ele **não** é registrado automaticamente no kernel32 do Wasm, não cria CPUs e não implementa CreateThread/ExitThread do convidado. O objetivo é fornecer semântica testável para uma futura ponte, não fazer uma correção cosmética que deixa o mesmo binário falhando.

## Provas de execução

- `artifacts/guest-probes.json`: original thread.exe continua INCOMPLETE_THREAD_EXECUTION.
- `artifacts/synthetic-all.json`: thread-validation.exe falha, import `kernel32.dll!WaitForMultipleObjects` ausente seguido de salto nulo.
- `node --test tests/node/thread-sync.test.mjs`: 10 testes JS aprovados. Não são testes de scheduler Wasm.
