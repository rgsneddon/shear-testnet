import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, newIdentity } from '../../crypto/address.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { decodeHeader, encodeHeader, setNonce } from '../../crypto/header.js';
import { shearHash, meetsTarget } from '../../crypto/shear_hash.js';
import { LIVE_MIN_BITS } from '../../crypto/asert.js';
import { createStore } from '../src/store.js';
import { mineTemplate, shouldAdopt, digestTx } from '../src/chain.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 9));
}

function mineOne(store, dest, bits = LIVE_MIN_BITS) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now();
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits, now });
  const found = mineTemplate({ ...tpl, bits }, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  return store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
  });
}

function tmpStore() {
  return createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reorg-')));
}

describe('most-work adopt', () => {
  it('heavier valid fork replaces the local tip; equal work keeps first-seen; invalid rest-frame is refused', () => {
    const dest = destMiner();
    const local = tmpStore();
    const first = mineOne(local, dest);
    assert.equal(first.ok, true, first.reason);
    const firstHash = Buffer.from(local.tip().hash);

    const equalPeer = tmpStore();
    assert.equal(mineOne(equalPeer, dest).ok, true);
    const equal = local.ingest(equalPeer.blocks);
    assert.equal(equal.ok, false);
    assert.equal(equal.reason, 'not_heavier');
    assert.equal(Buffer.from(local.tip().hash).equals(firstHash), true);

    const events = [];
    local.on('reorg', (e) => events.push(e));
    local.queueTx({
      id: 'bounce-1',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 1,
      fee: 100,
      vin: [{ address: dest }],
      vout: [{ address: dest, nanos: 1 }],
    });
    const heavier = tmpStore();
    assert.equal(mineOne(heavier, dest).ok, true);
    assert.equal(mineOne(heavier, dest).ok, true);
    assert.equal(heavier.tip().height, 2);
    assert.equal(shouldAdopt(local.blocks, heavier.blocks), true);
    const got = local.ingest(heavier.blocks);
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.reorg, true);
    assert.equal(local.tip().height, 2);
    assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(heavier.tip().hash)), true);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'reorg');
    assert.ok(events[0].from_hash);
    assert.ok(events[0].to_hash);
    assert.ok(events[0].depth >= 1);
    assert.equal(Array.isArray(events[0].orphaned_txids), true);
    const tips = local.getchaintips();
    assert.equal(tips.some((t) => t.status === 'active'), true);
    assert.equal(tips.some((t) => t.status === 'valid-fork'), true);
    assert.equal(local.getpolicy().consensus_min, 6);
    assert.equal(local.getpolicy().bands.pool_merchant, 30);
    assert.equal(local.mempool.some((t) => t.id === 'bounce-1'), true);
  });

  it('ingest of an invalid child of the tip fails verifyBlock and keeps the tip', () => {
    const dest = destMiner();
    const store = tmpStore();
    assert.equal(mineOne(store, dest).ok, true);
    const parent = store.tip();
    const now = Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000;
    const { tpl } = store.template({ miner: dest, bits: LIVE_MIN_BITS, shareBits: LIVE_MIN_BITS, now });
    const found = mineTemplate({ ...tpl, bits: LIVE_MIN_BITS }, { maxTries: 3_000_000, shareBits: LIVE_MIN_BITS });
    assert.ok(found && found.block, 'need child pow');
    const id = newIdentity();
    const poisoned = {
      header: found.header,
      txs: [{
        ...tpl.txs[0],
        vout: tpl.txs[0].vout.map((o) => ({ ...o, address: id.address })),
      }],
      samples: tpl.samples,
      miner: dest,
    };
    const before = Buffer.from(store.tip().hash);
    const height = store.tip().height;
    const refused = store.ingest([poisoned]);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'merkle');
    assert.equal(store.tip().height, height);
    assert.equal(Buffer.from(store.tip().hash).equals(before), true);
  });

  it('heavier rest-frame fork is refused with miner_addr and the old tip remains', () => {
    const dest = destMiner();
    const local = tmpStore();
    assert.equal(mineOne(local, dest).ok, true);
    const fork = tmpStore();
    assert.equal(mineOne(fork, dest).ok, true);
    assert.equal(mineOne(fork, dest).ok, true);
    const id = newIdentity();
    const last = fork.blocks[1];
    const txs = [{
      ...last.txs[0],
      vout: last.txs[0].vout.map((o) => ({ ...o, address: id.address })),
    }];
    const decoded = decodeHeader(last.header);
    const merkle = merkleRoot(txs.map(digestTx));
    let header = encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: merkle,
      continuityRoot: decoded.continuityRoot,
      timestamp: decoded.timestamp,
      bits: decoded.bits,
      nonce: 0n,
    });
    let found = null;
    for (let n = 0n; n < 3_000_000n; n += 1n) {
      const h = setNonce(header, n);
      if (meetsTarget(shearHash(h), decoded.bits)) {
        found = h;
        break;
      }
    }
    assert.ok(found, 'need pow on rest-frame body');
    const poisoned = fork.blocks.map((b, i) => (i !== 1 ? b : { ...b, header: found, txs }));
    const before = Buffer.from(local.tip().hash);
    const refused = local.ingest(poisoned);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'miner_addr');
    assert.equal(local.tip().height, 1);
    assert.equal(Buffer.from(local.tip().hash).equals(before), true);
  });

  it('append still extends a child of the current tip', () => {
    const dest = destMiner();
    const store = tmpStore();
    const a = mineOne(store, dest);
    assert.equal(a.ok, true);
    const h1 = store.tip().height;
    const b = mineOne(store, dest);
    assert.equal(b.ok, true);
    assert.equal(store.tip().height, h1 + 1);
  });
});
