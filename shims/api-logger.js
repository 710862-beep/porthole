/* Diagnostic collector for measured Rust guest calls, not JS shim attribution. */
(function(global){
  'use strict';
  class ApiLogger {
    constructor(limit=20){this.limit=Math.max(1,Math.min(limit,100));this.callLog=[];}
    log(api,args){const entry={api:String(api),args,origin:'rust-guest',timestamp:Date.now()};this.callLog.push(entry);if(this.callLog.length>this.limit)this.callLog.shift();return entry;}
    getLastCall(){return this.callLog.at(-1)||null;}
    getLog(){return this.callLog.slice();}
    ingestTail(entries){for(const entry of entries){const index=entry.indexOf(' args=');this.log(index<0?entry:entry.slice(0,index),index<0?'':entry.slice(index+6));}}
    ingestCrash(message){
      const text=String(message);const causal=text.match(/causal_import=Some\("([^"\n]+)"\)/);
      const tail=text.match(/LAST20_API=(\[[\s\S]*\])$/);
      if(tail){try{this.ingestTail(JSON.parse(tail[1]));}catch{/* keep raw fault; never infer an API from a malformed log */}}
      return {causalImport:causal?causal[1].replace(/@IAT$/,''):null,lastApi:this.getLastCall(),last20:this.getLog(),causality:'Only a decoded fault operand matching an IAT slot identifies the null import; lastApi alone is not causal.'};
    }
  }
  (global.Porthole=global.Porthole||{}).ApiLogger=ApiLogger;
})(globalThis);
