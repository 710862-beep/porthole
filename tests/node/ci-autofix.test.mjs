import assert from 'node:assert/strict';
import { parseFailures, sanitizeEvidence } from '../../ci/autofix.mjs';

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log('  ✓', name); };
const recipes = { 'kernel32.dll!GetTickCount64': {} };

console.log('\n[CI autofix / classificação]');
check('isola DLL/API e diferencia receita de Upstream Missing', () => {
  const result = parseFailures([
    'kernel32:file FAILED: GetProcAddress kernel32.dll!GetTickCount64 returned NULL',
    'ERROR NOT_IMPLEMENTED advapi32.dll!RegSetKeySecurity',
    '✓ kernel32.dll!CreateFileW passed',
  ].join('\n'), recipes);
  assert.deepEqual(result.map((item) => item.qualifiedName), ['advapi32.dll!RegSetKeySecurity', 'kernel32.dll!GetTickCount64']);
  assert.equal(result[0].status, 'Upstream Missing');
  assert.equal(result[1].status, 'candidate-available');
  assert.match(result[1].fingerprint, /^[0-9a-f]{16}$/);
});
check('evidência não preserva tokens, cookies ou paths de usuário', () => {
  const sanitized = sanitizeEvidence('FAILED token=abc cookie: "secret" C:\\Users\\me\\file.txt kernel32.dll!Missing');
  assert.equal(sanitized.includes('abc'), false);
  assert.equal(sanitized.includes('secret'), false);
  assert.equal(sanitized.includes('Users'), false);
  assert.match(sanitized, /\[REDACTED\]/);
});
check('linhas informativas sem falha não geram candidatos', () => {
  assert.deepEqual(parseFailures('kernel32.dll!CreateFileW → OK\nLoadLibrary user32.dll → SHIM ativo', recipes), []);
});

console.log(`\nci-autofix: ${checks} verificações concluídas.`);
