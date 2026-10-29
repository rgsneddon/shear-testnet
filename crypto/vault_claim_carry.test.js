/**
 * F1 hardening. A reward claim lives only in a `reward-claim` tx. A withdraw,
 * lock, vote or leaf vote that carries a vaultProof, a nullifier or a
 * reward-claim output is refused as `claim_carried` on every path that runs
 * the vault: block apply, the mempool trial, and the supply replay that load
 * and reorg use. The EVM dispatcher refuses the same body. Each block's vault
 * mint-bank delta must equal the supply ledger's minted-interest delta.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BPS, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM, VAULT_FS1_ACTIVATION_HEIGHT } from './asert.js';
import { newIdentity, hash20FromAddress } from './address.js';
import { vaultDest } from './flow_sheet.js';
import { proveRange, pointBytes, pointFrom, randomScalar } from './note.js';
import { txDigestV3 } from './admit_v3.js';
import * as rv from './reserve_vault.js';
import * as evm from './reserve_evm.js';
import * as supply from '../node/src/supply.js';
import {
  proveLeafRetire,
  proveVaultReward,
  subtractUnlock,
  vaultLockNote,
} from './vault_reward_fs1.js';

const {
  appendVaultLockNote,
  applyReserveBlock,
  chainPeriodIndex,
  cloneVault,
  consensusUnlockPeriod,
  deposit,
  emptyVault,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  portalIdFromDest,
  provePrincipalOpen,
  rewardClaimTx,
  signWithdrawReward,
  trialReserveApply,
  withdrawSignedDest,
  withdrawTx,
} = rv;

const T0 = 1_700_000_000_000;
const span = RESERVE_EPOCH_MS;
const HEIGHT = VAULT_FS1_ACTIVATION_HEIGHT;
const big = (v) => BigInt(String(v ?? 0));

function dest20() {
  const id = newIdentity();
  const dest = vaultDest(id.address, { viewKey: id.viewKey });
  return { id, dest, d20: Buffer.from(hash20FromAddress(dest)) };
}

function proveClaim({ bps = GENESIS_BPS, remainMs = span } = {}) {
  const who = dest20();
  const proved = proveVaultReward({
    locks: [{ amount: PI_SHE_NANOS, index: 0 }],
    which: 0,
    rootEpoch: 0,
    earnEpoch: 0,
    bps,
    remainMs,
    span,
    dest20: who.d20,
  });
  assert.ok(proved, 'proof');
  return { who, proved, bps };
}

/** One claimable reward leaf and one indexed π leaf owned by `who`. */
function plantBook(who, row) {
  const state = emptyVault();
  state.genesisMs = T0;
  state.magic = MAGIC_TESTNET;
  // The epoch rate the claim was proved at, as a queued oracle commit.
  state.pendingRates = { 0: row.bps ?? GENESIS_BPS };
  const claimNote = vaultLockNote(row.proved.locks[0].amount, row.proved.locks[0].scalar, row.proved.locks[0].blind).note;
  assert.ok(appendVaultLockNote(state, claimNote));
  state.epochStartRoots = { 0: state.vaultLockRoot };
  state.epochRewardDue = { 0: String(row.proved.nanos) };
  const stamp = lockUnlockOf(state, T0);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const blind = randomScalar();
  const leaf = vaultLockNote(PI_SHE_NANOS, randomScalar(), blind, unlock);
  const got = deposit({
    state,
    dest: who.dest,
    nanos: PI_SHE_NANOS,
    nowMs: T0,
    ownerPub: who.id.spendPub.toString('hex'),
    commit: leaf.commit,
    rangeProof: proveRange(BigInt(PI_SHE_NANOS), blind),
    unlock,
    rangeCommit: pointBytes(subtractUnlock(pointFrom(leaf.commit), unlock)),
    piProof: proveRange(0n, blind),
  });
  assert.equal(got.ok, true, got.reason);
  assert.ok(appendVaultLockNote(state, leaf.note, {
    earnEpoch: Math.floor(Number(stamp.epoch) || 0),
    bornEpoch: chainPeriodIndex(state, T0),
    unlockEpoch: unlock,
    lockHeight: 1,
  }));
  state.vaultLockRoots = { 0: state.vaultLockRoot };
  return { state, leaf };
}

function claimOf(who, row) {
  const tx = rewardClaimTx({
    to: who.dest,
    vault: {
      blob: row.proved.blob,
      nullifier: row.proved.nullifier,
      nanos: row.proved.nanos,
      rootEpoch: 0,
      earnEpoch: 0,
      note: row.proved.note,
    },
  });
  tx.full = true;
  return tx;
}

/**
 * Indexed π withdraw. `carry` picks which claim parts ride on it:
 * proof, nullifier, out (the claim's own reward-claim vout). `bare` names
 * the portal on the output only (no tx-level portalId, from, to or payout).
 */
function withdrawWith(state, leaf, who, row, { carry = [], bare = false, id = 'wd' } = {}) {
  const stub = leafStubNanos(state, [leaf.commit.toString('hex')]);
  const tx = withdrawTx({ from: who.dest, to: who.dest, nanos: PI_SHE_NANOS + Number(stub), id });
  if (carry.includes('out')) tx.vout.push(claimOf(who, row).vout[0]);
  if (carry.includes('proof')) tx.vaultProof = row.proved.blob;
  if (carry.includes('nullifier')) tx.nullifier = row.proved.nullifier;
  if (carry.length) {
    tx.rootEpoch = 0;
    tx.earnEpoch = 0;
    tx.full = true;
  }
  if (bare) {
    delete tx.portalId;
    delete tx.payoutPortalId;
    delete tx.from;
    delete tx.to;
  }
  const portal = portalIdFromDest(who.dest);
  tx.principalProof = provePrincipalOpen(leaf.commit, PI_SHE_NANOS, leaf.blind, tx, portal, MAGIC_TESTNET, leaf.unlock);
  const nowMs = T0 + span;
  const retire = proveLeafRetire({
    scalar: leaf.scalar,
    epochs: leafEpochsToBurn(state, leaf.note.toString('hex'), chainPeriodIndex(state, nowMs)),
    leaf: leaf.note,
    txBind: txDigestV3(tx, MAGIC_TESTNET),
    unlockEpoch: chainPeriodIndex(state, nowMs),
    magic: MAGIC_TESTNET,
  });
  tx.retireProof = retire.proof;
  signWithdrawReward(tx, who.id.privateKey, {
    portalId: portal,
    nanos: PI_SHE_NANOS,
    dest: withdrawSignedDest(tx),
    state,
    nowMs,
  });
  return { tx, stub: big(stub) };
}

const blockOf = (state, tx) => ({
  height: HEIGHT,
  txs: [{ coinbase: true, vout: [], vaultLockRoot: state.vaultLockRoots['0'] }, tx],
});
const run = (state, tx) => applyReserveBlock({
  state,
  block: blockOf(state, tx),
  nowMs: T0 + span,
  height: HEIGHT,
  genesisMs: T0,
});
const counters = (s) => ({
  mintBank: big(s.mintBankNanos),
  permitted: big(s.rewardPermittedNanos),
  minted: Object.keys(s.mintedIds || {}).sort().join(','),
});

const CARRIES = [
  ['proof+nullifier+out, portal on the output only', ['proof', 'nullifier', 'out'], true],
  ['proof+nullifier+out, tx-level portal', ['proof', 'nullifier', 'out'], false],
  ['proof only, portal on the output only', ['proof'], true],
  ['nullifier only', ['nullifier'], false],
  ['reward-claim output only', ['out'], false],
];

describe('F1: a withdraw does not carry a reward claim', () => {
  for (const [name, carry, bare] of CARRIES) {
    it(`refuses ${name} on block apply, mempool trial and replay`, () => {
      const row = proveClaim();
      const { who } = row;
      const book = plantBook(who, row);
      const before = counters(book.state);
      const { tx } = withdrawWith(book.state, book.leaf, who, row, { carry, bare, id: `wd-${carry.join('-')}-${bare}` });

      // Block apply.
      const state = cloneVault(book.state);
      const got = run(state, tx);
      assert.deepEqual(
        { ok: got.ok, reason: got.reason },
        { ok: false, reason: 'claim_carried' },
        `block apply: mintBank moved by ${big(state.mintBankNanos) - before.mintBank}`,
      );
      assert.deepEqual(counters(state), before, 'no mint-bank, permitted or nullifier change');

      // Mempool trial on a clone.
      const trial = trialReserveApply({
        state: book.state,
        block: blockOf(book.state, tx),
        nowMs: T0 + span,
        height: HEIGHT,
        genesisMs: T0,
      });
      assert.deepEqual({ ok: trial.ok, reason: trial.reason }, { ok: false, reason: 'claim_carried' }, 'mempool trial');

      // Load / reorg replay through the supply module's vault step.
      const replay = supply.vaultAfterBlock(cloneVault(book.state), { ...blockOf(book.state, tx), time: T0 + span }, [], { magic: MAGIC_TESTNET });
      assert.equal(replay.ok, false, 'replay must refuse');

      // The same proof still claims normally in a reward-claim tx.
      const later = cloneVault(book.state);
      const paid = run(later, claimOf(who, row));
      assert.equal(paid.ok, true, paid.reason);
      assert.equal(big(later.mintBankNanos) - before.mintBank, big(row.proved.nanos));
    });
  }

  it('a plain withdraw still passes and mints only the arrival stub', () => {
    const row = proveClaim();
    const book = plantBook(row.who, row);
    const before = big(book.state.mintBankNanos);
    const { tx, stub } = withdrawWith(book.state, book.leaf, row.who, row, { id: 'wd-plain' });
    const got = run(book.state, tx);
    assert.equal(got.ok, true, got.reason);
    assert.equal(big(book.state.mintBankNanos) - before, stub);
  });

  it('refuses a lock, vote or leaf vote carrying claim fields', () => {
    const row = proveClaim();
    const rewardOut = claimOf(row.who, row).vout[0];
    for (const kind of ['lock', 'vote', 'leaf-vote']) {
      for (const extra of [{ vaultProof: row.proved.blob }, { nullifier: row.proved.nullifier }, { vout: [{ kind }, rewardOut] }]) {
        const state = emptyVault();
        state.genesisMs = T0;
        state.magic = MAGIC_TESTNET;
        const tx = { programId: RESERVE_PROGRAM, id: 'x', kind, vout: [{ kind }], ...extra };
        const got = applyReserveBlock({
          state,
          block: { height: HEIGHT, txs: [{ coinbase: true, vout: [] }, tx] },
          nowMs: T0 + span,
          height: HEIGHT,
          genesisMs: T0,
        });
        assert.deepEqual({ ok: got.ok, reason: got.reason }, { ok: false, reason: 'claim_carried' }, `${kind} ${Object.keys(extra)}`);
      }
    }
  });

  it('the EVM dispatcher refuses the same bodies before any call', async () => {
    const row = proveClaim();
    const book = plantBook(row.who, row);
    for (const [, carry, bare] of CARRIES) {
      const { tx } = withdrawWith(book.state, book.leaf, row.who, row, { carry, bare, id: `evm-${carry.join('-')}` });
      let got;
      try {
        got = await evm.executeReserveTx(null, tx, T0 + span, { blockHeight: HEIGHT });
      } catch (err) {
        got = { ok: 'threw', reason: String(err?.message || err).slice(0, 80) };
      }
      assert.deepEqual(got, { ok: false, reason: 'claim_carried' });
    }
  });
});

describe('F1: vault mint delta equals the supply ledger mint delta', () => {
  // Spread: the epoch rate moves the reward (a partial remain does not prove
  // on a full-epoch leaf). Each case is one claim block and one withdraw
  // block, checked against the ledger's own counters.
  const RATES = [1, GENESIS_BPS, GENESIS_BPS + 19, 500, 2000];
  const REMAINS = [span];
  it('honest claim and withdraw blocks: bank delta == ledger delta, over a spread', () => {
    const seen = new Set();
    for (const bps of RATES) {
      for (const remainMs of REMAINS) {
        const tag = `${bps}/${remainMs}`;
        const row = proveClaim({ bps, remainMs });
        const book = plantBook(row.who, row);
        const parent = cloneVault(book.state);
        const claimTx = claimOf(row.who, row);
        const claimBlock = blockOf(parent, claimTx);
        const ledgerClaim = rv.stakeRewardSupply(parent, claimBlock, T0 + span, HEIGHT);
        assert.equal(ledgerClaim.ok, true, `ledger claim ${tag}: ${ledgerClaim.reason}`);
        const afterClaim = cloneVault(parent);
        const claimed = run(afterClaim, claimTx);
        assert.equal(claimed.ok, true, `claim ${tag}: ${claimed.reason}`);
        const bankClaim = big(afterClaim.mintBankNanos) - big(parent.mintBankNanos);
        assert.equal(bankClaim, big(ledgerClaim.minted), `claim delta ${tag}`);
        assert.equal(bankClaim, big(row.proved.nanos), `claim reward ${tag}`);
        assert.equal(typeof supply.vaultMintDeltaRejected, 'function', 'invariant helper');
        assert.equal(supply.vaultMintDeltaRejected(parent, afterClaim, big(ledgerClaim.minted)), null);
        seen.add(String(bankClaim));

        // plantBook deposits directly; a mined note lock also books its π on
        // the note book, which the ledger's withdraw walk checks.
        afterClaim.openedLockNanos = big(afterClaim.openedLockNanos) + BigInt(PI_SHE_NANOS);
        const { tx, stub } = withdrawWith(afterClaim, book.leaf, row.who, row, { id: `wd-${tag}` });
        const wdBlock = { ...blockOf(afterClaim, tx), time: T0 + span };
        const ledgerWd = rv.blockWithdrawInterest(afterClaim, wdBlock, T0 + span, {});
        assert.equal(ledgerWd.ok, true, `ledger withdraw ${tag}: ${ledgerWd.reason}`);
        const afterWd = cloneVault(afterClaim);
        const wd = run(afterWd, tx);
        assert.equal(wd.ok, true, `withdraw ${tag}: ${wd.reason}`);
        const bankWd = big(afterWd.mintBankNanos) - big(afterClaim.mintBankNanos);
        assert.equal(bankWd, big(ledgerWd.nanos), `withdraw delta ${tag}`);
        assert.equal(bankWd, stub, `withdraw stub ${tag}`);
        assert.equal(supply.vaultMintDeltaRejected(afterClaim, afterWd, big(ledgerWd.nanos)), null);
      }
    }
    assert.ok(seen.size === RATES.length, `the spread must move the reward (saw ${seen.size} values)`);
  });

  it('a delta mismatch in either direction is refused as vault_mint', () => {
    assert.equal(typeof supply.vaultMintDeltaRejected, 'function', 'invariant helper');
    for (const bank of [0n, 1n, 7n, BigInt(PI_SHE_NANOS), 2n ** 52n]) {
      for (const off of [-1n, 1n, bank, -bank, 13n]) {
        const ledger = bank + off;
        if (ledger < 0n || off === 0n) continue;
        const got = supply.vaultMintDeltaRejected({ mintBankNanos: 5n }, { mintBankNanos: 5n + bank }, ledger);
        assert.deepEqual(got, { ok: false, reason: 'vault_mint' }, `${bank}/${ledger}`);
      }
      assert.equal(supply.vaultMintDeltaRejected({ mintBankNanos: 5n }, { mintBankNanos: 5n + bank }, bank), null);
      assert.equal(supply.vaultMintDeltaRejected(null, { mintBankNanos: bank }, bank), null);
    }
  });
});
