#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkout } from './fetch-torture-sources.mjs';
const pin=JSON.parse(fs.readFileSync('tests/torture/pins.json','utf8')).suites['vk-gl-cts'];
checkout(pin.repository,pin.revision,pin.path);
function run(cmd,args,cwd=pin.path){const r=spawnSync(cmd,args,{cwd,stdio:'inherit',timeout:3600000});if(r.status!==0)throw Error(`${cmd} failed: ${r.status} ${r.error||''}`);}
run(process.env.PYTHON||'python3',['external/fetch_sources.py']);
const build=path.resolve('tests/assets/vk-cts-build');
const target=process.platform==='win32'?'default':'vulkan_headless';
run('cmake',['-S','.','-B',build,`-DDEQP_TARGET=${target}`,'-DSELECTED_BUILD_TARGETS=deqp-vk','-DCMAKE_BUILD_TYPE=Release',...(process.platform==='win32'?['-G','Visual Studio 17 2022','-A','x64']:['-G','Ninja'])]);
run('cmake',['--build',build,'--target','deqp-vk','--config','Release','--parallel','4']);
const exe=path.join(build,'external/vulkancts/modules/vulkan',process.platform==='win32'?'Release/deqp-vk.exe':'deqp-vk');
if(!fs.existsSync(exe))throw Error(`Missing ${exe}`);
if(process.platform==='win32'){
 const crypto=await import('node:crypto');const bytes=fs.readFileSync(exe);const out='tests/assets/torture/deqp-vk.exe';fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(exe,out);
 const mp='tests/assets/torture/MANIFEST.json';const m=fs.existsSync(mp)?JSON.parse(fs.readFileSync(mp,'utf8')):{version:1,binaries:[]};
 m.binaries=m.binaries.filter(b=>b.name!=='deqp-vk.exe').concat({name:'deqp-vk.exe',path:out,suite:'vk-gl-cts',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,sourceRevision:pin.revision,args:['--deqp-case=dEQP-VK.info.*','--deqp-case=dEQP-VK.api.*','--deqp-log-images=disable','--deqp-log-shader-sources=disable','--deqp-log-filename=C:\\Game\\cts.qpa'],env:{},origin:'upstream-source-unmodified'});fs.writeFileSync(mp,JSON.stringify(m,null,2)+'\n');
}
console.log(`[cts] Built ${exe}; Linux build is a native reference only, not a Porthole Vulkan HLE result.`);
