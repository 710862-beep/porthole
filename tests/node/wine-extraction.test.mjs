import {test} from 'node:test';
import assert from 'node:assert/strict';
import {definitions,maskC} from '../../scripts/extract-wine-api.mjs';
test('extracts definitions, not prototypes/calls, ignores literal braces',()=>{
 const source='int other(int x);\nint entry(int x) { /* } */ const char *s="{\\\"}"; if(x) { return other(x); } return 0; }\nint aux(void) { return 1; }';
 const defs=definitions(source);assert.deepEqual([...defs.keys()],['entry','aux']);assert.deepEqual(defs.get('entry').calls,['other']);assert.equal(defs.get('entry').startLine,2);
});
test('ambiguous source fails loudly',()=>assert.throws(()=>definitions('int f(){return 0;}\nint f(){return 1;}'),/Ambiguous/));
test('unterminated literal fails loudly',()=>assert.throws(()=>maskC('"oops'),/Unterminated/));
