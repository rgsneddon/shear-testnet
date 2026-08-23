import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { HASH_BONUS_NANOS } from '../../crypto/asert.js';
import { buildTemplate, mineTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { reconstructOwner } from '../../pool/src/wallet_api.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
  };
}

describe('node chain is lean, light, scalable, prunable', () => {
  it('collates hashes, prunes sample bodies, keeps sealed txs for explorer', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-prune-'));
    const store = createStore(dir, { pruneAfter: 2 });
    const fat = Array.from({ length: 250 }, (_, i) => ({
      miner: alice.address,
      nonce: String(i),
      tag: 'a',
      count: 1,
    }));

    const b1 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: alice.address,
      bits: 8,
      now: Date.now(),
      samples: fat,
      txs: [{
        id: 'send-forever',
        from: alice.address,
        to: bob.address,
        nanos: 3,
        vin: [{ address: alice.address }],
        vout: [{ address: bob.address, nanos: 3 }],
      }],
    }));
    const a1 = store.append(b1);
    assert.equal(a1.ok, true);
    assert.equal(store.blocks[0].samples.length, 1);
    assert.equal(store.blocks[0].samples[0].count, 250);
    assert.equal(store.blocks[0].txs[0].samples, undefined);

    const b2 = mine(buildTemplate({
      prev: a1.block.hash,
      height: 2,
      miner: alice.address,
      bits: 8,
      now: Date.now() + 90_000,
      samples: [{ miner: alice.address, nonce: 'x', tag: 'a', count: 2 }],
    }));
    assert.equal(store.append(b2).ok, true);

    const b3 = mine(buildTemplate({
      prev: store.tip().hash,
      height: 3,
      miner: alice.address,
      bits: 8,
      now: Date.now() + 180_000,
      samples: [{ miner: alice.address, nonce: 'y', tag: 'a', count: 1 }],
    }));
    assert.equal(store.append(b3).ok, true);

    const buried = store.blocks[0];
    assert.equal(buried.samplesPruned, true);
    assert.deepEqual(buried.samples, []);
    assert.ok(buried.txs[0].vout.some((o) => o.kind === 'pot'));
    assert.ok(buried.txs[0].vout.some((o) => o.kind === 'hash' && o.nanos === 250 * HASH_BONUS_NANOS));
    assert.equal(buried.txs[1].id, 'send-forever');

    const disk = fs.readFileSync(path.join(dir, 'chain.jsonl'), 'utf8').trim().split('\n');
    const row1 = JSON.parse(disk[0]);
    assert.deepEqual(row1.samples, []);
    assert.equal(row1.samplesPruned, true);
    assert.equal(row1.txs[1].id, 'send-forever');
    assert.equal(row1.tpl, undefined);
    assert.ok(!JSON.stringify(row1).includes('"count":1'));

    const histAlice = reconstructOwner(store, alice.address);
    const histBob = reconstructOwner(store, bob.address);
    assert.ok(histAlice.txs.some((t) => t.id === 'send-forever'));
    assert.ok(histBob.txs.some((t) => t.id === 'send-forever'));
    assert.ok(histAlice.txs.some((t) => t.kind === 'hash' || t.kind === 'coinbase'));

    const buriedCheck = verifyBlock(buried, null, { buried: true });
    assert.equal(buriedCheck.ok, true);

    const reopened = createStore(dir, { pruneAfter: 2 });
    const again = reconstructOwner(reopened, bob.address);
    assert.ok(again.txs.some((t) => t.id === 'send-forever'));
  });
});
