import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createStore } from '../src/store.js';
import { mineTemplate, shouldAdopt } from '../src/chain.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 9));
}

function mineOne(store, dest, bits = 8) {
  const { tpl, job } = store.template({ miner: dest, bits, shareBits: bits });
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

    const id = newIdentity();
    const rest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const badStore = tmpStore();
    const mined = mineOne(badStore, rest);
    assert.equal(mined.ok, true);
    const poisoned = [{
      ...badStore.blocks[0],
      txs: [{
        ...badStore.blocks[0].txs[0],
        vout: badStore.blocks[0].txs[0].vout.map((o) => ({ ...o, address: id.address })),
      }],
    }];
    const before = Buffer.from(local.tip().hash);
    const refused = local.ingest(poisoned);
    assert.equal(refused.ok, false);
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
