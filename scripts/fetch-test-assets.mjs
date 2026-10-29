import { githubAPIHeaders } from './github-api-auth.mjs';
/** Acquisition only: downloaded programs are never executed by this script.
 * curl uses the system CA store (Node's CA store differs in some sandboxes).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validatePE(bytes, minSize = 64) {
  if (bytes.length < Math.max(64, minSize)) throw new Error(`Size ${bytes.length} below ${minSize}`);
  if (bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Missing MZ');
  const offset = bytes.readUInt32LE(60);
  if (offset < 64 || offset + 24 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550) throw new Error('Invalid PE signature/offset');
  return { machine: bytes.readUInt16LE(offset + 4), size: bytes.length };
}
const revision = '7c9243072755da54054bcaa9e1351371af638ded';
const root = 'tests/assets';
const manifest = { version: 1, generatedAt: new Date().toISOString(), assets: [], attempts: [], errors: [] };
function download(url) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-fetch-'));
  const file = path.join(tmp, 'payload');
  const attempt = { url };
  manifest.attempts.push(attempt);
  try {
    const r = spawnSync('curl', [...githubAPIHeaders(url), '--location', '--fail-with-body', '--silent', '--show-error', '--connect-timeout', '10', '--max-time', '60', '--max-filesize', '67108864', '--proto', '=https', '--proto-redir', '=https', '--output', file, '--write-out', '%{http_code}', url], { encoding: 'utf8', timeout: 65000 });
    attempt.httpStatus = Number(r.stdout) || null;
    if (r.status !== 0) throw new Error(r.error?.message || r.stderr.trim() || `curl exit ${r.status}`);
    return fs.readFileSync(file);
  } catch (e) { attempt.error = e.message; throw e; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function json(url) { return JSON.parse(download(url).toString()); }
function save(name, bytes, url, extra = {}, minSize = 64) {
  const pe = validatePE(bytes, minSize);
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, bytes); fs.renameSync(`${file}.tmp`, file);
  manifest.assets.push({ path: file, url, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...pe, ...extra });
  console.log(`[acquired] ${name} (${bytes.length} bytes)`);
}
function acquire(name, sources, minSize = 64) {
  for (const url of sources) {
    try { save(name, download(url), url, {}, minSize); return; }
    catch (e) { manifest.errors.push({ asset: name, url, reason: e.message, recovered: false }); }
  }
  throw new Error(`${name}: all ${sources.length} sources failed`);
}
function githubBlob(repo, ref, item, name) {
  const url = `https://api.github.com/repos/${repo}/git/blobs/${item.sha}`;
  const blob = json(url);
  if (blob.encoding !== 'base64') throw new Error(`Unsupported blob encoding ${blob.encoding}`);
  save(name, Buffer.from(blob.content, 'base64'), url, { repository: repo, revision: ref, upstreamPath: item.path });
}
function task(name, fn) { try { fn(); } catch (e) { manifest.errors.push({ asset: name, reason: e.message }); console.error(`[FAILED] ${name}: ${e.message}`); } }
export function main() {
  fs.mkdirSync(root, { recursive: true });
  task('retrowin32', () => {
    const tree = json(`https://api.github.com/repos/evmar/retrowin32/git/trees/${revision}?recursive=1`);
    if (tree.truncated || !tree.tree) throw new Error('Incomplete upstream tree');
    const files = tree.tree.filter(x => x.path.endsWith('.exe') && x.type === 'blob');
    if (!files.length) throw new Error('No executables discovered');
    for (const item of files) task(item.path, () => githubBlob('evmar/retrowin32', revision, item, `retrowin32/${item.path.replace(/^exe\//, '')}`));
  });
  task('wine/winetest.exe', () => {
    const sources = [];
    for (const repo of ['ArtifexSoftware/wine', 'wine-mirror/wine']) {
      try {
        const releases = json(`https://api.github.com/repos/${repo}/releases?per_page=10`);
        for (const release of releases) for (const asset of release.assets || []) if (/winetest.*\.exe$/i.test(asset.name) && !/64/.test(asset.name)) sources.push(asset.browser_download_url);
      } catch (e) { manifest.errors.push({ asset: 'wine/winetest.exe', repository: repo, reason: e.message }); }
    }
    sources.push('https://test.winehq.org/builds/winetest-latest.exe', 'https://web.archive.org/web/2024/https://winehq.org/winetest.exe');
    acquire('wine/winetest.exe', sources, 1048577);
  });
  // These public pages may be HTML, not PE files. Reject them, never save HTML as an exe.
  task('games/doom95.exe', () => acquire('games/doom95.exe', ['https://archive.org/download/doom95/doom95.exe']));
  task('games/kkrieger.exe', () => acquire('games/kkrieger.exe', ['https://www.theprodukkt.com/files/kkrieger.exe', 'https://archive.org/download/kkrieger/kkrieger.exe']));
  // Search the requested mirror; do not guess a Windows proprietary binary URL.
  task('game/windows mirror discovery', () => {
    const repo = 'Abel0424/abandons';
    const info = json(`https://api.github.com/repos/${repo}`);
    const tree = json(`https://api.github.com/repos/${repo}/git/trees/${info.default_branch}?recursive=1`);
    if (tree.truncated || !tree.tree) throw new Error('Incomplete mirror tree');
    for (const [pattern, name] of [[/^doom95\.exe$/i, 'games/doom95.exe'], [/^kkrieger\.exe$/i, 'games/kkrieger.exe'], [/^(winmine|minesweeper)\.exe$/i, 'windows/Minesweeper.exe'], [/^notepad\.exe$/i, 'windows/notepad.exe']]) {
      if (manifest.assets.some(a => a.path === `${root}/${name}`)) continue;
      const item = tree.tree.find(x => pattern.test(path.basename(x.path)));
      if (!item) { manifest.errors.push({ asset: name, reason: `No matching executable in ${repo}` }); continue; }
      githubBlob(repo, info.default_branch, item, name);
    }
  });
  task('Dependencies', () => {
    const release = json('https://api.github.com/repos/lucasg/Dependencies/releases/latest');
    const asset = release.assets.find(a => a.name === 'Dependencies_x86_Release.zip');
    if (!asset) throw new Error('x86 release not found');
    const bytes = download(asset.browser_download_url);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-zip-'));
    try {
      const zip = path.join(tmp, 'asset.zip'); fs.writeFileSync(zip, bytes);
      // Read exactly one member, never extract archive paths into the filesystem.
      const list = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
      if (list.status !== 0) throw new Error(list.stderr);
      const member = list.stdout.split('\n').find(x => /(^|\/)Dependencies\.exe$/i.test(x));
      if (!member) throw new Error('Dependencies.exe not in archive');
      const r = spawnSync('unzip', ['-p', zip, member], { maxBuffer: 67108864 });
      if (r.status !== 0) throw new Error('Cannot read ZIP member');
      save('windows/Dependencies.exe', r.stdout, asset.browser_download_url, { member, archiveSha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  task('NSIS installer', () => {
    const release = json('https://api.github.com/repos/notepad-plus-plus/notepad-plus-plus/releases/latest');
    const asset = release.assets.find(a => /^npp\..*\.Installer\.exe$/i.test(a.name));
    if (!asset) throw new Error('32-bit Notepad++ NSIS installer not found');
    acquire('installers/notepad-plus-plus.exe', [asset.browser_download_url]);
  });
  const required = ['wine/winetest.exe', 'games/doom95.exe', 'games/kkrieger.exe', 'windows/Minesweeper.exe', 'windows/notepad.exe', 'windows/Dependencies.exe', 'installers/notepad-plus-plus.exe', 'retrowin32/cpp/thread.exe'];
  manifest.missing = required.filter(name => !manifest.assets.some(a => a.path === `${root}/${name}`));
  manifest.status = manifest.missing.length || manifest.errors.some(e => e.asset.startsWith('exe/')) ? 'ACQUISITION_FAILED' : 'ACQUIRED';
  fs.writeFileSync(`${root}/MANIFEST.json`, JSON.stringify(manifest, null, 2) + '\n');
  fs.mkdirSync('artifacts', { recursive: true });
  fs.copyFileSync(`${root}/MANIFEST.json`, 'artifacts/asset-acquisition.json');
  console.log(JSON.stringify({ status: manifest.status, acquired: manifest.assets.length, missing: manifest.missing, errors: manifest.errors }, null, 2));
  if (manifest.status !== 'ACQUIRED') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
