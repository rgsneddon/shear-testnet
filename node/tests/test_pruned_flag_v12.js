/**
 * A peer samplesPruned flag is not burial. Sealed hash credits are trusted
 * only when the block is 1000 confirmations under this node's own tip, the
 * same rule as flowSkipAllowed. Any nanos, any dest count.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { SAMPLE_PRUNE_CONFIRMATIONS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { flowSkipAllowed } from '../../crypto/chronoflux.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import {
  creditsEqual,
  freshForBlock,
  hashCreditRoot,
} from '../../crypto/hash_owed.js';
import {
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  clearLiveSharePow,
} from '../../crypto/share_batch.js';
import { decodeWireBlock, encodeWireBlock } from '../src/p2p.js';
import { applyVerifiedIpcBlock } from '../src/p2p_ipc.js';
import { createStore } from '../src/store.js';
import { auditCirculatingSupply } from '../src/supply.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function destAt(n) {
  const raw = Buffer.alloc(20);
  raw.writeUInt32BE(n >>> 0, 16);
  return encodeDest(raw);
}

function shareAt(dest, low, bits) {
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    proofSlot: 0,
  };
}

function pinShares(header, rows) {
  for (const row of rows) {
    assert.equal(rememberLiveSharePow(header, row.nonce, {
      noteCommit: noteCommitOfShare(row),
      shareBits: row.shareBits,
      lz: row.lz,
    }), true);
  }
}

function appendTpl(store, dest, tag, when, shares) {
  const tip = store.tip();
  if (shares?.length && tip?.header) pinShares(tip.header, shares);
  const { tpl } = store.template({
    miner: dest,
    now: when,
    shareBatch: shares || [],
  });
  return {
    tpl,
    got: store.append({
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
      hashCredits: tpl.hashCredits,
    }, { trustedPowHash: easyPow(tag), skipSharePow: true }),
  };
}

function creditRow(dest, nanos) {
  const dest20 = hash20FromAddress(dest);
  return {
    noteCommit: noteCommitOfDest20(dest20),
    dest20,
    nanos,
    admitBase: null,
    address: '',
  };
}

function flagged(block, rows) {
  const txs = (block.txs || []).map((tx, i) => (
    i === 0 ? { ...tx, hashCreditRoot: hashCreditRoot(rows) } : tx
  ));
  return {
    ...block,
    txs,
    shareBatch: [],
    samples: [],
    samplesPruned: true,
    hashCredits: rows,
  };
}

describe('samplesPruned does not forge hash credits', () => {
  it('trusts a sealed record only when this tip buries the block', () => {
    clearLiveSharePow();
    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pruned-flag-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const genesis = appendTpl(store, dest, 1, t0, []);
    assert.equal(genesis.got.ok, true, genesis.got.reason);
    const shares = [1, 2, 3].map((i) => shareAt(destAt(i), BigInt(i), SHARE_FLOOR_BITS));
    const honest = appendTpl(store, dest, 2, t0 + 90_000, shares);
    assert.equal(honest.got.ok, true, honest.got.reason);
    const tipBefore = store.tip().height;
    const owedBefore = auditCirculatingSupply(store.blocks);
    assert.equal(owedBefore.status, 'verified', owedBefore.reason);
    const nextShares = [4, 5, 6].map((i) => shareAt(destAt(i), BigInt(i), SHARE_FLOOR_BITS));
    pinShares(store.tip().header, nextShares);
    const next = store.template({
      miner: dest,
      now: t0 + 180_000,
      shareBatch: nextShares,
    }).tpl;
    const body = {
      header: next.header,
      txs: next.txs,
      samples: next.samples,
      shareBatch: next.shareBatch || [],
      miner: dest,
      aLeaves: next.aLeaves,
      bLeaves: next.bLeaves,
      rootA: next.rootA,
      rootB: next.rootB,
      weight: next.weight,
      hashCredits: next.hashCredits,
      height: tipBefore + 1,
    };
    const rows = next.hashCredits;
    assert.ok(rows.length >= 1);
    const forged = flagged(body, rows);
    const depths = [0, 1, 999, SAMPLE_PRUNE_CONFIRMATIONS];
    for (const depth of depths) {
      const tip = forged.height + depth;
      const flag = { height: forged.height, samplesPruned: true };
      assert.equal(flowSkipAllowed(flag, tip), depth >= SAMPLE_PRUNE_CONFIRMATIONS, `depth ${depth}`);
      const got = freshForBlock(forged, undefined, tip);
      if (depth >= SAMPLE_PRUNE_CONFIRMATIONS) {
        assert.equal(got.ok, true, `buried ${depth}`);
        assert.equal(creditsEqual(got.fresh, rows), true);
      } else {
        assert.equal(got.ok, false, `unburied ${depth}`);
      }
    }
    const nanos = [1n, 2n ** 28n];
    for (const n of nanos) {
      const one = flagged(body, [creditRow(destAt(1), n)]);
      assert.equal(freshForBlock(one, undefined, one.height).ok, false, `nanos ${n}`);
      assert.equal(freshForBlock(one, undefined, one.height + SAMPLE_PRUNE_CONFIRMATIONS).ok, true, `buried nanos ${n}`);
    }
    const many = [1, 2, 3].map((i) => creditRow(destAt(i), BigInt(i)));
    const extra = flagged(body, rows.concat([creditRow(destAt(9), 1n)]));
    assert.equal(freshForBlock(flagged(body, many), undefined, body.height).ok, false);
    assert.equal(freshForBlock(extra, undefined, extra.height).ok, false);
    const mismatch = { ...forged, txs: forged.txs.map((tx, i) => (i === 0 ? { ...tx, hashCreditRoot: Buffer.alloc(32, 7) } : tx)) };
    assert.equal(freshForBlock(mismatch, undefined, mismatch.height + SAMPLE_PRUNE_CONFIRMATIONS).ok, false);
    const bare = flagged(body, []);
    const bareGot = freshForBlock(bare, undefined, bare.height);
    assert.equal(bareGot.ok, true);
    assert.equal(bareGot.fresh.length, 0);

    const rejected = store.append(forged, { trustedPowHash: easyPow(3), skipSharePow: true });
    assert.equal(rejected.ok, false, rejected.reason);
    assert.equal(rejected.reason, 'samples_pruned');
    assert.equal(store.tip().height, tipBefore);
    const wired = decodeWireBlock(encodeWireBlock({ ...forged, hash: easyPow(3) }));
    assert.equal(wired.samplesPruned, true);
    const viaWire = store.ingest([wired], { trustedPowHash: easyPow(4), skipSharePow: true });
    assert.equal(viaWire.ok, false, viaWire.reason);
    assert.equal(viaWire.reason, 'samples_pruned');
    assert.equal(store.tip().height, tipBefore);
    const viaIpc = applyVerifiedIpcBlock(store, {
      type: 'ipc_block',
      block: encodeWireBlock({ ...forged, hash: easyPow(5) }),
      powHash: easyPow(5).toString('hex'),
    });
    assert.equal(viaIpc.ok, false, viaIpc.reason);
    assert.equal(viaIpc.reason, 'samples_pruned');
    assert.equal(store.tip().height, tipBefore);
    const after = auditCirculatingSupply(store.blocks);
    assert.equal(after.status, 'verified', after.reason);
    assert.equal(after.measuredHashNanos, owedBefore.measuredHashNanos);

    const disagree = {
      ...body,
      samplesPruned: false,
      hashCredits: [creditRow(destAt(9), 1n)],
    };
    const live = store.append(disagree, { trustedPowHash: easyPow(6), skipSharePow: true });
    assert.equal(live.ok, false, live.reason);
    assert.equal(store.tip().height, tipBefore);

    const fastDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pruned-flag-fast-'));
    const fast = createStore(fastDir, { fastSync: true });
    const fg = appendTpl(fast, dest, 11, t0, []);
    assert.equal(fg.got.ok, true, fg.got.reason);
    const kept = appendTpl(fast, dest, 12, t0 + 90_000, shares);
    assert.equal(kept.got.ok, true, kept.got.reason);
    assert.ok((fast.blocks[1].shareBatch || []).length > 0);
    const bounced = createStore(fastDir, { fastSync: true });
    assert.equal(bounced.blocks.length, fast.blocks.length);
    assert.equal(bounced.blocks[1].samplesPruned, false);
    assert.ok((bounced.blocks[1].shareBatch || []).length > 0);
    assert.equal(auditCirculatingSupply(bounced.blocks).status, 'verified');
  });
});
