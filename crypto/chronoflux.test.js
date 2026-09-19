import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SAMPLE_PRUNE_CONFIRMATIONS,
  SPENDABLE_CONFIRMATIONS,
  isSpendableHeight,
  shouldPruneSamples,
  flowSkipAllowed,
  collateSamples,
  rollHashBundle,
  leanBlock,
  pruneSamples,
  sealedExplorerRows,
  compactChainBlock,
  compactTx,
  sealedVinLinkField,
} from './chronoflux.js';
import { lockTx, voteTx, portalIdFromDest } from './reserve_vault.js';
import { newIdentity, hash20FromAddress, admitBaseFromAddress, freshStealthDest } from './address.js';
import { vaultDest, destForLogin } from './flow_sheet.js';
import { verifySealedNote, reviveBytes, sealCoinbaseNote, noteCommitOfDest20 } from './note.js';
import { attachAdmitPub } from './admit.js';
import { PI_SHE_NANOS, GENESIS_BITS_PACKED } from './asert.js';
import { digestTx, buildTemplate, verifyBlock, GENESIS_PREV } from '../node/src/chain.js';
import { poolWithdrawTx } from './levy.js';
import { attachDummyOuts } from './dummy.js';
import { admitMempool, emptyMempool } from './mempool.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('chronoflux prune + collate', () => {
  it('collates thousands of hashes into one sample per miner', () => {
    const miner = 'shear1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const fat = Array.from({ length: 4000 }, (_, i) => ({
      miner,
      nonce: String(i),
      tag: 'a',
      count: 1,
    }));
    const slim = collateSamples(fat);
    assert.equal(slim.length, 1);
    assert.equal(slim[0].count, 4000);
    assert.ok(JSON.stringify(slim).length < JSON.stringify(fat).length / 100);
  });

  it('prunes sample bodies after 1000 confirmations and never drops sealed txs', () => {
    assert.equal(SAMPLE_PRUNE_CONFIRMATIONS, 1000);
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    assert.equal(isSpendableHeight(100, 99), false);
    assert.equal(isSpendableHeight(100, 100), false);
    assert.equal(isSpendableHeight(100, 104), false);
    assert.equal(isSpendableHeight(100, 105), true);
    assert.equal(shouldPruneSamples(1, 1001), true);
    assert.equal(shouldPruneSamples(2, 1001), false);
    assert.equal(shouldPruneSamples(1, 1000), false);
    assert.equal(flowSkipAllowed({ height: 1, samplesPruned: true }, 1), false);
    assert.equal(flowSkipAllowed({ height: 1, samplesPruned: true }, 1000), false);
    assert.equal(flowSkipAllowed({ height: 1, samplesPruned: true }, 1001), true);
    assert.equal(flowSkipAllowed({ height: 1, samplesPruned: false }, 1001), false);
    const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-prunewatch-'));
    fs.writeFileSync(path.join(watchDir, 'chain.jsonl'), `${JSON.stringify({
      height: 1,
      hash: 'ab'.repeat(32),
      samplesPruned: true,
      samples: [],
      shareBatch: [{ nonce: '1' }],
      txs: [{ coinbase: true, vout: [{ kind: 'pot' }] }],
    })}\n`);
    const watch = spawnSync(process.execPath, [path.join(root, 'node/scripts/watch_prune.mjs')], {
      env: { ...process.env, SHEAR_DATA: watchDir },
      encoding: 'utf8',
    });
    assert.notEqual(watch.status, 0);
    const report = JSON.parse(watch.stdout.split('\n').filter(Boolean).at(-1));
    assert.equal(report.ok, false);
    const reasons = (report.dangers || []).map((d) => d.reason);
    assert.ok(reasons.includes('pruned_too_early'), reasons.join(','));
    assert.ok(reasons.includes('pruned_still_has_shares'), reasons.join(','));
    assert.equal(report.skipPowPeerFlagAlone, true);
    const send = {
      id: 'send-1',
      from: 'shear1from',
      to: 'shear1to',
      nanos: 50,
      vin: [{ address: 'shear1from' }],
      vout: [{ address: 'shear1to', nanos: 50 }],
    };
    const block = {
      height: 1,
      hash: 'aa',
      samples: [{ miner: 'shear1from', nonce: '1', tag: 't', count: 9 }],
      txs: [
        {
          coinbase: true,
          height: 1,
          samples: [{ miner: 'shear1from', count: 9 }],
          vout: [
            { address: 'shear1from', nanos: 100_000_000_000, kind: 'pot' },
            { address: 'shear1from', nanos: 90, kind: 'hash' },
          ],
        },
        send,
      ],
    };
    const pruned = pruneSamples(block);
    assert.equal(pruned.samplesPruned, true);
    assert.deepEqual(pruned.samples, []);
    assert.equal(pruned.txs[0].samples, undefined);
    assert.equal(pruned.txs[0].vout.length, 2);
    assert.equal(pruned.txs[1].id, 'send-1');
    const rows = sealedExplorerRows(pruned);
    assert.equal(rows.length, 3);
    assert.ok(rows.some((r) => r.kind === 'coinbase' && r.nanos === 100_000_000_000));
    assert.ok(rows.some((r) => r.id === 'send-1-vout-0'));
    assert.throws(() => pruneSamples({ height: 1, txs: [] }), /prune_refuses_empty_txs/);
    assert.throws(() => pruneSamples({
      height: 1,
      txs: [{ coinbase: true, vout: [] }],
    }), /prune_refuses_empty_coinbase/);
    const dest20 = Buffer.alloc(20, 7);
    const lockKept = pruneSamples({
      height: 1,
      samples: [{ miner: 'x', count: 9 }],
      shareBatch: [{ nonce: '1' }],
      txs: [
        { coinbase: true, vout: [{ kind: 'pot', noteCommit: Buffer.alloc(32, 1) }] },
        { id: 'lock-keep', kind: 'lock', vout: [{ kind: 'lock', dest20, valueProof: { v: 5 } }] },
      ],
    });
    assert.equal(lockKept.samplesPruned, true);
    assert.deepEqual(lockKept.shareBatch, []);
    assert.equal(lockKept.txs[1].id, 'lock-keep');
    assert.equal(Buffer.from(lockKept.txs[1].vout[0].dest20).equals(dest20), true);
    assert.equal(lockKept.txs[1].vout[0].valueProof.v, 5);
  });

  it('compact chain row is header + sealed txs, not per-hash JSON', () => {
    const fatSamples = Array.from({ length: 200 }, (_, i) => ({
      miner: 'shear1a',
      nonce: String(i),
      count: 1,
    }));
    const row = compactChainBlock({
      magic: 'shear-testnet-v1',
      height: 4,
      miner: 'shear1a',
      samples: fatSamples,
      txs: [
        compactTx({
          coinbase: true,
          height: 4,
          samples: fatSamples,
          vout: [{ address: 'shear1a', nanos: 100_000_000_000, kind: 'pot' }],
        }),
      ],
    });
    assert.equal(row.samples.length, 1);
    assert.equal(row.samples[0].count, 200);
    assert.equal(row.txs[0].samples, undefined);
    assert.equal(row.txs[0].vout[0].kind, 'pot');
    const prunedRow = compactChainBlock({ ...row, samplesPruned: true, samples: fatSamples });
    assert.deepEqual(prunedRow.samples, []);
    assert.equal(prunedRow.txs.length, 1);
  });

  it('rolls a 9s hash bundle: N hashes become one row per miner, bonus still N units', () => {
    const a = 'ssa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'ssa1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const fat = [
      ...Array.from({ length: 3000 }, (_, i) => ({ miner: a, nonce: String(i), tag: 'a', count: 1 })),
      ...Array.from({ length: 2000 }, (_, i) => ({ miner: b, nonce: String(i), tag: 'b', count: 1 })),
    ];
    const bundle = rollHashBundle(fat);
    assert.equal(bundle.length, 2);
    assert.equal(bundle.find((s) => s.miner === a).count, 3000);
    assert.equal(bundle.find((s) => s.miner === b).count, 2000);
    const bonusUnits = bundle.reduce((n, s) => n + s.count, 0);
    assert.equal(bonusUnits, 5000);
    const lean = leanBlock({
      height: 1,
      samples: fat,
      txs: [{ coinbase: true, height: 1, samples: fat, vout: [{ kind: 'pot', nanos: 1 }] }],
    });
    assert.equal(lean.samples.length, 2);
    assert.equal(lean.txs[0].samples, undefined);
    assert.ok(JSON.stringify(lean.samples).length < JSON.stringify(fat).length / 50);
  });

  it('emits one explorer row per body vout so leftover is not left on from', () => {
    const from = 'ssa1from';
    const to = 'ssa1to';
    const change = 'ssa1change';
    const rows = sealedExplorerRows({
      height: 9,
      hash: 'bb',
      txs: [
        { coinbase: true, vout: [{ address: from, nanos: 100, kind: 'pot' }] },
        {
          id: 'pay-1',
          kind: 'send',
          from,
          to,
          nanos: 40,
          fee: 5,
          vout: [
            { address: to, nanos: 40, kind: 'send' },
            { address: change, nanos: 55, kind: 'send' },
          ],
        },
      ],
    });
    const pay = rows.find((r) => r.id === 'pay-1-vout-0');
    const leftover = rows.find((r) => r.id === 'pay-1-vout-1');
    const levy = rows.find((r) => r.id === 'pay-1-levy');
    assert.equal(pay.to, to);
    assert.equal(pay.from, from);
    assert.equal(pay.nanos, 40);
    assert.equal(pay.kind, 'send');
    assert.equal(leftover.to, change);
    assert.equal(leftover.from, from);
    assert.equal(leftover.nanos, 55);
    assert.equal(leftover.kind, 'send');
    assert.equal(levy.kind, 'levy');
    assert.equal(levy.from, from);
    assert.equal(levy.nanos, 5);
  });

  it('compact lock drops the opening and still proves the amount after JSON', () => {
    const id = newIdentity();
    const continuum = destForLogin(id.address, { viewKey: id.viewKey });
    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const tx = lockTx({ from: continuum, to: vault, nanos: PI_SHE_NANOS, id: 'lock-json' });
    assert.equal(verifySealedNote(tx.vout[0], PI_SHE_NANOS), true);
    const sealed = compactTx(tx);
    assert.equal(sealed.vout[0].r, undefined);
    assert.equal(sealed.kind, 'lock');
    assert.equal(sealed.to, undefined);
    assert.equal(sealed.from, undefined);
    assert.equal(sealed.vout[0].address, undefined);
    assert.equal(sealed.nanos, undefined);
    assert.equal(sealed.vout[0].nanos, undefined);
    assert.ok(sealed.vout[0].commit);
    assert.ok(sealed.vout[0].rangeProof || sealed.vout[0].valueProof);
    if (sealed.vout[0].rangeProof) {
      assert.equal(sealed.vout[0].rangeProof === true, false);
    }
    const wire = JSON.parse(JSON.stringify(sealed), reviveBytes);
    assert.equal(Buffer.isBuffer(wire.vout[0].commit), true);
    assert.equal(verifySealedNote(wire.vout[0], PI_SHE_NANOS), true);
    assert.equal(wire.vout[0].r, undefined);
    assert.ok(sealed.vout[0].dest20);
    assert.ok(sealed.vout[0].portalId);
    assert.equal(digestTx(sealed).equals(digestTx(tx)), true);
  });

  it('compact address-only lock keeps dest20/portalId/valueProof.v so digestTx matches the fat body', () => {
    const id = newIdentity();
    const continuum = destForLogin(id.address, { viewKey: id.viewKey });
    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const fat = {
      id: 'lock-addr',
      programId: 'shear-reserve-v1',
      kind: 'lock',
      from: continuum,
      to: vault,
      nanos: PI_SHE_NANOS,
      vin: [{ address: continuum }],
      vout: [{ kind: 'lock', address: vault, nanos: PI_SHE_NANOS }],
    };
    const sealed = compactTx(fat);
    const blob = JSON.stringify(sealed);
    assert.doesNotMatch(blob, /ssa1/);
    assert.doesNotMatch(blob, /she1/);
    assert.doesNotMatch(blob, /"nanos"/);
    assert.doesNotMatch(blob, /"address"/);
    assert.equal(sealed.from, undefined);
    assert.equal(sealed.to, undefined);
    assert.equal(sealed.vout[0].address, undefined);
    assert.equal(sealed.vout[0].nanos, undefined);
    assert.ok(sealed.vout[0].dest20);
    assert.equal(Buffer.from(sealed.vout[0].dest20).length, 20);
    assert.equal(sealed.vout[0].portalId, portalIdFromDest(vault));
    assert.equal(Number(sealed.vout[0].valueProof.v), PI_SHE_NANOS);
    assert.equal(digestTx(sealed).equals(digestTx(fat)), true);
    const wire = JSON.parse(JSON.stringify(sealed), reviveBytes);
    assert.equal(digestTx(wire).equals(digestTx(fat)), true);

    const voteFat = {
      id: 'vote-addr',
      programId: 'shear-reserve-v1',
      kind: 'vote',
      from: continuum,
      to: vault,
      payer: continuum,
      choice: 'leave bonus as-is',
      vin: [{ address: continuum }],
      vout: [{ kind: 'vote', address: vault, nanos: 0 }],
    };
    const voteSealed = compactTx(voteFat);
    assert.doesNotMatch(JSON.stringify(voteSealed), /ssa1/);
    assert.doesNotMatch(JSON.stringify(voteSealed), /"nanos"/);
    assert.equal(voteSealed.payer, undefined);
    assert.ok(voteSealed.vout[0].dest20);
    assert.equal(digestTx(voteSealed).equals(digestTx(voteFat)), true);
  });

  it('compact pool-withdraw keeps dest20+value so header merkle still matches after lean/wire', () => {
    const id = newIdentity();
    const payee = newIdentity();
    const from = destForLogin(id.address, { viewKey: id.viewKey });
    const to = destForLogin(payee.address, { viewKey: payee.viewKey });
    const fat = poolWithdrawTx({ from, to, nanos: 314_159_265_358, fee: 100, id: 'auto-payout-test' });
    const sealed = compactTx(fat);
    const blob = JSON.stringify(sealed);
    assert.doesNotMatch(blob, /ssa1/);
    assert.equal(sealed.from, undefined);
    assert.equal(sealed.to, undefined);
    assert.equal(sealed.vout[0].address, undefined);
    assert.equal(sealed.vin[0].address, undefined);
    assert.ok(sealed.vin[0].dest20);
    assert.equal(sealed.vin[0].prev, undefined);
    assert.equal(sealed.vout[0].kind, 'pool-withdraw');
    assert.ok(sealed.vout[0].dest20);
    assert.equal(Number(sealed.vout[0].valueProof.v), 314_159_265_358);
    assert.equal(digestTx(sealed).equals(digestTx(fat)), true);
    const wire = JSON.parse(JSON.stringify(sealed), reviveBytes);
    assert.equal(digestTx(wire).equals(digestTx(fat)), true);
    const lean = leanBlock({
      height: 36,
      txs: [
        { coinbase: true, height: 36, vout: [{ kind: 'pot', nanos: 100_000_000_000 }, { kind: 'finder-fee', nanos: 50 }, { kind: 'reserve-fee', nanos: 50 }] },
        fat,
      ],
    });
    assert.equal(digestTx(lean.txs[1]).equals(digestTx(fat)), true);
  });

  it('compact of a fat vin is C̃-only; verify and mempool reject a still-linked vin', () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey });
    const fat = {
      kind: 'send',
      from: dest,
      to: dest,
      fee: 100,
      vin: [{
        prev: Buffer.alloc(32, 9),
        index: 1,
        noteCommit: Buffer.alloc(32, 4),
        commit: Buffer.alloc(32, 2),
        address: dest,
      }],
      vout: [{ address: dest, nanos: 1, kind: 'send' }],
    };
    const sealed = compactTx(fat);
    assert.deepEqual(Object.keys(sealed.vin[0]), ['commit']);
    assert.equal(sealed.vin[0].prev, undefined);
    assert.equal(sealed.vin[0].index, undefined);
    assert.equal(sealed.vin[0].noteCommit, undefined);
    assert.equal(sealedVinLinkField(sealed.vin[0]), null);
    const commitOnly = attachDummyOuts({
      kind: 'send',
      from: dest,
      to: dest,
      fee: 100,
      id: 'commit-only-vin',
      vin: [{ commit: fat.vin[0].commit }],
      vout: [{ address: dest, nanos: 1, kind: 'send' }],
    });
    assert.deepEqual(Object.keys(commitOnly.vin[0]), ['commit']);
    assert.equal(sealedVinLinkField(commitOnly.vin[0]), null);
    const admitCommit = admitMempool(emptyMempool(), commitOnly);
    assert.notEqual(admitCommit.reason, 'vin_link');
    const linked = attachDummyOuts({ ...fat, id: 'linked-vin' });
    assert.equal(admitMempool(emptyMempool(), linked).reason, 'vin_link');
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
      txs: [linked],
    });
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      miner: tpl.miner,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      weight: tpl.weight,
      shareBatch: tpl.shareBatch || [],
    };
    const got = verifyBlock(block, null, { trustedPowHash: Buffer.alloc(32) });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'vin_link');
  });

  it('compact hash vout keeps dest20, noteCommit, wrap, and valueProof.v', () => {
    const id = newIdentity();
    const dest = freshStealthDest(id).dest;
    const d20 = hash20FromAddress(dest);
    const admit = admitBaseFromAddress(dest);
    const nanos = 620544;
    const fat = attachAdmitPub(sealCoinbaseNote(nanos, { dest20: d20, kind: 'hash' }), { admitBase: admit });
    const tx = { coinbase: true, height: 7, vin: [{ coinbase: true, height: 7 }], vout: [fat] };
    const sealed = compactTx(tx);
    const o = sealed.vout[0];
    assert.equal(o.kind, 'hash');
    assert.equal(o.r, undefined);
    assert.ok(o.noteCommit);
    assert.ok(o.dest20);
    assert.equal(Buffer.from(o.dest20).length, 20);
    assert.ok(Buffer.from(o.noteCommit).equals(noteCommitOfDest20(d20)));
    assert.ok(o.rEph);
    assert.ok(o.rCt);
    assert.equal(Number(o.valueProof.v), nanos);
    assert.doesNotMatch(JSON.stringify(sealed), /ssa1/);
    assert.equal(digestTx(sealed).equals(digestTx(tx)), true);
    const rows = sealedExplorerRows({ height: 7, hash: Buffer.alloc(32, 7), txs: [sealed] });
    const hashRow = rows.find((r) => r.kind === 'hash');
    assert.ok(hashRow);
    assert.ok(hashRow.toDest20);
    assert.equal(hashRow.nanos, nanos);
  });
});
