import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import { verifyBlock } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

// Regtest work (bits 4, about 16 hashes). Every header carries a real nonce
// and every block claims its own ShearHash, so no check is trusted past.
async function seal(header, bits) {
  const found = await mineHeaderParallel(header, bits, 8_192, 1);
  assert.ok(found && found.block, 'regtest pow');
  return { header: found.header, hash: found.hash };
}

function flipContinuity(header) {
  const decoded = decodeHeader(Buffer.from(header));
  decoded.continuityRoot = Buffer.alloc(32, 0x9);
  return encodeHeader(decoded);
}

async function asBlock(tpl, extra = {}) {
  const { header: raw, ...rest } = extra;
  const { header, hash } = await seal(raw || tpl.header, tpl.bits);
  return {
    header,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    hash,
    ...rest,
  };
}

describe('v12 IBD does not skip on a peer-advertised height', () => {
  const dirs = [];
  after(async () => {
    await closeMineWorkers();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a tall advertised tip still rejects a continuity lie on the block being checked', async () => {
    const dest = minerDest();
    const other = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-h-'));
    dirs.push(dir);
    const store = createRegtestStore(dir, { bits: 4 });
    const t0 = 1_700_000_000_000;
    const honest = store.template({ miner: dest, shareBits: 4, now: t0 });
    const sealed = await Promise.resolve(store.append(await asBlock(honest.tpl, { miner: dest })));
    assert.equal(sealed.ok, true, sealed.reason);

    const rivalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-r-'));
    dirs.push(rivalDir);
    const rivalStore = createRegtestStore(rivalDir, { bits: 4 });
    const rivalTpl = rivalStore.template({ miner: other, shareBits: 4, now: t0 }).tpl;
    // The continuity lie is sealed with real work, so continuity is the
    // first check it fails.
    const broken = await asBlock(rivalTpl, {
      header: flipContinuity(rivalTpl.header),
      samplesPruned: true,
      height: 1,
    });
    // The same block, advertised at a tall height. The height is not an input.
    const decoy = { ...broken, height: 80_000 };
    const got = await Promise.resolve(store.ingest([broken, decoy], {
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
    const child = await asBlock(childTpl, {
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
      magic: store.magic,
      genesisMs: t0,
      nowMs: t0 + TARGET_BLOCK_INTERVAL_MS,
    });
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'continuity');
  });
});
