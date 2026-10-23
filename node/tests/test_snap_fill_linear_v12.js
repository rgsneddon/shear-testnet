/**
 * Snapshot interest fill walks a bounded oracle window, not the whole prefix.
 * Growth across 2k, 4k, and 8k blocks stays linear. The same walk accepts
 * the book magic instead of a hard-coded testnet constant.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeader } from '../../crypto/header.js';
import { MAGIC_MAINNET, MAGIC_TESTNET } from '../../crypto/asert.js';
import { emptyVault, rewardCommitment, supplyIdentity } from '../../crypto/reserve_vault.js';
import { fillSnapInterest, vaultAfterBlock } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;

function header(ts) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: ts,
    bits: 16,
  });
}

function chain(n) {
  const root = rewardCommitment(emptyVault(), GENESIS).root;
  const blocks = [];
  for (let i = 0; i < n; i += 1) {
    blocks.push({
      height: i + 1,
      header: header(GENESIS + i * 90_000),
      txs: [{ coinbase: true, rewardRoot: root, vout: [] }],
    });
  }
  return blocks;
}

function fill(blocks, magic) {
  const rows = blocks.map(() => ({}));
  const started = process.hrtime.bigint();
  const got = fillSnapInterest(rows, blocks, { magic });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { got, rows, ms };
}

describe('snapshot fill is linear under the book magic', () => {
  it('a windowed replay matches a full prefix, including mainnet magic', () => {
    const blocks = chain(300);
    for (const magic of [MAGIC_TESTNET, MAGIC_MAINNET]) {
      const { got, rows } = fill(blocks, magic);
      assert.equal(got.ok, true, `${magic} ${got.reason}`);
      assert.equal(got.magic, magic, `${magic} snap magic`);
      let vault = null;
      for (let i = 0; i < blocks.length; i += 1) {
        const advanced = vaultAfterBlock(vault, blocks[i], blocks.slice(0, i), {
          requireStakeReward: true,
          magic,
        });
        assert.equal(advanced.ok, true, `${magic} full ${i}`);
        vault = advanced.vault;
      }
      const identity = supplyIdentity(vault);
      assert.equal(identity.ok, true);
      assert.equal(BigInt(rows[rows.length - 1].vaultPrincipal), BigInt(identity.principalNanos));
      assert.equal(vault.magic, magic);
    }
  });

  it('2k, 4k, and 8k blocks grow linearly', () => {
    const times = {};
    for (const n of [2000, 4000, 8000]) {
      const { got, ms } = fill(chain(n), MAGIC_TESTNET);
      assert.equal(got.ok, true, `${n} ${got.reason}`);
      times[n] = ms;
      console.log(`snap-fill n=${n} ms=${ms.toFixed(1)}`);
    }
    // Quadratic growth is about 4x per doubling. Linear growth is about 2x.
    assert.ok(times[4000] < times[2000] * 3, `4k/2k ${times[4000]}/${times[2000]}`);
    assert.ok(times[8000] < times[4000] * 3, `8k/4k ${times[8000]}/${times[4000]}`);
  });
});
