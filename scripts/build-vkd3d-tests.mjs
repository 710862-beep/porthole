#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkoutRecursive as checkout } from './fetch-torture-sources.mjs';
const pins = JSON.parse(fs.readFileSync('tests/torture/pins.json','utf8')).suites['vkd3d-proton'];
checkout(pins.repository, pins.revision, pins.path);
function run(cmd,args) { const r=spawnSync(cmd,args,{cwd:pins.path,stdio:'inherit',timeout:1800000}); if(r.status!==0) throw Error(`${cmd} failed: ${r.status} ${r.error||''}`); }
const build = path.resolve('tests/assets/vkd3d-proton-build');
fs.mkdirSync(build, { recursive: true });
let cross = fs.readFileSync(path.join(pins.path, 'build-win64.txt'), 'utf8');
const widl = process.env.PORTHOLE_WIDL || ['widl', '/usr/lib/wine/widl', '/usr/lib/wine/x86_64-unix/widl'].find(p => p.includes('/') ? fs.existsSync(p) : spawnSync(p, ['--version']).status === 0);
if (widl) cross = cross.replace("[binaries]", `[binaries]\nwidl = '${widl}'`);
const crossPath = path.join(build, 'porthole-win64.txt');
fs.writeFileSync(crossPath, cross);
run(process.env.PORTHOLE_MESON||'meson',['setup',build,'--cross-file',crossPath,'-Denable_tests=true','-Denable_extras=false','--buildtype=release','-Dc_args=-D_WIN32_WINNT=0x0A00 -DPATHCCH_NONE=0','-Dcpp_args=-D_WIN32_WINNT=0x0A00 -DPATHCCH_NONE=0']);
run(process.env.PORTHOLE_MESON||'meson',['compile','-C',build,'tests/d3d12']);
const exe=path.join(build,'tests/d3d12.exe');
if(!fs.existsSync(exe)) throw Error(`Missing ${exe}`);
fs.mkdirSync('tests/assets/torture',{recursive:true});
const crypto=await import('node:crypto'); const bytes=fs.readFileSync(exe);
const target='tests/assets/torture/vkd3d-d3d12.exe';fs.copyFileSync(exe,target);
const mp='tests/assets/torture/MANIFEST.json';const m=fs.existsSync(mp)?JSON.parse(fs.readFileSync(mp,'utf8')):{version:1,binaries:[]};
m.binaries=m.binaries.filter(b=>b.name!==path.basename(target)).concat({name:path.basename(target),path:target,suite:'vkd3d-proton',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,sourceRevision:pins.revision,args:[],env:{VKD3D_TEST_DEBUG:'2',VKD3D_TEST_PLATFORM:'windows'},origin:'upstream-source-unmodified'});
fs.writeFileSync(mp,JSON.stringify(m,null,2)+'\n');
