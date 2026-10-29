#!/usr/bin/env node
/**
 * Full-suite CI shards. Every test file that `npm test` names is in exactly
 * one shard, unless tests/ci_pending.txt lists it with the PR that fixes it.
 * A SCOPE row holds out a file whose subject Russell ruled out of scope (a
 * dated ruling in its reason); it is not a fix owed by a PR, and --check
 * prints it as skipped, never as passed.
 * A `track` row names a file a later PR must change but that still passes:
 * it stays in its shard, and it may be a test helper as well as a test file.
 * Weights come from tests/ci_timings.json (seconds per file, measured on the
 * build servers). An unmeasured file counts as 60 s when a shard is planned.
 * --check names each missing weight. The runner's kill cap for one is 600 s.
 *
 *   node tests/ci_shard.js --check          pending list is well formed
 *   node tests/ci_shard.js --count N        print a JSON matrix of 0..N-1
 *   node tests/ci_shard.js --shard I --of N print shard I's files, one per line
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The same globs as package.json "test". A new test file joins a shard
// without any workflow edit.
const DIRS = [
  ['crypto', /\.test\.js$/],
  ['node/tests', /^test_.*\.js$/],
  ['pool/tests', /^test_.*\.js$/],
  ['miner/tests', /^test_.*\.js$/],
  ['sheark-miner/tests', /^test_.*\.js$/],
  ['tests', /^test_.*\.js$/],
];
const EXTRA = ['tests/forbid_foreign_names.js', 'tests/forbid_privacy_regressions.js', 'tests/privacy.walk.js'];
// PRHASH is the native ShearHash thread-safety PR that lands after PR 130.
// SCOPE is a scope ruling, not a PR: the file returns when that scope opens.
const PENDING_PRS = new Set(['PR2', 'PR3', 'PRHASH', 'SCOPE']);
const TRACK_DIRS = ['crypto', 'node/tests', 'pool/tests', 'miner/tests', 'sheark-miner/tests', 'tests'];

export function allTestFiles() {
  const out = [];
  for (const [dir, re] of DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      if (re.test(name)) out.push(`${dir}/${name}`);
    }
  }
  for (const f of EXTRA) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out;
}

/** Rows of `path PRn [track] reason`. Blank lines and # comments are ignored. */
export function readPending() {
  const file = path.join(root, 'tests/ci_pending.txt');
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const [i, raw] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [f, pr, ...rest] = line.split(/\s+/);
    const track = rest[0] === 'track';
    const why = track ? rest.slice(1) : rest;
    rows.push({ line: i + 1, file: f, pr, track, reason: why.join(' ') });
  }
  return rows;
}

export function checkPending(files = allTestFiles(), rows = readPending()) {
  const errors = [];
  const known = new Set(files);
  const seen = new Set();
  for (const r of rows) {
    if (r.track) {
      if (!TRACK_DIRS.some((d) => r.file.startsWith(`${d}/`)) || !fs.existsSync(path.join(root, r.file))) {
        errors.push(`line ${r.line}: ${r.file} is not a test file or helper`);
      }
    } else if (!known.has(r.file)) {
      errors.push(`line ${r.line}: ${r.file} is not a test file`);
    }
    if (!PENDING_PRS.has(r.pr)) errors.push(`line ${r.line}: ${r.file} needs PR2, PR3, PRHASH or SCOPE, got ${r.pr || 'nothing'}`);
    if (r.pr === 'SCOPE' && r.track) errors.push(`line ${r.line}: ${r.file} SCOPE holds a file out; it cannot be tracked`);
    if (r.pr === 'SCOPE' && !/Russell \d{1,2} [A-Z][a-z]{2}\b/.test(r.reason)) errors.push(`line ${r.line}: ${r.file} SCOPE needs the dated ruling (Russell D Mon)`);
    if (!r.reason) errors.push(`line ${r.line}: ${r.file} needs a reason`);
    if (seen.has(r.file)) errors.push(`line ${r.line}: ${r.file} is listed twice`);
    seen.add(r.file);
  }
  return errors;
}

function timings() {
  const file = path.join(root, 'tests/ci_timings.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Longest first into the lightest shard. Deterministic for a given input. */
export function planShards(n, files = allTestFiles(), rows = readPending(), weight = timings()) {
  const pending = new Set(rows.filter((r) => !r.track).map((r) => r.file));
  const run = files.filter((f) => !pending.has(f));
  const cost = (f) => Number(weight[f]) > 0 ? Number(weight[f]) : 60;
  run.sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
  const shards = Array.from({ length: n }, () => ({ files: [], load: 0 }));
  for (const f of run) {
    let best = shards[0];
    for (const s of shards) if (s.load < best.load) best = s;
    best.files.push(f);
    best.load += cost(f);
  }
  return shards;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkPending();
  if (errors.length) {
    for (const e of errors) console.error(`ci_pending.txt ${e}`);
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    const rows = readPending();
    const held = rows.filter((r) => !r.track);
    const files = allTestFiles();
    const weight = timings();
    console.log(`${files.length} test files, ${held.length} pending, ${rows.length - held.length} tracked (still run)`);
    for (const r of rows) console.log(`${r.track ? 'tracked' : r.pr === 'SCOPE' ? 'skipped' : 'pending'} ${r.pr} ${r.file}: ${r.reason}`);
    for (const f of files) {
      if (!(Number(weight[f]) > 0)) console.log(`unmeasured: add ${f} to tests/ci_timings.json`);
    }
  } else if (arg('--count')) {
    const n = Number(arg('--count'));
    console.log(JSON.stringify(Array.from({ length: n }, (_, i) => i)));
  } else if (arg('--shard') != null) {
    const n = Number(arg('--of'));
    const i = Number(arg('--shard'));
    const shard = planShards(n)[i];
    if (!shard) process.exit(2);
    for (const f of shard.files) console.log(f);
  } else {
    console.error('usage: --check | --count N | --shard I --of N');
    process.exit(2);
  }
}
