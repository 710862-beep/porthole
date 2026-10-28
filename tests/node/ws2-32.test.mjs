import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import '../../shims/ws2_32.js';
const {WinSockShim:Socket}=globalThis.Porthole;
test('startup refcount and socket parameter failures',()=>{
 const s=new Socket();assert.equal(s.socket(),-1);assert.equal(s.WSAGetLastError(),10093);assert.equal(s.WSAStartup(1),10092);assert.equal(s.WSAStartup(),0);assert.equal(s.socket(23),-1);assert.equal(s.WSACleanup(),0);assert.equal(s.WSACleanup(),-1);
});
test('network is denied by default, even with a supplied transport',async()=>{
 let called=false;const s=new Socket({transport:{connect(){called=true;}}});s.WSAStartup();assert.equal(await s.connect(s.socket(),'github.com',443),-1);assert.equal(s.WSAGetLastError(),10013);assert.equal(called,false);s.WSACleanup();
 const asyncPolicy=new Socket({authorize:async()=>false,transport:{connect(){called=true;}}});asyncPolicy.WSAStartup();assert.equal(await asyncPolicy.connect(asyncPolicy.socket(),'github.com',443),-1);assert.equal(called,false);asyncPolicy.WSACleanup();
});
test('no transport reports unsupported rather than fake connectivity',async()=>{
 const s=new Socket({authorize:()=>true});s.WSAStartup();assert.equal(await s.connect(s.socket(),'github.com',443),-1);assert.equal(s.WSAGetLastError(),10045);assert.equal(await s.getaddrinfo('github.com',443),null);s.WSACleanup();
});
test('failed connection is retryable and invalid buffers are rejected',async()=>{
 const s=new Socket({authorize:()=>true,transport:{connect:async()=>{throw Error('refused');}}});s.WSAStartup();const h=s.socket();assert.equal(await s.connect(h,'host',80),-1);assert.equal(s.WSAGetLastError(),10061);assert.equal(await s.send(h,new Uint8Array()),-1);s.WSACleanup();
});
test('close during asynchronous connect closes late connection',async()=>{
 let release,closed=false;const s=new Socket({authorize:()=>true,transport:{connect:()=>new Promise(resolve=>release=resolve)}});s.WSAStartup();const h=s.socket(),p=s.connect(h,'host',80);s.closesocket(h);release({close(){closed=true;}});assert.equal(await p,-1);assert.equal(closed,true);s.WSACleanup();
});
test('DNS facade obeys authorization and handles resolver errors',async()=>{
 const s=new Socket({authorize:host=>host==='ok',transport:{resolve:async()=>['127.0.0.1']}});s.WSAStartup();assert.equal(await s.gethostbyname('denied'),null);assert.deepEqual(await s.gethostbyname('ok'),{name:'ok',addresses:['127.0.0.1']});assert.equal(await s.getaddrinfo('ok',-1),null);s.WSACleanup();
});
test('transport contract cannot silently overrun send/recv buffers',async()=>{
 const s=new Socket({authorize:()=>true,transport:{connect:async()=>({send:async()=>999,recv:async()=>new Uint8Array(99),close(){}})}});s.WSAStartup();const h=s.socket();await s.connect(h,'host',80);assert.equal(await s.send(h,new Uint8Array(1)),-1);assert.equal(await s.recv(h,1),null);assert.equal(await s.recv(h,0),null);s.WSACleanup();
});
test('real HTTP GET through injected Node TCP transport (loopback, not browser or guest)',async(t)=>{
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain'});res.end('porthole-real-loopback');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port;
 const transport={
  resolve:async(host)=>[host],
  connect:async(host,port)=>{
   const socket=net.createConnection({host,port});socket.setTimeout(3000,()=>socket.destroy(Error('timeout')));
   await once(socket,'connect');const iterator=socket[Symbol.asyncIterator]();let pending=Buffer.alloc(0);
   return {send:bytes=>new Promise((resolve,reject)=>socket.write(bytes,e=>e?reject(e):resolve(bytes.length))),recv:async(max)=>{if(!pending.length){const next=await iterator.next();if(next.done)return new Uint8Array();pending=Buffer.from(next.value);}const part=pending.subarray(0,max);pending=pending.subarray(part.length);return new Uint8Array(part);},close:()=>socket.destroy()};
  }
 };
 const s=new Socket({transport,authorize:(host,p)=>host==='127.0.0.1'&&p===port});s.WSAStartup();const h=s.socket();t.after(()=>s.WSACleanup());
 assert.equal(await s.connect(h,'127.0.0.1',port),0);
 const request=new TextEncoder().encode('GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n');assert.equal(await s.send(h,request),request.length);
 let response='';for(;;){const bytes=await s.recv(h,64);assert.ok(bytes);if(!bytes.length)break;response+=new TextDecoder().decode(bytes);}
 assert.match(response,/HTTP\/1\.1 200 OK/);assert.match(response,/porthole-real-loopback/);assert.equal(s.closesocket(h),0);
});
