// Audit aid, not a C compiler: direct calls are an overapproximation. Callback/macro
// and cross-translation-unit boundaries remain explicitly unresolved.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fetchWine} from './fetch-wine-source.mjs';
export function maskC(s){
 let out='',state='code';
 for(let i=0;i<s.length;i++){
  const c=s[i],n=s[i+1];
  if(state==='code'){
   if(c==='/'&&n==='*'){out+='  ';i++;state='block';}
   else if(c==='/'&&n==='/'){out+='  ';i++;state='line';}
   else if(c==='"'||c==="'"){out+=' ';state=c;}
   else out+=c;
  }else if(state==='block'&&c==='*'&&n==='/'){out+='  ';i++;state='code';}
  else if(state==='line'&&c==='\n'){out+='\n';state='code';}
  else if((state==='"'||state==="'")&&c==='\\'){out+='  ';i++;}
  else if(c===state){out+=' ';state='code';}
  else out+=c==='\n'?'\n':' ';
 }
 if(!['code','line'].includes(state))throw Error('Unterminated C comment/literal');return out;
}
export function definitions(source){
 const text=maskC(source),result=new Map();
 // Only top-level definitions. Reject control statements and prototypes.
 const re=/\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g;
 let m;
 while((m=re.exec(text))){
  const open=re.lastIndex-1;let depth=1,end=open+1;
  for(;end<text.length&&depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}
  if(depth)throw Error('Unbalanced C function');
  const start=text.lastIndexOf('\n',m.index)+1,name=m[1];
  if(result.has(name))throw Error(`Ambiguous definition ${name}`);
  const body=text.slice(open+1,end-1),calls=[...new Set([...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(x=>x[1]))].filter(x=>!['if','while','for','switch','sizeof','return'].includes(x)).sort();
  result.set(name,{name,startLine:source.slice(0,start).split('\n').length,endLine:source.slice(0,end).split('\n').length,code:source.slice(start,end),calls});re.lastIndex=end;
 }
 return result;
}
export function extract(dll='user32',entry='CreateDialogParamA'){
 const sourceFile={user32:'dialog.c',comctl32:'updown.c',advapi32:'advapi.c',kernelbase:entry==='WideCharToMultiByte'?'locale.c':['SetCurrentDirectoryA','FindFirstFileA'].includes(entry)?'file.c':'process.c'}[dll];if(!sourceFile)throw Error('This audited extractor supports user32/dialog.c and comctl32/updown.c only');
 if(!/^[A-Za-z_]\w*$/.test(entry))throw Error('Invalid function');
 const commit=fetchWine(),file=`dlls/${dll}/${sourceFile}`,source=fs.readFileSync(`vendor/wine-source/${file}`,'utf8'),defs=definitions(source);
 if(!defs.has(entry))throw Error(`Definition not found: ${entry}`);
 const queue=[entry],seen=new Set(),functions=[];
 while(queue.length){const name=queue.shift();if(seen.has(name))continue;seen.add(name);const fn=defs.get(name);functions.push({...fn,source:file});for(const dep of fn.calls)if(defs.has(dep))queue.push(dep);}
 const boundaries=[...new Set(functions.flatMap(f=>f.calls).filter(x=>!seen.has(x)))].sort();
 const out='artifacts/wine-extraction';fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(`${out}/${dll}-functions.c`,functions.map(f=>`/* ${file}:${f.startLine}-${f.endLine} ${commit} */\n${f.code}`).join('\n\n'));
 const report={repository:'https://github.com/wine-mirror/wine',commit,source:file,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),license:({user32:'LGPL-2.1-or-later; Copyright Alexandre Julliard',comctl32:'LGPL-2.1-or-later; Copyright Dimitrie O. Paun',advapi32:'LGPL-2.1-or-later; Copyright Sven Verdoolaege',kernelbase:'LGPL-2.1-or-later; Copyright Alexandre Julliard'})[dll],copyrights:source.split('\n').slice(0,80).filter(l=>/Copyright/.test(l)).map(l=>l.trim().replace(/^\*\s*/,'')),scope:'Lexical same-translation-unit direct-call closure; not a complete semantic/transitive Wine dependency graph',entry,functions:functions.map(({code,...f})=>f),boundaries,unresolvedIndirectCalls:true,status:'EXTRACTED_NOT_TRANSLATED_OR_VALIDATED'};
 fs.writeFileSync(dll==='user32'?'docs/wine-extraction-report.json':`docs/wine-${dll}${entry==='WideCharToMultiByte'?'-locale':entry==='SetCurrentDirectoryA'?'-file':entry==='FindFirstFileA'?'-find':''}-extraction.json`,JSON.stringify(report,null,2)+'\n');fs.copyFileSync('LICENSE.Wine',`${out}/COPYING.LIB`);fs.copyFileSync(`vendor/wine-source/${file}`,`${out}/${sourceFile}`);console.log(`Extracted ${functions.length} functions; ${boundaries.length} explicit external/macro boundaries`);return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url))extract(process.argv[2],process.argv[3]);
