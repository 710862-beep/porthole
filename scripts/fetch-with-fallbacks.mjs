import { githubAPIHeaders } from './github-api-auth.mjs';
/** Authorized acquisition alternatives. Never disables TLS or conceals synthetic provenance. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { main, validatePE } from './fetch-test-assets.mjs';
main(); // Initial public-source attempts and pinned retrowin32 blobs.
const manifest = JSON.parse(fs.readFileSync('tests/assets/MANIFEST.json'));
manifest.fallbacks = { attempts: [], discoveries: [], synthetic: [], unavailable: [{ strategy: 'jsDelivr/unpkg/external proxies', reason: 'Hosts outside environment allowlist; no TLS bypass or unauthorized proxy attempted.' }] };
function request(url, binary = false) {
  const item = { url, accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' };
  manifest.fallbacks.attempts.push(item);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-api-'));
  try {
    const file = path.join(tmp,'payload');
    const run = spawnSync('curl', [...githubAPIHeaders(url), '-sS', '-L', '--fail-with-body', '--connect-timeout', '10', '--max-time', '45', '--max-filesize', '67108864', '--proto', '=https', '--proto-redir', '=https', '-H', `Accept: ${item.accept}`, '-H', 'X-GitHub-Api-Version: 2022-11-28', '-o', file, '-w', '%{http_code}\n%{url_effective}', url], { encoding: 'utf8', timeout: 50000 });
    const [code, finalUrl] = (run.stdout || '').split('\n'); item.httpStatus = Number(code)||null; item.finalUrl = finalUrl;
    if (run.status !== 0) throw new Error(run.stderr || run.error?.message || `exit ${run.status}`);
    return fs.readFileSync(file);
  } catch(e) { item.error=e.message; throw e; }
  finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}
const json = url => JSON.parse(request(url).toString());
function save(name, bytes, origin, min=64) {
  const pe = validatePE(bytes,min);
  if (pe.machine !== 0x14c) throw new Error(`Not x86: ${pe.machine}`);
  const file=`tests/assets/${name}`; fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,bytes);
  manifest.assets=manifest.assets.filter(a=>a.path!==file);
  manifest.assets.push({path:file,...pe,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),...origin});
}
function task(name,fn) { try { fn(); } catch(e) { manifest.fallbacks.attempts.push({strategy:name,error:e.message}); console.error(`[fallback failed] ${name}: ${e.message}`); } }
for (const [repo,match,name,zip] of [
  ['lucasg/Dependencies',/^Dependencies_x86_Release.zip$/,'windows/Dependencies.exe',true],
  ['notepad-plus-plus/notepad-plus-plus',/^npp\..*\.Installer\.exe$/i,'installers/notepad-plus-plus.exe',false]
]) task(`release asset API ${repo}`,()=>{
  const release=json(`https://api.github.com/repos/${repo}/releases/latest`);
  const asset=release.assets.find(a=>match.test(a.name)); if(!asset) throw new Error('No matching release asset');
  const bytes=request(asset.url,true);
  if (!zip) { save(name,bytes,{url:asset.url,tag:release.tag_name}); return; }
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'porthole-release-'));
  try {
    const file=path.join(tmp,'asset.zip'); fs.writeFileSync(file,bytes);
    const list=spawnSync('unzip',['-Z1',file],{encoding:'utf8'});
    if(list.status!==0) throw new Error('Release API did not return a readable ZIP (may have returned JSON metadata)');
    const member=list.stdout.split('\n').find(p=>/(^|\/)Dependencies\.exe$/i.test(p));
    if(!member) throw new Error('No Dependencies.exe in archive');
    const data=spawnSync('unzip',['-p',file,member],{maxBuffer:67108864});
    if(data.status!==0) throw new Error('ZIP member read failed');
    save(name,data.stdout,{url:asset.url,tag:release.tag_name,member});
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
// Deterministic, identified public mirror: search results are not stable inputs.
task('pinned DOOM95 mirror blob',()=>{
  if(manifest.assets.some(a=>a.path==='tests/assets/games/doom95.exe'))return;
  const url='https://api.github.com/repos/mshoger/doom95/git/blobs/650051f2ec90a61385acb8fec4ce57444b7e4d94';
  const blob=json(url);if(blob.encoding!=='base64')throw Error('Expected base64 Git blob');
  const bytes=Buffer.from(blob.content,'base64');
  if(crypto.createHash('sha256').update(bytes).digest('hex')!=='209aaa8f56e982ad21cad48d853e6a926900062f8f46757c649ccc7e2249dec8')throw Error('Pinned DOOM95 checksum mismatch');
  save('games/doom95.exe',bytes,{url,repository:'mshoger/doom95',provenance:'public mirror; not authenticated official distribution'});
});
// Bounded and explicit search, not a claim to have exhausted all public forks.
for(const [query,basename,name,min] of [
  ['winetest in:name',/^winetest.*\.exe$/i,'wine/winetest.exe',1048577],
  ['doom95 in:name',/^doom95\.exe$/i,'games/doom95.exe',64],
  ['kkrieger in:name',/^(\.?(kkrieger|kk))\.exe$/i,'games/kkrieger.exe',64]
]) task(`repository search ${query}`,()=>{
  const search=json(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=3`);
  manifest.fallbacks.discoveries.push({query,total:search.total_count,repositories:(search.items||[]).map(r=>r.full_name)});
  for(const repo of search.items||[]) {
    if(manifest.assets.some(a=>a.path===`tests/assets/${name}`)) break;
    task(`tree ${repo.full_name}`,()=>{
      const tree=json(`https://api.github.com/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
      if(tree.truncated) throw new Error('Truncated tree: not evidence of absence');
      const files=(tree.tree||[]).filter(a=>a.type==='blob' && basename.test(path.basename(a.path)));
      if(!files.length) throw new Error('No matching standalone PE (archives/source require separate build)');
      for(const file of files) {
        const url=`https://api.github.com/repos/${repo.full_name}/git/blobs/${file.sha}`;
        const blob=json(url); if(blob.encoding!=='base64') throw new Error('Unsupported blob encoding');
        save(name,Buffer.from(blob.content,'base64'),{url,repository:repo.full_name,tree:tree.sha,upstreamPath:file.path},min); break;
      }
    });
  }
});
// Wine build forks often publish Linux Wine, not PE conformance bundles.
for (const query of ['winetest in:name language:shell', 'wine-builds in:name', 'wine-staging in:name']) task(`Wine build search ${query}`, () => {
  const search = json(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=3`);
  manifest.fallbacks.discoveries.push({ query, total: search.total_count, repositories: (search.items || []).map(r => r.full_name) });
  for (const repo of search.items || []) task(`Wine fork releases ${repo.full_name}`, () => {
    const releases = json(`https://api.github.com/repos/${repo.full_name}/releases?per_page=2`);
    const assets = releases.flatMap(r => r.assets || []);
    manifest.fallbacks.discoveries.push({ repository: repo.full_name, releaseAssets: assets.map(a => a.name) });
    const candidates = assets.filter(a => /winetest.*\.exe$/i.test(a.name) && !/64/.test(a.name));
    if (!candidates.length) throw new Error('No standalone x86 winetest PE in the inspected releases; Linux Wine archives are not Windows conformance PE fixtures');
    for (const asset of candidates) task(`Wine PE asset ${asset.url}`, () => save('wine/winetest.exe', request(asset.url, true), { url: asset.url }, 1048577));
  });
});
// Build independent substitutes without claiming original games/Wine are acquired.
const build=spawnSync(process.execPath,['scripts/build-synthetic.mjs'],{encoding:'utf8',timeout:180000});
fs.mkdirSync('artifacts',{recursive:true}); fs.writeFileSync('artifacts/synthetic-build.log',(build.stdout||'')+(build.stderr||''));
if(build.status===0) manifest.fallbacks.synthetic=JSON.parse(fs.readFileSync('tests/synthetic/BUILD.json')).tests;
else manifest.fallbacks.attempts.push({strategy:'synthetic PE source build',error:build.error?.message||build.stderr||`exit ${build.status}`});
manifest.missing=manifest.missing.filter(name=>!manifest.assets.some(a=>a.path===`tests/assets/${name}`));
const upstreamFailure=manifest.errors.some(e=>e.asset==='retrowin32'||e.asset.startsWith('exe/'));
manifest.status=manifest.missing.length||upstreamFailure?'ACQUISITION_PARTIAL':'ACQUIRED';
fs.writeFileSync('tests/assets/MANIFEST.json',JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync('artifacts/asset-acquisition.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:manifest.status,missing:manifest.missing,syntheticBuilt:manifest.fallbacks.synthetic.length},null,2));
process.exitCode=manifest.missing.length||upstreamFailure||build.status!==0?1:0;
