// Deliberately does not emit deployable Rust by token replacement: BOOL, guest
// pointers, macro expansion and C control flow require semantic review.
import fs from 'node:fs';
const report=JSON.parse(fs.readFileSync('docs/wine-extraction-report.json'));
const drafts=report.functions.map(f=>({function:f.name,source:`${f.source}:${f.startLine}-${f.endLine}`,commit:report.commit,status:'MANUAL_PORT_REQUIRED',calls:f.calls,review:['guest memory bounds','Win32 ABI/types','allocation/cleanup','callback/reentrancy','error mapping','driver/server dependencies','license attribution']}));
fs.mkdirSync('artifacts/wine-extraction',{recursive:true});
fs.writeFileSync('artifacts/wine-extraction/translation-review.json',JSON.stringify(drafts,null,2)+'\n');
console.log('Generated review inventory; NO automatic Rust translation or validation claimed.');
