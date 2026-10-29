import test from 'node:test';import assert from 'node:assert/strict';
import {evaluate} from '../../scripts/validate-all-tests.mjs';
test('missing reports and exit-zero-only reports cannot authorize promotion',()=>{assert.equal(evaluate({}).promotable,false);assert.equal(evaluate({synthetic:{tests:[{name:'thread-validation',status:'PASS',result:{exitCode:0}}]}}).promotable,false);});
test('documented causal import is still a failing DOOM95 gate',()=>{const result=evaluate({doom:{status:'BACKEND_FAILURE',exitCode:0,executionAttempted:true,causalImport:'user32.dll!Example'}});assert.equal(result.checks.find(c=>c.name.startsWith('DOOM95')).pass,false);});

test('DOOM95 exit zero after missing DLL is not gameplay',()=>{const result=evaluate({doom:{status:'PASS',executionAttempted:true,exitCode:0,causalImport:null,gameplayValidated:false}});assert.equal(result.checks.find(c=>c.name.startsWith('DOOM95')).pass,false);assert.equal(result.promotable,false);});
