import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ADMIT_ARITY_ID,
  ADMIT_CYCLE_ID,
  ADMIT_LEAF_ID,
  FS1_CYCLE_C1,
  FS1_CYCLE_C2,
  FS1_DEPTH,
  FS1_LAYER_ONE_LEN,
  FS1_LAYER_TWO_LEN,
  FS1_LEAF_HP_DST,
  FS1_LEAF_LEN,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_TESTNET_V11,
  MAGIC_TESTNET_V12,
  consensusFingerprint,
  mainnetFingerprint,
} from './asert.js';
import { FS1_HP_DST, FS1_LEAF_BYTES, fs1Leaf } from './fs1_leaf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, 'native', 'vendor', 'monero-oxide-77788c3');
const rs = (...p) => readFileSync(path.join(vendor, ...p), 'utf8');

function rustConst(src, name) {
  const m = src.match(new RegExp(`pub const ${name}:\\s*[^=]+=\\s*([^;]+);`));
  assert.ok(m, name);
  return m[1].trim();
}

function rustStr(src, name) {
  const m = rustConst(src, name).match(/^"([^"]*)"$/);
  assert.ok(m, name);
  return m[1];
}

function tokens(fp) {
  return fp.split(':');
}

/**
 * Case folded, and whitespace around `=`, `-`, and `_` removed.
 * `ADMIT_ARITY = 32` and `Shear - Admit - Leaf - V2` still hit.
 * A space that only separates two words stays, so prose is not glued into a name.
 */
function normalisedSource(src) {
  return String(src || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([=\-_])\s*/g, '$1');
}

const PASTA_NAMES = ['pallas', 'vesta', 'pasta'];

function fingerprintSource() {
  return readFileSync(path.join(here, 'asert.js'), 'utf8');
}

function tokenValue(fp, key) {
  const hits = tokens(fp).filter((t) => t.startsWith(`${key}=`));
  assert.equal(hits.length, 1, key);
  return hits[0].slice(key.length + 1);
}

const books = () => [
  ['testnet', consensusFingerprint(MAGIC_TESTNET)],
  ['v12', consensusFingerprint(MAGIC_TESTNET_V12)],
  ['v11', consensusFingerprint(MAGIC_TESTNET_V11)],
  ['mainnet', consensusFingerprint(MAGIC_MAINNET)],
  ['mainnet-genesis', mainnetFingerprint()],
];

test('ADMIT_ARITY=32 and shear-admit-leaf-v2 are banned from every fingerprint', () => {
  for (const [name, fp] of books()) {
    assert.equal(tokens(fp).includes('ADMIT_ARITY=32'), false, name);
    assert.doesNotMatch(fp, /ADMIT_ARITY=32(?![0-9])/, name);
    assert.doesNotMatch(fp, /shear-admit-leaf-v2/i, name);
    assert.doesNotMatch(fp, /ADMIT_ARITY=\d+(:|$)/, `${name}: a bare bucket arity`);
  }
});

// PSA-df82-1. Russell's ruling: crypto/asert.js carries the FS-1 parameters.
// The retired bucket tokens must not come back in that file or on any book.
// PSA-d123-1: the scan folds case and whitespace. admit.js may still name the
// legacy admitVerifyV3 curve path; this scan stays on the fingerprint source.
test('PSA-df82-1: asert.js uses FS-1 parameters, not ADMIT_ARITY=32 or shear-admit-leaf-v2', () => {
  const src = fingerprintSource();
  const norm = normalisedSource(src);
  assert.equal(norm.includes('admit_arity=32'), false);
  assert.equal(norm.includes('shear-admit-leaf-v2'), false);
  const start = src.indexOf('export function consensusFingerprint');
  const end = src.indexOf('export function mainnetFingerprint');
  assert.ok(start >= 0 && end > start);
  const fn = src.slice(start, end);
  assert.match(fn, /`ADMIT_CYCLE=\$\{ADMIT_CYCLE_ID\}`/);
  assert.match(fn, /`ADMIT_ARITY=\$\{ADMIT_ARITY_ID\}`/);
  assert.match(fn, /`ADMIT_LEAF=\$\{ADMIT_LEAF_ID\}`/);
  assert.equal(ADMIT_ARITY_ID, `fs1-selene${FS1_LAYER_ONE_LEN}-helios${FS1_LAYER_TWO_LEN}-d${FS1_DEPTH}`);
  assert.equal(ADMIT_LEAF_ID, `fs1-ed25519-OIC${FS1_LEAF_LEN}-Hp-${FS1_LEAF_HP_DST}`);
  assert.equal(ADMIT_CYCLE_ID, `fs1-${FS1_CYCLE_C1}-${FS1_CYCLE_C2}`);
  assert.notEqual(ADMIT_ARITY_ID, '32');
  assert.equal(/shear-admit-leaf-v2/i.test(ADMIT_LEAF_ID), false);
  for (const [name, fp] of books()) {
    assert.equal(fp.includes('ADMIT_ARITY=32'), false, name);
    assert.equal(/shear-admit-leaf-v2/i.test(fp), false, name);
    assert.equal(tokenValue(fp, 'ADMIT_ARITY'), ADMIT_ARITY_ID, name);
    assert.equal(tokenValue(fp, 'ADMIT_LEAF'), ADMIT_LEAF_ID, name);
    assert.equal(tokenValue(fp, 'ADMIT_CYCLE'), ADMIT_CYCLE_ID, name);
  }
});

test('ADMIT and AMOUNT stay, and the cycle, arity and leaf are the FS-1 ones', () => {
  for (const [name, fp] of books()) {
    assert.equal(tokenValue(fp, 'ADMIT'), 'ADMITv3', name);
    assert.equal(tokenValue(fp, 'AMOUNT'), 'confidential', name);
    assert.equal(tokenValue(fp, 'ADMIT_K'), '1', name);
    assert.equal(tokenValue(fp, 'N1'), 'admit-note-point', name);
    assert.equal(tokenValue(fp, 'ADMIT_CYCLE'), 'fs1-selene-helios', name);
    assert.equal(tokenValue(fp, 'ADMIT_ARITY'), 'fs1-selene38-helios18-d7', name);
    assert.equal(tokenValue(fp, 'ADMIT_LEAF'), 'fs1-ed25519-OIC96-Hp-shear-admit-Hp', name);
    assert.equal(/fcmp/i.test(fp), false, name);
  }
  assert.equal(ADMIT_CYCLE_ID, 'fs1-selene-helios');
  assert.equal(ADMIT_ARITY_ID, 'fs1-selene38-helios18-d7');
  assert.equal(ADMIT_LEAF_ID, 'fs1-ed25519-OIC96-Hp-shear-admit-Hp');
});

test('Pasta names are banned from every fingerprint', () => {
  for (const [name, fp] of books()) {
    assert.equal(tokenValue(fp, 'ADMIT_CYCLE'), `fs1-${FS1_CYCLE_C1}-${FS1_CYCLE_C2}`, name);
    for (const pasta of PASTA_NAMES) {
      assert.equal(new RegExp(pasta, 'i').test(fp), false, `${name}: ${pasta}`);
    }
  }
});

test('PSA-d123-1: the fingerprint source scan folds case and whitespace and bans pasta names', () => {
  assert.equal(normalisedSource('ADMIT_ARITY = 32').includes('admit_arity=32'), true);
  assert.equal(normalisedSource('Shear-Admit-Leaf-V2').includes('shear-admit-leaf-v2'), true);
  assert.equal(normalisedSource('Shear - Admit - Leaf - V2').includes('shear-admit-leaf-v2'), true);
  const folded = normalisedSource('Pallas\nVesta\tPasta');
  assert.equal(folded.includes('pallas'), true);
  assert.equal(folded.includes('vesta'), true);
  assert.equal(folded.includes('pasta'), true);
  assert.equal(normalisedSource('a 2 s solve stamped as a gap').includes('vesta'), false);
  const src = fingerprintSource();
  const norm = normalisedSource(src);
  assert.equal(norm.includes('admit_arity=32'), false);
  assert.equal(norm.includes('shear-admit-leaf-v2'), false);
  for (const pasta of PASTA_NAMES) {
    assert.equal(norm.includes(pasta), false, pasta);
  }
});

test('the FS-1 fingerprint parameters match the tree crate', () => {
  const fcmps = rs('fcmps', 'src', 'lib.rs');
  assert.equal(Number(rustConst(fcmps, 'LAYER_ONE_LEN')), FS1_LAYER_ONE_LEN);
  assert.equal(Number(rustConst(fcmps, 'LAYER_TWO_LEN')), FS1_LAYER_TWO_LEN);
  const membership = rs('shear-fs1', 'src', 'membership.rs');
  assert.equal(Number(rustConst(membership, 'DEPTH')), FS1_DEPTH);
  const leaf = rs('shear-fs1', 'src', 'leaf.rs');
  assert.equal(Number(rustConst(leaf, 'LEAF_BYTES')), FS1_LEAF_LEN);
  assert.equal(rustConst(leaf, 'HP_DST'), `b"${FS1_LEAF_HP_DST}"`);
  const tree = rs('shear-fs1', 'src', 'chain_tree.rs');
  assert.match(tree, /selene/);
  assert.match(tree, /helios/);
  assert.match(membership, /type C1 = Selene;/);
  assert.match(membership, /type C2 = Helios;/);
  const c1 = rustStr(membership, 'CYCLE_C1');
  const c2 = rustStr(membership, 'CYCLE_C2');
  const cycle = rustStr(membership, 'ADMIT_CYCLE');
  assert.equal(cycle, `fs1-${c1}-${c2}`);
  assert.equal(FS1_CYCLE_C1, c1);
  assert.equal(FS1_CYCLE_C2, c2);
  assert.equal(ADMIT_CYCLE_ID, cycle);
  assert.equal(tokenValue(consensusFingerprint(), 'ADMIT_CYCLE'), cycle);
});

test('the FS-1 fingerprint leaf is the N-1 predicate', () => {
  assert.equal(FS1_LEAF_BYTES, FS1_LEAF_LEN);
  assert.equal(FS1_HP_DST, FS1_LEAF_HP_DST);
  const rows = rs('shear-fs1', 'vectors', 'n1_leaf.txt')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'));
  const valid = rows.filter((r) => r[3] !== 'skip');
  assert.ok(valid.length >= 2);
  for (const [name, admitPub, commit, want] of valid) {
    const got = fs1Leaf({ admitPub: Buffer.from(admitPub, 'hex'), commit: Buffer.from(commit, 'hex') });
    assert.equal(got.length, FS1_LEAF_LEN, name);
    assert.equal(got.toString('hex'), want, name);
  }
});
