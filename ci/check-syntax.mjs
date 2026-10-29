import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['js', 'shims', 'ci', 'tests/node', 'tests/wine', 'scripts'];
const files = ['input-raw.js', 'vfs-persist.js', 'spoof-hardware.js'];
function visit(relative) {
  if (!fs.existsSync(relative)) return;
  const stat = fs.statSync(relative);
  if (stat.isDirectory()) for (const entry of fs.readdirSync(relative)) visit(path.join(relative, entry));
  else if (/\.(?:js|mjs)$/.test(relative)) files.push(relative);
}
for (const root of roots) visit(root);
for (const file of [...new Set(files)].sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`node --check: ${new Set(files).size} scripts OK`);
