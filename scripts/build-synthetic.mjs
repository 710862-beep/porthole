import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validatePE } from './fetch-test-assets.mjs';
const zig = process.env.PORTHOLE_ZIG || '/home/user/.cache/porthole-tools/ziglang/zig';
const check = spawnSync(zig, ['version'], { encoding: 'utf8' });
if (check.status !== 0 || check.stdout.trim() !== '0.13.0') throw new Error('Zig 0.13.0 required. Install: python3 -m pip install --target .cache/tools ziglang==0.13.0; set PORTHOLE_ZIG to its zig executable.');
const root = 'tests/synthetic';
const names = ['thread-validation', 'input-test', 'network-test', 'registry-test', 'installer-test', 'controls-test'];
const result = { kind: 'porthole-authored-synthetic-pe32', compiler: 'zig 0.13.0', tests: [] };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
for (const name of names) {
  const source = `${root}/${name}.c`, output = `${root}/${name}.exe`;
  const libs = name === 'controls-test' ? ['-luser32','-lcomctl32'] : name === 'network-test' ? ['-lws2_32'] : name === 'input-test' ? ['-luser32'] : ['registry-test', 'installer-test'].includes(name) ? ['-ladvapi32'] : [];
  const args = ['cc', '-target', 'x86-windows-gnu', '-Os', '-march=i386', '-mno-sse', '-mno-sse2', '-nostdlib', '-fno-stack-protector', '-isystem', path.join(path.dirname(zig), 'lib/libc/include/any-windows-any'), '-Wl,--entry,mainCRTStartup', '-Wl,--subsystem,console', source, '-lkernel32', ...libs, '-o', output];
  const run = spawnSync(zig, args, { encoding: 'utf8', timeout: 120000 });
  if (run.status !== 0) throw new Error(`${name}: ${run.stderr || run.error?.message}`);
  const bytes = fs.readFileSync(output); const pe = validatePE(bytes);
  // Authored, unsigned fixtures only: normalize the linker wall-clock COFF timestamp.
  bytes.writeUInt32LE(0, bytes.readUInt32LE(60) + 8);
  fs.writeFileSync(output, bytes);
  if (pe.machine !== 0x14c) throw new Error('Expected x86 PE');
  result.tests.push({ name, path: output, sha256: hash(bytes), source, sourceSha256: hash(fs.readFileSync(source)), headerSha256: hash(fs.readFileSync(`${root}/common.h`)), args, ...pe });
  console.log(`[built synthetic] ${output} ${bytes.length} bytes`);
}
fs.writeFileSync(`${root}/BUILD.json`, JSON.stringify(result, null, 2)+'\n');
