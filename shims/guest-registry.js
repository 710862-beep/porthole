/* Synchronous registry overlay for the candidate Rust Host trait. No x86
 * pointers enter JS. Rust passes copied bytes through wasm-bindgen slices.
 * Call ready() before guest execution and flush() before reporting persistence.
 */
(function(global) {
  'use strict';
  const P=global.Porthole=global.Porthole||{};
  class GuestRegistryBridge {
    constructor(store) { this.store=store; this.handles=new Map(); this.next=0x10000; this.loaded=false; this.failure=null; }
    async ready() { await this.store.ready; this.loaded=true; }
    _persist() { this.store._save().catch(error=>{this.failure=error;}); }
    async flush() { await this.store.flush(); if(this.failure)throw this.failure; }
    call(op,handle,name,type,data) {
      if(!this.loaded) return JSON.stringify({status:21});
      try {
        const root=P.Registry.ROOTS[handle>>>0] || this.handles.get(handle);
        if(!root) return JSON.stringify({status:6});
        const input=String(name||'');
        if(input.includes('\0')||input.length>4096)return JSON.stringify({status:87});
        if(op==='create'||op==='open') {
          const path=input?`${root}\\${input}`:root;
          let result;
          if(op==='create') { result=this.store.createKeySync(path); this._persist(); }
          else if(!this.store._record(path))return JSON.stringify({status:2});
          const h=this.next++;this.handles.set(h,result?.path||path);
          return JSON.stringify({status:0,handle:h,disposition:result?.disposition||2});
        }
        if(op==='close') { if(!P.Registry.ROOTS[handle>>>0])this.handles.delete(handle);return JSON.stringify({status:0}); }
        if(op==='set') {
          const bytes=Uint8Array.from(data||[]); if(bytes.length>1048576)return JSON.stringify({status:87});
          let value;
          if(type===3||type===0)value=bytes;
          else if(type===4&&bytes.length===4)value=new DataView(bytes.buffer).getUint32(0,true);
          else if(type===1||type===2) {
            // Initial guest ANSI contract is ASCII only, not an invented ACP.
            if(bytes.some(b=>b>127))return JSON.stringify({status:50});
            value=new TextDecoder().decode(bytes).replace(/\0+$/,'');
          } else return JSON.stringify({status:50});
          this.store.setValueSync(root,input,type,value);this._persist();return JSON.stringify({status:0});
        }
        if(op==='query') {
          const value=this.store._record(root)?.values.get(input.toLocaleLowerCase('en-US'));
          if(!value)return JSON.stringify({status:2});
          let bytes;
          if(value.type===3||value.type===0)bytes=value.data;
          else if(value.type===4){bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value.data,true);}
          else if(value.type===1||value.type===2){if(/[^\x00-\x7f]/.test(value.data))return JSON.stringify({status:50});bytes=new TextEncoder().encode(value.data+'\0');}
          else return JSON.stringify({status:50});
          return JSON.stringify({status:0,type:value.type,data:Array.from(bytes)});
        }
        return JSON.stringify({status:50});
      }catch(error){return JSON.stringify({status:error.status||87});}
    }
  }
  P.GuestRegistryBridge=GuestRegistryBridge;
})(globalThis);
