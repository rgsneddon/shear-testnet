import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity, spendDestOf } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
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
  enact,
  lockTx,
  withdrawTx,
  verifyReservePayout,
  boundReserveWithdraw,
  walletLockNotes,
  walletReleaseNotes,
  prematureLockSpend,
  foreignReserveMint,
  supplyIdentity,
  creditFeeBank,
  payoutStakeReward,
  portalIdFromDest,
  applyReserveBlock,
} from '../../crypto/reserve_vault.js';
import { reserveFeeDest } from '../../crypto/levy.js';
import { signSpendTx, publicReserveReceipt, verifyReservePortalOpen } from '../../crypto/spend.js';
import { GENESIS_PREV, buildTemplate, verifyBlock } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { adminWalletBalance } from '../../pool/src/admin.js';
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
  'BPS_STEP', 'CUTOFF_MS', 'DAY_MS', 'EPOCH_DAYS', 'EPOCH_DAYS_MAINNET', 'EPOCH_DAYS_TESTNET',
  'EPOCH_MS', 'GENESIS_BONUS', 'GENESIS_BPS', 'JOIN_CUTOFF_DAYS', 'MAX_BPS', 'ORACLE_MAX_AGE_MS',
  'PI_NANOS', 'PROGRAM_ID', 'REWARD_DENOM_DAYS', 'SHEAR_MAINNET', 'SHEAR_TESTNET',
  'SHEAR_TESTNET_V1', 'SHEAR_TESTNET_V10', 'SHEAR_TESTNET_V11', 'SHEAR_TESTNET_V12',
  'SHEAR_TESTNET_V3', 'SHEAR_TESTNET_V4', 'SHEAR_TESTNET_V5', 'SHEAR_TESTNET_V6',
  'SHEAR_TESTNET_V7', 'SHEAR_TESTNET_V8', 'SHEAR_TESTNET_V9', 'addMore', 'annualBps',
  'bonusEnacted', 'canJoin', 'currentEpoch', 'cutoffLengthMs', 'enact', 'enactedAtEpoch',
  'enactedAtMs', 'enactedDelta', 'enactedDown', 'enactedHold', 'enactedLiveBonus', 'enactedUp',
  'epochBps', 'epochDaysOf', 'epochLengthMs', 'epochOpen', 'epochStart', 'liveHashBonusNanos',
  'lock', 'magic', 'nextEpochBps', 'observeRate', 'oracleAsOfMs', 'portalId', 'portalOf',
  'publicView', 'remainingDays', 'remainingMs', 'totalLocked', 'vote', 'votesDecrease',
  'votesHold', 'votesIncrease', 'withdraw',
];

function owner() {
  const id = newIdentity();
  return { id, dest: spendDestOf(id.spendPub) };
}

function sign(tx, id, nonce) {
  if (nonce != null) tx.nonce = nonce;
  return signSpendTx(tx, id.privateKey);
}

function unbound(principal, when = T0) {
  const who = owner();
  const state = emptyVault();
  const got = deposit({
    state,
    dest: who.dest,
    nanos: principal,
    nowMs: when,
    payout: false,
    spendPub: who.id.spendPub,
  });
  assert.equal(got.ok, true, got.reason);
  return { who, state, note: got.note };
}

function boundLock(principal, when = T0) {
  const who = owner();
  const state = emptyVault();
  const got = deposit({
    state,
    dest: who.dest,
    nanos: principal,
    nowMs: when,
    spendPub: who.id.spendPub,
  });
  assert.equal(got.ok, true, got.reason);
  return { who, state, note: got.note };
}

function withdrawFor(who, state, dest, { principal, reward, when = END } = {}) {
  const active = Number(state.portals[portalIdFromDest(who.dest)]?.staked || principal || 0);
  const idle = Number(state.portals[portalIdFromDest(who.dest)]?.idle || 0);
  const p = principal != null ? principal : active + idle;
  const r = reward != null ? reward : interestNanos(active, state.epochBps);
  const note = (state.portals[portalIdFromDest(who.dest)]?.locks || [])[0];
  const tx = withdrawTx({
    from: who.dest,
    to: dest,
    nanos: p + r,
    principal: p,
    reward: r,
    id: `w-${p}-${dest.slice(-6)}`,
    lockNote: note,
    spendPub: who.id.spendPub,
  });
  sign(tx, who.id);
  return tx;
}

function asBlock(tx, now, extra = {}) {
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: extra.miner || spendDestOf(newIdentity().spendPub),
    bits: GENESIS_BITS_PACKED,
    now,
    txs: tx ? [tx] : [],
  });
  if (extra.observe) {
    tpl.txs[0].observe = extra.observe;
    const decoded = decodeHeader(Buffer.from(tpl.header));
    const { digestTx } = extra;
    void digestTx;
  }
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

async function verifyAt(tx, now, opts = {}) {
  const block = asBlock(tx, now);
  return verifyBlock(block, null, {
    trustedPowHash: Buffer.alloc(32),
    skipSharePow: true,
    reserveState: opts.reserveState || null,
    committedBps: opts.committedBps,
    evmHistory: opts.evmHistory,
    nowMs: now,
  });
}

describe('Vault Security test map', () => {
  it('P1-a unset payout cannot be redirected', async () => {
    const fresh = spendDestOf(newIdentity().spendPub);
    const pool = spendDestOf(newIdentity().spendPub);
    const sinks = [fresh, pool, reserveFeeDest()];
    for (const principal of PRINCIPALS) {
      for (const dest of sinks) {
        const { who, state } = unbound(principal);
        const tx = withdrawFor(who, state, dest, { principal, reward: 0 });
        const pay = verifyReservePayout(state, tx, END);
        assert.equal(pay.ok, false, `${principal} ${dest}`);
        assert.equal(pay.reason, 'no_payout');
        const bound = boundReserveWithdraw(state, tx);
        assert.equal(bound.reason, 'no_payout');
        const block = await verifyAt(tx, END, { reserveState: state });
        assert.equal(block.ok, false, block.reason);
        assert.equal(block.reason, 'no_payout');
      }
      const stripped = lockTx({
        from: spendDestOf(newIdentity().spendPub),
        to: spendDestOf(newIdentity().spendPub),
        nanos: principal,
        id: `strip-${principal}`,
        bindPayout: false,
      });
      delete stripped.payoutPortalId;
      assert.equal(stripped.payoutPortalId, undefined);
      const state = emptyVault();
      const applied = applyReserveBlock({ state, block: { txs: [stripped] }, nowMs: T0 });
      assert.equal(applied.some((r) => r.action === 'lock' && r.ok), true, JSON.stringify(applied));
      const pid = stripped.portalId;
      assert.equal(state.portals[pid].payout ?? null, null);
      assert.equal(state.portals[pid].payoutPortalId ?? null, null);
    }
  });

  it('P1-b lock note stays under the user key', () => {
    const positions = [T0, T0 + Math.floor(RESERVE_EPOCH_MS / 2), END - 1];
    for (const principal of [PI_SHE_NANOS, PI_SHE_NANOS * 3, PI_SHE_NANOS * 100]) {
      for (const when of positions) {
        const who = owner();
        const opener = when === T0 ? who : owner();
        const state = emptyVault();
        if (when !== T0) {
          assert.equal(deposit({
            state, dest: opener.dest, nanos: PI_SHE_NANOS, nowMs: T0, spendPub: opener.id.spendPub,
          }).ok, true);
        }
        const sealed = lockTx({
          from: who.dest,
          to: who.dest,
          nanos: principal,
          id: `lock-${principal}-${when}`,
          unlockMs: END,
          spendPub: who.id.spendPub,
        });
        const out = sealed.vout[0];
        const want20 = Buffer.from(out.dest20).toString('hex');
        assert.equal(want20.length, 40);
        assert.equal(String(out.spendPub), Buffer.from(who.id.spendPub).toString('hex'));
        applyReserveBlock({
          state,
          block: { txs: [{ coinbase: true, vout: [] }, sealed] },
          nowMs: when,
        });
        const listed = walletLockNotes(state, { dest: who.dest, spendPub: who.id.spendPub });
        assert.ok(listed.length >= 1);
        const row = listed.find((n) => n.nanos === principal);
        assert.ok(row, `missing note ${principal}`);
        assert.equal(row.timeLocked, true);
        assert.equal(row.spendable, false);
        assert.equal(row.dest20, want20);
        assert.equal(row.spendPub, Buffer.from(who.id.spendPub).toString('hex'));
        const wd = withdrawTx({
          from: who.dest,
          to: who.dest,
          nanos: principal,
          principal,
          reward: 0,
          id: `vin-${principal}`,
          lockNote: { ...out, id: row.id, owner: who.dest },
          spendPub: who.id.spendPub,
        });
        assert.equal(Buffer.from(wd.vin[0].commit).equals(Buffer.from(out.commit)), true);
        assert.equal(wd.vin[0].id, row.id);
      }
    }
  });

  it('P1-c reward lands in the owner wallet', async () => {
    const splits = ['staked', 'idle', 'half', 'rho'];
    for (const split of splits) {
      for (const bps of [0, 1, 264, 10000]) {
        const who = owner();
        const state = emptyVault();
        const open = deposit({
          state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0, spendPub: who.id.spendPub,
        });
        assert.equal(open.ok, true, open.reason);
        if (split === 'idle') {
          const bob = owner();
          deposit({ state, dest: bob.dest, nanos: PI_SHE_NANOS, nowMs: END - 1, payout: bob.dest, spendPub: bob.id.spendPub });
        } else if (split === 'half') {
          deposit({ state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: END - 1, spendPub: who.id.spendPub });
        } else if (split === 'rho') {
          deposit({ state, dest: who.dest, nanos: 1, nowMs: END - 1, spendPub: who.id.spendPub });
        }
        state.epochBps = bps;
        const portal = state.portals[portalIdFromDest(who.dest)];
        const active = Number(portal.staked);
        const idle = Number(portal.idle);
        const reward = interestNanos(active, bps);
        const done = withdraw({ state: cloneVault(state), dest: who.dest, nowMs: END, payout: who.dest });
        assert.equal(done.ok, true, `${split} ${bps} ${done.reason}`);
        assert.equal(done.payout, active + idle + reward);
        assert.equal(done.to, who.dest);
        assert.equal(done.reward, reward);
        const tx = withdrawFor(who, state, who.dest, { principal: active + idle, reward });
        const scanned = walletReleaseNotes(tx, { dest: who.dest });
        assert.equal(scanned.reduce((a, n) => a + n.nanos, 0), active + idle + reward);
        assert.ok(scanned.every((n) => n.spendable === true));
        const wrong = withdrawFor(who, state, spendDestOf(newIdentity().spendPub), { principal: active + idle, reward });
        assert.equal(verifyReservePayout(state, wrong, END).reason, 'payout_mismatch');
        const fat = withdrawFor(who, state, who.dest, { principal: active + idle, reward: reward + 1 });
        const fatGot = await verifyAt(fat, END, { reserveState: state, committedBps: bps });
        assert.equal(fatGot.reason, 'mint_amount', fatGot.reason);
      }
    }
  });

  it('P1-d unsigned or foreign-key withdraw, and the owner key verifies', async () => {
    const pool = owner();
    for (const principal of PRINCIPALS) {
      const { who, state } = boundLock(principal);
      const good = withdrawFor(who, state, who.dest, { principal, reward: interestNanos(principal, state.epochBps) });
      const none = { ...good, spendPub: undefined, sig: undefined };
      const random = sign({ ...good, sig: undefined, spendPub: undefined, id: `r-${principal}` }, newIdentity());
      const poolSigned = sign({ ...good, sig: undefined, spendPub: undefined, id: `p-${principal}` }, pool.id);
      const mutated = sign({ ...good, id: `n-${principal}` }, who.id, 1);
      mutated.nonce = 2;
      for (const tx of [none, random, poolSigned, mutated]) {
        assert.equal(verifyReservePortalOpen(tx), false);
        const got = await verifyAt(tx, END, { reserveState: state, committedBps: state.epochBps });
        assert.equal(got.ok, false, got.reason);
        assert.equal(got.reason, 'unsigned');
      }
    }
    const { who, state, note } = boundLock(PI_SHE_NANOS);
    const reward = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const tx = withdrawFor(who, state, who.dest, { principal: PI_SHE_NANOS, reward });
    const lock = lockTx({
      from: who.dest,
      to: who.dest,
      nanos: PI_SHE_NANOS,
      id: 'evm-lock',
      spendPub: who.id.spendPub,
    });
    const header = encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: T0,
      bits: GENESIS_BITS_PACKED,
    });
    const got = await verifyAt(tx, END, {
      reserveState: state,
      committedBps: state.epochBps,
      evmHistory: [{ header, txs: [{ coinbase: true, vout: [] }, lock] }],
    });
    assert.equal(got.ok, true, `${got.reason || ''} ${got.error || ''} ${note.id}`);
  });

  it('P1-e a public withdraw receipt is unsigned', async () => {
    for (const principal of PRINCIPALS) {
      const { who, state } = boundLock(principal);
      const tx = withdrawFor(who, state, who.dest, { principal, reward: 0 });
      delete tx.spendPub;
      delete tx.sig;
      tx.vout[0].dest20 = tx.vout[0].dest20 || Buffer.alloc(20, 3);
      assert.equal(publicReserveReceipt(tx), false);
      assert.equal(verifyReservePortalOpen(tx), false);
      const got = await verifyAt(tx, END, { reserveState: state });
      assert.equal(got.ok, false);
      assert.equal(got.reason, 'unsigned');
    }
  });

  it('P2-a and P2-b epoch release follows header time, not a caller clock', async () => {
    const early = [T0, T0 + 1, END - 1, END - DAY];
    const walls = [0, 30 * DAY, 2 * RESERVE_EPOCH_MS];
    const { who, state } = boundLock(PI_SHE_NANOS);
    const tx = withdrawFor(who, state, who.dest);
    const realNow = Date.now;
    try {
      for (const stamp of early) {
        for (const ahead of walls) {
          Date.now = () => stamp + ahead;
          tx.nowMs = END + ahead;
          const got = await verifyAt(tx, stamp, { reserveState: state, committedBps: state.epochBps });
          assert.equal(got.reason, 'epoch_open', `${stamp} wall+${ahead} ${got.reason}`);
        }
      }
      Date.now = () => END + 2 * RESERVE_EPOCH_MS;
      tx.nowMs = END + 9 * DAY;
      const lock = lockTx({
        from: who.dest,
        to: who.dest,
        nanos: PI_SHE_NANOS,
        id: 'p2-lock',
        spendPub: who.id.spendPub,
      });
      const header = encodeHeader({
        prevBlockHash: Buffer.alloc(32),
        merkleRoot: Buffer.alloc(32),
        continuityRoot: Buffer.alloc(32),
        timestamp: T0,
        bits: GENESIS_BITS_PACKED,
      });
      const evmHistory = [{ header, txs: [{ coinbase: true, vout: [] }, lock] }];
      const open = await verifyAt(tx, END, { reserveState: state, committedBps: state.epochBps, evmHistory });
      assert.equal(open.ok, true, `${open.reason || ''} ${open.error || ''}`);
      const just = await verifyAt(tx, END + 1, { reserveState: state, committedBps: state.epochBps, evmHistory });
      assert.equal(just.ok, true, `${just.reason || ''} ${just.error || ''}`);
    } finally {
      Date.now = realNow;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-clock-'));
    const store = createStore(dir);
    const miner = who.dest;
    const { tpl } = store.template({ miner, now: T0 + 1000 });
    const pow = Buffer.alloc(32, 0);
    pow[31] = 7;
    const appended = await Promise.resolve(store.append({
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      miner,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, { trustedPowHash: pow, skipSharePow: true }));
    assert.equal(appended.ok, true, appended.reason);
    const tipMs = Number(decodeHeader(Buffer.from(store.tip().header)).timestamp);
    deposit({
      state: store.reserveVault,
      dest: who.dest,
      nanos: PI_SHE_NANOS,
      nowMs: tipMs,
      spendPub: who.id.spendPub,
    });
    assert.ok(tipMs < store.reserveVault.epochStartMs + RESERVE_EPOCH_MS);
    const earlyTx = withdrawFor(who, store.reserveVault, who.dest);
    earlyTx.nowMs = tipMs + 10 * RESERVE_EPOCH_MS;
    Date.now = () => tipMs + 10 * RESERVE_EPOCH_MS;
    try {
      const mem = store.reservePayoutOnTip(earlyTx, END);
      assert.equal(mem.reason, 'epoch_open');
      const queued = store.queueTx(earlyTx);
      assert.equal(queued.reason, 'epoch_open');
    } finally {
      Date.now = realNow;
    }
  });

  it('P2-c a withdraw is not repeatable across the epoch or a reorg', () => {
    const { who, state } = boundLock(PI_SHE_NANOS);
    const reward = interestNanos(PI_SHE_NANOS, state.epochBps);
    const first = withdraw({ state, dest: who.dest, nowMs: END });
    assert.equal(first.ok, true, first.reason);
    const again = withdraw({ state, dest: who.dest, nowMs: END + 1 });
    assert.equal(again.reason, 'double_mint');
    const later = withdraw({ state, dest: who.dest, nowMs: END + DAY });
    assert.equal(later.reason, 'double_mint');
    state.currentEpoch = Number(state.currentEpoch || 1) + 1;
    state.epochStartMs = END;
    state.bonusEnacted = false;
    const next = withdraw({ state, dest: who.dest, nowMs: END + RESERVE_EPOCH_MS });
    assert.equal(next.reason, 'empty');

    const fresh = boundLock(PI_SHE_NANOS);
    const snap = cloneVault(fresh.state);
    const sealed = withdraw({ state: fresh.state, dest: fresh.who.dest, nowMs: END });
    assert.equal(sealed.ok, true, sealed.reason);
    const minted = Number(fresh.state.mintBankNanos);
    const restored = cloneVault(snap);
    const readded = withdraw({ state: restored, dest: fresh.who.dest, nowMs: END });
    assert.equal(readded.ok, true, readded.reason);
    assert.equal(Number(restored.mintBankNanos), minted);
    assert.equal(supplyIdentity(restored).mintedReward, minted);
    assert.equal(withdraw({ state: restored, dest: fresh.who.dest, nowMs: END + 1 }).reason, 'double_mint');
  });

  it('P2-d a lock note spend before the epoch end is locked', () => {
    const times = [T0, T0 + 1, END - 1, END - DAY];
    for (const stamp of times) {
      const { who, state, note } = boundLock(PI_SHE_NANOS);
      const tx = {
        kind: 'send',
        from: who.dest,
        to: who.dest,
        nanos: 1,
        vin: [{ address: who.dest, id: note.id, kind: 'lock', unlockMs: note.unlockMs }],
        vout: [{ address: who.dest, nanos: 1, kind: 'send' }],
      };
      assert.equal(prematureLockSpend(state, tx, stamp).reason, 'locked');
      assert.equal(prematureLockSpend(state, tx, END).ok, true);
      tx.nowMs = END + 10 * DAY;
      assert.equal(prematureLockSpend(state, tx, stamp).reason, 'locked');
    }
  });

  it('P3-a reserve-fee notes do not fund the reward', () => {
    const portals = [1, 3, 17];
    for (const n of portals) {
      const state = emptyVault();
      const people = [];
      for (let i = 0; i < n; i += 1) {
        const who = owner();
        people.push(who);
        assert.equal(deposit({
          state, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0 + i, spendPub: who.id.spendPub,
        }).ok, true);
      }
      const reward = interestNanos(PI_SHE_NANOS, state.epochBps);
      const banks = [0, Math.max(0, reward - 1), reward, reward + 1, reward * 10];
      for (const bank of banks) {
        const trial = cloneVault(state);
        if (bank > 0) creditFeeBank(trial, bank);
        applyReserveBlock({
          state: trial,
          block: { txs: [{ coinbase: true, vout: [{ kind: 'reserve-fee', nanos: bank }] }] },
          nowMs: T0 + 10,
        });
        const before = Number(trial.feeBankNanos);
        for (const who of people) {
          const paid = withdraw({ state: trial, dest: who.dest, nowMs: END });
          assert.equal(paid.ok, true, `${n} ${bank} ${paid.reason}`);
          assert.equal(paid.reward, reward);
          assert.equal(paid.rewardSource, 'coinbase');
        }
        assert.equal(Number(trial.feeBankNanos), before);
        const minted = payoutStakeReward({ state: emptyVault(), reward, id: `fee-${n}-${bank}` });
        assert.equal(minted.fromFee, 0);
        assert.equal(minted.minted, reward);
        assert.equal(minted.source, 'coinbase');
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
      let expected = 0;
      let cursor = T0;
      for (let e = 0; e < epochs; e += 1) {
        const people = 1 + Math.floor(rand() * 3);
        const locked = [];
        for (let i = 0; i < people; i += 1) {
          const who = owner();
          const nanos = PI_SHE_NANOS + Math.floor(rand() * 1000);
          const at = cursor + Math.floor(rand() * DAY);
          const got = deposit({ state, dest: who.dest, nanos, nowMs: at, spendPub: who.id.spendPub });
          assert.equal(got.ok, true, got.reason);
          locked.push(who);
        }
        const end = state.epochStartMs + RESERVE_EPOCH_MS;
        if (e === epochs - 1 && epochs > 1) {
          const snap = cloneVault(state);
          for (const who of locked) {
            const due = interestNanos(Number(state.portals[portalIdFromDest(who.dest)].staked), state.epochBps);
            const paid = withdraw({ state, dest: who.dest, nowMs: end });
            assert.equal(paid.ok, true, paid.reason);
            expected += due;
          }
          const reorg = cloneVault(snap);
          let reorgMint = Number(snap.mintBankNanos);
          for (const who of locked) {
            const due = interestNanos(Number(reorg.portals[portalIdFromDest(who.dest)].staked), reorg.epochBps);
            assert.equal(withdraw({ state: reorg, dest: who.dest, nowMs: end }).ok, true);
            reorgMint += due;
          }
          assert.equal(Number(reorg.mintBankNanos), reorgMint);
          assert.equal(supplyIdentity(reorg).ok, true);
          Object.assign(state, reorg);
          expected = reorgMint;
        } else {
          for (const who of locked) {
            const due = interestNanos(Number(state.portals[portalIdFromDest(who.dest)].staked), state.epochBps);
            const paid = withdraw({ state, dest: who.dest, nowMs: end + Math.floor(rand() * 1000) });
            assert.equal(paid.ok, true, paid.reason);
            expected += due;
          }
          if (e + 1 < epochs) {
            const nxt = owner();
            assert.equal(deposit({
              state, dest: nxt.dest, nanos: PI_SHE_NANOS, nowMs: end + 1, spendPub: nxt.id.spendPub,
            }).ok, true);
            cursor = end + 1;
          }
        }
        const idn = supplyIdentity(state);
        assert.equal(idn.ok, true, JSON.stringify(idn));
        assert.equal(idn.mintedReward, expected);
        assert.equal(idn.reason, undefined);
      }
      const broken = cloneVault(state);
      broken.mintBankNanos = BigInt(expected + 1);
      const bad = supplyIdentity(broken);
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, 'supply');
    }
  });

  it('P3-c a foreign reserve output is mint_forbidden', async () => {
    const amounts = [1, PI_SHE_NANOS, 2 ** 40];
    const kinds = ['reserve', 'reserve-interest', 'reserve-shortfall', 'reserve-reward'];
    const dest = spendDestOf(newIdentity().spendPub);
    for (const kind of kinds) {
      for (const nanos of amounts) {
        const tx = {
          id: `foreign-${kind}-${nanos}`,
          kind: 'send',
          programId: 'not-reserve',
          from: dest,
          to: dest,
          nanos,
          vin: [{ address: dest }],
          vout: [{ address: dest, nanos, kind }],
          fee: 0,
        };
        assert.equal(foreignReserveMint(tx).reason, 'mint_forbidden');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-foreign-'));
        const store = createStore(dir);
        assert.equal(store.queueTx(tx).reason, 'mint_forbidden');
        const got = await verifyAt(tx, T0, {});
        assert.equal(got.ok, false, got.reason);
        assert.equal(got.reason, 'mint_forbidden');
      }
    }
    assert.equal(RESERVE_PROGRAM, 'shear-reserve-v1');
  });

  it('P4-a and P4-c a miner or pool observe without quorum does not move the rate', async () => {
    const ages = [T0, T0 - 13 * DAY, T0 - 15 * DAY];
    const rates = [0, 1, GENESIS_BPS - 100, GENESIS_BPS + 100, 9999, 10000];
    const state = emptyVault();
    deposit({ state, dest: owner().dest, nanos: PI_SHE_NANOS, nowMs: T0 });
    const prior = state.epochBps;
    for (const k of [1, 5, 13]) {
      for (const bps of rates) {
        for (const observedAtMs of ages) {
          for (let n = 0; n < (k === 1 ? 1 : 1); n += 1) {
            const observe = { annualBps: bps, observedAtMs, producer: 'miner-1' };
            assert.equal(observeVerdict(observe).reason, 'oracle_quorum');
            const tpl = buildTemplate({
              prev: GENESIS_PREV,
              height: 1,
              miner: spendDestOf(newIdentity().spendPub),
              bits: GENESIS_BITS_PACKED,
              now: T0,
              txs: [],
            });
            const decoded = decodeHeader(Buffer.from(tpl.header));
            const { digestTx } = await import('../src/chain.js');
            const { merkleRoot } = await import('../../crypto/merkle.js');
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
            assert.equal(got.reason, 'oracle_quorum', `${k} ${bps} ${observedAtMs} ${got.reason}`);
            assert.equal(state.epochBps, prior);
            assert.ok(k < ORACLE_QUORUM);
          }
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
      deposit({ state: store.reserveVault, dest: who.dest, nanos: PI_SHE_NANOS, nowMs: T0 });
      const paid = withdraw({ state: store.reserveVault, dest: who.dest, nowMs: END });
      assert.equal(paid.ok, true, paid.reason);
      assert.equal(paid.reward, interestNanos(PI_SHE_NANOS, GENESIS_BPS));
    }
  });

  it('P5-a Reserve bytecode has no admin', () => {
    const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/Reserve.json'), 'utf8'));
    const names = pin.abi.filter((row) => row.type === 'function').map((row) => row.name);
    assert.deepEqual(names, ABI_NAMES);
    for (const banned of ['onlyOwner', 'owner', 'pause', 'upgradeTo', 'upgradeToAndCall']) {
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

  it('P5-c no foreign key can move a lock, and admin-spendable ignores it', async () => {
    const keys = [owner(), owner(), owner()];
    for (const principal of PRINCIPALS) {
      const { who, state } = boundLock(principal);
      for (const key of keys) {
        const tx = withdrawFor(who, state, who.dest, { principal, reward: 0 });
        delete tx.sig;
        delete tx.spendPub;
        sign(tx, key.id);
        assert.equal(verifyReservePortalOpen(tx), false);
        const got = await verifyAt(tx, END, { reserveState: state });
        assert.equal(got.reason, 'unsigned');
      }
      const missing = withdrawFor(who, state, reserveFeeDest(), { principal, reward: 0 });
      delete missing.sig;
      delete missing.spendPub;
      assert.equal(verifyReservePortalOpen(missing), false);
    }
    const store = {
      historyFor: () => [],
      tip: () => null,
    };
    const bal = adminWalletBalance(store, spendDestOf(newIdentity().spendPub), null);
    assert.equal(bal.spendableNanos, 0);
    const src = fs.readFileSync(path.join(ROOT, 'pool/src/admin.js'), 'utf8');
    assert.equal(/totalLocked|mintBank|reserveVault/.test(src.slice(src.indexOf('function adminWalletBalance'), src.indexOf('function adminSpendFrom'))), false);
    const deployDir = path.join(ROOT, 'deploy');
    if (fs.existsSync(deployDir)) {
      const files = fs.readdirSync(deployDir);
      assert.equal(files.some((name) => /private|secret|\.key$/i.test(name)), false);
    }
  });

  it('P5-d no env or pause flag halts a withdraw', async () => {
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
      const { who, state } = boundLock(PI_SHE_NANOS);
      const paid = withdraw({ state, dest: who.dest, nowMs: END });
      assert.equal(paid.ok, true, paid.reason);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-nopause-'));
      const store = createStore(dir);
      store.pause.reserveInterest = true;
      const tx = withdrawFor(who, state, who.dest);
      const queued = store.queueTx(tx);
      assert.notEqual(queued.reason, 'paused');
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
