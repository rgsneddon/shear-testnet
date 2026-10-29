/**
 * merkleRoot pairs an odd last leaf with itself, so [A, B, C] and
 * [A, B, C, C] have one root and one block hash (the CVE-2012-2459 class).
 * A block whose leaves repeat a digest is refused before its root is
 * compared (chain.js blockLeaves), on verify and on a book reload, so the
 * same header never stands for a body that applies a tx twice (Russell
 * 26 Oct, pre-existing).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { createStore } from '../src/store.js';
import { assessHeader, blockLeaves, digestTx, verifyBlock, verifyLoadedChain } from '../src/chain.js';

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function resealed(block, txs) {
  const d = decodeHeader(Buffer.from(block.header));
  return { ...block, header: encodeHeader({ ...d, merkleRoot: merkleRoot(txs.map(digestTx)) }), txs };
}

const send = (fill) => ({
  kind: 'send',
  fee: 1,
  vin: [{ commit: Buffer.alloc(32, fill) }],
  vout: [{ kind: 'send', commit: Buffer.alloc(32, fill + 1) }],
});

describe('a repeated merkle leaf is refused', () => {
  it('[A, B, C] and [A, B, C, C] share a root, and blockLeaves refuses the second', () => {
    const [a, b, c] = [send(1), send(3), send(5)];
    const three = [a, b, c].map(digestTx);
    const four = [a, b, c, c].map(digestTx);
    assert.ok(merkleRoot(three).equals(merkleRoot(four)), 'the odd-leaf copy hides the duplicate');
    assert.deepEqual(blockLeaves([a, b, c]).map((l) => Buffer.from(l).toString('hex')), three.map((l) => Buffer.from(l).toString('hex')));
    assert.equal(blockLeaves([a, b, c, c]), null);
    assert.equal(blockLeaves([a, a]), null, 'any repeat, not only the last');
  });

  it('the same header over a duplicated last tx is duplicate_tx at the merkle stage and refused on verify and reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-merkle-dup-'));
    try {
      const store = createStore(dir);
      const dest = minerDest();
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: 1_700_000_000_000 });
      const base = {
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
        height: 1,
      };
      const stamp = Number(decodeHeader(Buffer.from(tpl.header)).timestamp);
      const opts = { genesisMs: stamp, trustedPowHash: Buffer.from(`${'00'.repeat(31)}01`, 'hex'), skipSharePow: true, nowMs: stamp };
      // Three leaves: the coinbase and two sends. The fourth repeats the last.
      const odd = resealed(base, [tpl.txs[0], send(1), send(3)]);
      const dup = { ...odd, txs: [...odd.txs, odd.txs[2]] };
      assert.ok(merkleRoot(dup.txs.map(digestTx)).equals(decodeHeader(Buffer.from(dup.header)).merkleRoot), 'same root, same header');
      const oddHead = await Promise.resolve(assessHeader(odd, null, opts));
      assert.notEqual(oddHead?.reason, 'merkle');
      assert.notEqual(oddHead?.reason, 'duplicate_tx');
      const dupHead = await Promise.resolve(assessHeader(dup, null, opts));
      assert.equal(dupHead?.ok, false);
      assert.equal(dupHead.reason, 'duplicate_tx');
      // verifyBlock refuses it too. Its pre-PoW row checks run first and see
      // these stand-in sends (send_unavailable) before the merkle stage.
      const verdict = await Promise.resolve(verifyBlock(dup, null, opts));
      assert.equal(verdict.ok, false);
      // A book reload refuses it too (stepLoaded checks the leaves before the
      // root; its stage-0 pass over the book sees these stand-in sends first).
      const loaded = verifyLoadedChain([{ ...dup, hash: Buffer.alloc(32, 1) }], {
        trustStoredHash: true,
        nowMs: stamp,
        genesisHash: '',
      });
      assert.equal(loaded.ok, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
