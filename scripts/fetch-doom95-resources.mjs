/** Companion data from the same pinned public mirror; never a success stub. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validatePE} from './fetch-test-assets.mjs';
const blobs={
 'doomlnch.dll':'78b1ad671bb05a95570193e94dbfb64c62c0b0fe',
 'doomcfg.dll':'31148e78ef00c41643e65fdc11208cf0e0b8ffd1',
 'doomipx.dll':'c6cbcecd0b0829daac71de35e9d6e80ca779517f',
 'doommdm.dll':'e3b6161fb755f2b1425179e6120b3b59a5ce2ab3',
 'doomser.dll':'c1d93d2432fda272dff770965208c0ea915707db',
 'doom1.wad':'1a58f66277d6bc869dfeb701591bd39f25eaacd0'
};
const report={repository:'mshoger/doom95',tree:'bbd1b4d96986ba6351ae2012697ae3a5a0153a08',provenance:'Public mirror, not authenticated official distribution',files:[],errors:[]};
fs.mkdirSync('tests/assets/games/doom95-resources',{recursive:true});fs.mkdirSync('artifacts',{recursive:true});
for(const [name,sha] of Object.entries(blobs)){
 const endpoint=`repos/mshoger/doom95/git/blobs/${sha}`;
 try{
  const blob=JSON.parse(execFileSync('gh',['api',endpoint],{maxBuffer:32*1024*1024,timeout:60000}));
  if(blob.encoding!=='base64')throw Error('Not base64');
  const bytes=Buffer.from(blob.content,'base64');
  const hash=crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(hash!==sha || bytes.length!==blob.size)throw Error('Git blob integrity mismatch');
  let format;
  if(name.endsWith('.dll')){format=validatePE(bytes,64);if(format.machine!==0x14c)throw Error('Not x86');}
  else {if(bytes.length<12||bytes.toString('ascii',0,4)!=='IWAD')throw Error('Invalid IWAD');const count=bytes.readUInt32LE(4),offset=bytes.readUInt32LE(8);if(offset+count*16>bytes.length)throw Error('Invalid lump directory');format={kind:'IWAD',lumps:count};}
  fs.writeFileSync(`tests/assets/games/doom95-resources/${name}`,bytes);
  report.files.push({name,url:`https://api.github.com/${endpoint}`,gitBlob:sha,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),format});
 }catch(error){report.errors.push({name,url:`https://api.github.com/${endpoint}`,error:error.message});}
}
fs.writeFileSync('artifacts/doom95-resources.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;
