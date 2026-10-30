#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pins = JSON.parse(fs.readFileSync('tests/torture/pins.json', 'utf8'));
const selected = process.argv.slice(2).filter(a => !a.startsWith('--'));
const names = selected.length ? selected : Object.keys(pins.suites);
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr || r.error}`);
  return r.stdout.trim();
}
export function checkout(repo, revision, dir) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`Unpinned revision for ${repo}`);
  const u = new URL(repo);
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error(`Unapproved source host: ${repo}`);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) git(dir, ['init', '-q']);
  if (fs.existsSync(path.join(dir, '.git', 'HEAD')) && spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir }).status === 0
      && git(dir, ['rev-parse', 'HEAD']) === revision) {
    if (git(dir, ['status', '--porcelain'])) throw new Error(`Dirty upstream checkout: ${dir}`);
  } else {
    git(dir, ['fetch', '--depth=1', repo, revision]);
    git(dir, ['checkout', '--detach', '-q', 'FETCH_HEAD']);
  }
  if (git(dir, ['rev-parse', 'HEAD']) !== revision) throw new Error(`Revision mismatch: ${dir}`);
  return { repository: repo, revision, path: dir };
}
export function checkoutRecursive(repo, revision, dir, depth = 0) {
  if (depth > 6) throw new Error(`Submodule recursion too deep at ${dir}`);
  const entry = checkout(repo, revision, dir);
  entry.submodules = {};
  const modFile = path.join(dir, '.gitmodules');
  if (!fs.existsSync(modFile)) return entry;
  const text = fs.readFileSync(modFile, 'utf8');
  const blocks = [...text.matchAll(/\[submodule "([^"]+)"\]([\s\S]*?)(?=\n\[|$)/g)];
  for (const [, name, body] of blocks) {
    const subPath = body.match(/^\s*path\s*=\s*(.+)$/m)?.[1].trim();
    let url = body.match(/^\s*url\s*=\s*(.+)$/m)?.[1].trim();
    if (!subPath || !url) throw new Error(`Malformed .gitmodules entry ${name} in ${dir}`);
    if (url.startsWith('../')) url = new URL(url, repo.endsWith('/') ? repo : repo + '/').href;
    const link = git(dir, ['ls-tree', revision, '--', subPath]);
    const pin = link.match(/^160000 commit ([0-9a-f]{40})\t/)?.[1];
    if (!pin) throw new Error(`Missing gitlink pin for ${name} in ${repo}@${revision}`);
    entry.submodules[subPath] = checkoutRecursive(url, pin, path.join(dir, subPath), depth + 1);
  }
  return entry;
}
export async function main() {
const result = [];

for (const name of names) {
  const spec = pins.suites[name];
  if (!spec) throw new Error(`Unknown suite: ${name}`);
  const entry = checkoutRecursive(spec.repository, spec.revision, spec.path);
  for (const [sub, pin] of Object.entries(spec.submodules || {})) {
    const actual = entry.submodules[sub];
    if (!actual || actual.revision !== pin.revision) throw new Error(`Explicit pin mismatch for ${name}/${sub}`);
  }
  result.push({ name, ...entry });
  console.log(`[fetch] VERIFIED ${name} ${spec.revision}`);
}
fs.mkdirSync('artifacts/torture', { recursive: true });
fs.writeFileSync('artifacts/torture/sources.json', JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), suites: result }, null, 2) + '\n');

}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
