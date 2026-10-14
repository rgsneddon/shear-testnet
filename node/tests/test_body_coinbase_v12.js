/**
 * A body tx that wears the coinbase flag skips kind, range, flow, and the
 * levy. A fee on it used to verify and mint finder-fee and reserve-fee notes.
 * Only txs[0] is the coinbase. Any fee, any value kind, any truthy flag.
 * A proof or spend tag on that tx is still admit_membership.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { V12_VALUE_KINDS } from '../../crypto/spend.js';
import { flowNeedsDummy } from '../../crypto/dummy.js';
import { FS1_SEND_REASON } from '../../crypto/fs1_send_gate.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { coinbaseLevyPays, GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';
import { createStore } from '../src/store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const NOW = 1_700_000_000_000;
const FEES = [0, 1, 2, 100, (2 ** 20) + 3];
const FLAGS = [true, 1, 'yes'];

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function blockOf(tpl) {
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
    height: tpl.height,
  };
}

function template(who, txs) {
  return buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: who,
    finderDest: who,
    txs,
    bits: GENESIS_BITS_PACKED,
    now: NOW,
  });
}

describe('a body coinbase cannot mint the levy', () => {
  it('any fee and any value kind is coinbase, and a carried proof stays admit_membership', () => {
    const who = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-body-cb-'));
    const store = createStore(dir);
    try {
      for (const fee of FEES) {
        for (const kind of V12_VALUE_KINDS) {
          for (const flag of FLAGS) {
            const tx = {
              id: `cb-${kind}-${fee}-${flag}`,
              kind,
              fee,
              coinbase: flag,
              vin: [{ address: who }],
              vout: [],
            };
            const tpl = template(who, [tx]);
            const verdict = verifyBlock(blockOf(tpl), null, { probeBody: true });
            assert.equal(verdict.ok, false, `${kind} ${fee} ${flag}`);
            // Stage 0: a block never carries a proofless send, whatever its flag.
            const want = flowNeedsDummy(tx) ? FS1_SEND_REASON : 'coinbase';
            assert.equal(verdict.reason, want, `${kind} ${fee} ${flag} ${verdict.reason}`);
            if (fee > 0) {
              const bound = coinbaseLevyPays(tpl.txs[0], fee);
              assert.equal(bound.ok, true, `${kind} ${fee} ${bound.reason || ''}`);
              assert.equal(bound.finder + bound.reserve, fee, `${kind} ${fee}`);
            }
            const queued = store.queueTx({ ...tx, vin: [{ address: who }], vout: [] });
            assert.equal(queued.ok, false, `queue ${kind} ${fee}`);
            assert.equal(queued.reason, 'coinbase', `queue ${kind} ${fee} ${queued.reason}`);
            assert.equal(store.mempool.some((row) => row && row.id === tx.id), false);
            const parked = admitMempool(emptyMempool(), { ...tx }, { baseFee: 1 });
            assert.equal(parked.ok, false, `admit ${kind} ${fee}`);
            assert.equal(parked.reason, 'coinbase', `admit ${kind} ${fee} ${parked.reason}`);
          }
        }
      }

      for (const kind of ['send', 'b-spend', 'coinbase']) {
        for (const fee of [0, 100, (2 ** 20) + 3]) {
          const tx = {
            id: `proof-${kind}-${fee}`,
            kind,
            fee,
            coinbase: true,
            vin: [{ address: who }],
            vout: [],
            admit_proof: { blob: Buffer.from([3, fee & 255, kind.length]) },
          };
          // A bucket proof on a send is the Stage 0 gate; on other kinds it stays admit_membership.
          const want = flowNeedsDummy(tx) ? FS1_SEND_REASON : 'admit_membership';
          const queued = store.queueTx(tx);
          assert.equal(queued.reason, want, `queue proof ${kind} ${fee} ${queued.reason}`);
          const parked = admitMempool(emptyMempool(), tx, { baseFee: 1 });
          assert.equal(parked.reason, want, `admit proof ${kind} ${fee} ${parked.reason}`);
          const verdict = verifyBlock(blockOf(template(who, [tx])), null, { probeBody: true });
          assert.equal(verdict.ok, false);
          assert.equal(verdict.reason, want, `verify proof ${kind} ${fee} ${verdict.reason}`);
        }
      }

      const bare = verifyBlock(blockOf(template(who, [])), null, { probeBody: true });
      assert.equal(bare.ok, true, bare.reason || 'bare');

      const send = verifyBlock(blockOf(template(who, [{
        id: 'plain-send',
        kind: 'send',
        fee: 100,
        vin: [{ address: who }],
        vout: [],
      }])), null, { probeBody: true });
      assert.equal(send.ok, false);
      assert.notEqual(send.reason, 'coinbase', send.reason);

      // The flagged tx is judged first. A later send with a non-bucket proof
      // passes Stage 0 and would be admit_membership only if the flag were skipped.
      const two = verifyBlock(blockOf(template(who, [
        { id: 'flagged', kind: 'withdraw', fee: 2, coinbase: true, vin: [{ address: who }], vout: [] },
        { id: 'later', kind: 'send', fee: 2, vin: [{ address: who }], vout: [], admit_proof: { blob: Buffer.from([2, 1]) } },
      ])), null, { probeBody: true });
      assert.equal(two.ok, false);
      assert.equal(two.reason, 'coinbase', two.reason);
    } finally {
      try { store.close?.(); } catch { /* temp dir */ }
    }
  });
});
