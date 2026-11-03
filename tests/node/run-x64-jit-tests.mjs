#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const explicit = process.env.PORTHOLE_X64_WASM_DIR;
const candidates = explicit
  ? [path.resolve(root, explicit)]
  : [path.join(root, 'artifacts/porthole-x64-wasm')];
const wasmDir = candidates.find(dir =>
  fs.existsSync(path.join(dir, 'porthole_x64_wasm.js')) &&
  fs.existsSync(path.join(dir, 'porthole_x64_wasm_bg.wasm')),
);
if (!wasmDir) {
  console.error('x64 JIT tests require a built ABI-v3 core. Build rust/porthole-x64-wasm for wasm32-unknown-unknown, run wasm-bindgen --target web into artifacts/porthole-x64-wasm, or set PORTHOLE_X64_WASM_DIR.');
  process.exit(1);
}

const gluePath = path.join(wasmDir, 'porthole_x64_wasm.js');
const wasmPath = path.join(wasmDir, 'porthole_x64_wasm_bg.wasm');
const mod = await import(pathToFileURL(gluePath).href);
const core = await mod.default(fs.readFileSync(wasmPath));
const probe = new mod.BrowserX64Emulator(8192);
const contextSlots = probe.jit_context_slots?.();
const compilerVersion = probe.jit_compiler_version?.();
if (contextSlots !== 64 || compilerVersion !== 14) {
  console.error(`Refusing to run x64 JIT tests with a stale core: expected ABI v3 / 64 context slots / compiler 14, got ${contextSlots ?? 'no ABI export'} slots / compiler ${compilerVersion ?? 'no compiler-version export'} (${wasmDir}).`);
  process.exit(1);
}
void core;

const files = [
  'tests/node/x64-jit-native.test.mjs',
  'tests/node/x64-jit-differential.test.mjs',
  'tests/node/x64-jit-alu-direction.test.mjs',
  'tests/node/x64-jit-coverage.test.mjs',
  'tests/node/x64-jit-aot-cache.test.mjs',
];
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, PORTHOLE_X64_WASM_DIR: wasmDir },
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const tests = Number(result.stdout.match(/^# tests (\d+)$/m)?.[1] ?? 0);
const skipped = Number(result.stdout.match(/^# skipped (\d+)$/m)?.[1] ?? 0);
if (tests !== 13 || skipped !== 0) {
  console.error(`Expected all 13 ABI-v3 JIT tests to execute (zero skips); observed tests=${tests}, skipped=${skipped}, core=${wasmDir}.`);
  process.exit(1);
}
console.log(`Verified: ${tests} x64 JIT tests passed against ${wasmDir}.`);
