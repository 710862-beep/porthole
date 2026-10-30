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
export async function main() {
const result = [];

for (const name of names) {
  const spec = pins.suites[name];
  if (!spec) throw new Error(`Unknown suite: ${name}`);
  const entry = checkout(spec.repository, spec.revision, spec.path);
  entry.submodules = {};
  for (const [sub, pin] of Object.entries(spec.submodules || {})) {
    entry.submodules[sub] = checkout(pin.repository, pin.revision, path.join(spec.path, sub));
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
