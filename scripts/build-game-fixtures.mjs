#!/usr/bin/env node
/*
 * Builds the "real game startup" fixtures: plain PE32+ x86_64 Windows executables compiled from
 * `tests/game/*.c` with the pinned zig toolchain. No Wine sources are involved, so this runs in
 * seconds and stays reproducible.
 *
 * Output: tests/assets/game/{game_startup,hello_world,doom_d3d12_startup}.exe + MANIFEST.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function findZig() {
  const candidates = [process.env.PORTHOLE_ZIG, '/home/user/.cache/porthole-tools/ziglang/zig', 'zig'].filter(Boolean);
  for (const bin of candidates) {
    const res = spawnSync(bin, ['version'], { encoding: 'utf8' });
    if (res.status === 0 && /^0\.13\./.test(res.stdout.trim())) return bin;
  }
  throw new Error('Zig 0.13.x required. Install: python3 -m pip install --target /home/user/.cache/porthole-tools ziglang==0.13.0');
}

const SPECS = [
  {
    name: 'game_startup.exe',
    source: 'tests/game/game_startup.c',
    description: 'CreateFileW + 2 GB VirtualAlloc + GetProcAddress + D3D12CreateDevice + ExitProcess(0)',
    expect: { exitCode: 0, marker: 'GAME_STARTUP_RESULT failures=0' },
    libs: ['-ld3d12', '-ldxgi', '-lkernel32', '-luuid'],
  },
  {
    name: 'hello_world.exe',
    source: 'tests/game/hello_world.c',
    description: 'minimal ucrt/stdio program that exits through ExitProcess(0)',
    expect: { exitCode: 0, marker: 'HELLO_WORLD_OK' },
    libs: ['-lkernel32'],
  },
  {
    // Same image code, stopped before stage 13, so the failure-report format is measured in CI
    // rather than only appearing when a real regression happens.
    name: 'doom_d3d12_blocked.exe',
    source: 'tests/game/doom_d3d12_startup.c',
    description: 'D3D12 boot that deliberately stops before CreateSwapChainForHwnd',
    commandLine: 'C:\\Game\\doom_d3d12_blocked.exe /blockstage:13',
    expect: { exitCode: 13, stageBlocked: true },
    libs: ['-ld3d12', '-ldxgi', '-lkernel32', '-luuid'],
  },
  {
    name: 'doom_d3d12_startup.exe',
    source: 'tests/game/doom_d3d12_startup.c',
    description: 'DOOM-2016-shaped D3D12 boot: factory→device→queue→PSO→swapchain→Present',
    expect: { exitCode: 0, marker: 'DOOM_STARTUP_OK' },
    libs: ['-ld3d12', '-ldxgi', '-lkernel32', '-luuid'],
  },
];

export function buildGameFixtures({ outDir = 'tests/assets/game' } = {}) {
  const zig = findZig();
  fs.mkdirSync(outDir, { recursive: true });
  const built = [];

  for (const spec of SPECS) {
    const exePath = path.join(outDir, spec.name);
    const args = [
      'cc',
      '-target', 'x86_64-windows-gnu',
      '-O1',
      '-DCOBJMACROS=',
      '-DWIDL_C_INLINE_WRAPPERS',
      '-include', 'windows.h',
      '-Wno-format', '-Wno-int-conversion', '-Wno-incompatible-pointer-types',
      spec.source,
      ...spec.libs,
      '-Wl,--subsystem,console',
      '-o', exePath,
    ];
    const run = spawnSync(zig, args, { encoding: 'utf8', timeout: 180_000 });
    if (run.status !== 0) {
      throw new Error(`Failed compiling ${spec.name}:\n${run.stderr || run.stdout}`);
    }
    // Deterministic hashes: zero the COFF TimeDateStamp.
    const bytes = fs.readFileSync(exePath);
    const peOff = bytes.readUInt32LE(0x3c);
    bytes.writeUInt32LE(0, peOff + 8);
    fs.writeFileSync(exePath, bytes);

    const machine = bytes.readUInt16LE(peOff + 4);
    const magic = bytes.readUInt16LE(peOff + 24);
    if (machine !== 0x8664 || magic !== 0x020b) {
      throw new Error(`${spec.name}: expected PE32+ x86_64, got machine=0x${machine.toString(16)} magic=0x${magic.toString(16)}`);
    }
    // Sanity: the D3D12 fixtures must actually import the D3D12/DXGI entry points.
    const imports = new Set();
    const text = bytes.toString('latin1');
    for (const sym of ['D3D12CreateDevice', 'CreateDXGIFactory2', 'CreateSwapChainForHwnd', 'VirtualAlloc', 'GetProcAddress']) {
      if (text.includes(`${sym}\0`)) imports.add(sym);
    }

    built.push({
      name: spec.name,
      path: exePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
      machine: `0x${machine.toString(16)}`,
      magic: `0x${magic.toString(16)}`,
      source: spec.source,
      sourceSha256: sha256(fs.readFileSync(spec.source)),
      description: spec.description,
      expect: spec.expect,
      imports: [...imports].sort(),
    });
    console.log(`[game-build] ${spec.name}: ${bytes.length} bytes sha256=${sha256(bytes).slice(0, 16)}… imports=[${[...imports].join(', ')}]`);
  }

  const manifest = {
    version: 1,
    kind: 'porthole-x64-game-startup-fixtures',
    compiler: 'zig 0.13.0 (x86_64-windows-gnu)',
    note: 'Synthetic startup sequences written for Porthole. No game code, no Wine code.',
    binaries: built,
  };
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildGameFixtures();
}
