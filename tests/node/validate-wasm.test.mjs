// Validator regression uses the EXISTING stable engine, not a remote candidate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'porthole-integrity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const file of ['retrowin32.wasm','glue.mjs'])fs.copyFileSync(`vendor/retrowin32/${file}`,path.join(dir,file));
 const sums=()=>fs.writeFileSync(path.join(dir,'SHA256SUMS'),['retrowin32.wasm','glue.mjs'].map(f=>`${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,f))).digest('hex')}  /runner/path/${f}`).join('\n')+'\n');
 sums();return {dir,sums,run:()=>spawnSync(process.execPath,['scripts/validate-wasm.mjs',dir],{encoding:'utf8'})};
}
test('integrity validation accepts stable reference and portable basename checksums',t=>{
 const c=setup(t),r=c.run();assert.equal(r.status,0,r.stderr);const j=JSON.parse(r.stdout);assert.equal(j.status,'INTEGRITY_VALIDATED_NOT_COMPATIBILITY');assert.equal(j.wasmSha256,'5dc271886ebd68f2ba682099e71415bae7e40a457b3819d165484ffec0e1be41');
});
test('integrity validation rejects a mismatched JS binding',t=>{
 const c=setup(t);fs.appendFileSync(path.join(c.dir,'glue.mjs'),'\n//tampered\n');const r=c.run();assert.notEqual(r.status,0);assert.match(r.stderr,/checksum mismatch/);
});
test('integrity validation rejects truncated files and invalid magic',t=>{
 const c=setup(t),file=path.join(c.dir,'retrowin32.wasm');fs.writeFileSync(file,Buffer.alloc(32));assert.match(c.run().stderr,/unexpectedly small/);fs.writeFileSync(file,Buffer.alloc(1048577));assert.match(c.run().stderr,/magic/);
});
test('integrity validation compiles the module, not only its magic bytes',t=>{
 const c=setup(t),bytes=Buffer.alloc(1048577,255);Buffer.from([0,97,115,109,1,0,0,0]).copy(bytes);fs.writeFileSync(path.join(c.dir,'retrowin32.wasm'),bytes);c.sums();const r=c.run();assert.notEqual(r.status,0);assert.match(r.stderr,/CompileError/);
});

test('integrity validation rejects checksummed but syntactically invalid generated glue',t=>{
 const c=setup(t);fs.appendFileSync(path.join(c.dir,'glue.mjs'),'\nexport { default as invalid };\n');c.sums();const r=c.run();assert.notEqual(r.status,0);assert.match(r.stderr,/SyntaxError/);
});
