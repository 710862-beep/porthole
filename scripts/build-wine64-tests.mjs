import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchWine } from './fetch-wine-source.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function findZig() {
  const candidates = [
    process.env.PORTHOLE_ZIG,
    '/home/user/.cache/porthole-tools/ziglang/zig',
    'zig',
  ].filter(Boolean);
  for (const bin of candidates) {
    const res = spawnSync(bin, ['version'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim().startsWith('0.13.')) return bin;
  }
  throw new Error(
    'Zig 0.13.x required for PE32+ Wine conformance build. Install via: python3 -m pip install --target /home/user/.cache/porthole-tools ziglang==0.13.0'
  );
}

function makeTestlistSource(testNames) {
  const decls = testNames.map((n) => `extern void func_${n}(void);`).join('\n');
  const entries = testNames.map((n) => `    { "${n}", func_${n} },`).join('\n');
  return `#include <windows.h>
#define STANDALONE
#include "wine/test.h"

const char * __cdecl __wine_dbg_strdup( const char *str ) {
    struct winetest_thread_data *data = winetest_get_thread_data();
    size_t len = strlen(str) + 1;
    if (data->str_pos + len > data->strings + sizeof(data->strings)) data->str_pos = data->strings;
    memcpy(data->str_pos, str, len);
    char *ret = data->str_pos;
    data->str_pos += len;
    return ret;
}

${decls}

const struct test winetest_testlist[] = {
${entries}
    { 0, 0 }
};
`;
}

const WINTERNL_OVERLAY = `#ifndef PORTHOLE_WINE64_WINTERNL_OVERLAY_H
#define PORTHOLE_WINE64_WINTERNL_OVERLAY_H
#define _TEB _MINGW_ORIG_TEB
#define TEB MINGW_ORIG_TEB
#define PTEB PMINGW_ORIG_TEB
#define _PEB _MINGW_ORIG_PEB
#define PEB MINGW_ORIG_PEB
#define PPEB PMINGW_ORIG_PEB
#define _RTL_USER_PROCESS_PARAMETERS _MINGW_ORIG_RTL_USER_PROCESS_PARAMETERS
#define RTL_USER_PROCESS_PARAMETERS MINGW_ORIG_RTL_USER_PROCESS_PARAMETERS
#define PRTL_USER_PROCESS_PARAMETERS PMINGW_ORIG_RTL_USER_PROCESS_PARAMETERS
#include_next <winternl.h>
#undef _TEB
#undef TEB
#undef PTEB
#undef _PEB
#undef PEB
#undef PPEB
#undef _RTL_USER_PROCESS_PARAMETERS
#undef RTL_USER_PROCESS_PARAMETERS
#undef PRTL_USER_PROCESS_PARAMETERS

typedef struct _CURDIR {
    UNICODE_STRING DosPath;
    HANDLE Handle;
} CURDIR;

typedef struct _RTL_USER_PROCESS_PARAMETERS {
    ULONG MaximumLength;
    ULONG Length;
    ULONG Flags;
    ULONG DebugFlags;
    HANDLE ConsoleHandle;
    ULONG ConsoleFlags;
    HANDLE StandardInput;
    HANDLE StandardOutput;
    HANDLE StandardError;
    CURDIR CurrentDirectory;
    UNICODE_STRING DllPath;
    UNICODE_STRING ImagePathName;
    UNICODE_STRING CommandLine;
} RTL_USER_PROCESS_PARAMETERS, *PRTL_USER_PROCESS_PARAMETERS;

typedef struct _PEB {
    BYTE Reserved1[2];
    BYTE BeingDebugged;
    BYTE Reserved2[1];
    PVOID Reserved3[2];
    PPEB_LDR_DATA Ldr;
    PRTL_USER_PROCESS_PARAMETERS ProcessParameters;
    PVOID Reserved4[3];
    PVOID AtlThunkSListPtr;
    PVOID Reserved5;
    ULONG Reserved6;
    PVOID Reserved7;
    ULONG Reserved8;
    ULONG AtlThunkSListPtr32;
    PVOID Reserved9[45];
} PEB, *PPEB;

typedef struct _TEB {
    NT_TIB Tib;
    PVOID EnvironmentPointer;
    CLIENT_ID ClientId;
    PVOID ActiveRpcHandle;
    PVOID ThreadLocalStoragePointer;
    PPEB ProcessEnvironmentBlock;
} TEB, *PTEB;

#define NtCurrentTeb() ((PTEB)__readgsqword(0x30))
#endif
`;

export function buildWine64Suite({ outDir = 'tests/assets/wine64', only = null, toolchain = process.env.PORTHOLE_WINE_TOOLCHAIN || 'zig' } = {}) {
  const wineSha = fetchWine('vendor/wine-source');
  const zig = toolchain === 'zig' ? findZig() : null;
  const cc = process.env.PORTHOLE_MINGW_CC || 'x86_64-w64-mingw32-gcc';
  const windres = process.env.PORTHOLE_MINGW_WINDRES || 'x86_64-w64-mingw32-windres';
  if (!['zig', 'mingw'].includes(toolchain)) throw new Error(`Unknown Wine toolchain: ${toolchain}`);
  fs.mkdirSync(outDir, { recursive: true });
  const incDir = path.join(outDir, '_inc');
  fs.mkdirSync(path.join(incDir, 'wine'), { recursive: true });

  for (const [src, dst] of [
    ['vendor/wine-source/include/wine/test.h', path.join(incDir, 'wine/test.h')],
    ['vendor/wine-source/include/wine/debug.h', path.join(incDir, 'wine/debug.h')],
    ['vendor/wine-source/include/dxcore.h', path.join(incDir, 'dxcore.h')],
    ['vendor/wine-source/include/dxcore_interface.h', path.join(incDir, 'dxcore_interface.h')],
  ]) {
    fs.copyFileSync(src, dst);
  }
  fs.writeFileSync(path.join(incDir, 'winternl.h'), WINTERNL_OVERLAY);
  const testHeaderPath = path.join(incDir, 'wine/test.h');
  let testHeader = fs.readFileSync(testHeaderPath, 'utf8');
  const observer = fs.readFileSync('tests/torture/wine-observer.h', 'utf8');
  const marker = '#endif  /* __WINE_WINE_TEST_H */';
  if (!testHeader.includes(marker)) throw new Error('Wine test.h observer insertion point missing');
  testHeader = testHeader.replace(marker, observer + '\n' + marker);
  fs.writeFileSync(testHeaderPath, testHeader);

  const specs = [
    {
      name: 'kernel32_test.exe',
      origin: 'upstream-wine-unmodified',
      license: 'LGPL-2.1-or-later',
      sources: [
        'vendor/wine-source/dlls/kernel32/tests/power.c',
        'vendor/wine-source/dlls/kernel32/tests/drive.c',
        'vendor/wine-source/dlls/kernel32/tests/atom.c',
        'vendor/wine-source/dlls/kernel32/tests/environ.c',
        'vendor/wine-source/dlls/kernel32/tests/directory.c',
      ],
      subtests: ['power', 'drive', 'atom', 'environ', 'directory'],
      cflags: ['-O1'],
      libs: ['-lkernel32', '-luser32', '-ladvapi32'],
    },
    {
      name: 'user32_test.exe',
      origin: 'upstream-wine-unmodified',
      license: 'LGPL-2.1-or-later',
      sources: [
        'vendor/wine-source/dlls/user32/tests/wsprintf.c',
        'vendor/wine-source/dlls/user32/tests/uitools.c',
      ],
      subtests: ['wsprintf', 'uitools'],
      cflags: ['-O1'],
      libs: ['-luser32', '-lgdi32', '-lkernel32'],
    },
    {
      name: 'd3d12_test.exe',
      origin: 'upstream-wine-unmodified',
      license: 'LGPL-2.1-or-later',
      sources: ['vendor/wine-source/dlls/d3d12/tests/d3d12.c'],
      subtests: ['d3d12'],
      cflags: ['-O1', '-DCOBJMACROS=', '-DWIDL_C_INLINE_WRAPPERS'],
      libs: ['-ld3d12', '-ldxgi', '-luser32', '-lgdi32', '-lkernel32', '-luuid'],
    },
    {
      name: 'd3d9_test.exe', origin: 'upstream-wine-unmodified', license: 'LGPL-2.1-or-later',
      sources: ['d3d9ex.c', 'device.c', 'stateblock.c', 'visual.c'].map(f => `vendor/wine-source/dlls/d3d9/tests/${f}`),
      subtests: ['d3d9ex', 'device', 'stateblock', 'visual'], cflags: ['-O1', '-DCOBJMACROS='],
      libs: ['-ld3d9', '-luser32', '-lgdi32', '-lkernel32', '-luuid'],
    },
    {
      name: 'd3d11_test.exe', origin: 'upstream-wine-unmodified', license: 'LGPL-2.1-or-later',
      sources: ['vendor/wine-source/dlls/d3d11/tests/d3d11.c'], resources: ['vendor/wine-source/dlls/d3d11/tests/resource.rc'],
      subtests: ['d3d11'], cflags: ['-O1', '-DCOBJMACROS=', '-DWIDL_C_INLINE_WRAPPERS'],
      libs: ['-ld3d11', '-ldxgi', '-ld3dcompiler', '-luser32', '-lgdi32', '-lkernel32', '-luuid'],
    },
    {
      name: 'dxgi_test.exe', origin: 'upstream-wine-unmodified', license: 'LGPL-2.1-or-later',
      sources: ['vendor/wine-source/dlls/dxgi/tests/dxgi.c'], subtests: ['dxgi'], cflags: ['-O1', '-DCOBJMACROS=', '-DWIDL_C_INLINE_WRAPPERS'],
      libs: ['-ld3d10_1', '-ldxgi', '-luser32', '-lgdi32', '-lkernel32', '-luuid'],
    },
    {
      name: 'vulkan_test.exe', origin: 'upstream-wine-unmodified', license: 'LGPL-2.1-or-later',
      sources: ['vendor/wine-source/dlls/vulkan-1/tests/vulkan.c'], subtests: ['vulkan'], cflags: ['-O1'],
      libs: ['-lvulkan-1', '-luser32', '-lkernel32'],
    },
    {
      name: 'comdlg32_test.exe', origin: 'upstream-wine-unmodified', license: 'LGPL-2.1-or-later',
      sources: ['filedlg.c', 'finddlg.c', 'fontdlg.c', 'itemdlg.c', 'printdlg.c'].map(f => `vendor/wine-source/dlls/comdlg32/tests/${f}`),
      resources: ['vendor/wine-source/dlls/comdlg32/tests/rsrc.rc'], subtests: ['filedlg', 'finddlg', 'fontdlg', 'itemdlg', 'printdlg'], cflags: ['-O1', '-DCOBJMACROS='],
      libs: ['-luuid', '-lshell32', '-lole32', '-lcomdlg32', '-lwinspool', '-luser32', '-lgdi32', '-lkernel32'],
    },
    {
      name: 'user32_dialog_test.exe', origin: 'upstream-wine-unmodified', license: 'LGPL-2.1-or-later',
      sources: ['msg.c', 'dialog.c', 'resource.c'].map(f => `vendor/wine-source/dlls/user32/tests/${f}`),
      resources: ['vendor/wine-source/dlls/user32/tests/resource.rc'], subtests: ['msg', 'dialog', 'resource'], cflags: ['-O1'],
      libs: ['-luser32', '-lgdi32', '-ladvapi32', '-limm32', '-lkernel32', '-luuid'],
    },
    {
      name: 'porthole_x64_plan_test.exe',
      origin: 'porthole-wine-harness-x64',
      license: 'LGPL-2.1-or-later',
      sources: ['tests/wine64/porthole_x64_plan_test.c'],
      subtests: ['x64_plan'],
      cflags: ['-O1', '-fno-vectorize', '-fno-slp-vectorize'],
      libs: ['-ld3d12', '-ldxgi', '-luser32', '-lgdi32', '-lkernel32', '-luuid'],
    },
  ];

  const built = [];
  const selectedSpecs = only ? specs.filter(s => only.some(n => s.name.includes(n))) : specs;
  if (!selectedSpecs.length) throw new Error(`No Wine specs match ${only}`);
  for (const spec of selectedSpecs) {
    const testlistPath = path.join(outDir, `_${spec.name.replace(/\.exe$/, '')}_testlist.c`);
    fs.writeFileSync(testlistPath, makeTestlistSource(spec.subtests));
    const exePath = path.join(outDir, spec.name);
    const objects = [];
    for (const rc of spec.resources || []) {
      const obj = path.join(outDir, `${path.basename(rc, '.rc')}.res`);
      const rr = toolchain === 'zig'
        ? spawnSync(zig, ['rc', '/:auto-includes', 'gnu', '/i', 'vendor/wine-source/include', '/i', path.dirname(rc), '/fo', obj, rc], { encoding: 'utf8', timeout: 180000 })
        : spawnSync(windres, ['-I', 'vendor/wine-source/include', '-I', path.dirname(rc), '-i', rc, '-o', obj, '-O', 'coff'], { encoding: 'utf8', timeout: 180000 });
      if (rr.status !== 0) throw new Error(`Resource compile failed ${rc}:\n${rr.stderr || rr.stdout || rr.error}`);
      objects.push(obj);
    }
    const prefix = toolchain === 'mingw' ? [
      '-D__USE_MINGW_ANSI_STDIO=0', '-D_WIN32_WINNT=0x0a00',
    ] : ['cc', '-target', 'x86_64-windows-gnu'];
    const args = [
      ...prefix,
      '-DPeb=ProcessEnvironmentBlock', '-DDECLSPEC_EXPORT=',
      '-DENABLE_VIRTUAL_TERMINAL_PROCESSING=4',
      '-Ddebugstr_a=wine_dbgstr_a', '-Ddebugstr_w=wine_dbgstr_w',
      '-Ddebugstr_an=wine_dbgstr_an', '-Ddebugstr_wn=wine_dbgstr_wn',
      '-include', 'windows.h', `-I${incDir}`, ...(toolchain === 'mingw' ? ['-idirafter', 'vendor/wine-source/include'] : []),
      '-Wno-format', '-Wno-int-conversion', '-Wno-incompatible-pointer-types', '-Wno-macro-redefined',
      ...spec.cflags, ...spec.sources, testlistPath, ...spec.libs, ...objects,
      '-Wl,--subsystem,console', '-o', exePath,
    ];
    const run = spawnSync(toolchain === 'zig' ? zig : cc, args, { encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
    if (run.status !== 0) {
      throw new Error(`Failed compiling ${spec.name}:\n${run.stderr || run.stdout}`);
    }
    fs.rmSync(testlistPath, { force: true });
    // Normalize COFF TimeDateStamp for deterministic hashes
    const bytes = fs.readFileSync(exePath);
    const peOff = bytes.readUInt32LE(0x3c);
    bytes.writeUInt32LE(0, peOff + 8);
    fs.writeFileSync(exePath, bytes);
    const machine = bytes.readUInt16LE(peOff + 4);
    const magic = bytes.readUInt16LE(peOff + 24);
    if (machine !== 0x8664 || magic !== 0x020b) {
      throw new Error(`Expected PE32+ x86_64 for ${spec.name}, got machine=0x${machine.toString(16)} magic=0x${magic.toString(16)}`);
    }
    built.push({
      name: spec.name,
      path: exePath,
      bytes: bytes.length,
      sha256: sha256(bytes),
      origin: spec.origin,
      harness: 'porthole-assertion-observer-v1',
      wineCommit: wineSha,
      license: spec.license,
      sources: spec.sources.map((s) => ({ path: s, sha256: sha256(fs.readFileSync(s)) })),
      subtests: spec.subtests,
    });
    console.log(`[wine64-build] ${spec.name}: ${bytes.length} bytes sha256=${sha256(bytes).slice(0, 16)}… subtests=[${spec.subtests.join(', ')}]`);
  }

  fs.rmSync(incDir, { recursive: true, force: true });
  for (const extra of fs.readdirSync(outDir)) {
    if (extra.endsWith('.pdb') || extra.endsWith('.lib')) {
      fs.rmSync(path.join(outDir, extra), { force: true });
    }
  }

  const manifestPath = path.join(outDir, 'MANIFEST.json');
  const previous = only && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).binaries || [] : [];
  const merged = [...previous.filter(b => !built.some(n => n.name === b.name)), ...built];
  const manifest = {
    version: 1,
    kind: 'wine64-pe32plus-conformance',
    compiler: toolchain === 'zig' ? 'zig 0.13.0 (x86_64-windows-gnu)' : `${cc} (MinGW-w64)`,
    harness: { kind: 'porthole-assertion-observer-v1', sha256: sha256(fs.readFileSync('tests/torture/wine-observer.h')), note: 'Generated Wine test.h observer; upstream test .c/.rc sources are unmodified.' },
    wineCommit: wineSha,
    binaries: merged,
  };
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--only');
  const tc = argv.indexOf('--toolchain');
  buildWine64Suite({ only: at >= 0 ? argv[at + 1].split(',') : null, toolchain: tc >= 0 ? argv[tc + 1] : undefined });
}
