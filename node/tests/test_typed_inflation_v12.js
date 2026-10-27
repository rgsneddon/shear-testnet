import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { pointBytes, pointFrom, proveRange, randomScalar, sealNote, sealCoinbaseNote } from '../../crypto/note.js';
import { proveLeafRetire, subtractUnlock, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { newIdentity, freshStealthDest, ed25519SeedOf, hash20FromAddress } from '../../crypto/address.js';
import {
  typedCommitRejected,
  verifyFundedBody,
  boundReserveWithdraw,
  reserveAuth,
  signSpendTx,
} from '../../crypto/spend.js';
import {
  emptyVault,
  withdraw,
  applyReserveBlock,
  verifyReservePayout,
  cloneVault,
  portalIdFromDest,
  portalPrincipalNanos,
  compactLockLeakRejected,
  withdrawLeakRejected,
  appendVaultLockNote,
  chainPeriodIndex,
  consensusUnlockPeriod,
  enact,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  provePrincipalOpen,
} from '../../crypto/reserve_vault.js';
import { deposit, withdrawTx } from '../../crypto/owned_portal.js';
import { noteCommitSpendableNanos } from '../../crypto/coinbase_notes.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';

const KINDS = ['lock', 'vote', 'withdraw', 'vortice-register'];
const AMOUNTS = [1, 1_000_000_000, 50_000_000_000];
// One epoch after genesis. A tranche-less lump locked in epoch 0 is due,
// so these cases still reach the mint and payout gates.
const LUMP_GENESIS = 1;
const LUMP_CLOCK = 1 + RESERVE_EPOCH_MS;

function dueLump(nanos, extra = {}) {
  return {
    staked: nanos,
    idle: 0,
    lockEpoch: 0,
    ownerPub: '11'.repeat(32),
    ...extra,
  };
}

// A lock or withdraw on the wire names dest20 only. from, to, payer, and an
// ssa1 address on it are vote_leak, which the queue, mempool, and block check
// before the kind and membership gates.
const COMPACT_KINDS = new Set(['lock', 'withdraw']);

function assertNoLeak(tx, label) {
  assert.equal(compactLockLeakRejected(tx), null, `${label} lock leak`);
  assert.equal(withdrawLeakRejected(tx), null, `${label} withdraw leak`);
}

function mine(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
  };
}

/** One indexed π leaf, as crypto/reserve_vault.test.js depositIndexed. */
function depositIndexed(state, dest, nowMs, extra = {}) {
  const magic = state.magic || MAGIC_TESTNET;
  const stamp = lockUnlockOf({ genesisMs: state.genesisMs, magic }, nowMs);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const blind = randomScalar();
  const scalar = randomScalar();
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  assert.ok(leaf, 'leaf');
  const got = deposit({
    state,
    dest,
    nanos: PI_SHE_NANOS,
    nowMs,
    payout: extra.payout,
    payoutPortalId: extra.payoutPortalId,
    ownerPub: extra.ownerPub,
    commit: leaf.commit,
    rangeProof: proveRange(BigInt(PI_SHE_NANOS), blind),
    unlock,
    rangeCommit: pointBytes(subtractUnlock(pointFrom(leaf.commit), unlock)),
    piProof: proveRange(0n, blind),
  });
  assert.equal(got.ok, true, got.reason);
  assert.ok(appendVaultLockNote(state, leaf.note, {
    earnEpoch: Math.floor(Number(stamp.epoch) || 0),
    bornEpoch: chainPeriodIndex(state, nowMs),
    unlockEpoch: unlock,
    lockHeight: extra.lockHeight || 1,
  }), 'lock note index');
  return { ...got, planted: { leaf, unlock } };
}

/** FS-1 hidden withdraw of that leaf, as crypto/reserve_vault.test.js indexedHiddenWithdraw. */
function indexedHiddenWithdraw(state, dest, nowMs, extra) {
  const planted = extra.planted;
  const stub = leafStubNanos(state, [planted.leaf.commit.toString('hex')]);
  const nanos = PI_SHE_NANOS + Number(stub);
  const tx = withdrawTx({ from: dest, to: extra.payout || dest, nanos, id: extra.id || `hidden-${nowMs}` });
  const magic = state.magic || MAGIC_TESTNET;
  const proof = provePrincipalOpen(
    planted.leaf.commit, PI_SHE_NANOS, planted.leaf.blind, tx, portalIdFromDest(dest), magic, planted.leaf.unlock,
  );
  assert.ok(proof, 'principal proof');
  tx.principalProof = proof;
  const retire = proveLeafRetire({
    scalar: planted.leaf.scalar,
    epochs: leafEpochsToBurn(state, planted.leaf.note.toString('hex'), chainPeriodIndex(state, nowMs)),
    leaf: planted.leaf.note,
    txBind: txDigestV3(tx, magic),
    unlockEpoch: chainPeriodIndex(state, nowMs),
    magic,
  });
  assert.ok(retire?.proof, 'retire proof');
  tx.retireProof = retire.proof;
  const paid = withdraw({
    state,
    dest,
    portalId: portalIdFromDest(dest),
    nowMs,
    payout: extra.payout,
    payoutPortalId: extra.payoutPortalId,
    principal: nanos,
    principalProof: proof,
    retireProof: tx.retireProof,
    tx,
  });
  return { paid, nanos, stub: Number(stub) };
}

function stealthBox() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  return {
    id,
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
  };
}

describe('typed kinds cannot mint from an unproven commit or a foreign portal', () => {
  it('a commit vin on a non-Flow kind is rejected for any amount and any of those kinds', { timeout: 180_000 }, async () => {
    const box = stealthBox();
    const dest = box.dest;
    const d20 = hash20FromAddress(dest);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-typed-'));
    const store = createStore(dir);
    for (const kind of KINDS) {
      for (const nanos of AMOUNTS) {
        const note = sealNote(nanos, { dest20: d20, kind });
        const compact = COMPACT_KINDS.has(kind);
        const tx = {
          id: `${kind}-${nanos}`,
          kind,
          programId: kind === 'lock' || kind === 'vote' || kind === 'withdraw' ? RESERVE_PROGRAM : '',
          ...(compact ? {} : { from: dest, to: dest }),
          nanos,
          fee: 0,
          vin: [compact ? { commit: note.commit, dest20: d20 } : { commit: note.commit, address: dest, dest20: d20 }],
          vout: [compact ? { ...note, kind } : { ...note, kind, address: dest }],
        };
        // No FS-1 blob here, so spendPub and sig are not the FS-1 identity leak.
        signSpendTx(tx, box.key);
        assertNoLeak(tx, `${kind} ${nanos}`);
        assert.equal(typedCommitRejected(tx)?.reason, 'admit_membership', `${kind} ${nanos}`);
        const refused = kind === 'vortice-register';
        const want = refused ? 'kind' : 'admit_membership';
        const body = verifyFundedBody([tx], () => nanos * 4, {
          reserveState: { portals: { [portalIdFromDest(dest)]: { staked: nanos, idle: 0, ownerPub: tx.spendPub } }, epochBps: 0 },
        });
        assert.equal(body.ok, false, `${kind} ${nanos}`);
        assert.equal(body.reason, want, `${kind} ${nanos} ${body.reason}`);
        const queued = store.queueTx(tx);
        assert.equal(queued.ok, false, `${kind} ${nanos} ${queued.reason}`);
        assert.equal(queued.reason, want, `${kind} ${nanos}`);
        const parked = admitMempool(emptyMempool(), tx, { baseFee: 1 });
        assert.equal(parked.ok, false, `${kind} ${nanos} mempool`);
        assert.equal(parked.reason, want, `${kind} ${nanos} mempool ${parked.reason}`);
        const tpl = buildTemplate({
          prev: GENESIS_PREV,
          height: 1,
          miner: dest,
          bits: GENESIS_BITS_PACKED,
          now: 1_700_000_000_000,
          txs: [tx],
        });
        const got = await Promise.resolve(verifyBlock(mine(tpl), null, {
          trustedPowHash: Buffer.alloc(32),
          reserveState: { portals: { [portalIdFromDest(dest)]: { staked: nanos, idle: 0 } }, epochBps: 0 },
        }));
        assert.equal(got.ok, false, `${kind} ${nanos}`);
        assert.equal(got.reason, want, `${kind} ${nanos} ${got.reason}`);
      }
    }
  });

  it('a refused kind returns kind before an unbound proof or tag', { timeout: 180_000 }, async () => {
    const box = stealthBox();
    const dest = box.dest;
    const d20 = hash20FromAddress(dest);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-kind-before-carry-'));
    const store = createStore(dir);
    const refused = ['vortice-register', 'evm-value', 'claim', 'user-spend', 'made-up-kind'];
    const carries = [
      { admit_proof: { blob: Buffer.alloc(8, 1) } },
      { admit_proofs: [{ blob: Buffer.alloc(8, 2) }] },
      { spendTag: Buffer.alloc(32, 3) },
    ];
    for (const kind of refused) {
      for (const nanos of AMOUNTS) {
        const note = sealNote(nanos, { dest20: d20, kind });
        for (const carry of carries) {
          const tx = {
            id: `${kind}-${nanos}-${Object.keys(carry)[0]}`,
            kind,
            from: dest,
            to: dest,
            nanos,
            fee: 0,
            vin: [{ commit: note.commit, address: dest, dest20: d20 }],
            vout: [{ ...note, kind, address: dest }],
            ...carry,
          };
          signSpendTx(tx, box.key);
          const label = `${kind} ${nanos} ${Object.keys(carry)[0]}`;
          const body = verifyFundedBody([tx], () => nanos * 4, { reserveState: { portals: {}, epochBps: 0 } });
          assert.equal(body.reason, 'kind', `${label} body ${body.reason}`);
          const queued = store.queueTx(tx);
          assert.equal(queued.reason, 'kind', `${label} queue ${queued.reason}`);
          const parked = admitMempool(emptyMempool(), tx, { baseFee: 1 });
          assert.equal(parked.reason, 'kind', `${label} mempool ${parked.reason}`);
          const tpl = buildTemplate({
            prev: GENESIS_PREV,
            height: 1,
            miner: dest,
            bits: GENESIS_BITS_PACKED,
            now: 1_700_000_000_000,
            txs: [tx],
          });
          const got = await Promise.resolve(verifyBlock(mine(tpl), null, {
            trustedPowHash: Buffer.alloc(32),
          }));
          assert.equal(got.reason, 'kind', `${label} block ${got.reason}`);
          const bare = {
            ...tx,
            id: `${tx.id}-bare`,
            vout: [{ ...note, kind, address: dest, rangeProof: null }],
          };
          const bareBlock = await Promise.resolve(verifyBlock(mine(buildTemplate({
            prev: GENESIS_PREV,
            height: 1,
            miner: dest,
            bits: GENESIS_BITS_PACKED,
            now: 1_700_000_000_000,
            txs: [bare],
          })), null, { trustedPowHash: Buffer.alloc(32) }));
          assert.equal(bareBlock.reason, 'range_proof', `${label} bare ${bareBlock.reason}`);
          assert.notEqual(store.queueTx(bare).reason, 'admit_membership', `${label} bare queue`);
          assert.equal(admitMempool(emptyMempool(), bare, { baseFee: 1 }).reason, 'kind', `${label} bare mempool`);
        }
      }
    }
    for (const nanos of AMOUNTS) {
      const note = sealNote(nanos, { dest20: d20, kind: 'pool-withdraw' });
      const tx = {
        id: `pool-withdraw-${nanos}`,
        kind: 'pool-withdraw',
        from: dest,
        to: dest,
        nanos,
        fee: 0,
        vin: [{ commit: note.commit, address: dest, dest20: d20 }],
        vout: [{ ...note, kind: 'pool-withdraw', address: dest }],
        admit_proof: { blob: Buffer.alloc(8, 4) },
        spendTag: Buffer.alloc(32, 5),
      };
      signSpendTx(tx, box.key);
      assert.equal(store.queueTx(tx).reason, 'custodial_pull', `pool-withdraw ${nanos}`);
      assert.equal(verifyFundedBody([tx], () => nanos * 4).reason, 'custodial_pull', `pool-withdraw ${nanos}`);
      assert.equal(admitMempool(emptyMempool(), tx, { baseFee: 1 }).reason, 'custodial_pull', `pool-withdraw ${nanos}`);
      const got = await Promise.resolve(verifyBlock(mine(buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner: dest,
        bits: GENESIS_BITS_PACKED,
        now: 1_700_000_000_000,
        txs: [tx],
      })), null, { trustedPowHash: Buffer.alloc(32) }));
      assert.equal(got.reason, 'custodial_pull', `pool-withdraw ${nanos} ${got.reason}`);
    }
  });

  it('a lock, vote, or withdraw output must name its own kind', { timeout: 180_000 }, async () => {
    const box = stealthBox();
    const dest = box.dest;
    const d20 = hash20FromAddress(dest);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-explicit-kind-'));
    const store = createStore(dir);
    const typed = ['lock', 'vote', 'withdraw'];
    for (const kind of typed) {
      for (const nanos of AMOUNTS) {
        const note = sealNote(nanos, { dest20: d20, kind });
        const compact = COMPACT_KINDS.has(kind);
        const tx = {
          id: `blank-${kind}-${nanos}`,
          kind,
          programId: RESERVE_PROGRAM,
          ...(compact ? {} : { from: dest, to: dest }),
          nanos,
          fee: 0,
          vin: [compact ? { dest20: d20 } : { address: dest }],
          vout: [
            compact ? { ...note, kind } : { ...note, kind, address: dest },
            compact ? { dest20: d20, nanos: 1 } : { address: dest, nanos: 1 },
          ],
        };
        assertNoLeak(tx, `${kind} ${nanos}`);
        const body = verifyFundedBody([tx], () => nanos * 4, {
          reserveState: { portals: {}, epochBps: 0 },
        });
        assert.equal(body.reason, 'kind', `${kind} ${nanos} ${body.reason}`);
        const queued = store.queueTx(tx);
        assert.equal(queued.reason, 'kind', `${kind} ${nanos} ${queued.reason}`);
        const parked = admitMempool(emptyMempool(), tx, { baseFee: 1 });
        assert.equal(parked.reason, 'kind', `${kind} ${nanos} ${parked.reason}`);
        const tpl = buildTemplate({
          prev: GENESIS_PREV,
          height: 1,
          miner: dest,
          bits: GENESIS_BITS_PACKED,
          now: 1_700_000_000_000,
          txs: [tx],
        });
        const got = await Promise.resolve(verifyBlock(mine(tpl), null, {
          trustedPowHash: Buffer.alloc(32),
        }));
        assert.equal(got.reason, 'kind', `${kind} ${nanos} ${got.reason}`);
      }
    }
  });

  it('a lock with no payer is unfunded, and a second vout cannot ride a withdraw', () => {
    const dest = stealthBox().dest;
    for (const nanos of AMOUNTS) {
      const bare = {
        kind: 'lock',
        nanos,
        vin: [{}],
        vout: [{ kind: 'lock', nanos, address: dest }],
      };
      const funded = verifyFundedBody([bare], () => nanos * 4, { reserveState: { portals: {}, epochBps: 0 } });
      // A lock that does not present FS-1 is the wrong admit shape. The
      // anchor window is only consulted once that shape is present.
      assert.equal(funded.reason, 'admit_version', String(nanos));
      const extra = boundReserveWithdraw({
        kind: 'withdraw',
        from: dest,
        nanos,
        vout: [
          { kind: 'withdraw', nanos, address: dest },
          { kind: 'withdraw', nanos: 1, address: dest },
        ],
      }, {
        epochBps: 0,
        portals: { [portalIdFromDest(dest)]: { staked: nanos, idle: 0 } },
      });
      assert.equal(extra.reason, 'mint_amount', String(nanos));
    }
  });

  it('withdraw pays only the recorded owner and the recorded payout', () => {
    const owner = stealthBox();
    const thief = stealthBox();
    const victimId = portalIdFromDest(owner.dest);
    for (const nanos of AMOUNTS) {
      const note = sealNote(nanos, { dest20: hash20FromAddress(thief.dest), kind: 'withdraw' });
      const redirected = {
        kind: 'withdraw',
        programId: RESERVE_PROGRAM,
        mint: true,
        nanos,
        portalId: victimId,
        payoutPortalId: portalIdFromDest(thief.dest),
        vin: [],
        vout: [{ ...note, kind: 'withdraw', address: thief.dest }],
      };
      signSpendTx(redirected, thief.key);
      const state = {
        epochBps: 0,
        genesisMs: LUMP_GENESIS,
        portals: {
          [victimId]: dueLump(nanos, {
            ownerPub: owner.id.spendPub.toString('hex'),
            payout: owner.dest,
            payoutPortalId: portalIdFromDest(owner.dest),
          }),
        },
      };
      const cap = boundReserveWithdraw(redirected, state, null, LUMP_CLOCK);
      assert.equal(cap.reason, 'payout_mismatch', String(nanos));
      const foreign = {
        kind: 'withdraw',
        programId: RESERVE_PROGRAM,
        mint: true,
        nanos,
        portalId: victimId,
        payoutPortalId: portalIdFromDest(owner.dest),
        from: owner.dest,
        vin: [],
        vout: [{ ...sealNote(nanos, { dest20: hash20FromAddress(owner.dest), kind: 'withdraw' }), kind: 'withdraw', address: owner.dest }],
      };
      signSpendTx(foreign, thief.key);
      const auth = reserveAuth(foreign, state, new Map());
      assert.equal(auth.reason, 'unsigned', String(nanos));
    }
  });

  it('an unindexed lock is not paid, an indexed π lock is paid and its principal stays subtracted, and a lock receipt is not a coin', () => {
    const box = stealthBox();
    const dest = box.dest;
    const pub = box.id.spendPub.toString('hex');
    for (const nanos of [1, PI_SHE_NANOS, PI_SHE_NANOS + 1]) {
      const state = emptyVault();
      state.genesisMs = 1;
      const credited = deposit({
        state,
        dest,
        nanos,
        nowMs: 1,
        payout: dest,
        payoutPortalId: portalIdFromDest(dest),
        ownerPub: pub,
      });
      assert.equal(credited.ok, true, credited.reason);
      state.epochStartMs = 1;
      state.bonusEnacted = true;
      state.currentEpoch = 1;
      const heldBefore = portalPrincipalNanos(state, dest);
      const lockedBefore = Number(state.totalLockedNanos);
      // This deposit has no lock-note index entry. A matured commitment that
      // is not indexed is not a receipt, so the withdraw is refused and
      // nothing leaves the vault. The indexed π case below is the paid path.
      const paid = withdraw({
        state,
        dest,
        portalId: portalIdFromDest(dest),
        nowMs: 1 + RESERVE_EPOCH_MS,
        payout: dest,
        payoutPortalId: portalIdFromDest(dest),
      });
      assert.equal(paid.ok, false, `${nanos} unindexed paid`);
      assert.equal(paid.reason, 'stake_reward', `${nanos} ${paid.reason}`);
      assert.equal(portalPrincipalNanos(state, dest), heldBefore, `${nanos} held`);
      assert.equal(Number(state.totalLockedNanos), lockedBefore, `${nanos} locked`);
      const d20 = hash20FromAddress(dest);
      const lockNote = sealCoinbaseNote(nanos, { dest20: d20, kind: 'lock' });
      const blocks = [{
        height: 1,
        txs: [{ kind: 'lock', vout: [{ ...lockNote, kind: 'lock' }] }],
      }];
      assert.equal(noteCommitSpendableNanos(blocks, dest, 30), 0);
      const back = sealCoinbaseNote(nanos, { dest20: d20, kind: 'withdraw' });
      const paidBlocks = [{
        height: 1,
        txs: [{ kind: 'withdraw', vout: [{ ...back, kind: 'withdraw' }] }],
      }];
      assert.equal(noteCommitSpendableNanos(paidBlocks, dest, 30), nanos);
    }

    // Paid path: an indexed π leaf, withdrawn by FS-1 after its epoch ends.
    const state = emptyVault();
    state.genesisMs = 1;
    state.magic = MAGIC_TESTNET;
    const id = portalIdFromDest(dest);
    const locked = depositIndexed(state, dest, 1, { payout: dest, payoutPortalId: id, ownerPub: pub });
    // A hidden lock credits no public staked/idle and no totalLockedNanos.
    assert.equal(portalPrincipalNanos(state, dest), 0);
    assert.equal(Number(state.totalLockedNanos), 0);
    const end = 1 + RESERVE_EPOCH_MS;
    assert.equal(enact({ state, nowMs: end }).ok, true);
    const drawn = indexedHiddenWithdraw(state, dest, end, {
      planted: locked.planted,
      payout: dest,
      payoutPortalId: id,
      id: 'typed-paid',
    });
    const paid = drawn.paid;
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(paid.payout, PI_SHE_NANOS);
    assert.equal(paid.interest, 0);
    assert.equal(paid.arrival, drawn.stub);
    // withdraw() adds the released π to redeemedNanos, so the paid principal
    // stays in this dest's held total and the lock and withdraw notes are not
    // both spendable. totalLockedNanos had no public π to drop and is clamped at 0.
    assert.equal(portalPrincipalNanos(state, dest), PI_SHE_NANOS);
    assert.equal(Number(state.portals[id].redeemedNanos), PI_SHE_NANOS);
    assert.equal(Number(state.totalLockedNanos), 0);
    assert.equal(Number(state.openedWithdrawNanos), PI_SHE_NANOS);
    assert.equal(state.portals[id].tranches.length, 0);
    const again = withdraw({ state, dest, portalId: id, nowMs: end, payout: dest, payoutPortalId: id });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'double_mint');
    assert.equal(portalPrincipalNanos(state, dest), PI_SHE_NANOS);
    const d20 = hash20FromAddress(dest);
    const lockNote = sealCoinbaseNote(PI_SHE_NANOS, { dest20: d20, kind: 'lock' });
    assert.equal(noteCommitSpendableNanos([{
      height: 1,
      txs: [{ kind: 'lock', vout: [{ ...lockNote, kind: 'lock' }] }],
    }], dest, 30), 0);
    // The withdraw receipt opens π plus this leaf's arrival stub.
    const back = sealCoinbaseNote(drawn.nanos, { dest20: d20, kind: 'withdraw' });
    assert.equal(noteCommitSpendableNanos([{
      height: 1,
      txs: [{ kind: 'withdraw', vout: [{ ...back, kind: 'withdraw' }] }],
    }], dest, 30), drawn.nanos);
  });

  it('a withdraw mints only an opened principal plus interest, once per portal', () => {
    const dest = stealthBox().dest;
    const id = portalIdFromDest(dest);
    for (const nanos of AMOUNTS) {
      const portal = dueLump(nanos, {
        payout: dest,
        payoutPortalId: id,
      });
      const state = {
        epochBps: 0,
        genesisMs: LUMP_GENESIS,
        currentEpoch: 4,
        mintedIds: Object.create(null),
        portals: { [id]: { ...portal } },
      };
      const opened = sealNote(nanos, { dest20: hash20FromAddress(dest), kind: 'withdraw' });
      const tx = {
        kind: 'withdraw',
        programId: RESERVE_PROGRAM,
        portalId: id,
        payoutPortalId: id,
        nanos,
        vout: [{ ...opened, kind: 'withdraw', address: dest }],
      };
      const drawn = new Set();
      const first = boundReserveWithdraw(tx, state, drawn, LUMP_CLOCK);
      assert.equal(first.ok, true, `${nanos} ${first.reason}`);
      drawn.add(first.mintId);
      const second = boundReserveWithdraw({ ...tx, id: 'again' }, state, drawn, LUMP_CLOCK);
      assert.equal(second.reason, 'double_mint', `${nanos} ${second.reason}`);
      state.mintedIds[first.mintId] = true;
      const later = boundReserveWithdraw({ ...tx, id: 'later' }, state, new Set(), LUMP_CLOCK);
      assert.equal(later.reason, 'double_mint', `${nanos} later ${later.reason}`);

      const foreign = boundReserveWithdraw({
        ...tx,
        programId: 'not-the-reserve',
        vin: [{ commit: Buffer.alloc(32, 9) }],
      }, {
        epochBps: 0,
        genesisMs: LUMP_GENESIS,
        currentEpoch: 4,
        portals: { [id]: { ...portal } },
      }, null, LUMP_CLOCK);
      assert.equal(foreign.reason, 'mint_forbidden', `${nanos} ${foreign.reason}`);

      const broken = sealNote(nanos, { dest20: hash20FromAddress(dest), kind: 'withdraw' });
      broken.valueProof = { ...broken.valueProof, z: Buffer.alloc(32, 1) };
      const unopened = boundReserveWithdraw({
        ...tx,
        vout: [{ ...broken, kind: 'withdraw' }],
      }, {
        epochBps: 0,
        genesisMs: LUMP_GENESIS,
        currentEpoch: 4,
        portals: { [id]: { ...portal } },
      }, null, LUMP_CLOCK);
      assert.equal(unopened.reason, 'mint_amount', `${nanos} ${unopened.reason}`);

      const partial = sealNote(nanos > 1 ? nanos - 1 : 0, {
        dest20: hash20FromAddress(dest),
        kind: 'withdraw',
      });
      const short = boundReserveWithdraw({
        ...tx,
        nanos: nanos > 1 ? nanos - 1 : 0,
        vout: [{ ...partial, kind: 'withdraw' }],
      }, {
        epochBps: 0,
        genesisMs: LUMP_GENESIS,
        currentEpoch: 9,
        portals: { [id]: { ...portal } },
      }, null, LUMP_CLOCK);
      assert.equal(short.reason, 'mint_amount', `${nanos} short ${short.reason}`);

      const vault = emptyVault();
      vault.genesisMs = 1;
      assert.equal(deposit({ state: vault, dest, nanos, nowMs: 1, payout: dest, payoutPortalId: id }).ok, true);
      const clock = 1 + RESERVE_EPOCH_MS;
      // Epoch end leaves principal in the vault. The foreign program
      // must not move it either.
      const control = cloneVault(vault);
      applyReserveBlock({ state: control, block: { txs: [] }, nowMs: clock });
      const skipped = applyReserveBlock({
        state: vault,
        block: {
          txs: [{
            kind: 'withdraw',
            programId: 'not-the-reserve',
            vin: [{ commit: Buffer.alloc(32, 4) }],
            vout: [{ ...opened, kind: 'withdraw' }],
          }],
        },
        nowMs: clock,
      });
      assert.equal(skipped.some((r) => r.action === 'withdraw' && r.ok === true), false);
      assert.equal(Number(vault.totalLockedNanos), Number(control.totalLockedNanos));
      const pay = verifyReservePayout(vault, {
        kind: 'withdraw',
        programId: 'not-the-reserve',
        from: dest,
        nanos,
        vout: [{ ...opened, kind: 'withdraw' }],
        nowMs: 1 + RESERVE_EPOCH_MS,
      });
      assert.equal(pay.reason, 'mint_forbidden', `${nanos} ${pay.reason}`);
    }
  });
});
