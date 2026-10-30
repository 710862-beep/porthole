#!/usr/bin/env node
/*
 * Dependency-boundary guard (see ARCHITECTURE.md). Deliberately tiny: this repo has no
 * ESLint yet, so this script encodes the three machine-checkable rules with plain greps.
 * Exit 1 with the offending lines if a rule trips. Run in review / CI when convenient.
 *
 * Rule 1: rust/ core must not reference ui/ or DOM/browser JS objects beyond lib.rs glue.
 * Rule 3: ui/ must not import from rust/ or js/ internals (contracts + x64.html embed only).
 * Rule 4: tests/ must not import from ui/.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let failures = 0;

function* walk(dir, exts) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, exts);
    else if (exts.some((x) => e.name.endsWith(x))) yield p;
  }
}
function check(files, pattern, rule) {
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (pattern.test(line)) {
        console.log(`${rule} :: ${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        failures++;
      }
    });
  }
}

// Rule 1 (docs in code may mention ui/; only flag use/imports of DOM in Rust sources
// outside the wasm-bindgen export file).
const rustFiles = [...walk(path.join(root, 'rust/porthole-x64-wasm/src'), ['.rs'])]
  .filter((f) => !f.endsWith('lib.rs'));
check(rustFiles, /\b(web_sys|window\(\)|document\(\))\b/, 'RULE1 core-references-browser');

// Rule 3.
const uiFiles = [...walk(path.join(root, 'ui'), ['.js', '.ts', '.html'])];
check(uiFiles, /(from\s+['"]|src=['"]|href=['"])[^'"]*(rust\/|js\/x64-(nvme|d3d12))/, 'RULE3 ui-reaches-internals');

// Rule 4.
const testFiles = [...walk(path.join(root, 'tests'), ['.js', '.mjs', '.ts'])];
check(testFiles, /(from\s+['"]|require\(['"])[^'"]*ui\//, 'RULE4 tests-depend-on-ui');

if (failures) {
  console.log(`check-boundaries: FAIL (${failures} violation(s)) — see ARCHITECTURE.md`);
  process.exit(1);
}
console.log('check-boundaries: PASS (rules 1/3/4 grep-clean)');
