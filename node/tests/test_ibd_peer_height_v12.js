import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { verifyBlock } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function flipContinuity(header) {
  const decoded = decodeHeader(Buffer.from(header));
  decoded.continuityRoot = Buffer.alloc(32, 0x9);
  return encodeHeader(decoded);
}

function asBlock(tpl, extra = {}) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hash: easyPowHash(),
    ...extra,
  };
}

describe('v12 IBD does not skip on a peer-advertised height', () => {
  it('a tall advertised tip still rejects a continuity lie on the block being checked', async () => {
    const dest = minerDest();
    const other = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-h-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const honest = store.template({ miner: dest, shareBits: 4, now: t0 });
    const sealed = await Promise.resolve(store.append(asBlock(honest.tpl, { miner: dest }), {
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
    }));
    assert.equal(sealed.ok, true, sealed.reason);

    const rivalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-r-'));
    const rivalStore = createStore(rivalDir);
    const rivalTpl = rivalStore.template({ miner: other, shareBits: 4, now: t0 }).tpl;
    const broken = asBlock(rivalTpl, {
      miner: other,
      header: flipContinuity(rivalTpl.header),
      samplesPruned: true,
      height: 1,
    });
    const decoy = {
      ...broken,
      height: 80_000,
      hash: easyPowHash(),
      samplesPruned: true,
    };
    const got = await Promise.resolve(store.ingest([broken, decoy], {
      trustBlockHash: true,
      skipSharePow: true,
      nowMs: t0 + TARGET_BLOCK_INTERVAL_MS,
    }));
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'continuity');
    assert.equal(got.at, 0);
    assert.equal(store.tip().height, 1);

    const tip = store.tip();
    const childTpl = store.template({
      miner: dest,
      shareBits: 4,
      now: t0 + TARGET_BLOCK_INTERVAL_MS,
    }).tpl;
    const child = asBlock(childTpl, {
      miner: dest,
      header: flipContinuity(childTpl.header),
      samplesPruned: true,
      height: 2,
    });
    const direct = verifyBlock(child, {
      hash: tip.hash,
      header: tip.header,
      height: tip.height,
      rootA: tip.rootA,
      rootB: tip.rootB,
      txs: tip.txs,
      bLeaves: tip.bLeaves,
      weight: tip.weight,
    }, {
      tipHeight: 1_000_000,
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
      genesisMs: t0,
      nowMs: t0 + TARGET_BLOCK_INTERVAL_MS,
    });
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'continuity');
  });
});
