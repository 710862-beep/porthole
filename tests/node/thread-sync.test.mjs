import test from 'node:test';
import assert from 'node:assert/strict';
import '../../shims/thread-sync.js';
const { ThreadSync: Sync, THREAD_WAIT: W }=globalThis.Porthole;
test('auto reset event releases one waiter per signal', async()=>{
 const s=new Sync(), e=s.CreateEvent(); const a=s.WaitForSingleObject(e,100), b=s.WaitForSingleObject(e,10);
 s.SetEvent(e); assert.equal(await a,0); assert.equal(await b,W.WAIT_TIMEOUT); s.dispose();
});
test('manual event releases all and remains signaled until reset',async()=>{
 const s=new Sync(),e=s.CreateEvent(true);const a=s.WaitForSingleObject(e),b=s.WaitForSingleObject(e);
 s.SetEvent(e);assert.deepEqual(await Promise.all([a,b]),[0,0]);assert.equal(await s.WaitForSingleObject(e,0),0);
 s.ResetEvent(e);assert.equal(await s.WaitForSingleObject(e,0),W.WAIT_TIMEOUT);s.dispose();
});
test('wait all does not consume a partially available semaphore',async()=>{
 const s=new Sync(),sem=s.CreateSemaphore(1,2),e=s.CreateEvent();
 assert.equal(await s.WaitForMultipleObjects([sem,e],true,0),W.WAIT_TIMEOUT);
 assert.equal(await s.WaitForSingleObject(sem,0),0);s.ReleaseSemaphore(sem);const p=s.WaitForMultipleObjects([sem,e],true,100);s.SetEvent(e);assert.equal(await p,0);assert.equal(await s.WaitForSingleObject(sem,0),W.WAIT_TIMEOUT);s.dispose();
});
test('wait any returns lowest available index',async()=>{
 const s=new Sync(),a=s.CreateEvent(),b=s.CreateEvent(false,true);assert.equal(await s.WaitForMultipleObjects([a,b],false,0),1);s.dispose();
});
test('semaphore validates bounds and tracks previous count',async()=>{
 const s=new Sync();assert.equal(s.CreateSemaphore(2,1),0);const h=s.CreateSemaphore(0,2);assert.deepEqual(s.ReleaseSemaphore(h,2),{previous:0});assert.equal(s.ReleaseSemaphore(h),false);assert.equal(s.lastError,298);assert.equal(await s.WaitForSingleObject(h,0),0);s.dispose();
});
test('closed handles fail pending waits instead of silently hanging',async()=>{
 const s=new Sync(),h=s.CreateEvent();const p=s.WaitForSingleObject(h);assert.equal(s.CloseHandle(h),true);assert.equal(await p,W.WAIT_FAILED);assert.equal(s.lastError,6);s.dispose();
});
test('invalid wait arguments fail explicitly',async()=>{
 const s=new Sync(),h=s.CreateEvent();for(const args of [[[],false,0],[[h,h],true,0],[[h],false,-1]])assert.equal(await s.WaitForMultipleObjects(...args),W.WAIT_FAILED);s.dispose();
});
test('critical sections support recursion, ownership and queued transfer',async()=>{
 const s=new Sync();s.InitializeCriticalSection(42);await s.EnterCriticalSection(42,1);await s.EnterCriticalSection(42,1);
 let acquired=false;const p=s.EnterCriticalSection(42,2).then(()=>acquired=true);assert.equal(s.LeaveCriticalSection(42,3),false);s.LeaveCriticalSection(42,1);await Promise.resolve();assert.equal(acquired,false);s.LeaveCriticalSection(42,1);await p;assert.equal(acquired,true);s.LeaveCriticalSection(42,2);assert.equal(s.DeleteCriticalSection(42),true);s.dispose();
});
test('TLS separates thread identities and rejects freed slots',()=>{
 const s=new Sync(),slot=s.TlsAlloc();s.TlsSetValue(slot,1,10);s.TlsSetValue(slot,2,20);assert.equal(s.TlsGetValue(slot,1),10);assert.equal(s.TlsGetValue(slot,2),20);assert.equal(s.TlsGetValue(slot,3),0);assert.equal(s.TlsFree(slot),true);assert.equal(s.TlsSetValue(slot,1,30),false);s.dispose();
});
test('dispose resolves pending event waits as failed',async()=>{
 const s=new Sync(),p=s.WaitForSingleObject(s.CreateEvent());s.dispose();assert.equal(await p,W.WAIT_FAILED);
});
