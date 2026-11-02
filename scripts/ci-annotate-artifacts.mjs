#!/usr/bin/env node
/**
 * Surfaces the JSON evidence under `artifacts/` as workflow annotations.
 *
 * Job logs are not readable from a restricted-egress environment, and GitHub caps a check
 * run at 50 annotations, so a failing lane otherwise reports nothing but "Process completed
 * with exit code 1". This walks the recognised report shapes and emits one compact
 * `::error::`/`::notice::` line per non-passing entry, newest-relevant first, so the
 * failing lane's own evidence is visible on the check without downloading the artifact.
 *
 * Nothing here changes a verdict: it only prints what the runner already decided.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'artifacts';
const MAX_ANNOTATIONS = 40;
const MAX_LEN = 900;

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const clip = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN)}…` : t;
};

const out = [];
function emit(level, file, message) {
  out.push(`::${level} file=${file}::${esc(clip(message))}`);
}

function annotateTests(file, json, key = 'tests') {
  const tests = Array.isArray(json?.[key]) ? json[key] : [];
  for (const t of tests) {
    const status = String(t.status || 'UNKNOWN');
    if (status === 'PASS') continue;
    const bits = [
      `${file}: ${t.name || '(unnamed)'} ${status}`,
      t.error ? `error=${clip(t.error)}` : null,
      t.reason ? `reason=${clip(t.reason)}` : null,
      t.exitCode !== undefined && t.exitCode !== null ? `exit=${t.exitCode}` : null,
      t.instructions !== undefined ? `insns=${t.instructions}` : null,
      t.terminal ? `terminal=${clip(t.terminal)}` : null,
    ].filter(Boolean);
    const stdout = t.result?.stdout || t.stdout;
    if (stdout && status !== 'PASS') bits.push(`stdout=${clip(stdout)}`);
    emit('error', file, bits.join(' · '));
  }
}

function annotatePromotion(file, json) {
  if (json.promotable === true) return;
  const bits = [`${file}: promotable=${json.promotable}`];
  for (const k of ['status', 'reason', 'note', 'error']) if (json[k]) bits.push(`${k}=${clip(json[k])}`);
  if (Array.isArray(json.gates)) {
    for (const g of json.gates) if (g && g.pass === false) bits.push(`gate-fail:${g.name || g.id}=${clip(g.reason || g.detail || 'fail')}`);
  }
  if (Array.isArray(json.missing) && json.missing.length) bits.push(`missing=${clip(json.missing.join(','))}`);
  emit('error', file, bits.join(' · '));
}

function annotateAcquisition(file, json) {
  const bits = [`${file}: status=${json.status || 'unknown'}`];
  if (Array.isArray(json.missing) && json.missing.length) bits.push(`missing=${clip(json.missing.join(','))}`);
  if (Array.isArray(json.errors)) for (const e of json.errors.slice(0, 4)) bits.push(`err=${clip(typeof e === 'string' ? e : JSON.stringify(e))}`);
  emit(json.status === 'COMPLETE' || json.status === 'PASS' ? 'notice' : 'error', file, bits.join(' · '));
}

let files = [];
try {
  files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
} catch {
  process.exit(0);
}

for (const file of files) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const base = path.basename(file);
  if (Array.isArray(json?.tests)) annotateTests(base, json);
  else if (json && 'promotable' in json) annotatePromotion(base, json);
  else if (json && (json.missing || json.acquired) && json.status) annotateAcquisition(base, json);
  else if (json && typeof json.status === 'string' && json.status !== 'PASS' && json.kind) {
    emit('error', base, `${base}: status=${json.status} kind=${json.kind}`);
  }
}

if (out.length === 0) {
  console.log(`[ci-annotate-artifacts] no non-passing entries under ${dir}`);
  process.exit(0);
}
// GitHub keeps the first 50 annotations of a check run; keep the most actionable ones.
for (const line of out.slice(0, MAX_ANNOTATIONS)) console.log(line);
if (out.length > MAX_ANNOTATIONS) {
  console.log(`::warning file=${dir}::${esc(`${out.length - MAX_ANNOTATIONS} further entries omitted (annotation cap)`)}`);
}
