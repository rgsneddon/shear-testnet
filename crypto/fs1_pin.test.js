import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ASERT_TAU_MS, MAGIC_TESTNET, consensusFingerprint } from './asert.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, 'native', 'vendor', 'monero-oxide-77788c3');
const pin = JSON.parse(readFileSync(path.join(vendor, 'ADMIT_PIN.json'), 'utf8'));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function dirSha256(root) {
  const h = createHash('sha256');
  const files = walk(root).map((abs) => path.relative(root, abs).split(path.sep).join('/')).sort();
  for (const rel of files) {
    const data = readFileSync(path.join(root, rel));
    h.update(Buffer.from(rel, 'utf8'));
    h.update(Buffer.from([0]));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(data.length));
    h.update(len);
    h.update(data);
  }
  return h.digest('hex');
}

test('the FS-1 vendor matches the monero-oxide pin and is wired only through the vendored path', () => {
  assert.equal(pin.commit, '77788c368145127f2dde2ac3e2ddce919f3ddd01');
  assert.equal(pin.cryptoTree, '6ba344ad5412c103dab278845a8b418886fdd3d5');
  assert.equal(pin.wired, true);
  assert.deepEqual(pin.excluded, ['monero-fcmp-plus-plus', 'monero-fcmp-plus-plus-generators']);
  const names = Object.keys(pin.trees).sort();
  assert.deepEqual(names, ['divisors', 'fcmps', 'generalized-bulletproofs', 'helioselene']);
  for (const name of names) {
    assert.equal(dirSha256(path.join(vendor, name)), pin.dirSha256[name], name);
    const licence = readFileSync(path.join(vendor, name, 'LICENSE'), 'utf8');
    assert.match(licence, /Luke Parker/);
    assert.match(licence, /MIT License/);
  }
  const rels = Object.keys(pin.files).sort();
  assert.equal(rels.length, 60);
  for (const rel of rels) {
    assert.equal(rel.includes('monero-fcmp'), false);
    const data = readFileSync(path.join(vendor, ...rel.split('/')));
    assert.equal(createHash('sha256').update(data).digest('hex'), pin.files[rel], rel);
  }
  const present = new Set(walk(vendor).map((abs) => path.relative(vendor, abs).split(path.sep).join('/')));
  for (const rel of rels) assert.equal(present.has(rel), true);
  assert.equal(present.has('THIRD_PARTY_NOTICES.txt'), true);
  const notice = readFileSync(path.join(vendor, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const name of [
    'helioselene',
    'ec-divisors',
    'generalized-bulletproofs',
    'full-chain-membership-proofs',
    'generalized-bulletproofs-circuit-abstraction',
    'generalized-bulletproofs-ec-gadgets',
  ]) {
    assert.equal(notice.includes(name), true, name);
  }
  assert.match(notice, /MIT/);
  assert.match(notice, /Luke Parker/);
  assert.match(notice, /monero-oxide Developers/);
  assert.match(notice, /2022-2025/);
  assert.match(notice, /2023-2025/);
  assert.match(notice, /2021-2025/);
  assert.match(notice, /2024-2025/);
  assert.equal(readFileSync(path.join(vendor, 'helioselene', 'LICENSE'), 'utf8').includes('Copyright (c) 2022-2025 Luke Parker'), true);
  assert.equal(readFileSync(path.join(vendor, 'divisors', 'LICENSE'), 'utf8').includes('Copyright (c) 2023-2025 Luke Parker'), true);
  assert.equal(readFileSync(path.join(vendor, 'generalized-bulletproofs', 'LICENSE'), 'utf8').includes('Copyright (c) 2025 monero-oxide Developers'), true);
  assert.equal(readFileSync(path.join(vendor, 'fcmps', 'LICENSE'), 'utf8').includes('Copyright (c) 2024-2025 Luke Parker'), true);
  assert.equal(readFileSync(path.join(vendor, 'fcmps', 'circuit-abstraction', 'LICENSE'), 'utf8').includes('Copyright (c) 2024-2025 Luke Parker'), true);
  assert.equal(readFileSync(path.join(vendor, 'fcmps', 'ec-gadgets', 'LICENSE'), 'utf8').includes('Copyright (c) 2024-2025 Luke Parker'), true);
  const admitToml = readFileSync(path.join(here, 'native', 'admit', 'Cargo.toml'), 'utf8');
  const admitLock = readFileSync(path.join(here, 'native', 'admit', 'Cargo.lock'), 'utf8');
  const deny = readFileSync(path.join(here, 'native', 'deny.toml'), 'utf8');
  assert.match(admitToml, /shear-fs1 = \{ path = "\.\.\/vendor\/monero-oxide-77788c3\/shear-fs1" \}/);
  for (const banned of ['monero-fcmp-plus-plus', 'monero-fcmp-plus-plus-generators']) {
    assert.equal(deny.includes(`name = "${banned}"`), true, banned);
    assert.equal(admitLock.includes(`name = "${banned}"`), false, banned);
  }
  const packages = admitLock.split('[[package]]').slice(1);
  for (const name of ['helioselene', 'generalized-bulletproofs', 'full-chain-membership-proofs', 'ec-divisors',
    'generalized-bulletproofs-circuit-abstraction', 'generalized-bulletproofs-ec-gadgets', 'shear-fs1']) {
    const rows = packages.filter((row) => row.includes(`name = "${name}"\n`));
    assert.equal(rows.length, 1, name);
    assert.equal(/\nsource = /.test(rows[0]), false, `${name} must come from the vendored path`);
  }
  assert.equal(MAGIC_TESTNET, 'shear-testnet-v12');
  assert.equal(ASERT_TAU_MS, 7_200_000);
  assert.equal(/fcmp/i.test(consensusFingerprint()), false);
});
