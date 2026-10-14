/**
 * PSA-1f69-1. N-1 rejects a payout whose output joins the admit set and is
 * not an FS-1 leaf. The reason is admit_note_point, from height 0, on
 * mempool, queueTx, the block template, block verify, load, fork replay,
 * P2P, and snap/bootstrap. An honest coinbase or pool payout of each kind
 * is still a leaf. A vault withdrawal of value 0 is mint_amount. A positive
 * withdrawal is sealed with a hash-derived non-zero r. The Stage 0 send
 * gate still wins, and the genesis pin stays empty.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admitBaseFromAddress, hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { attachAdmitPub, outputJoinsAdmitSet } from '../../crypto/admit.js';
import { writeChainBin } from '../../crypto/chainbin.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { fs1Leaf, fs1OutputNote } from '../../crypto/fs1_leaf.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { chainNoteRuleRejected, txNoteRuleRejected, zeroWithdrawRejected } from '../../crypto/n1.js';
import { scalarBytes, sealCoinbaseNote } from '../../crypto/note.js';
import { kt10WithdrawBlind, withdrawTx } from '../../crypto/reserve_vault.js';
import { boundReserveWithdraw } from '../../crypto/spend.js';
import { chainStage0Rejected } from '../../crypto/fs1_send_gate.js';
import { readLatestBootstrap } from '../src/bootstrap.js';
import {
  V12_GENESIS_BLOCK_HASH,
  buildTemplate,
  coinbaseTx,
  verifyBlock,
  verifyLoadedChain,
} from '../src/chain.js';
import { createP2p } from '../src/p2p.js';
import { createStore } from '../src/store.js';

const T0 = 1_700_000_000_000;
const PAYOUT_KINDS = ['pot', 'hash', 'finder-fee', 'reserve-fee', 'pool-fee'];
const BREAKS = ['zero-commit', 'missing-commit', 'identity-admit', 'bad-admit', 'bad-commit'];

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function honestNote(dest, kind) {
  const d20 = hash20FromAddress(dest);
  return attachAdmitPub(sealCoinbaseNote(1000, { dest20: d20, kind }), {
    admitBase: admitBaseFromAddress(dest),
  });
}

function breakNote(note, mode) {
  if (mode === 'zero-commit') return { ...note, commit: Buffer.alloc(32) };
  if (mode === 'missing-commit') {
    const out = { ...note };
    delete out.commit;
    return out;
  }
  if (mode === 'identity-admit') return { ...note, admitPub: Buffer.alloc(32) };
  if (mode === 'bad-admit') return { ...note, admitPub: Buffer.alloc(32, 0xff) };
  if (mode === 'bad-commit') return { ...note, commit: Buffer.alloc(32, 0xff) };
  throw new Error(mode);
}

function payoutTx(dest, kind, mode) {
  return {
    id: `n1-${kind}-${mode}`,
    kind,
    fee: 0,
    vout: [breakNote(honestNote(dest, kind), mode)],
  };
}

function flowTx() {
  const blob = Buffer.alloc(160, 9);
  blob[0] = 3;
  const tag = Buffer.from(blob.subarray(1, 33));
  return {
    id: 'stage0-send',
    kind: 'send',
    nanos: 1,
    fee: 0,
    anchor: 8,
    vin: [{ commit: Buffer.alloc(32, 5) }],
    vout: [{ kind: 'send', admitPub: Buffer.alloc(32), commit: Buffer.alloc(32) }],
    admit_proof: { v: 3, blob, spendTag: tag, cTilde: Buffer.alloc(32, 5) },
    spendTag: tag,
  };
}

describe('N-1 payout leaves (PSA-1f69-1)', () => {
  it('rejects each payout kind, one broken leaf per kind, on every accept path', () => {
    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-'));
    const store = createStore(dir);
    try {
      const cases = PAYOUT_KINDS.map((kind, i) => ({ kind, mode: BREAKS[i], tx: payoutTx(dest, kind, BREAKS[i]) }));
      for (const { kind, mode, tx } of cases) {
        const label = `${kind} ${mode}`;
        assert.equal(outputJoinsAdmitSet(tx, tx.vout[0]), true, label);
        assert.equal(fs1Leaf(fs1OutputNote(tx.vout[0])), null, label);
        assert.equal(txNoteRuleRejected(tx).reason, 'admit_note_point', label);

        const parked = admitMempool(emptyMempool(), tx);
        assert.equal(parked.reason, 'admit_note_point', `${label} mempool`);
        const queued = store.queueTx(tx);
        assert.equal(queued.reason, 'admit_note_point', `${label} queue`);
        assert.equal(store.mempool.some((row) => row.id === tx.id), false, label);

        const p2p = createP2p({ store, port: 0 });
        p2p.ingestRemoteTx(tx, { destroy() {} });
        assert.equal(store.mempool.some((row) => row.id === tx.id), false, `${label} p2p`);
        p2p.close();
      }

      const bad = cases.map((row) => row.tx);
      const tpl = buildTemplate({
        height: 1,
        miner: dest,
        now: T0,
        txs: bad,
        potShares: [{ address: dest, nanos: 1000, kind: 'pot' }],
      });
      for (const tx of bad) {
        assert.equal(tpl.txs.some((row) => row.id === tx.id), false, tx.id);
      }
      assert.equal(txNoteRuleRejected(tpl.txs[0]), null);

      for (const { kind, tx } of cases) {
        const block = {
          header: tpl.header,
          height: 0,
          hash: Buffer.alloc(32, 3),
          txs: [tx],
        };
        assert.equal(verifyBlock(block, null).reason, 'admit_note_point', `${kind} verify`);
        assert.equal(verifyLoadedChain([block]).reason, 'admit_note_point', `${kind} load`);
        assert.equal(chainNoteRuleRejected([block]).reason, 'admit_note_point', `${kind} height`);
        assert.equal(store.verifyFork([block]).reason, 'admit_note_point', `${kind} fork`);
        assert.equal(store.ingest([block]).reason, 'admit_note_point', `${kind} replay`);
      }

      const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-snap-'));
      fs.writeFileSync(path.join(snapDir, 'chain.jsonl'), `${JSON.stringify({
        header: Buffer.alloc(80, 1).toString('hex'),
        hash: Buffer.alloc(32, 2).toString('hex'),
        height: 1,
        txs: [cases[0].tx],
      })}\n`);
      assert.throws(() => createStore(snapDir), /admit_note_point/);
      fs.rmSync(snapDir, { recursive: true, force: true });

      const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-boot-'));
      const bootBlock = {
        header: tpl.header,
        hash: Buffer.alloc(32, 9),
        height: 1,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        txs: [cases.find((row) => row.mode === 'zero-commit').tx],
      };
      const bootPaths = path.join(bootDir, 'bootstrap');
      fs.mkdirSync(bootPaths, { recursive: true });
      writeChainBin(path.join(bootPaths, 'latest.bin'), [bootBlock]);
      fs.writeFileSync(path.join(bootPaths, 'latest.json'), `${JSON.stringify({
        latest: true,
        magic: MAGIC_TESTNET,
        height: 1,
        hash: bootBlock.hash.toString('hex'),
        genesisHash: bootBlock.hash.toString('hex'),
      })}\n`);
      assert.throws(() => readLatestBootstrap(bootDir), /admit_note_point/);
      fs.rmSync(bootDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every honest coinbase and pool payout kind is a valid leaf', () => {
    const dest = minerDest();
    const shares = PAYOUT_KINDS.map((kind) => ({ address: dest, nanos: 1000, kind }));
    const cb = coinbaseTx({ height: 1, miner: dest, potShares: shares, potNanos: 5000 });
    assert.deepEqual(cb.vout.map((o) => o.kind), PAYOUT_KINDS);
    for (const o of cb.vout) {
      assert.equal(outputJoinsAdmitSet(cb, o), true, o.kind);
      const leaf = fs1Leaf(fs1OutputNote(o));
      assert.equal(leaf && leaf.length, 96, o.kind);
    }
    assert.equal(txNoteRuleRejected(cb), null);

    const tpl = buildTemplate({
      height: 1,
      miner: dest,
      now: T0,
      potShares: shares,
      txs: [{ id: 'fee-src', fee: 10000, kind: 'pay', vout: [] }],
    });
    const seen = new Set();
    for (const o of tpl.txs[0].vout) {
      if (!outputJoinsAdmitSet(tpl.txs[0], o)) continue;
      seen.add(o.kind);
      assert.equal(fs1Leaf(fs1OutputNote(o))?.length, 96, o.kind);
    }
    for (const kind of PAYOUT_KINDS) assert.equal(seen.has(kind), true, kind);
    assert.equal(seen.has('finder-fee'), true);
    assert.equal(seen.has('reserve-fee'), true);
    assert.equal(txNoteRuleRejected(tpl.txs[0]), null);
  });

  it('keeps the stage 0 send gate ahead of N-1, and the genesis pin empty', () => {
    const send = flowTx();
    assert.equal(admitMempool(emptyMempool(), send).reason, 'send_unavailable');
    assert.equal(chainStage0Rejected([{ txs: [send] }]).reason, 'send_unavailable');
    assert.equal(verifyBlock({ height: 0, txs: [send] }, null).reason, 'send_unavailable');
    assert.equal(V12_GENESIS_BLOCK_HASH, '');
  });

  it('bans a zero withdrawal and seals a positive one with a non-zero hash blind', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const zero = withdrawTx({ from: dest, to: dest, nanos: 0, id: 'z' });
    assert.equal(zero.vout[0].commit, undefined);
    assert.equal(zeroWithdrawRejected(zero).reason, 'mint_amount');
    assert.equal(boundReserveWithdraw(zero).reason, 'mint_amount');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n1-wd-'));
    try {
      const store = createStore(dir);
      assert.equal(store.queueTx(zero).reason, 'mint_amount');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const a = withdrawTx({ from: dest, to: dest, nanos: 1000, id: 'w' });
    const b = withdrawTx({ from: dest, to: dest, nanos: 1000, id: 'w' });
    const other = withdrawTx({ from: dest, to: dest, nanos: 1000, id: 'other' });
    assert.ok(Buffer.isBuffer(a.vout[0].r));
    assert.equal(a.vout[0].r.equals(b.vout[0].r), true);
    assert.equal(a.vout[0].r.equals(Buffer.alloc(32)), false);
    assert.equal(a.vout[0].r.equals(other.vout[0].r), false);
    assert.equal(a.vout[0].r.equals(scalarBytes(kt10WithdrawBlind(dest, 1000, 'w'))), true);
    const joined = attachAdmitPub(a.vout[0], { admitBase: admitBaseFromAddress(dest) });
    assert.equal(fs1Leaf(fs1OutputNote(joined))?.length, 96);
  });
});
