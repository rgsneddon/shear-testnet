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

function tokens(fp) {
  return fp.split(':');
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
    assert.doesNotMatch(fp, /shear-admit-leaf-v2/, name);
    assert.doesNotMatch(fp, /ADMIT_ARITY=\d+(:|$)/, `${name}: a bare bucket arity`);
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
    for (const pasta of ['pallas', 'vesta', 'pasta']) {
      assert.equal(new RegExp(pasta, 'i').test(fp), false, `${name}: ${pasta}`);
    }
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
  assert.equal(FS1_CYCLE_C1, 'selene');
  assert.equal(FS1_CYCLE_C2, 'helios');
  assert.equal(ADMIT_CYCLE_ID, `fs1-${FS1_CYCLE_C1}-${FS1_CYCLE_C2}`);
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
