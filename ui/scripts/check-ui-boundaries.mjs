#!/usr/bin/env node
/*
 * UI boundary guard (extends ARCHITECTURE.md rule 3).
 *
 * 1. runtime/ is framework-free: no React imports, no imports from src/.
 * 2. src/ must not reach into rust/ or the legacy js/ platform internals.
 * 3. No native alert()/confirm()/prompt() anywhere in product code.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const exts = new Set([".ts", ".tsx"]);
let failures = 0;
let scanned = 0;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (exts.has(path.extname(entry.name))) yield full;
  }
}

function report(file, index, line, rule) {
  console.log(`${rule} :: ${path.relative(root, file)}:${index + 1}: ${line.trim().slice(0, 140)}`);
  failures += 1;
}

for (const file of walk(path.join(root, "runtime"))) {
  scanned += 1;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (/from\s+["']react["']|from\s+["']framer-motion["']/.test(line)) {
      report(file, index, line, "RUNTIME-no-framework");
    }
    if (/from\s+["'](?:@\/|\.\.\/src\/|src\/)/.test(line)) {
      report(file, index, line, "RUNTIME-no-ui-import");
    }
  });
}

for (const file of walk(path.join(root, "src"))) {
  scanned += 1;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (/from\s+["'][^"']*(?:rust\/|js\/x64-)/.test(line)) {
      report(file, index, line, "UI-no-internals");
    }
    if (/(?:window\.)?(?:alert|confirm|prompt)\s*\(/.test(line) && !/\/\//.test(line)) {
      report(file, index, line, "UI-no-native-dialogs");
    }
  });
}

if (failures > 0) {
  console.log(`check-ui-boundaries: FAIL (${failures} violation(s), ${scanned} files)`);
  process.exit(1);
}
console.log(`check-ui-boundaries: PASS (${scanned} files)`);
