#!/usr/bin/env node
/* Classificador/autofix determinístico. Não gera stubs de sucesso. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FAILURE_LINE = /(?:\bfail(?:ed|ure)?\b|\berror\b|\berro\b|missing|not[_ ]implemented|não resolvido|não está implementado|export_not_found|dll_not_found)/i;
const API = /\b([a-z0-9_.-]+\.dll)!([A-Za-z_][A-Za-z0-9_]*)\b/gi;

export function sanitizeEvidence(line) {
  return String(line || '')
    .replace(/\b(token|cookie|secret|password|credential|value|data)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/(?:[A-Za-z]:\\|\/home\/|\/Users\/)[^\s"']+/g, '[PATH]')
    .slice(0, 320);
}

export function parseFailures(text, recipes = {}) {
  const failures = new Map();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(?:✓|PASS\b)/.test(line) || !FAILURE_LINE.test(line)) continue;
    for (const match of line.matchAll(API)) {
      const dll = match[1].toLocaleLowerCase('en-US');
      const api = match[2];
      const qualifiedName = `${dll}!${api}`;
      if (!failures.has(qualifiedName)) {
        failures.set(qualifiedName, {
          dll,
          api,
          qualifiedName,
          fingerprint: crypto.createHash('sha256').update(qualifiedName).digest('hex').slice(0, 16),
          status: Object.prototype.hasOwnProperty.call(recipes, qualifiedName) ? 'candidate-available' : 'Upstream Missing',
          evidence: sanitizeEvidence(line),
        });
      }
    }
  }
  return Array.from(failures.values()).sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
}

function argsOf(argv) {
  const result = { logs: [], report: 'artifacts/porthole-autofix-report.json', apply: false, commit: false, repo: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--log') result.logs.push(argv[++i]);
    else if (arg === '--report') result.report = argv[++i];
    else if (arg === '--repo') result.repo = argv[++i];
    else if (arg === '--apply') result.apply = true;
    else if (arg === '--commit') result.commit = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return result;
}

function inside(repo, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`Path de receita inválido: ${relative}`);
  const resolved = path.resolve(repo, relative);
  if (resolved !== repo && !resolved.startsWith(`${path.resolve(repo)}${path.sep}`)) throw new Error('Receita tentou escapar do repositório.');
  return resolved;
}

function command(command, args, cwd, inherit = true) {
  const result = spawnSync(command, args, { cwd, stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function writeReport(repo, relative, report) {
  const target = inside(repo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  return target;
}

function loadRecipes(repo) {
  const file = inside(repo, 'ci/shim-recipes.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.version !== 1 || !parsed.recipes || typeof parsed.recipes !== 'object') throw new Error('Formato de shim-recipes inválido.');
  return parsed.recipes;
}

function applyCandidate(repo, qualifiedName, recipe) {
  const sourceRel = recipe.source;
  const testRel = recipe.targetTest;
  const source = inside(repo, sourceRel);
  const test = inside(repo, testRel);
  const beforeRel = recipe.insertBefore;
  const snippet = fs.readFileSync(inside(repo, recipe.snippet), 'utf8');
  const regression = fs.readFileSync(inside(repo, recipe.test), 'utf8');
  if (snippet.length > 16384 || regression.length > 32768) throw new Error('Receita excede limite de tamanho.');
  if (/\b(?:eval|Function|child_process|process\.env|fetch|XMLHttpRequest)\b/.test(snippet)) throw new Error('Snippet contém operação não permitida.');

  const original = fs.readFileSync(source, 'utf8');
  const method = qualifiedName.split('!')[1];
  if (new RegExp(`\\b${method}\\s*\\(`).test(original)) return { status: 'already-implemented', restore() {} };
  if (!beforeRel || !original.includes(beforeRel)) throw new Error(`Âncora de ${sourceRel} não encontrada.`);
  if (fs.existsSync(test)) throw new Error(`Teste de destino já existe: ${testRel}`);
  fs.writeFileSync(source, original.replace(beforeRel, `${snippet}\n${beforeRel}`));
  fs.mkdirSync(path.dirname(test), { recursive: true });
  fs.writeFileSync(test, regression);
  return {
    status: 'candidate-written',
    restore() {
      fs.writeFileSync(source, original);
      fs.rmSync(test, { force: true });
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = argsOf(argv);
  const repo = path.resolve(args.repo);
  const recipes = loadRecipes(repo);
  const logs = args.logs.length ? args.logs : ['artifacts/npm-test.log'];
  const text = logs.map((log) => {
    const file = inside(repo, log);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }).join('\n');
  const failures = parseFailures(text, recipes);
  const report = { version: 1, generatedAt: new Date().toISOString(), logs, status: failures.length ? 'MISSING_API' : 'NO_MISSING_API', failures };
  let reportPath = writeReport(repo, args.report, report);
  console.log(`[autofix] ${failures.length} API(s) ausente(s); relatório: ${path.relative(repo, reportPath)}`);
  for (const failure of failures) console.log(`  ${failure.status}: ${failure.qualifiedName} [${failure.fingerprint}]`);
  if (!args.apply) return 0;

  const candidate = failures.find((failure) => failure.status === 'candidate-available');
  if (!candidate) {
    console.error('[autofix] Upstream Missing: nenhuma receita revisada disponível.');
    return 3;
  }
  const recipe = recipes[candidate.qualifiedName];
  if (args.commit) {
    if (process.env.PORTHOLE_AUTOFIX_COMMIT !== '1') throw new Error('Auto-commit requer PORTHOLE_AUTOFIX_COMMIT=1.');
    const branch = command('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo, false);
    if (branch.status || branch.stdout.trim() !== 'arena/6a52f3cb-porthole') throw new Error('Auto-commit só é permitido na branch da sessão.');
    const dirty = command('git', ['status', '--porcelain'], repo, false);
    if (dirty.status || dirty.stdout.trim()) throw new Error('Auto-commit requer worktree limpo.');
  }

  const applied = applyCandidate(repo, candidate.qualifiedName, recipe);
  candidate.status = applied.status;
  if (applied.status === 'already-implemented') { writeReport(repo, args.report, report); return 0; }
  console.log(`[autofix] Candidato real para ${candidate.qualifiedName}; executando regressão e suíte completa.`);
  const isolated = command(process.execPath, [inside(repo, recipe.targetTest)], repo);
  const full = isolated.status === 0 ? command('npm', ['test'], repo) : isolated;
  if (full.status !== 0) {
    applied.restore();
    candidate.status = 'candidate-failed';
    report.status = 'AUTOFIX_FAILED';
    writeReport(repo, args.report, report);
    console.error(`[autofix] ${candidate.qualifiedName} falhou; candidato revertido.`);
    return 2;
  }
  candidate.status = 'candidate-passed';
  report.status = 'AUTOFIX_PASSED';
  writeReport(repo, args.report, report);

  if (args.commit) {
    const added = command('git', ['add', '--', recipe.source, recipe.targetTest], repo);
    const committed = added.status === 0 ? command('git', ['commit', '-m', `fix(shim): implement ${candidate.qualifiedName} [autofix]`], repo) : added;
    if (committed.status !== 0) {
      command('git', ['reset', '--', recipe.source, recipe.targetTest], repo);
      applied.restore();
      candidate.status = 'commit-failed';
      report.status = 'AUTOFIX_FAILED';
      writeReport(repo, args.report, report);
      console.error(`[autofix] git add/commit falhou para ${candidate.qualifiedName}; candidato revertido.`);
      return 2;
    }
    candidate.status = 'committed';
    writeReport(repo, args.report, report);
  }
  console.log(`[autofix] ${candidate.qualifiedName}: ${candidate.status}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(`[autofix] ${error.message}`); process.exitCode = 1; });
}
