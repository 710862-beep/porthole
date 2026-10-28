import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
require('../../js/porthole-linker.js');require('../../js/vfs.js');require('../../js/vfs-fallback.js');
require('../../shims/registry.js');require('../../shims/guest-registry.js');require('../../js/retrowin32-backend.js');
const P=globalThis.Porthole;
function store(vfs){return new P.Registry.RegistryStore({vfs});}
function memory(){const files=new Map();return {files,async readFile(k){if(!files.has(k))throw Object.assign(Error('not found'),{code:'NOT_FOUND'});return files.get(k);},async writeFile(k,bytes){files.set(k,new TextEncoder().encode(bytes));}};}
const call=(b,...args)=>JSON.parse(b.call(...args));
test('guest registry bridge refuses calls before preload',()=>{const b=new P.GuestRegistryBridge(store(memory()));assert.equal(call(b,'create',0x80000001,'App').status,21);});
test('guest sync overlay marshals BINARY/DWORD, handles, and persists through store',async()=>{
 const vfs=memory(),b=new P.GuestRegistryBridge(store(vfs));await b.ready();const c=call(b,'create',0x80000001,'Software\\Roblox\\Client');assert.equal(c.status,0);assert.equal(c.disposition,1);
 const token=Uint8Array.from({length:128},(_,i)=>i);assert.equal(call(b,'set',c.handle,'AuthToken',3,token).status,0);assert.deepEqual(call(b,'query',c.handle,'AuthToken').data,Array.from(token));
 assert.equal(call(b,'set',c.handle,'UserId',4,new Uint8Array([57,48,0,0])).status,0);assert.deepEqual(call(b,'query',c.handle,'UserId').data,[57,48,0,0]);await b.flush();
 const second=new P.GuestRegistryBridge(store(vfs));await second.ready();const reopened=call(second,'open',0x80000001,'Software\\Roblox\\Client');assert.equal(reopened.status,0);assert.deepEqual(call(second,'query',reopened.handle,'AuthToken').data,Array.from(token));assert.equal(call(b,'close',c.handle,'').status,0);assert.equal(call(b,'query',c.handle,'UserId').status,6);
});
test('guest registry rejects unsupported types instead of pretending success',async()=>{
 const b=new P.GuestRegistryBridge(store(memory()));await b.ready();const c=call(b,'create',0x80000001,'Software\\X');assert.equal(call(b,'set',c.handle,'x',11,new Uint8Array(8)).status,50);assert.equal(call(b,'set',c.handle,'x',1,new Uint8Array([255,0])).status,50);
});
test('guest registry persistence failure is observable at flush',async()=>{
 const vfs=memory();vfs.writeFile=async()=>{throw Error('disk denied');};const b=new P.GuestRegistryBridge(store(vfs));await b.ready();assert.equal(call(b,'create',0x80000001,'Software\\X').status,0);await assert.rejects(b.flush(),/disk denied/);
});
function proc(vfs=null){return new P.Retrowin32Process({}, {path:'C:\\Tests\\x.exe',bytes:new Uint8Array([1]),vfs,preload:false});}
test('candidate host clock and synchronous directory overlay reject invalid paths',()=>{
 const p=proc();assert.equal(typeof p.ticks(),'number');assert.equal(p.create_dir('C:\\App'),0);assert.equal(p.create_dir('C:\\App'),183);assert.equal(p.create_dir('D:\\Outside'),5);assert.equal(p.create_dir('C:\\Missing\\Child'),3);assert.equal(p.create_dir('C:\\App\\Child'),0);
});
test('candidate directory host propagates queued persistence failure',async()=>{
 const p=proc({createDirectory:async()=>{throw Error('denied');}});assert.equal(p.create_dir('C:\\App'),0);await assert.rejects(p.flushWrites(),/denied/);
});
test('fallback mkdir creates empty directories without claiming physical persistence',async()=>{
 const f=new P.FallbackVFS();await f.mapFiles([{name:'seed',webkitRelativePath:'Drive/seed',size:1,arrayBuffer:async()=>new Uint8Array([1]).buffer}]);assert.equal((await f.createDirectory('C:\\App')).persistent,false);assert.equal((await f.stat('C:\\App')).kind,'directory');await assert.rejects(f.createDirectory('C:\\Missing\\Child'));await assert.rejects(f.createDirectory('C:\\App'));
});
require('../../shims/user32.js');require('../../shims/api-logger.js');
test('headless input forwards signed deltas to bounded real host queue',()=>{
 const process=proc();const injector=new P.User32InputInjector(process);
 for(const [dx,dy] of [[10,5],[-5,15],[20,-10]])injector.inject_test_input(dx,dy);
 assert.deepEqual(JSON.parse(process.raw_input_events()),[[10,5],[-5,15],[20,-10]]);assert.equal(process.raw_input_events(),'[]');
 assert.throws(()=>injector.inject_test_input(NaN,1),RangeError);assert.throws(()=>injector.inject_test_input(2147483648,1),RangeError);
 for(let i=0;i<256;i++)injector.inject_test_input(1,1);assert.throws(()=>injector.inject_test_input(1,1),RangeError);
});
test('absent TCP transport returns explicit unsupported rather than success',()=>{assert.deepEqual(JSON.parse(proc().network_call('{"op":"socket"}')),{error:10045});});
test('guest API logger preserves exact IAT cause without confusing last API',()=>{
 const logger=new P.ApiLogger();const result=logger.ingestCrash('NULL_INDIRECT_CALL causal_import=Some("kernel32.dll!Example@IAT") LAST20_API=["OtherAPI args=[00000000]"]');
 assert.equal(result.causalImport,'kernel32.dll!Example');assert.equal(result.lastApi.api,'OtherAPI');assert.equal(result.lastApi.origin,'rust-guest');
});
test('API tail is bounded and missing IAT provenance never invents a causal API',()=>{const logger=new P.ApiLogger(20);for(let i=0;i<100;i++)logger.log('API'+i,[]);assert.equal(logger.getLog().length,20);assert.equal(logger.getLastCall().api,'API99');assert.equal(logger.ingestCrash('jmp to null page').causalImport,null);logger.ingestTail(['SendMessageA args=[00000000]']);assert.equal(logger.getLastCall().api,'SendMessageA');assert.equal(logger.getLastCall().args,'[00000000]');});
test('GetAsyncKeyState host tracks transitions, held state, release and consume-on-query',()=>{const process=proc();assert.equal(process.key_state(16),0);process.injectKey(16,true);assert.equal(process.key_state(16),0x8001);assert.equal(process.key_state(16),0x8000);process.injectKey(16,false);assert.equal(process.key_state(16),0);assert.throws(()=>process.injectKey(256,true),RangeError);});

test('synchronous stat reflects actual cached bytes and directories, rejects empty and unauthorized paths',()=>{const p=proc();p._registerFile('C:\\Tests\\data.bin',new Uint8Array([1,2,3]));assert.deepEqual(JSON.parse(p.file_info('data.bin')),{status:0,kind:'file',size:3});assert.equal(JSON.parse(p.file_info('.')).kind,'directory');assert.equal(p.create_dir('C:\\Empty'),0);assert.equal(JSON.parse(p.file_info('C:\\Empty')).kind,'directory');assert.equal(JSON.parse(p.file_info('')).status,123);assert.equal(JSON.parse(p.file_info('D:\\secret')).status,5);assert.equal(JSON.parse(p.file_info('missing')).status,2);assert.equal(JSON.parse(p.file_info('Missing\\child')).status,3);});
test('process current directory changes relative resolution without changing host cwd',()=>{
 const p=proc();assert.equal(p.create_dir('C:\\Sandbox'),0);assert.equal(p.set_current_dir('C:\\Sandbox'),0);assert.equal(p.current_dir(),'C:\\Sandbox');p._registerFile('C:\\Sandbox\\marker',new Uint8Array([1]));assert.equal(JSON.parse(p.file_info('marker')).status,0);assert.equal(p.set_current_dir('marker'),267);assert.equal(p.set_current_dir('missing'),3);assert.equal(p.current_dir(),'C:\\Sandbox');assert.equal(p.set_current_dir('..'),0);assert.equal(p.current_dir(),'C:\\');assert.equal(p.set_current_dir('D:\\Outside'),5);assert.equal(p.set_current_dir(''),123);
});
test('directory snapshot enumerates only immediate authorized cached children',()=>{
 const p=proc();p._registerFile('C:\\Tests\\Game.WAD',new Uint8Array([1,2,3]));p._registerFile('C:\\Tests\\Nested\\Hidden.WAD',new Uint8Array([1]));
 const snapshot=JSON.parse(p.read_dir(''));assert.equal(snapshot.status,0);assert.equal(snapshot.entries.find(e=>e.name==='Game.WAD').size,3);assert.equal(snapshot.entries.find(e=>e.name==='Nested').kind,'directory');assert.ok(!snapshot.entries.some(e=>e.name==='Hidden.WAD'));assert.equal(JSON.parse(p.read_dir('D:\\Denied')).status,5);assert.equal(JSON.parse(p.read_dir('missing')).status,3);assert.equal(JSON.parse(p.read_dir('Game.WAD')).status,267);
});
