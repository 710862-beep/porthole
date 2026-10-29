import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { sanitizeEvidence } from '../../ci/autofix.mjs';

const require = createRequire(import.meta.url);
require('../../js/vfs.js');
require('../../js/porthole-linker.js');
require('../../js/retrowin32-backend.js');
const P = globalThis.Porthole;

function parseArgs(argv) {
  const result = { manifest: 'tests/wine/manifest.json', report: 'artifacts/wine-report.json', requireFixtures: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') result.manifest = argv[++i];
    else if (argv[i] === '--report') result.report = argv[++i];
    else if (argv[i] === '--require-fixtures') result.requireFixtures = true;
    else throw new Error(`Argumento desconhecido: ${argv[i]}`);
  }
  return result;
}
function inside(root, relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Path fora do repositório: ${relative}`);
  return resolved;
}
function xml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function missingApis(text) {
  const result = new Set();
  for (const match of String(text || '').matchAll(/\b([a-z0-9_.-]+\.dll)!([A-Za-z_][A-Za-z0-9_]*)/gi)) result.add(`${match[1].toLowerCase()}!${match[2]}`);
  return Array.from(result);
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve('.');
const manifest = JSON.parse(fs.readFileSync(inside(root, args.manifest), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.tests)) throw new Error('Manifesto Wine inválido.');
const report = { version: 1, kind: 'wine-pe-conformance', generatedAt: new Date().toISOString(), status: 'ACQUISITION_FAILED', tests: [] };
let backend = null;
let wasm = null;

for (const test of manifest.tests) {
  const started = Date.now();
  const item = { name: test.name || test.path, path: test.path, status: 'ACQUISITION_FAILED', durationMs: 0, missingApis: [] };
  report.tests.push(item);
  try {
    const file = inside(root, test.path);
    if (!fs.existsSync(file)) { item.status = 'ACQUISITION_FAILED'; item.error = 'Fixture ausente após aquisição; consulte artifacts/asset-acquisition.json.'; continue; }
    const bytes = fs.readFileSync(file);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    item.sha256 = sha256;
    if (!/^[0-9a-f]{64}$/.test(test.sha256 || '') || sha256 !== test.sha256) throw new Error('SHA-256 do fixture não corresponde ao manifesto.');
    if (!backend) {
      wasm = fs.readFileSync(inside(root, 'vendor/retrowin32/retrowin32.wasm'));
      backend = new P.Retrowin32Backend({ wasmBytes: wasm });
    }
    const process = await backend.createProcess({
      path: `C:\\WineTests\\${path.basename(test.path)}`,
      bytes,
      preload: false,
      commandLine: test.commandLine,
    });
    process.start();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(async () => {
        try { await process.stop('Wine test timeout.'); }
        catch (error) { resolve({ status: 'timeout', error: `Timeout e falha ao parar: ${error.message}` }); return; }
        resolve({ status: 'timeout', error: `Timeout após ${test.timeoutMs || 15000} ms.` });
      }, test.timeoutMs || 15000);
    });
    const result = await Promise.race([process.done, timeout]);
    clearTimeout(timer);
    item.instructions = result.instructions == null ? null : result.instructions;
    item.instructionCounterValid = typeof result.instructionCounterValid === 'boolean' ? result.instructionCounterValid : null;
    item.exitCode = result.exitCode;
    item.output = sanitizeEvidence(process.output).slice(0, 4000);
    item.missingApis = missingApis(`${result.error || ''}\n${process.output}`);
    if (result.status === 'timeout') { item.status = 'TIMEOUT'; item.error = result.error; }
    else if (result.status !== 'exited') { item.status = item.missingApis.length ? 'MISSING_API' : 'BACKEND_ERROR'; item.error = sanitizeEvidence(result.error || 'Processo não terminou normalmente.'); }
    else {
      const expectedExit = test.expectedExitCode == null ? 0 : Number(test.expectedExitCode);
      const stdout = test.stdoutIncludes == null || process.output.includes(test.stdoutIncludes);
      item.status = result.exitCode === expectedExit && stdout ? 'PASS' : 'FAIL';
      if (item.status === 'FAIL') item.error = `Exit/stdout divergente; esperado exit ${expectedExit}.`;
    }
  } catch (error) {
    item.error = sanitizeEvidence(error.message);
    item.missingApis = missingApis(error.message);
    item.status = item.missingApis.length ? 'MISSING_API' : 'BACKEND_ERROR';
  } finally { item.durationMs = Date.now() - started; }
}

if (manifest.tests.length && report.tests.every((item) => item.status === 'PASS')) report.status = 'PASS';
else if (report.tests.some((item) => !['PASS'].includes(item.status))) report.status = 'FAIL';
else report.status = 'ACQUISITION_FAILED';
report.summary = { declaredPrograms: report.tests.length, passedPrograms: report.tests.filter(t => t.status === 'PASS').length, failedPrograms: report.tests.filter(t => t.status !== 'PASS').length, wineAssertionsExecuted: null };
if (!manifest.tests.length) report.error = 'Aquisição Wine não produziu fixture validado. Consulte artifacts/asset-acquisition.json; nenhum assert Wine foi executado.';
fs.mkdirSync('tests/reports', { recursive: true });
fs.writeFileSync('tests/reports/wine-test-results.json', JSON.stringify(report, null, 2) + '\n');
const reportFile = inside(root, args.report);
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="porthole-wine-pe" tests="${report.tests.length}" failures="${report.tests.filter((item) => !['PASS'].includes(item.status)).length}" skipped="0">\n${report.tests.map((item) => `  <testcase name="${xml(item.name)}" time="${(item.durationMs / 1000).toFixed(3)}">${item.status === 'PASS' ? '' : `<failure message="${xml(item.status)}">${xml(item.error || '')}</failure>`}</testcase>`).join('\n')}\n</testsuite>\n`;
fs.writeFileSync(`${reportFile}.xml`, junit);
console.log(`[wine-pe] ${report.status}: ${report.tests.filter((item) => item.status === 'PASS').length}/${report.tests.length} PASS; relatório ${args.report}`);
if (report.error) console.error(`[wine-pe] ${report.error}`);
process.exitCode = report.status === 'PASS' ? 0 : 1;
