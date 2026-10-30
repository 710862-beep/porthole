#!/usr/bin/env node
/*
 * "Strict TypeScript, no `any`" is a product rule, so it gets a machine check
 * (the repo has no ESLint). Scans UI sources for explicit any usage.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const roots = [path.join(root, "src"), path.join(root, "runtime")];
const pattern = /(?::\s*any\b|\bas\s+any\b|<any>|any\[\]|Record<[^>]*,\s*any>)/;
const exts = new Set([".ts", ".tsx"]);
let failures = 0;
let scanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (exts.has(path.extname(entry.name))) {
      scanned += 1;
      const lines = fs.readFileSync(full, "utf8").split("\n");
      lines.forEach((line, index) => {
        // Ignore comment-only mentions (e.g. explaining the rule).
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (pattern.test(line)) {
          console.log(`no-any :: ${path.relative(root, full)}:${index + 1}: ${trimmed.slice(0, 120)}`);
          failures += 1;
        }
      });
    }
  }
}

for (const dir of roots) walk(dir);
if (failures > 0) {
  console.log(`check-no-any: FAIL (${failures} explicit any in ${scanned} files)`);
  process.exit(1);
}
console.log(`check-no-any: PASS (${scanned} files, zero explicit any)`);
