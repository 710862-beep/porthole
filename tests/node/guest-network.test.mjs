import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {GuestNetwork} from '../../scripts/guest-network.mjs';
async function invoke(bridge,value){let result=JSON.parse(bridge.call(JSON.stringify(value)));const start=Date.now();while(result.pending){assert.ok(Date.now()-start<7000);await new Promise(r=>setTimeout(r,1));result=JSON.parse(bridge.call(JSON.stringify({op:'poll',job:result.job})));}return result;}
test('real guest transport exchanges HTTP bytes and EOF; enforces handles and authorization',async()=>{
 let seen=false;const server=http.createServer((req,res)=>{seen=req.url==='/probe';res.end('PORTHOLE_NETWORK_OK');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const bridge=new GuestNetwork({allowedAddresses:['127.0.0.1']});
 try{
  assert.equal((await invoke(bridge,{op:'recv',socket:99,length:1})).error,10038);
  const lookup=await invoke(bridge,{op:'lookup',host:'localhost'});assert.deepEqual(lookup.address,[127,0,0,1]);
  const socket=(await invoke(bridge,{op:'socket'})).result;
  assert.equal((await invoke(bridge,{op:'connect',socket,host:'192.0.2.1',port:80})).error,10013);
  assert.equal((await invoke(bridge,{op:'connect',socket,host:'127.0.0.1',port:server.address().port})).result,0);
  const data=Array.from(Buffer.from('GET /probe HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
  assert.equal((await invoke(bridge,{op:'send',socket,data})).result,data.length);
  let bytes=[];while(true){const read=await invoke(bridge,{op:'recv',socket,length:7});assert.ok(!read.error);if(!read.data.length)break;bytes.push(...read.data);}
  assert.match(Buffer.from(bytes).toString(),/HTTP\/1.1 200/);assert.match(Buffer.from(bytes).toString(),/PORTHOLE_NETWORK_OK/);assert.ok(seen);
  assert.equal((await invoke(bridge,{op:'close',socket})).result,0);assert.equal((await invoke(bridge,{op:'close',socket})).error,10038);
 }finally{bridge.close();await new Promise(resolve=>server.close(resolve));}
});
test('guest networking without an authorized destination cannot connect',async()=>{
 const bridge=new GuestNetwork();try{const socket=(await invoke(bridge,{op:'socket'})).result;assert.equal((await invoke(bridge,{op:'connect',socket,host:'127.0.0.1',port:80})).error,10013);}finally{bridge.close();}
});
