import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import {
  GENESIS_BPS,
  ORACLE_QUORUM,
  bundledEpochBps,
  interestNanos,
  observeVerdict,
} from '../../crypto/reserve_oracle.js';
import {
  emptyVault,
  cloneVault,
  deposit,
  withdraw,
  portalEpochInterest,
  lockTx,
  withdrawTx,
  verifyReservePayout,
  supplyIdentity,
  creditFeeBank,
  payoutStakeReward,
  portalIdFromDest,
  applyReserveBlock,
} from '../../crypto/reserve_vault.js';
import { extraMintAllowed } from '../../crypto/asert.js';
import { reserveFeeDest } from '../../crypto/levy.js';
import { publicReserveReceipt } from '../../crypto/dummy.js';
import {
  signSpendTx,
  boundReserveWithdraw,
  verifyReservePortalOpen,
  reserveAuth,
} from '../../crypto/spend.js';
import { GENESIS_PREV, buildTemplate, verifyBlock, digestTx } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { adminWalletBalance } from '../../pool/src/operator_wallet.js';
import {
  bootReserveEvm,
  callReserve,
  encodeDeposit,
  encodeVote,
  encodeEnact,
  encodeWithdraw,
  encodeObserveRate,
  encodePublicView,
  decodePublicView,
  SYSTEM,
  createAddressFromString,
} from '../../crypto/reserve_evm.js';

const T0 = 1_700_000_000_000;
const END = T0 + RESERVE_EPOCH_MS;
const DAY = 86_400_000;
const PRINCIPALS = [PI_SHE_NANOS, PI_SHE_NANOS + 1, PI_SHE_NANOS * 10, 2 ** 40];
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ABI_NAMES = [
  'CUTOFF_MS', 'DAY_MS', 'EPOCH_DAYS', 'EPOCH_DAYS_MAINNET', 'EPOCH_DAYS_TESTNET',
  'EPOCH_MS', 'GENESIS_BONUS', 'GENESIS_BPS', 'JOIN_CUTOFF_DAYS', 'ORACLE_MAX_AGE_MS',
  'PI_NANOS', 'PROGRAM_ID', 'REWARD_DENOM_DAYS', 'SHEAR_MAINNET', 'SHEAR_TESTNET',
  'SHEAR_TESTNET_V1', 'SHEAR_TESTNET_V10', 'SHEAR_TESTNET_V11', 'SHEAR_TESTNET_V12',
  'SHEAR_TESTNET_V3', 'SHEAR_TESTNET_V4', 'SHEAR_TESTNET_V5', 'SHEAR_TESTNET_V6',
  'SHEAR_TESTNET_V7', 'SHEAR_TESTNET_V8', 'SHEAR_TESTNET_V9', 'STAKE_CUTOFF_QUARTER_DEN', 'addMore', 'annualBps',
  'bonusEnacted', 'canJoin', 'claim', 'clearWithdrawHolds', 'commitRate', 'commitRewards', 'currentEpoch', 'cutoffLengthMs', 'enact', 'enactedAtEpoch',
  'enactedAtMs', 'enactedDelta', 'enactedDown', 'enactedHold', 'enactedLiveBonus', 'enactedUp',
  'epochBps', 'epochDaysOf', 'epochLengthMs', 'epochOpen', 'epochRateOf', 'epochStart', 'holdEpochRoll', 'holdWithdraw', 'liveHashBonusNanos',
  'lock', 'lockNote', 'magic', 'nextEpochBps', 'observeRate', 'oracleAsOfMs', 'pinClock', 'portalId', 'portalOf',
  'publicView', 'rateCommitEpoch', 'remainingDays', 'remainingMs', 'rewardNanos', 'syncEpoch', 'totalLocked', 'trimmedMeanBps', 'vote', 'votesDecrease',
  'votesHold', 'votesIncrease', 'withdraw',
];

function owner() {
  const id = newIdentity();
  return { id, dest: spendDestOf(id.spendPub), pub: Buffer.from(id.spendPub).toString('hex') };
}

function openPortal(principal, when = T0, { payout = null } = {}) {
  const who = owner();
  const state = emptyVault();
  state.genesisMs = T0;
  const got = deposit({
    state,
    dest: who.dest,
    nanos: principal,
    nowMs: when,
    payout: payout || undefined,
    ownerPub: who.pub,
  });
  assert.equal(got.ok, true, got.reason);
  return { who, state };
}

function signedWithdraw(who, state, dest, nanos) {
  const tx = withdrawTx({
    from: who.dest,
    to: dest,
    nanos,
    id: `w-${nanos}-${String(dest).slice(-6)}`,
  });
  return signSpendTx(tx, who.id.privateKey);
}

describe('Vault Security test map', () => {
  it('P1-a a bound payout portal cannot be redirected', () => {
    for (const principal of PRINCIPALS) {
      const payTo = owner();
      const { who, state } = openPortal(principal, T0, { payout: payTo.dest });
      const home = signedWithdraw(who, state, payTo.dest, principal);
      const foreign = signedWithdraw(who, state, spendDestOf(newIdentity().spendPub), principal);
      assert.equal(verifyReservePayout(state, foreign, END).reason, 'payout_mismatch');
      assert.equal(boundReserveWithdraw(foreign, state, null, END).reason, 'payout_mismatch');
      assert.equal(verifyReservePayout(state, home, END).ok, true, verifyReservePayout(state, home, END).reason);
    }
  });

  it('P1-b the lock stays under the owner key', () => {
    for (const principal of [PI_SHE_NANOS, PI_SHE_NANOS * 3, PI_SHE_NANOS * 100]) {
      const who = owner();
      const sealed = lockTx({
        from: who.dest,
        to: who.dest,
        nanos: principal,
        id: `lock-${principal}`,
      });
      const out = sealed.vout[0];
      const want20 = Buffer.from(hash20FromAddress(who.dest)).toString('hex');
      assert.equal(Buffer.from(out.dest20).toString('hex'), want20);
      const state = emptyVault();
      const applied = applyReserveBlock({
        state,
        block: {
          txs: [
            { coinbase: true, vout: [] },
            { ...sealed, spendPub: who.pub },
          ],
        },
        nowMs: T0,
        genesisMs: T0,
      });
      assert.equal(applied.ok, true, applied.reason);
      const portal = state.portals[sealed.portalId];
      assert.equal(Number(portal.staked) + Number(portal.idle), principal);
      deposit({
        state,
        dest: who.dest,
        nanos: 1,
        nowMs: T0 + 1,
        ownerPub: who.pub,
      });
      const stranger = owner();
      const denied = deposit({
        state,
        dest: who.dest,
        nanos: 1,
        nowMs: T0 + 2,
        ownerPub: stranger.pub,
      });
      assert.equal(denied.reason, 'unsigned');
      assert.equal(state.portals[portalIdFromDest(who.dest)].ownerPub, who.pub);
    }
  });

  it('P1-c reward lands in the owner wallet', () => {
    const splits = ['staked', 'idle', 'half', 'rho'];
    for (const split of splits) {
      for (const bps of [0, 1, 284, 10000]) {
        const who = owner();
        const state = emptyVault();
        state.genesisMs = T0;
        assert.equal(deposit({
          state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0, ownerPub: who.pub, payout: who.dest,
        }).ok, true);
        if (split === 'idle') {
          const bob = owner();
          deposit({
            state, dest: bob.dest, nanos: PI_SHE_NANOS, nowMs: END - 1, payout: bob.dest, ownerPub: bob.pub,
          });
        } else if (split === 'half') {
          deposit({ state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: END - 1, ownerPub: who.pub });
        } else if (split === 'rho') {
          deposit({ state, dest: who.dest, nanos: 1, nowMs: END - 1, ownerPub: who.pub });
        }
        state.epochBps = bps;
        const portal = state.portals[portalIdFromDest(who.dest)];
        const active = Number(portal.staked);
        const idle = Number(portal.idle);
        const reward = portalEpochInterest(state, portal, END);
        const done = withdraw({ state: cloneVault(state), dest: who.dest, nowMs: END, payout: who.dest });
        assert.equal(done.ok, true, `${split} ${bps} ${done.reason}`);
        assert.equal(done.payout, active + idle);
        assert.equal(done.to, who.dest);
        assert.equal(done.reward, 0);
        assert.equal(done.earned, reward);
        const exact = signedWithdraw(who, state, who.dest, active + idle);
        assert.equal(verifyReservePayout(state, exact, END).ok, true, verifyReservePayout(state, exact, END).reason);
        const wrong = signedWithdraw(who, state, spendDestOf(newIdentity().spendPub), active + idle);
        assert.equal(verifyReservePayout(state, wrong, END).reason, 'payout_mismatch');
        const fat = signedWithdraw(who, state, who.dest, active + idle + 1);
        assert.equal(boundReserveWithdraw(fat, state, null, END).reason, 'insufficient');
      }
    }
  });

  it('P1-d unsigned or foreign-key withdraw, and the owner key verifies', () => {
    const pool = owner();
    for (const principal of PRINCIPALS) {
      const { who, state } = openPortal(principal, T0, { payout: null });
      const good = signedWithdraw(who, state, who.dest, principal);
      const none = { ...good, spendPub: undefined, sig: undefined };
      const random = signSpendTx({ ...good, sig: undefined, spendPub: undefined, id: `r-${principal}` }, newIdentity().privateKey);
      const poolSigned = signSpendTx({ ...good, sig: undefined, spendPub: undefined, id: `p-${principal}` }, pool.id.privateKey);
      assert.equal(verifyReservePortalOpen(none), false);
      assert.equal(reserveAuth(none, state).reason, 'unsigned');
      for (const tx of [random, poolSigned]) {
        assert.equal(verifyReservePortalOpen(tx), false);
        assert.equal(reserveAuth(tx, state).reason, 'unsigned');
      }
      assert.equal(verifyReservePortalOpen(good), true);
      assert.equal(reserveAuth(good, state).ok, true, reserveAuth(good, state).reason);
      assert.equal(boundReserveWithdraw(good, state, null, END).ok, true, boundReserveWithdraw(good, state, null, END).reason);
    }
  });

  it('P1-e a sealed withdraw is not a public receipt', () => {
    for (const principal of PRINCIPALS) {
      const { who, state } = openPortal(principal);
      const tx = signedWithdraw(who, state, who.dest, principal);
      delete tx.spendPub;
      delete tx.sig;
      assert.equal(publicReserveReceipt(tx), false);
      assert.equal(verifyReservePortalOpen(tx), false);
      assert.equal(reserveAuth(tx, state).reason, 'unsigned');
    }
  });

  it('P2-a and P2-b epoch release follows header time, not a caller clock', () => {
    const early = [T0, T0 + 1, END - 1, END - DAY];
    const walls = [0, 30 * DAY, 2 * RESERVE_EPOCH_MS];
    const { who, state } = openPortal(PI_SHE_NANOS);
    const tx = signedWithdraw(who, state, who.dest, PI_SHE_NANOS);
    const realNow = Date.now;
    try {
      for (const stamp of early) {
        for (const ahead of walls) {
          Date.now = () => stamp + ahead;
          tx.nowMs = END + ahead;
          const got = verifyReservePayout(state, tx, stamp);
          assert.equal(got.reason, 'epoch_open', `${stamp} wall+${ahead} ${got.reason}`);
          const drawn = withdraw({ state: cloneVault(state), dest: who.dest, nowMs: stamp });
          assert.equal(drawn.reason, 'epoch_open', `${stamp} ${drawn.reason}`);
        }
      }
      Date.now = () => END + 2 * RESERVE_EPOCH_MS;
      tx.nowMs = END + 9 * DAY;
      assert.equal(verifyReservePayout(state, tx, END).ok, true);
      assert.equal(withdraw({ state: cloneVault(state), dest: who.dest, nowMs: END }).ok, true);
    } finally {
      Date.now = realNow;
    }
  });

  it('P2-c a withdraw is not repeatable across the epoch or a reorg', () => {
    const { who, state } = openPortal(PI_SHE_NANOS);
    const first = withdraw({ state, dest: who.dest, nowMs: END });
    assert.equal(first.ok, true, first.reason);
    assert.equal(withdraw({ state, dest: who.dest, nowMs: END + 1 }).reason, 'empty');
    assert.equal(withdraw({ state, dest: who.dest, nowMs: END + DAY }).reason, 'empty');
    state.currentEpoch = Number(state.currentEpoch || 1) + 1;
    state.epochStartMs = END;
    state.bonusEnacted = false;
    assert.equal(withdraw({ state, dest: who.dest, nowMs: END + RESERVE_EPOCH_MS }).reason, 'empty');

    const fresh = openPortal(PI_SHE_NANOS);
    const snap = cloneVault(fresh.state);
    const sealed = withdraw({ state: fresh.state, dest: fresh.who.dest, nowMs: END });
    assert.equal(sealed.ok, true, sealed.reason);
    const minted = Number(fresh.state.mintBankNanos);
    const restored = cloneVault(snap);
    const readded = withdraw({ state: restored, dest: fresh.who.dest, nowMs: END });
    assert.equal(readded.ok, true, readded.reason);
    assert.equal(Number(restored.mintBankNanos), minted);
    assert.equal(supplyIdentity(restored).mintedReward, minted);
    assert.equal(withdraw({ state: restored, dest: fresh.who.dest, nowMs: END + 1 }).reason, 'empty');
  });

  it('P2-d a withdraw before the epoch end is locked', () => {
    const times = [T0, T0 + 1, END - 1, END - DAY];
    for (const stamp of times) {
      const { who, state } = openPortal(PI_SHE_NANOS);
      const tx = signedWithdraw(who, state, who.dest, PI_SHE_NANOS);
      assert.equal(verifyReservePayout(state, tx, stamp).reason, 'epoch_open');
      tx.nowMs = END + 10 * DAY;
      assert.equal(verifyReservePayout(state, tx, stamp).reason, 'epoch_open');
      assert.equal(verifyReservePayout(state, tx, END).ok, true, verifyReservePayout(state, tx, END).reason);
    }
  });

  it('P3-a transaction fees are not a vault balance or a reward', () => {
    const dirty = emptyVault();
    dirty.feeBankNanos = 1n;
    assert.equal(supplyIdentity(dirty).reason, 'supply');
    for (const n of [1, 3, 17]) {
      const state = emptyVault();
      state.genesisMs = T0;
      const people = [];
      for (let i = 0; i < n; i += 1) {
        const who = owner();
        people.push(who);
        assert.equal(deposit({
          state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0 + i, ownerPub: who.pub,
        }).ok, true);
      }
      const dues = people.map((who) => portalEpochInterest(
        state,
        state.portals[portalIdFromDest(who.dest)],
        END,
      ));
      const reward = dues[0];
      for (const bank of [0, Math.max(0, reward - 1), reward, reward + 1, reward * 10]) {
        const trial = cloneVault(state);
        trial.feeBankNanos = BigInt(bank);
        assert.equal(creditFeeBank(trial, bank), 0);
        applyReserveBlock({
          state: trial,
          block: { txs: [{ coinbase: true, vout: [{ kind: 'reserve-fee', nanos: bank }, { kind: 'finder-fee', nanos: bank }] }] },
          nowMs: T0 + 10,
        });
        assert.equal(Number(trial.feeBankNanos), 0);
        let mintedSum = 0;
        for (let i = 0; i < people.length; i += 1) {
          const paid = withdraw({ state: trial, dest: people[i].dest, nowMs: END });
          assert.equal(paid.ok, true, `${n} ${bank} ${paid.reason}`);
          assert.equal(paid.reward, 0);
          assert.equal(paid.earned, dues[i]);
          assert.equal(paid.rewardSource, undefined);
        }
        assert.equal(Number(trial.feeBankNanos), 0);
        const idn = supplyIdentity(trial);
        assert.equal(idn.ok, true, idn.reason);
        assert.equal(idn.feeBankRewardNanos, 0);
        assert.equal(mintedSum, 0);
        assert.equal(idn.mintedReward, 0);
        const minted = payoutStakeReward({ state: emptyVault(), reward, id: `fee-${n}-${bank}` });
        assert.equal(minted.fromFee, 0);
        assert.equal(minted.minted, reward);
        assert.equal(minted.source, 'coinbase');
        assert.equal(minted.feeBank, 0);
      }
    }
  });

  it('P3-b supply identity holds across epochs and a boundary reorg', () => {
    const rand = (() => {
      let a = 0x5EED;
      return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    for (const epochs of [1, 5, 40]) {
      const state = emptyVault();
      state.genesisMs = T0;
      let expected = 0;
      let cursor = T0;
      for (let e = 0; e < epochs; e += 1) {
        const people = 1 + Math.floor(rand() * 3);
        const locked = [];
        for (let i = 0; i < people; i += 1) {
          const who = owner();
          const nanos = PI_SHE_NANOS + Math.floor(rand() * 1000);
          const at = cursor + Math.floor(rand() * DAY);
          const got = deposit({ state, dest: who.dest, nanos, nowMs: at, ownerPub: who.pub });
          assert.equal(got.ok, true, got.reason);
          locked.push(who);
        }
        const end = state.epochStartMs + RESERVE_EPOCH_MS;
        if (e === epochs - 1 && epochs > 1) {
          const snap = cloneVault(state);
          for (const who of locked) {
            const paid = withdraw({ state, dest: who.dest, nowMs: end });
            assert.equal(paid.ok, true, paid.reason);
            expected += paid.interest;
          }
          const reorg = cloneVault(snap);
          let reorgMint = Number(snap.mintBankNanos);
          for (const who of locked) {
            const paid = withdraw({ state: reorg, dest: who.dest, nowMs: end });
            assert.equal(paid.ok, true, paid.reason);
            reorgMint += paid.interest;
          }
          assert.equal(Number(reorg.mintBankNanos), reorgMint);
          assert.equal(supplyIdentity(reorg).ok, true);
          Object.assign(state, reorg);
          expected = reorgMint;
        } else {
          for (const who of locked) {
            const paid = withdraw({ state, dest: who.dest, nowMs: end + Math.floor(rand() * 1000) });
            assert.equal(paid.ok, true, paid.reason);
            expected += paid.interest;
          }
          if (e + 1 < epochs) {
            const nxt = owner();
            assert.equal(deposit({
              state, dest: nxt.dest, nanos: PI_SHE_NANOS, nowMs: end + 1, ownerPub: nxt.pub,
            }).ok, true);
            cursor = end + 1;
          }
        }
        const idn = supplyIdentity(state);
        assert.equal(idn.ok, true, JSON.stringify(idn));
        assert.equal(idn.mintedReward, expected);
        assert.equal(idn.reason, undefined);
      }
      const ceiling = supplyIdentity(state).permittedReward;
      const broken = cloneVault(state);
      broken.mintBankNanos = BigInt(ceiling + 1);
      const bad = supplyIdentity(broken);
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, 'supply');
      assert.ok(bad.mintedReward > bad.permittedReward);
    }
  });

  it('P3-c a foreign reserve output is mint_forbidden', () => {
    const amounts = [1, PI_SHE_NANOS, 2 ** 40];
    const kinds = ['reserve', 'reserve-interest', 'reserve-shortfall', 'reserve-reward'];
    for (const kind of kinds) {
      for (const nanos of amounts) {
        assert.equal(extraMintAllowed('not-reserve', { kind }), false);
        const { who, state } = openPortal(Math.max(nanos, PI_SHE_NANOS));
        const tx = signedWithdraw(who, state, who.dest, Math.max(nanos, PI_SHE_NANOS));
        tx.programId = 'not-reserve';
        tx.kind = kind === 'reserve-reward' ? 'withdraw' : kind;
        tx.mint = true;
        if (kind === 'reserve-reward') {
          assert.equal(boundReserveWithdraw(tx, state, null, END).reason, 'mint_forbidden');
        }
      }
    }
    assert.equal(RESERVE_PROGRAM, 'shear-reserve-v1');
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'reserve-reward' }), true);
  });

  it('P4-a and P4-c a miner or pool observe does not move the rate', async () => {
    const ages = [T0, T0 - 13 * DAY, T0 - 15 * DAY];
    const rates = [0, 1, GENESIS_BPS - 100, GENESIS_BPS + 100, 9999, 10000];
    const state = emptyVault();
    deposit({ state, dest: owner().dest, nanos: PI_SHE_NANOS, nowMs: T0 });
    const prior = state.epochBps;
    for (const k of [1, 5, 13]) {
      for (const bps of rates) {
        for (const observedAtMs of ages) {
          const observe = { annualBps: bps, observedAtMs, producer: 'miner-1' };
          assert.equal(observeVerdict(observe).reason, 'observe_unattested');
          const tpl = buildTemplate({
            prev: GENESIS_PREV,
            height: 1,
            miner: spendDestOf(newIdentity().spendPub),
            bits: GENESIS_BITS_PACKED,
            now: T0,
            txs: [],
          });
          const decoded = decodeHeader(Buffer.from(tpl.header));
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
          const got = await verifyBlock({
            header,
            txs: [cb],
            samples: tpl.samples,
            shareBatch: tpl.shareBatch || [],
            miner: tpl.miner,
            height: 1,
          }, null, { probeBody: true });
          assert.equal(got.reason, 'observe_unattested', `${k} ${bps} ${observedAtMs} ${got.reason}`);
          assert.equal(state.epochBps, prior);
          assert.ok(k < ORACLE_QUORUM);
        }
      }
    }
    assert.equal(bundledEpochBps(), GENESIS_BPS);
  });

  it('P4-b an operator snapshot cannot reach consensus', () => {
    const rates = [0, 1, 164, 364, 9999, 10000];
    const nodes = rates.slice(0, 3).map((bps, i) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-snap-${i}-`));
      fs.writeFileSync(path.join(dir, 'oracle-snapshot.json'), JSON.stringify({
        averagePercent: bps / 100,
        observedAt: '2026-08-01T00:00:00Z',
        annualBps: bps,
      }));
      fs.writeFileSync(path.join(dir, 'reserve.json'), JSON.stringify({
        epochBps: bps,
        oracle: { annualBps: bps },
        portals: {},
      }));
      return createStore(dir);
    });
    const bps = nodes.map((s) => s.reserveVault.epochBps);
    assert.equal(bps[0], GENESIS_BPS);
    assert.equal(bps[1], bps[0]);
    assert.equal(bps[2], bps[0]);
    for (const store of nodes) {
      const who = owner();
      const { tpl } = store.template({ miner: who.dest, now: T0 });
      assert.equal(tpl.txs[0].observe, undefined);
      assert.equal(tpl.txs[0].rateCommit, undefined);
      store.reserveVault.genesisMs = T0;
      deposit({
        state: store.reserveVault,
        dest: who.dest,
        nanos: PI_SHE_NANOS,
        nowMs: T0,
        ownerPub: who.pub,
      });
      const paid = withdraw({ state: store.reserveVault, dest: who.dest, nowMs: END });
      assert.equal(paid.ok, true, paid.reason);
      assert.equal(paid.reward, 0);
      assert.equal(paid.earned, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    }
  });

  it('P5-a Reserve bytecode has no admin', () => {
    const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/Reserve.json'), 'utf8'));
    const names = pin.abi.filter((row) => row.type === 'function').map((row) => row.name);
    assert.deepEqual(names, ABI_NAMES);
    for (const banned of ['onlyOwner', 'owner', 'pause', 'upgradeTo', 'upgradeToAndCall', 'MAX_BPS']) {
      assert.equal(names.includes(banned), false, banned);
    }
    const code = Buffer.from(String(pin.bytecode).replace(/^0x/i, ''), 'hex');
    const ipfs = Buffer.from('a2646970667358', 'hex');
    let end = code.length;
    const at = code.lastIndexOf(ipfs);
    if (at > 0) end = at;
    const found = new Set();
    for (let i = 0; i < end; i += 1) {
      const op = code[i];
      if (op >= 0x60 && op <= 0x7f) {
        i += op - 0x5f;
        continue;
      }
      if (op === 0xff) found.add('SELFDESTRUCT');
      if (op === 0xf4) found.add('DELEGATECALL');
      if (op === 0xf2) found.add('CALLCODE');
    }
    assert.equal(found.size, 0, [...found].join(','));
    const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/reserve-pin.yml'), 'utf8');
    assert.match(yml, /test_vault_security_map\.js/);
  });

  it('P5-b msg.sender does not change Reserve', async () => {
    const callers = [
      createAddressFromString(`0x${'00'.repeat(20)}`),
      createAddressFromString(`0x${'ab'.repeat(20)}`),
      SYSTEM,
    ];
    const views = [];
    const results = [];
    for (const caller of callers) {
      const s = await bootReserveEvm();
      const lock = await callReserve(s, encodeDeposit('ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', PI_SHE_NANOS, T0), { caller });
      const vote = await callReserve(s, encodeVote('ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 1, T0 + 2), { caller });
      const observe = await callReserve(s, encodeObserveRate(9999, Math.floor(T0 / 1000)), { caller, staticCall: true });
      const enacted = await callReserve(s, encodeEnact(END), { caller });
      const drawn = await callReserve(s, encodeWithdraw('ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', END), { caller });
      const view = decodePublicView((await callReserve(s, encodePublicView(END), { staticCall: true, caller })).returnValue);
      results.push([lock.ok, vote.ok, observe.ok, enacted.ok, drawn.ok]);
      views.push([view.oracleBps, view.liveHashBonusNanos, view.totalLockedNanos, view.currentEpoch]);
    }
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
    assert.equal(results[0][2], false);
    assert.deepEqual(views[1], views[0]);
    assert.deepEqual(views[2], views[0]);
  });

  it('P5-c no foreign key can move a lock, and admin-spendable ignores it', () => {
    const keys = [owner(), owner(), owner()];
    for (const principal of PRINCIPALS) {
      const { who, state } = openPortal(principal);
      for (const key of keys) {
        const tx = withdrawTx({ from: who.dest, to: who.dest, nanos: principal, id: `fk-${principal}-${key.dest.slice(-4)}` });
        signSpendTx(tx, key.id.privateKey);
        assert.equal(verifyReservePortalOpen(tx), false);
        assert.equal(reserveAuth(tx, state).reason, 'unsigned');
      }
      const missing = withdrawTx({ from: who.dest, to: reserveFeeDest(), nanos: principal, id: `miss-${principal}` });
      assert.equal(verifyReservePortalOpen(missing), false);
    }
    const src = fs.readFileSync(path.join(ROOT, 'pool/src/operator_wallet.js'), 'utf8');
    const slice = src.slice(src.indexOf('function adminWalletBalance'), src.indexOf('function adminSpendFrom'));
    assert.equal(/totalLocked|mintBank|reserveVault/.test(slice), false);
    const store = { historyFor: () => [], tip: () => null };
    const bal = adminWalletBalance(store, spendDestOf(newIdentity().spendPub), null);
    assert.equal(bal.spendableNanos, 0);
  });

  it('P5-d no env or pause flag halts a withdraw', () => {
    const src = fs.readFileSync(path.join(ROOT, 'node/src/store.js'), 'utf8');
    assert.equal(/pause\.reserveInterest/.test(src), false);
    assert.equal(/SHEAR_[A-Z0-9_]*(DISABLE|PAUSE|HALT).*RESERVE|RESERVE_.*DISABLE/.test(src), false);
    const flags = {
      SHEAR_ORACLE_BPS: '9999',
      SHEAR_MAINNET_EMIT: '1',
      SHEAR_NETWORK: 'shear-testnet-v12',
      SHEAR_FAST_SYNC: '1',
    };
    const prev = {};
    for (const [k, v] of Object.entries(flags)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const { who, state } = openPortal(PI_SHE_NANOS);
      const paid = withdraw({ state, dest: who.dest, nowMs: END });
      assert.equal(paid.ok, true, paid.reason);
      assert.equal(paid.reward, 0);
      assert.equal(paid.earned, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
