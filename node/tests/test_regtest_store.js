import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDest } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED, LIVE_MIN_BITS, MAGIC_MAINNET, MAGIC_TESTNET } from '../../crypto/asert.js';
import { MAGIC_REGTEST, regtestBitsOverride, sealRegtestFactory } from '../../crypto/regtest_bits.js';
import { createStore } from '../src/store.js';
import { createRegtestStore } from './regtest_store.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PIN = 'ab'.repeat(32);
const T0 = 1_700_000_000_000;

function dir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

describe('shear-regtest store factory', () => {
  it('a production createStore call refuses shear-regtest, including when a genesis pin is set', () => {
    assert.equal(LIVE_MIN_BITS, 4);
    process.env.NODE_TEST_CONTEXT = 'child-v8';
    process.env.SHEAR_REGTEST_BITS = '4';
    assert.equal(regtestBitsOverride(MAGIC_REGTEST), null);
    assert.equal(regtestBitsOverride(MAGIC_TESTNET), null);
    assert.equal(regtestBitsOverride(MAGIC_MAINNET), null);
    assert.throws(() => sealRegtestFactory(Symbol('forged'), 4), /regtest_magic/);
    assert.equal(regtestBitsOverride(MAGIC_REGTEST), null);

    assert.throws(
      () => createStore(dir('shear-regtest-prod-'), { magic: MAGIC_REGTEST }),
      /regtest_magic/,
    );
    assert.throws(
      () => createStore(dir('shear-regtest-pin-'), { magic: MAGIC_REGTEST, genesisHash: PIN }),
      /regtest_genesis_pin/,
    );
    assert.throws(
      () => createStore(dir('shear-regtest-forged-'), {
        magic: MAGIC_REGTEST,
        regtestPermit: Symbol('forged'),
      }),
      /regtest_magic/,
    );
    assert.throws(
      () => createRegtestStore(dir('shear-regtest-factory-pin-'), { genesisHash: PIN }),
      /regtest_genesis_pin/,
    );
    assert.equal(regtestBitsOverride(MAGIC_REGTEST), null);
    assert.throws(() => createRegtestStore(dir('shear-regtest-floor-'), { bits: LIVE_MIN_BITS - 1 }), /regtest_bits/);
    assert.throws(() => createRegtestStore(dir('shear-regtest-hi-'), { bits: 9 }), /regtest_bits/);

    delete process.env.NODE_TEST_CONTEXT;
    delete process.env.SHEAR_REGTEST_BITS;
    const opened = createRegtestStore(dir('shear-regtest-open-'), { bits: 4 });
    assert.equal(regtestBitsOverride(MAGIC_REGTEST), 4 * 65536);
    assert.equal(regtestBitsOverride(MAGIC_TESTNET), null);
    const sealed = opened.template({ miner: encodeDest(Buffer.alloc(20, 9)), bits: 1, now: T0 });
    assert.equal(sealed.tpl.bits, 4 * 65536);

    process.env.NODE_TEST_CONTEXT = 'child-v8';
    process.env.SHEAR_REGTEST_BITS = '4';
    assert.throws(
      () => createStore(dir('shear-regtest-after-'), { magic: MAGIC_REGTEST }),
      /regtest_magic/,
    );
    assert.throws(
      () => createStore(dir('shear-regtest-after-pin-'), {
        magic: MAGIC_REGTEST,
        genesisHash: PIN,
        regtestPermit: Symbol('forged'),
      }),
      /regtest_genesis_pin/,
    );
    assert.throws(
      () => createRegtestStore(dir('shear-regtest-factory-pin2-'), { genesisHash: PIN }),
      /regtest_genesis_pin/,
    );

    const plain = createStore(dir('shear-regtest-plain-'));
    const probed = plain.template({ miner: encodeDest(Buffer.alloc(20, 3)), bits: 1, now: T0 });
    assert.equal(probed.tpl.bits, GENESIS_BITS_PACKED);

    const walk = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, 'node/pack')
from bundle_modules import required_module_paths
paths = required_module_paths('.')
bad = [p for p in paths if p.startswith('node/tests/') or p.endswith('regtest_store.js') or p.endswith('mine_worker.mjs')]
if bad:
    raise SystemExit('bundled ' + ','.join(bad))
if 'crypto/regtest_bits.js' not in paths:
    raise SystemExit('missing inert regtest hook')
print(len(paths))
`], { cwd: repo, encoding: 'utf8' });
    assert.equal(walk.status, 0, walk.stderr || walk.stdout);
  });
});
