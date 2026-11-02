import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REPO = '710862-beep/porthole';
const fakeGh = `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const dir=process.env.FAKE_REPO_DIR;
const args=process.argv.slice(2);
function readStdin(){return fs.readFileSync(0,'utf8');}
function blobSha(b){return crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+b.length+'\\0'),b])).digest('hex');}
if(args[0]==='api'&&args[1]==='--method'&&args[2]==='POST'&&args[3].endsWith('/git/blobs')){
  const payload=JSON.parse(readStdin());const b=Buffer.from(payload.content,'base64');const sha=blobSha(b);
  fs.mkdirSync(path.join(dir,'blobs'),{recursive:true});fs.writeFileSync(path.join(dir,'blobs',sha),b);
  process.stdout.write(JSON.stringify({sha}));process.exit(0);
}
if(args[0]==='api'){
  const ep=args[1];
  if(ep==='repos/${REPO}/actions/runs/1'){process.stdout.write(JSON.stringify({head_sha:'abc123'}));process.exit(0);}
  if(ep==='repos/${REPO}/actions/runs/1/jobs?per_page=100'){process.stdout.write(JSON.stringify({jobs:[{check_run_url:'https://api.github.com/repos/${REPO}/check-runs/9'}]}));process.exit(0);}
  if(ep==='repos/${REPO}/check-runs/9/annotations?per_page=100'){process.stdout.write(fs.readFileSync(path.join(dir,'annotations.json'),'utf8'));process.exit(0);}
  const prefix='repos/${REPO}/git/blobs/';
  if(ep.startsWith(prefix)){const sha=ep.slice(prefix.length);const b=fs.readFileSync(path.join(dir,'blobs',sha));process.stdout.write(JSON.stringify({content:b.toString('base64')}));process.exit(0);}
}
process.stderr.write('fake gh: unsupported '+JSON.stringify(args));process.exit(9);
`;

test('torture evidence gzip blob transport round-trips and rejects tampering', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'porthole-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const gh = path.join(dir, 'bin', 'gh');
  fs.writeFileSync(gh, fakeGh, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'artifacts/torture'), { recursive: true });
  const raw = Buffer.from(JSON.stringify({ hello: 'world', padding: 'x'.repeat(200000) }));
  fs.writeFileSync(path.join(dir, 'artifacts/torture/report.json'), raw);
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, FAKE_REPO_DIR: dir, GITHUB_REPOSITORY: REPO, GITHUB_SHA: 'abc123', GITHUB_RUN_ID: '1', GITHUB_JOB: 'core' };
  const pub = spawnSync('python3', [path.resolve('scripts/publish-torture-blobs.py')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(pub.status, 0, pub.stderr);
  const notice = /::notice title=Porthole torture transfer::(.+)/.exec(pub.stdout);
  assert.ok(notice, pub.stdout);
  fs.writeFileSync(path.join(dir, 'annotations.json'), JSON.stringify([{ title: 'Porthole torture transfer', message: notice[1] }]));
  const dl = spawnSync('python3', [path.resolve('scripts/download-torture-blobs.py'), '1'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(dl.status, 0, dl.stderr);
  const out = path.join(dir, 'artifacts/remote/1/core/artifacts/torture/report.json');
  assert.deepEqual(fs.readFileSync(out), raw);
  // Corrupt the largest transported blob (the gzip payload, not the tiny manifest).
  const blobs = path.join(dir, 'blobs');
  let largest = null;
  for (const name of fs.readdirSync(blobs)) {
    const p = path.join(blobs, name);
    if (!largest || fs.statSync(p).size > fs.statSync(largest).size) largest = p;
  }
  const b = fs.readFileSync(largest); b[0] ^= 0xff; fs.writeFileSync(largest, b);
  const bad = spawnSync('python3', [path.resolve('scripts/download-torture-blobs.py'), '1'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /AssertionError/);
});
