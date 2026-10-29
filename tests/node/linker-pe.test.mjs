import assert from 'node:assert/strict';
import { loadScripts, buildPE } from './helpers.mjs';

const P = loadScripts('porthole-linker', 'pe-loader');
let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log('  ✓', name); };

console.log('\n[PE/COFF parser]');
const pe = P.PELoader.parse(buildPE(), { name: 'fixture.exe' });
check('MZ, PE32, x86, seção e entry point são lidos', () => {
  assert.equal(pe.format, 'PE32'); assert.equal(pe.architecture, 'x86');
  assert.equal(pe.sections[0].name, '.text'); assert.equal(pe.entryPointOffset, 0x400);
  assert.equal(pe.byteLength, 0x1000);
});
check('Import table produz DLLs e símbolos nomeados', () => {
  assert.equal(pe.imports.length, 2);
  assert.equal(pe.imports[0].dll, 'kernel32.dll');
  assert.equal(pe.imports[0].functions[0].name, 'CreateFileA');
  assert.equal(pe.imports[1].functions[0].name, 'Direct3DCreate9');
});
check('Parser nunca marca o entry point como executado', () => {
  assert.equal(pe.execution.executed, false); assert.equal(pe.execution.backend, null);
});
check('Ordinal é preservado sem inventar nome', () => {
  const ordinalPE = P.PELoader.parse(buildPE([{ dll: 'user32.dll', functions: [{ ordinal: 42 }] }]));
  assert.equal(ordinalPE.imports[0].functions[0].ordinal, 42);
  assert.equal(ordinalPE.imports[0].functions[0].name, null);
});
check('Arquivos inválidos/truncados são rejeitados', () => {
  assert.throws(() => P.PELoader.parse(new ArrayBuffer(64)), (e) => e.code === 'NOT_PE' || e.code === 'TRUNCATED');
  const invalid = buildPE(); new DataView(invalid).setUint32(0x80, 0, true);
  assert.throws(() => P.PELoader.parse(invalid), (e) => e.code === 'NOT_PE');
});

console.log('\n[Dynamic Linker]');
const tracer = new P.ApiTracer(100);
const linker = new P.DynamicLinker({ tracer });
let presents = 0;
linker.register('kernel32.dll', () => ({ CreateFileA(path) { return `open:${path}`; } }));
linker.register('d3d9.dll', () => ({ Direct3DCreate9(version) { return version; }, Present() { presents += 1; } }));
check('LoadLibrary é case-insensitive e mantém refcount', () => {
  const first = linker.loadLibrary('D3D9', 'test');
  const second = linker.loadLibrary('c:\\windows\\system32\\d3d9.dll', 'test');
  assert.equal(first, second); assert.equal(linker.loadedModules()[0].refs, 2);
});
check('GetProcAddress aceita instância e invoca export real', () => {
  const d3d = linker.loadLibrary('d3d9.dll');
  const present = linker.getProcAddress(d3d, 'Present');
  assert.equal(typeof present, 'function'); present(); assert.equal(presents, 1);
});
check('Resolver imports separa resolvidos, ordinais e DLLs ausentes', () => {
  const report = linker.resolveImports(pe);
  assert.equal(report.totalFunctions, 2); assert.equal(report.resolvedFunctions, 2);
  assert.equal(report.importsComplete, true);
  const missing = linker.resolveImports(P.PELoader.parse(buildPE([{ dll: 'dxgi.dll', functions: ['CreateDXGIFactory'] }])));
  assert.deepEqual(missing.unsupportedDlls, ['dxgi.dll']); assert.equal(missing.importsComplete, false);
});
check('FreeLibrary destrói somente no último refcount', () => {
  const before = linker.loadedModules().find((m) => m.name === 'd3d9.dll').refs;
  linker.freeLibrary('d3d9.dll');
  assert.equal(linker.loadedModules().find((m) => m.name === 'd3d9.dll').refs, before - 1);
  for (let i = 0; i < before && linker.loadedModules().some((m) => m.name === 'd3d9.dll'); i += 1) linker.freeLibrary('d3d9.dll');
  assert.equal(linker.loadedModules().some((m) => m.name === 'd3d9.dll'), false);
});
check('Tracer contém a interposição LoadLibrary → SHIM', () => {
  assert.ok(tracer.entries.some((entry) => /LoadLibrary\(.*d3d9\.dll.*SHIM ativo/.test(entry.message)));
});

console.log(`\nlinker-pe: ${passed} verificações concluídas.`);
