// Node-only authorized TCP transport. Browser hosts explicitly report 10045.
import net from 'node:net';
import dns from 'node:dns/promises';
export class GuestNetwork {
  constructor({allowedAddresses=[]}={}){this.allowed=new Set(allowedAddresses);this.sockets=new Map();this.jobs=new Map();this.next=0x60000000;this.nextJob=0;this.evidence={connections:0,sentBytes:0,receivedBytes:0};}
  call(text){try{return JSON.stringify(this.request(JSON.parse(text)));}catch{return '{"error":10022}';}}
  job(work){if(this.jobs.size>=128)return {error:10055};const job=++this.nextJob;const record={pending:true,job};this.jobs.set(job,record);Promise.resolve().then(work).then(value=>Object.assign(record,{pending:false},value),error=>Object.assign(record,{pending:false,error:error.code==='ECONNREFUSED'?10061:error.code==='ENOTFOUND'?11001:10054}));return {pending:true,job};}
  request(q){
    if(q.op==='poll'){const job=this.jobs.get(q.job);if(!job)return {error:10022};if(!job.pending)this.jobs.delete(q.job);return job;}
    if(q.op==='lookup')return this.job(async()=>{const value=await dns.lookup(q.host,{family:4});if(!this.allowed.has(value.address))return {error:10013};return {address:value.address.split('.').map(Number)};});
    if(q.op==='socket'){if(this.sockets.size>=64)return {error:10055};const socket=new net.Socket();const rec={socket,data:Buffer.alloc(0),ended:false,error:null,connected:false};socket.on('data',data=>{if(rec.data.length+data.length>1048576){rec.error=new Error('bounded receive');socket.destroy();}else rec.data=Buffer.concat([rec.data,data]);});socket.on('end',()=>{rec.ended=true;});socket.on('error',error=>{rec.error=error;});const id=++this.next;this.sockets.set(id,rec);return {result:id};}
    const rec=this.sockets.get(q.socket);if(!rec)return {error:10038};
    if(q.op==='close'){rec.socket.destroy();this.sockets.delete(q.socket);return {result:0};}
    if(q.op==='connect'){
      if(!this.allowed.has(q.host)||!Number.isInteger(q.port)||q.port<1||q.port>65535)return {error:10013};
      if(rec.connected)return {error:10056};
      return this.job(()=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{rec.socket.destroy();reject(new Error('connect timeout'));},5000);const failed=error=>{clearTimeout(timeout);reject(error);};rec.socket.once('error',failed);rec.socket.connect(q.port,q.host,()=>{clearTimeout(timeout);rec.socket.off('error',failed);rec.connected=true;this.evidence.connections++;resolve({result:0});});}));
    }
    if(!rec.connected)return {error:10057};
    if(q.op==='send'){if(!Array.isArray(q.data)||q.data.length>1048576||q.data.some(v=>!Number.isInteger(v)||v<0||v>255))return {error:10014};const bytes=Buffer.from(q.data);return this.job(()=>new Promise((resolve,reject)=>rec.socket.write(bytes,error=>{if(error)reject(error);else{this.evidence.sentBytes+=bytes.length;resolve({result:bytes.length});}})));}
    if(q.op==='recv'){if(!Number.isInteger(q.length)||q.length<1||q.length>1048576)return {error:10014};return this.job(async()=>{const start=Date.now();while(!rec.data.length&&!rec.ended&&!rec.error){if(Date.now()-start>5000)return {error:10060};await new Promise(r=>setTimeout(r,1));}if(rec.error)return {error:10054};const bytes=rec.data.subarray(0,q.length);rec.data=rec.data.subarray(bytes.length);this.evidence.receivedBytes+=bytes.length;return {data:Array.from(bytes)};});}
    return {error:10045};
  }
  close(){for(const rec of this.sockets.values())rec.socket.destroy();this.sockets.clear();this.jobs.clear();}
}
