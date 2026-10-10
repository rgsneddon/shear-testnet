import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import {
  GENESIS_BITS_PACKED,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
} from '../../crypto/asert.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import {
  GENESIS_BPS,
  ORACLE_MAX_AGE_MS,
  RESERVE_ORACLE_ID,
  RESERVE_ORACLE_MAX_BPS,
  clampBpsStep,
  interestNanos,
} from '../../crypto/reserve_oracle.js';
import {
  emptyVault,
  deposit,
  enact,
  observeRate,
  applyReserveBlock,
  previewWithdraw,
  lockTx,
} from '../../crypto/reserve_vault.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { GENESIS_PREV, buildTemplate, verifyBlock, digestTx } from '../src/chain.js';
import { createStore } from '../src/store.js';

const T0 = 1_700_000_000_000;
const BPS = [0, 1, 50, 100, 164, 264, 300, 364, 1000, 5000, 9999, RESERVE_ORACLE_MAX_BPS];
const BAD_BPS = [-1, RESERVE_ORACLE_MAX_BPS + 1, 1.5, Number.NaN, true, '9999', null, 2 ** 53];

function destOf(id) {
  return vaultDest(id.address, { viewKey: id.viewKey });
}

function payOf(id) {
  return destForLogin(id.address, { viewKey: id.viewKey });
}

function openEpoch(state, dest, nowMs) {
  const got = deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs });
  assert.equal(got.ok, true, got.reason);
  return got;
}

function coinbaseObserve(annualBps, observedAtMs) {
  return {
    coinbase: true,
    vout: [],
    observe: { annualBps, observedAtMs },
  };
}

describe('oracle observe is sealed in a block', () => {
  it('any local rate leaves the next epoch on the genesis bps; a prior block observe clamps', () => {
    for (const bps of BPS) {
      const want = clampBpsStep(GENESIS_BPS, bps);
      const alice = newIdentity();
      const bob = newIdentity();
      const local = emptyVault();
      openEpoch(local, destOf(alice), T0);
      assert.equal(enact({ state: local, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      assert.equal(observeRate({
        state: local,
        annualBps: bps,
        nowMs: T0 + RESERVE_EPOCH_MS + 1,
      }).ok, true);
      assert.equal(local.oracle.annualBps, bps);
      openEpoch(local, destOf(bob), T0 + RESERVE_EPOCH_MS + 2);
      assert.equal(local.epochBps, GENESIS_BPS, `local ${bps}`);
      assert.equal(local.sealedObserve ?? null, null, `local seal ${bps}`);

      const disk = emptyVault();
      openEpoch(disk, destOf(newIdentity()), T0);
      assert.equal(enact({ state: disk, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      disk.oracle = {
        id: RESERVE_ORACLE_ID,
        annualBps: bps,
        observedAtMs: T0 + RESERVE_EPOCH_MS + 1,
        components: [{ id: 'basket', bps }],
      };
      openEpoch(disk, destOf(newIdentity()), T0 + RESERVE_EPOCH_MS + 2);
      assert.equal(disk.epochBps, GENESIS_BPS, `disk ${bps}`);

      const held = emptyVault();
      const holder = destOf(newIdentity());
      openEpoch(held, holder, T0);
      const due = previewWithdraw(held, holder).interest;
      const mid = applyReserveBlock({
        state: held,
        block: { txs: [coinbaseObserve(bps, T0 + 1)] },
        nowMs: T0 + 1,
      });
      assert.equal(mid.ok, true, mid.reason);
      assert.equal(previewWithdraw(held, holder).interest, due, `preview ${bps}`);
      assert.equal(held.epochBps, GENESIS_BPS, `mid epoch ${bps}`);
      const paid = previewWithdraw(held, holder).interest;
      assert.equal(paid, interestNanos(PI_SHE_NANOS, GENESIS_BPS), `interest ${bps}`);

      const prior = emptyVault();
      openEpoch(prior, destOf(newIdentity()), T0);
      const sealed = applyReserveBlock({
        state: prior,
        block: { txs: [coinbaseObserve(bps, T0 + RESERVE_EPOCH_MS + 1)] },
        nowMs: T0 + 1,
      });
      assert.equal(sealed.ok, true, sealed.reason);
      assert.equal(prior.epochBps, GENESIS_BPS, `same epoch ${bps}`);
      assert.equal(enact({ state: prior, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      openEpoch(prior, destOf(newIdentity()), T0 + RESERVE_EPOCH_MS + 2);
      assert.equal(prior.epochBps, want, `prior block ${bps}`);
      assert.equal(prior.sealedObserve.annualBps, bps, `sealed bps ${bps}`);

      const same = emptyVault();
      const who = newIdentity();
      openEpoch(same, destOf(newIdentity()), T0);
      const end = T0 + RESERVE_EPOCH_MS;
      assert.equal(enact({ state: same, nowMs: end }).ok, true);
      const rolled = applyReserveBlock({
        state: same,
        block: {
          txs: [
            coinbaseObserve(bps, end + 1),
            lockTx({
              from: payOf(who),
              to: destOf(who),
              nanos: PI_SHE_NANOS,
              id: `lock-${bps}`,
            }),
          ],
        },
        nowMs: end + 2,
      });
      assert.equal(rolled.ok, true, JSON.stringify(rolled));
      assert.equal(same.epochBps, GENESIS_BPS, `same block ${bps}`);
      assert.equal(same.sealedObserve.annualBps, bps);
      const end2 = end + 2 + RESERVE_EPOCH_MS;
      assert.equal(enact({ state: same, nowMs: end2 }).ok, true);
      openEpoch(same, destOf(newIdentity()), end2 + 1);
      assert.equal(same.epochBps, want, `following epoch ${bps}`);

      const freezeAt = T0 + RESERVE_EPOCH_MS + 2;
      const freshAt = freezeAt - ORACLE_MAX_AGE_MS;
      const staleAt = freshAt - 1;
      const aged = emptyVault();
      openEpoch(aged, destOf(newIdentity()), T0);
      assert.equal(applyReserveBlock({
        state: aged,
        block: { txs: [coinbaseObserve(bps, freshAt)] },
        nowMs: T0 + 1,
      }).ok, true);
      assert.equal(enact({ state: aged, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      openEpoch(aged, destOf(newIdentity()), freezeAt);
      assert.equal(aged.epochBps, want, `age cap ${bps}`);

      const stale = emptyVault();
      openEpoch(stale, destOf(newIdentity()), T0);
      assert.equal(applyReserveBlock({
        state: stale,
        block: { txs: [coinbaseObserve(bps, staleAt)] },
        nowMs: T0 + 1,
      }).ok, true);
      assert.equal(enact({ state: stale, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      openEpoch(stale, destOf(newIdentity()), freezeAt);
      assert.equal(stale.epochBps, GENESIS_BPS, `stale ${bps}`);

      const quiet = emptyVault();
      const loud = emptyVault();
      loud.oracle = {
        id: RESERVE_ORACLE_ID,
        annualBps: bps,
        observedAtMs: T0 + RESERVE_EPOCH_MS + 1,
      };
      for (const state of [quiet, loud]) {
        openEpoch(state, destOf(newIdentity()), T0);
        assert.equal(applyReserveBlock({
          state,
          block: { txs: [coinbaseObserve(bps, T0 + RESERVE_EPOCH_MS + 1)] },
          nowMs: T0 + 1,
        }).ok, true);
        assert.equal(enact({ state, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
        openEpoch(state, destOf(newIdentity()), T0 + RESERVE_EPOCH_MS + 2);
      }
      assert.equal(quiet.epochBps, loud.epochBps, `two nodes ${bps}`);
      assert.equal(quiet.epochBps, want, `two nodes rate ${bps}`);
    }
  });

  it('a non-canonical observe is rejected and does not seal', () => {
    const badTimes = [-1, 1.5, '1', true, null];
    const cases = [
      ...BAD_BPS.map((annualBps) => ({ annualBps, observedAtMs: T0 })),
      ...badTimes.map((observedAtMs) => ({ annualBps: 300, observedAtMs })),
    ];
    for (const observe of cases) {
      const state = emptyVault();
      openEpoch(state, destOf(newIdentity()), T0);
      const before = state.epochBps;
      const applied = applyReserveBlock({
        state,
        block: {
          txs: [
            { coinbase: true, vout: [], observe },
            lockTx({
              from: payOf(newIdentity()),
              to: destOf(newIdentity()),
              nanos: PI_SHE_NANOS,
              id: 'bad-lock',
            }),
          ],
        },
        nowMs: T0 + 1,
      });
      assert.equal(applied.ok, false, JSON.stringify(observe));
      assert.equal(applied.reason, 'bad_rate', JSON.stringify(observe));
      assert.equal(state.epochBps, before);
      assert.equal(state.sealedObserve ?? null, null);
      assert.equal(Number(state.totalLockedNanos), PI_SHE_NANOS);
    }
    const body = emptyVault();
    const stray = applyReserveBlock({
      state: body,
      block: {
        txs: [
          { coinbase: true, vout: [] },
          { kind: 'send', observe: { annualBps: 300, observedAtMs: T0 } },
        ],
      },
      nowMs: T0,
    });
    assert.equal(stray.ok, false);
    assert.equal(stray.reason, 'bad_rate');
  });

  it('the coinbase digest binds any sealed observe, and compact keeps it', () => {
    const plain = { coinbase: true, height: 1, vin: [{ coinbase: true }], vout: [] };
    const bare = digestTx(plain);
    for (const bps of BPS) {
      const row = {
        ...plain,
        observe: { annualBps: bps, observedAtMs: T0, extra: 'not-consensus' },
      };
      const dig = digestTx(row);
      assert.equal(dig.equals(bare), false, `bare ${bps}`);
      const other = bps === RESERVE_ORACLE_MAX_BPS ? 0 : bps + 1;
      const flipped = digestTx({ ...plain, observe: { annualBps: other, observedAtMs: T0 } });
      assert.equal(dig.equals(flipped), false, `flip ${bps}`);
      const timed = digestTx({ ...plain, observe: { annualBps: bps, observedAtMs: T0 + 1 } });
      assert.equal(dig.equals(timed), false, `time ${bps}`);
      const compact = compactTx(row);
      assert.equal(compact.observe.annualBps, bps);
      assert.equal(compact.observe.observedAtMs, T0);
      assert.equal(Object.prototype.hasOwnProperty.call(compact.observe, 'extra'), false);
      assert.equal(digestTx(compact).equals(dig), true, `compact ${bps}`);
    }
    const bad = digestTx({ ...plain, observe: { annualBps: '9999', observedAtMs: T0 } });
    assert.equal(bad.equals(bare), false);
  });

  it('createStore ignores a reserve.json oracle for every rate', () => {
    for (const bps of BPS) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-oracle-'));
      fs.writeFileSync(path.join(dir, 'reserve.json'), JSON.stringify({
        oracle: {
          id: RESERVE_ORACLE_ID,
          annualBps: bps,
          observedAtMs: T0,
          components: [{ id: 'basket', bps }],
        },
        epochBps: bps,
        portals: { dead: { staked: '1', idle: '0' } },
      }));
      const store = createStore(dir);
      assert.equal(store.reserveVault.oracle.annualBps, GENESIS_BPS, `boot ${bps}`);
      assert.equal(store.reserveVault.epochBps, GENESIS_BPS, `boot epoch ${bps}`);
      assert.equal(store.reserveVault.sealedObserve ?? null, null, `boot seal ${bps}`);
      const state = store.reserveVault;
      openEpoch(state, destOf(newIdentity()), T0);
      assert.equal(enact({ state, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      assert.equal(observeRate({
        state,
        annualBps: bps,
        nowMs: T0 + RESERVE_EPOCH_MS + 1,
      }).ok, true);
      openEpoch(state, destOf(newIdentity()), T0 + RESERVE_EPOCH_MS + 2);
      assert.equal(state.epochBps, GENESIS_BPS, `store roll ${bps}`);
    }
  });

  it('verifyBlock rejects a non-canonical observe and accepts a canonical one', async () => {
    try { setHashBackend('jit'); } catch { /* interpreter */ }
    const who = payOf(newIdentity());
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      finderDest: '',
      txs: [{ id: 'fee-0', kind: 'send', fee: 0 }],
      bits: GENESIS_BITS_PACKED,
      now: T0,
    });
    const decoded = decodeHeader(Buffer.from(tpl.header));
    function blockFor(observe) {
      const cb = { ...tpl.txs[0], observe };
      const header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: merkleRoot([digestTx(cb)]),
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      return {
        header,
        txs: [cb],
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
    for (const bps of BPS) {
      const got = await verifyBlock(blockFor({ annualBps: bps, observedAtMs: T0 }), null, { probeBody: true });
      assert.equal(got.ok, true, `${bps} ${got.reason}`);
    }
    for (const annualBps of BAD_BPS) {
      const got = await verifyBlock(blockFor({ annualBps, observedAtMs: T0 }), null, { probeBody: true });
      assert.equal(got.ok, false, String(annualBps));
      assert.equal(got.reason, 'bad_rate', String(annualBps));
    }
  });
});
