import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDetection } from '../torture/run-detection.mjs';

test('al-khaser BAD/GOOD and missing API warnings are parsed without crash-only passes', () => {
  const text = [
    '[*] Warning: API ntdll.dll!NtQuerySystemInformation was expected to exist but was not found.',
    '[*] TLS process attach callback                                                                    [ BAD  ]',
    '[*] Checking IsDebuggerPresent API                                                                 [ GOOD ]',
    'Analysis done',
  ].join('\n');
  const r = parseDetection('al-khaser', text);
  assert.equal(r.completed, true);
  assert.equal(r.checks.length, 2);
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].kind, 'missing-api');
  assert.equal(r.findings[1].expected, 'GOOD');
  assert.equal(r.findings[1].actual, 'BAD');
});

test('pafish lowercase traced! is a finding and OK is not', () => {
  const text = [
    '[*] Using IsDebuggerPresent() ... traced!',
    '[*] Checking mouse presence ... OK',
    'Pafish has finished analyzing',
  ].join('\n');
  const r = parseDetection('pafish', text);
  assert.equal(r.completed, true);
  assert.equal(r.checks.length, 2);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].expected, 'OK');
  assert.equal(r.findings[0].actual, 'traced!');
});

test('incomplete detection output is not marked completed', () => {
  const r = parseDetection('al-khaser', '[*] Checking something ... [ BAD ]');
  assert.equal(r.completed, false);
  assert.equal(r.findings.length, 1);
});
