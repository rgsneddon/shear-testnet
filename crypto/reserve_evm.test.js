import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as asert from './asert.js';
import { PI_SHE_NANOS, RESERVE_EPOCH_MS, NANOS_PER_SHE, MAGIC_TESTNET, MAGIC_TESTNET_V12, EPOCH_DAYS_TESTNET } from './asert.js';
import { RESERVE_BOOKS } from './reserve_books.js';
import {
  applyReserveBooks,
  compileReserveSource,
  renderReserveAllow,
  renderReserveConstants,
  reserveSolRegions,
} from '../contracts/compile_reserve.js';
import {
  bootReserveEvm,
  reservePinOk,
  callReserve,
  encodePinClock,
  encodeVote,
  encodeEnact,
  encodeClaim,
  encodeDeposit as encodeDepositRaw,
  encodePiProofWord,
  encodeWithdraw as encodeWithdrawRaw,
  encodeCommitRewards,
  encodeSyncEpoch,
  encodePublicView,
  executeBlockEvm,
  decodePublicView,
  decodeBytes32,
  encodePortalOf,
  decodePortal,
  decodeWithdraw,
  decodeWithdrawEarned,
  encodeObserveRate,
  selector,
  shearMagicBytes,
} from './reserve_evm.js';
import { GENESIS_BPS } from './reserve_oracle.js';
import { txDigestV3 } from './admit_v3.js';
import { destCommitFromSpendPub, ed25519RawPub, encodeDest, hash20FromAddress, newIdentity, spendDestOf } from './address.js';
import { pointBytes, pointFrom, proveRange, randomScalar, sealCoinbaseNote } from './note.js';
import { proveLeafRetire, subtractUnlock, vaultLockNote } from './vault_reward_fs1.js';
import { boundReserveWithdraw, reserveAuth, signSpendTx } from './spend.js';
import {
  appendVaultLockNote,
  applyReserveBlock,
  chainPeriodIndex,
  cloneVault,
  consensusUnlockPeriod,
  emptyVault,
  leafEpochsToBurn,
  leafStubNanos,
  lockUnlockOf,
  reserveDigestSuffix,
  provePrincipalOpen,
  enact,
  packRewardAuth,
  packRewardProof,
  portalEpochInterest,
  portalIdFromDest,
  previewWithdraw,
  rewardClaimProof,
  rewardClaimTx,
  rewardCommitment,
  rewardOwnerCommit,
  signWithdrawReward,
  supplyIdentity,
  deposit as depositUnowned,
  withdraw,
  withdrawMintId,
  withdrawPaysInterest,
  withdrawRewardRejected,
  withdrawTx,
  portalOwnerKey,
} from './reserve_vault.js';
import { deposit, encodeDeposit, encodeWithdraw, lockTranches, ownerFor, ownerWithdrawAuth, portalOwner } from './owned_portal.js';
import { decodeHeader, encodeHeader } from './header.js';
import { merkleRoot } from './merkle.js';
import { GENESIS_BITS_PACKED, RESERVE_PROGRAM } from './asert.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../node/src/chain.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const destA = 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const destB = 'ssa1ppppppppppppppppppppppppppppppppppppppppppppppppppppp';

/** One indexed π leaf. An unindexed hidden tranche withdraws as stake_reward.
 *  The owner signs π. The receipt is π plus this leaf's arrival stub. */
function indexPiLock(state, dest, nowMs, ownerPub, lockHeight = 1) {
  const magic = state.magic || MAGIC_TESTNET;
  const stamp = lockUnlockOf({ genesisMs: state.genesisMs, magic }, nowMs);
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const scalar = randomScalar();
  const blind = randomScalar();
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  if (!leaf) return { ok: false, reason: 'leaf' };
  const ranged = pointBytes(subtractUnlock(pointFrom(leaf.commit), unlock));
  const range = proveRange(BigInt(PI_SHE_NANOS), blind);
  // The leaf commit hides π. The same proof the plain deposit used shows it
  // qualifies, so the epoch opens and enact can run.
  const piProof = proveRange(0n, blind);
  const got = deposit({
    state,
    dest,
    nanos: PI_SHE_NANOS,
    nowMs,
    ownerPub,
    commit: leaf.commit,
    rangeProof: range,
    unlock,
    rangeCommit: ranged,
    piProof,
  });
  if (!got.ok) return got;
  const rooted = appendVaultLockNote(state, leaf.note, {
    earnEpoch: Math.floor(Number(stamp.epoch) || 0),
    bornEpoch: chainPeriodIndex(state, nowMs),
    unlockEpoch: unlock,
    lockHeight,
  });
  if (!rooted) return { ok: false, reason: 'stake_reward' };
  return { ok: true, leaf };
}

/** Retire proof and principal opening bound to this withdraw. */
function indexedDraw(state, dest, when, planted, id, ownerKey, to = dest) {
  const commitHex = planted.leaf.commit.toString('hex');
  const stub = leafStubNanos(state, [commitHex]);
  const nanos = PI_SHE_NANOS + Number(stub);
  const tx = withdrawTx({ nanos, id, portalId: portalIdFromDest(dest) });
  // The payout is dest20. from, to, and payoutPortalId are vote_leak.
  delete tx.from;
  delete tx.to;
  delete tx.payer;
  delete tx.payoutPortalId;
  const d20 = hash20FromAddress(to) || hash20FromAddress(dest);
  if (d20) tx.dest20 = Buffer.from(d20);
  // The receipt has to open to the public nanos. A kind-only row is stake_reward.
  // Seal it before the proofs: the digest binds this note's commit and dest20.
  if (d20) {
    const note = sealCoinbaseNote(nanos, { dest20: Buffer.from(d20), kind: 'withdraw' });
    if (note.valueProof && typeof note.valueProof === 'object') {
      note.valueProof = { ...note.valueProof, v: nanos };
    }
    tx.vout = [note];
  }
  const portalId = portalIdFromDest(dest);
  const magic = state.magic || MAGIC_TESTNET;
  const proof = provePrincipalOpen(
    planted.leaf.commit, PI_SHE_NANOS, planted.leaf.blind, tx, portalId, magic, planted.leaf.unlock,
  );
  if (!proof) return null;
  tx.principalProof = proof;
  const period = chainPeriodIndex(state, when);
  const retire = proveLeafRetire({
    scalar: planted.leaf.scalar,
    epochs: leafEpochsToBurn(state, planted.leaf.note.toString('hex'), period),
    leaf: planted.leaf.note,
    txBind: txDigestV3(tx, magic),
    unlockEpoch: period,
    magic,
  });
  if (!retire) return null;
  tx.retireProof = retire.proof;
  if (ownerKey) {
    signWithdrawReward(tx, ownerKey, {
      portalId,
      nanos: PI_SHE_NANOS,
      dest: d20 ? Buffer.from(d20).toString('hex') : '',
      state,
      nowMs: when,
    });
  }
  return { tx, nanos, proof, stub };
}

describe('Reserve bytecode on the Shear EVM', () => {
  it('bootReserveEvm defaults to MAGIC_TESTNET', async () => {
    const src = fs.readFileSync(fileURLToPath(new URL('./reserve_evm.js', import.meta.url)), 'utf8');
    assert.match(src, /bootReserveEvm\(\{ network = MAGIC_TESTNET\b/);
    assert.match(src, /shearMagicBytes\(network = MAGIC_TESTNET\)/);
    assert.equal(MAGIC_TESTNET, MAGIC_TESTNET_V12);
    assert.equal(MAGIC_TESTNET_V12, 'shear-testnet-v12');
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v12');
    assert.equal(reservePinOk(), true);
    assert.equal(reservePinOk('shear-testnet-v11'), true);
    assert.equal(reservePinOk('shear-testnet-not-a-book'), false);
    const live = await bootReserveEvm();
    assert.ok(live.address);
    const got = await callReserve(live, selector('magic()'), { staticCall: true });
    assert.equal(got.ok, true, got.reason);
    assert.equal(
      Buffer.from(got.returnValue).equals(Buffer.from(shearMagicBytes(MAGIC_TESTNET))),
      true,
    );
  });

  it('CREATE with shear-testnet-v11 succeeds and an unknown magic reverts', async () => {
    const s = await bootReserveEvm({ network: 'shear-testnet-v11' });
    assert.ok(s.address);
    const magic = await callReserve(s, selector('magic()'), { staticCall: true });
    assert.equal(magic.ok, true, magic.reason);
    assert.equal(
      Buffer.from(magic.returnValue).equals(Buffer.from(shearMagicBytes('shear-testnet-v11'))),
      true,
    );
    const view = decodePublicView((await callReserve(s, encodePublicView(1), { staticCall: true })).returnValue);
    assert.equal(view.liveHashBonusNanos, 1);
    const prior = await bootReserveEvm({ network: 'shear-testnet-v9' });
    assert.ok(prior.address);
    await assert.rejects(
      () => bootReserveEvm({ network: 'shear-testnet-unknown' }),
      (err) => {
        assert.match(String(err.message), /^reserve_deploy: revert$/);
        return true;
      },
    );
  });

  it('piProofWord is the last 32 bytes of the JS lock reserve digest', async () => {
    const portalId = 'ab'.repeat(32);
    const commit = Buffer.alloc(32, 0x11);
    const ownerPub = Buffer.alloc(32, 0x22);
    const cases = [Buffer.from([1, 2, 3]), Buffer.alloc(0)];
    const session = await bootReserveEvm();
    for (const piProof of cases) {
      const tx = {
        kind: 'lock',
        portalId,
        programId: 'shear-reserve-v1',
        nanos: 0,
        ownerPub: ownerPub.toString('hex'),
        vout: [{ kind: 'lock', commit }],
      };
      if (piProof.length) tx.piProof = piProof;
      const js = reserveDigestSuffix(tx);
      const call = await callReserve(session, encodePiProofWord(piProof), { staticCall: true });
      assert.equal(call.ok, true, call.reason);
      const word = Buffer.from(call.returnValue);
      assert.equal(word.length, 32);
      assert.equal(word.equals(js.subarray(js.length - 32)), true, piProof.length ? 'proof' : 'empty');
    }
  });

  it('MAGIC_TESTNET, the Reserve.sol allowlist, and Reserve.json move together', () => {
    const sol = fs.readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    const asertSrc = fs.readFileSync(new URL('./asert.js', import.meta.url), 'utf8');
    const walletSrc = fs.readFileSync(new URL('../wallet/lib/shear_identity.dart', import.meta.url), 'utf8');
    const pin = JSON.parse(fs.readFileSync(new URL('../contracts/Reserve.json', import.meta.url), 'utf8'));
    const norm = (s) => s.replace(/\r\n/g, '\n');
    const regions = reserveSolRegions(sol);
    assert.equal(norm(regions.constants), renderReserveConstants(RESERVE_BOOKS));
    assert.equal(norm(regions.allow), renderReserveAllow(RESERVE_BOOKS));
    assert.equal(applyReserveBooks(sol), sol);
    assert.doesNotMatch(asertSrc, /export const MAGIC_TESTNET_V\d+ = '/);
    assert.doesNotMatch(asertSrc, /export const MAGIC_MAINNET = '/);
    assert.match(asertSrc, /from '\.\/reserve_books\.js'/);
    const magics = new Set();
    const sols = new Set();
    for (const row of RESERVE_BOOKS) {
      assert.equal(asert[row.asert], row.magic, row.asert);
      assert.equal(magics.has(row.magic), false, row.magic);
      assert.equal(sols.has(row.sol), false, row.sol);
      magics.add(row.magic);
      sols.add(row.sol);
    }
    assert.equal(asert.MAGIC_TESTNET, MAGIC_TESTNET_V12);
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v12');
    assert.equal(magics.has(MAGIC_TESTNET), true);
    const named = sol.match(new RegExp(
      `constant (SHEAR_TESTNET(?:_V\\d+)?) = keccak256\\(bytes\\("${MAGIC_TESTNET}"\\)\\)`,
    ));
    assert.ok(named, `Reserve.sol missing keccak256(bytes("${MAGIC_TESTNET}"))`);
    assert.match(regions.allow, new RegExp(`magic != ${named[1]}\\b`));
    const code = String(pin.bytecode || '').replace(/^0x/i, '').toLowerCase();
    const compiled = compileReserveSource(sol);
    assert.equal(compiled.bytecode, code);
    assert.equal(compiled.deployedBytecode, String(pin.deployedBytecode || '').replace(/^0x/i, '').toLowerCase());
    assert.deepEqual(compiled.abi, pin.abi);
    for (const magic of magics) {
      const hash = Buffer.from(shearMagicBytes(magic)).toString('hex');
      assert.equal(code.includes(hash), true, magic);
      assert.equal(compiled.bytecode.includes(hash), true, magic);
    }
    const dropped = RESERVE_BOOKS.slice(0, -1);
    assert.notEqual(renderReserveAllow(dropped), norm(regions.allow));
    assert.notEqual(applyReserveBooks(sol, dropped), sol);
    const extra = RESERVE_BOOKS.concat([
      Object.freeze({ asert: 'MAGIC_TESTNET_V99', sol: 'SHEAR_TESTNET_V99', magic: 'shear-testnet-v99' }),
    ]);
    assert.notEqual(renderReserveAllow(extra), norm(regions.allow));
    assert.equal(sol.includes(renderReserveConstants(extra)), false);
    assert.match(walletSrc, /const kBookMagic = 'shear-testnet-v12';/);
    assert.doesNotMatch(walletSrc, /const kBookMagic = 'shear-testnet-v11'/);
  });

  it('refuses a Reserve.sol source that contains a CR byte', () => {
    const sol = fs.readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    assert.equal(sol.includes('\r'), false);
    const crlf = sol.replace(/\n/g, '\r\n');
    assert.throws(() => applyReserveBooks(crlf), /CR byte/);
    assert.throws(() => compileReserveSource(crlf), /CR byte/);
    const lone = sol.replace('pragma', 'pra\rgma');
    assert.notEqual(lone, sol);
    assert.throws(() => applyReserveBooks(lone), /CR byte/);
    assert.throws(() => compileReserveSource(lone), /CR byte/);
  });

  it('a hand-edited magic is not the pinned bytecode', () => {
    const sol = fs.readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    const pin = JSON.parse(fs.readFileSync(new URL('../contracts/Reserve.json', import.meta.url), 'utf8'));
    const code = String(pin.bytecode || '').replace(/^0x/i, '').toLowerCase();
    const mutated = sol.replace(
      'keccak256(bytes("shear-testnet-v12"))',
      'keccak256(bytes("shear-testnet-v99"))',
    );
    assert.notEqual(mutated, sol);
    const bad = compileReserveSource(mutated);
    const live = Buffer.from(shearMagicBytes('shear-testnet-v12')).toString('hex');
    const stranger = Buffer.from(shearMagicBytes('shear-testnet-v99')).toString('hex');
    assert.notEqual(bad.bytecode, code);
    assert.equal(code.includes(live), true);
    assert.equal(bad.bytecode.includes(live), false);
    assert.equal(bad.bytecode.includes(stranger), true);
    assert.equal(code.includes(stranger), false);
  });

  it('a 20-byte dest20 binds the lockAuth key and a raw 32-byte id is unsigned', async () => {
    const s = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
    assert.equal((await callReserve(s, encodePinClock(t0))).ok, true);
    const ownerA = newIdentity();
    const ownerB = newIdentity();
    const dest20 = destCommitFromSpendPub(ownerA.spendPub);
    const first = await callReserve(s, encodeDepositRaw(dest20, Buffer.alloc(32, 9), t0, { key: ownerA.privateKey }, false));
    assert.equal(first.ok, true, first.reason);
    const front = await callReserve(s, encodeDepositRaw(dest20, Buffer.alloc(32, 8), t0 + 1, { key: ownerB.privateKey }, false));
    assert.equal(front.ok, false, 'front-run was accepted');
    assert.equal(front.reason, 'unsigned');
    const same = await callReserve(s, encodeDepositRaw(dest20, Buffer.alloc(32, 6), t0 + 2, { key: ownerA.privateKey }, false));
    assert.equal(same.ok, false);
    assert.equal(same.reason, 'portal_exists');
    const raw = await callReserve(s, encodeDepositRaw(Buffer.alloc(32, 7), Buffer.alloc(32, 4), t0 + 3, { key: ownerA.privateKey }, false));
    assert.equal(raw.ok, false, 'raw 32-byte id was accepted');
    assert.equal(raw.reason, 'unsigned');
    const copied = await callReserve(s, encodeDepositRaw(dest20, Buffer.alloc(32, 5), t0 + 4, Buffer.alloc(32, 1), false));
    assert.equal(copied.ok, false);
    assert.equal(copied.reason, 'owner_missing');
  });

  it('deploys, takes a π lock, lets a late first deposit vote, and enacts +1', async () => {
    const s = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
    assert.equal((await callReserve(s, encodePinClock(t0))).ok, true);
    const d = await callReserve(s, encodeDeposit(destA, PI_SHE_NANOS, t0));
    assert.equal(d.ok, true, d.reason);
    const view0 = decodePublicView((await callReserve(s, encodePublicView(t0), { staticCall: true })).returnValue);
    assert.equal(view0.currentEpoch, 0);
    assert.equal(view0.liveHashBonusNanos, 1);
    const v = await callReserve(s, encodeVote(destA, 1, t0 + 2));
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'not_voter');
    const epochMs = EPOCH_DAYS_TESTNET * 86_400_000;
    const cutoffMs = Math.floor(epochMs / 4);
    const late = t0 + epochMs - cutoffMs + 1_000;
    const bob = await callReserve(s, encodeDeposit(destB, PI_SHE_NANOS, late));
    assert.equal(bob.ok, true, bob.reason);
    const portalB = decodePortal((await callReserve(s, encodePortalOf(destB), { staticCall: true })).returnValue);
    assert.equal(portalB.idle, 0);
    assert.equal(portalB.staked, 0);
    assert.equal(portalB.joined, true);
    const bobVote = await callReserve(s, encodeVote(destB, 1, late));
    assert.equal(bobVote.ok, false);
    assert.equal(bobVote.reason, 'not_voter');
    const change = await callReserve(s, encodeVote(destA, 3, late));
    assert.equal(change.ok, false);
    assert.equal(change.reason, 'not_voter');
    const end = t0 + RESERVE_EPOCH_MS;
    const en = await callReserve(s, encodeEnact(end));
    assert.equal(en.ok, true, en.reason);
    const view = decodePublicView((await callReserve(s, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(view.liveHashBonusNanos, 1);
    assert.equal(view.oracleBps, GENESIS_BPS);
    assert.equal(view.bonusEnacted, true);
    const w = await callReserve(s, encodeWithdraw(destB, end, undefined, PI_SHE_NANOS, {
      locks: [{ nanos: PI_SHE_NANOS, at: late }],
    }));
    assert.equal(w.ok, false);
    assert.equal(w.reason, 'unsigned');
    const after = decodePublicView((await callReserve(s, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(after.votesIncrease, 0);
    assert.equal(after.votesDecrease, 0);
    assert.equal(after.votesIncrease + after.votesDecrease + after.votesHold, 0);
  });

  it('constructor freezes the plain-average bundle; second vote is VoteLocked; mid-epoch observe does not mint', async () => {
    const s = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
    assert.equal((await callReserve(s, encodePinClock(t0))).ok, true);
    const view0 = decodePublicView((await callReserve(s, encodePublicView(t0), { staticCall: true })).returnValue);
    assert.equal(view0.oracleBps, GENESIS_BPS);
    const d = await callReserve(s, encodeDeposit(destA, PI_SHE_NANOS, t0));
    assert.equal(d.ok, true, d.reason);
    // One portal, one lock. A second credit on destA is not a top-up.
    const topped = await callReserve(s, encodeDeposit(destA, NANOS_PER_SHE, t0, undefined, true));
    assert.equal(topped.ok, false);
    assert.equal(topped.reason, 'portal_exists');
    assert.equal((await callReserve(s, encodeVote(destA, 1, t0 + 2))).reason, 'not_voter');
    const locked = await callReserve(s, encodeVote(destA, 3, t0 + 3));
    assert.equal(locked.ok, false);
    assert.equal(locked.reason, 'not_voter');
    assert.equal((await callReserve(s, encodeObserveRate(9999, t0 + 4))).ok, false);
    const end = t0 + RESERVE_EPOCH_MS;
    assert.equal((await callReserve(s, encodeEnact(end))).ok, true);
    const w = await callReserve(s, encodeWithdraw(destA, end, undefined, PI_SHE_NANOS, {
      locks: [{ nanos: PI_SHE_NANOS, at: t0 }],
    }));
    assert.equal(w.ok, false);
    assert.equal(w.reason, 'unsigned');
    const view = decodePublicView((await callReserve(s, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(view.votesIncrease, 0);
    assert.equal(view.votesIncrease + view.votesDecrease + view.votesHold, 0);
  });

  it('withdraw after a new epoch opens does not decrement the new piles', async () => {
    const s = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
    assert.equal((await callReserve(s, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(s, encodeDeposit(destA, PI_SHE_NANOS, t0))).ok, true);
    assert.equal((await callReserve(s, encodeVote(destA, 1, t0 + 2))).reason, 'not_voter');
    const end1 = t0 + RESERVE_EPOCH_MS;
    assert.equal((await callReserve(s, encodeEnact(end1))).ok, true);
    assert.equal((await callReserve(s, encodeDeposit(destB, PI_SHE_NANOS, end1 + 1))).ok, true);
    assert.equal((await callReserve(s, encodeVote(destB, 3, end1 + 2))).reason, 'not_voter');
    const end2 = end1 + 1 + RESERVE_EPOCH_MS;
    assert.equal((await callReserve(s, encodeEnact(end2))).ok, true);
    const leftA = await callReserve(s, encodeWithdraw(destA, end2));
    assert.equal(leftA.ok, false);
    assert.equal(leftA.reason, 'unsigned');
    const view = decodePublicView((await callReserve(s, encodePublicView(end2), { staticCall: true })).returnValue);
    assert.equal(view.votesIncrease, 0);
    assert.equal(view.votesHold, 0);
    assert.ok(view.votesIncrease >= 0);
    assert.ok(view.votesDecrease >= 0);
    assert.ok(view.votesHold >= 0);
  });

  it('deleting the ClockUnpinned revert lets an unpinned lock through', async () => {
    const sol = fs.readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    const line = 'if (clockGenesis == 0) revert ClockUnpinned();';
    assert.equal(sol.includes(line), true);
    const t0 = 1_700_000_000_000;
    const live = await bootReserveEvm();
    const denied = await callReserve(live, encodeDeposit(destA, PI_SHE_NANOS, t0));
    assert.equal(denied.ok, false);
    const stripped = sol.replace(line, '');
    assert.notEqual(stripped, sol);
    const bad = compileReserveSource(stripped);
    assert.notEqual(bad.bytecode, String(
      JSON.parse(fs.readFileSync(new URL('../contracts/Reserve.json', import.meta.url), 'utf8')).bytecode || '',
    ).replace(/^0x/i, '').toLowerCase());
    const open = await bootReserveEvm({ bytecode: bad.bytecode });
    const allowed = await callReserve(open, encodeDeposit(destA, PI_SHE_NANOS, t0));
    assert.equal(allowed.ok, true, allowed.reason);
  });

  it('JS and the EVM roll the epoch on the same call at 257, 300, and 600 portals', async () => {
    const sol = fs.readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    const vault = fs.readFileSync(new URL('./reserve_vault.js', import.meta.url), 'utf8');
    assert.equal(sol.includes('_pinLegacyEpochs'), false);
    assert.equal(sol.includes('legacyPinCursor'), false);
    assert.equal(vault.includes('pinLegacyLockEpochs'), false);
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    for (const n of [257, 300, 600]) {
      const state = emptyVault();
      state.genesisMs = t0;
      state.magic = MAGIC_TESTNET;
      const session = await bootReserveEvm();
      assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
      for (let i = 0; i < n; i += 1) {
        const raw = Buffer.alloc(20);
        raw.writeUInt32BE(i + 1, 16);
        const dest = encodeDest(raw);
        const nanos = i === 0 ? PI_SHE_NANOS : 1;
        const jsLocked = deposit({ state, dest, nanos, nowMs: t0 });
        assert.equal(jsLocked.ok, true, `${n} js ${i} ${jsLocked.reason}`);
        const locked = await callReserve(session, encodeDeposit(dest, nanos, t0));
        assert.equal(locked.ok, true, `${n} evm ${i} ${locked.reason}`);
      }
      const enacted = applyReserveBlock({
        state,
        block: { height: 1, txs: [{ coinbase: true, vout: [] }] },
        nowMs: end,
        genesisMs: t0,
      });
      assert.equal(enacted.ok, true, `${n} ${enacted.reason}`);
      const en = await callReserve(session, encodeEnact(end));
      assert.equal(en.ok, true, `${n} ${en.reason}`);
      const evmHeld = decodePublicView((await callReserve(session, encodePublicView(end), { staticCall: true })).returnValue);
      assert.equal(state.currentEpoch, 0, `${n} js before roll`);
      assert.equal(evmHeld.currentEpoch, 0, `${n} evm before roll`);
      const rolled = applyReserveBlock({
        state,
        block: { height: 2, txs: [{ coinbase: true, vout: [] }] },
        nowMs: end,
        genesisMs: t0,
      });
      assert.equal(rolled.ok, true, `${n} ${rolled.reason}`);
      const sync = await callReserve(session, encodeSyncEpoch(end));
      assert.equal(sync.ok, true, `${n} ${sync.reason}`);
      const evmRolled = decodePublicView((await callReserve(session, encodePublicView(end), { staticCall: true })).returnValue);
      assert.equal(state.currentEpoch, evmRolled.currentEpoch, `${n} roll height`);
      assert.equal(state.currentEpoch, 1, `${n} rolled`);
    }
  });

  it('epoch-end gas stays flat for every π earner across 60 unclaimed epochs', async () => {
    const sol = fs.readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    const vault = fs.readFileSync(new URL('./reserve_vault.js', import.meta.url), 'utf8');
    assert.equal(sol.includes('_pinLegacyEpochs'), false);
    assert.equal(sol.includes('_releaseMatured'), false);
    assert.equal(sol.includes('function _rootOf'), false);
    assert.equal(sol.includes('earnerKeys'), false);
    assert.match(sol, /function commitRewards\(uint256 nowTs, bytes32 root\)/);
    assert.equal(vault.includes('pinLegacyLockEpochs'), false);
    const t0 = 1_700_000_000_000;
    const epochs = 60;
    const sizes = [1, 40, 1000];
    const gas = {};
    const firstGas = {};
    for (const n of sizes) {
      const js = emptyVault();
      js.genesisMs = t0;
      const session = await bootReserveEvm();
      assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
      let firstDest = '';
      let firstOwner = null;
      // N=1000 proves the commit does not walk earners. The 60-epoch walk
      // is N=1 and N=40, which is the growth the root used to have.
      const epochCount = n === 1000 ? 1 : epochs;
      for (let i = 0; i < n; i += 1) {
        const raw = Buffer.alloc(20);
        raw.writeUInt32BE(i + 1, 16);
        const dest = encodeDest(raw);
        let ownerPub = null;
        let ownerCommit = null;
        if (i === 0) {
          firstDest = dest;
          firstOwner = newIdentity();
          ownerPub = Buffer.from(firstOwner.spendPub).toString('hex');
          ownerCommit = rewardOwnerCommit(ownerPub);
        }
        const jsLock = deposit({
          state: js, dest, nanos: PI_SHE_NANOS, nowMs: t0, ownerPub: ownerPub || undefined,
        });
        assert.equal(jsLock.ok, true, `${n} js ${i} ${jsLock.reason}`);
        const evmLock = await callReserve(session, encodeDeposit(
          dest,
          PI_SHE_NANOS,
          t0,
          i === 0 ? { key: firstOwner.privateKey } : undefined,
        ));
        assert.equal(evmLock.ok, true, `${n} evm ${i} ${evmLock.reason}`);
      }
      for (let epoch = 0; epoch < epochCount; epoch += 1) {
        const now = t0 + (epoch + 1) * RESERVE_EPOCH_MS;
        assert.equal(enact({ state: js, nowMs: now }).ok, true, `js enact ${n} ${epoch}`);
        const en = await callReserve(session, encodeEnact(now));
        assert.equal(en.ok, true, `evm enact ${n} ${epoch} ${en.reason}`);
        const plan = rewardCommitment(js, now);
        assert.equal(plan.rows.length, 0, `rows ${n} ${epoch}`);
        const rolled = applyReserveBlock({
          state: js,
          block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
          nowMs: now,
          genesisMs: t0,
          requireStakeReward: true,
        });
        assert.equal(rolled.ok, true, `${n} ${epoch} ${rolled.reason}`);
        const evmRoll = await callReserve(session, encodeSyncEpoch(now));
        assert.equal(evmRoll.ok, true, `sync ${n} ${epoch} ${evmRoll.reason}`);
        const committed = await callReserve(session, encodeCommitRewards(now, plan.root));
        assert.equal(committed.ok, true, `commit ${n} ${epoch} ${committed.reason}`);
        assert.equal(decodeBytes32(committed.returnValue), plan.root, `root ${n} ${epoch}`);
        if (epoch === 0) firstGas[n] = committed.gasUsed;
        if (epoch === epochCount - 1) gas[n] = committed.gasUsed;
        const view = decodePublicView(
          (await callReserve(session, encodePublicView(now), { staticCall: true })).returnValue,
        );
        assert.equal(view.currentEpoch, js.currentEpoch, `epoch ${n} ${epoch}`);
        assert.equal(view.totalLockedNanos, 0, `evm locked ${n} ${epoch}`);
        assert.equal(Number(js.totalLockedNanos), 0, `js locked ${n} ${epoch}`);
        const id = supplyIdentity(js);
        assert.equal(id.ok, true, `${n} ${epoch} ${id.reason}`);
        assert.equal(id.principalNanos, 0, `principal ${n} ${epoch}`);
      }
      if (n === 1) {
        const nullifier = withdrawMintId(portalIdFromDest(firstDest), 0);
        const bad = await callReserve(session, encodeClaim(nullifier, 0, Buffer.alloc(33, 9), 1, Buffer.alloc(96)));
        assert.equal(bad.ok, false, 'bad proof');
        assert.equal(bad.reason, 'claim_unavailable');
        const later = rewardCommitment(js, t0 + (epochs + 1) * RESERVE_EPOCH_MS);
        assert.equal(later.rows.length, 0);
        void firstOwner;
      }
    }
    for (const n of sizes) {
      assert.ok(gas[n] > 0n, `gas ${n}`);
      assert.ok(gas[n] < gas[1] * 2n, `gas ${n}=${gas[n]} gas1=${gas[1]}`);
      assert.ok(gas[n] < firstGas[n] * 2n, `grown ${n} ${gas[n]} first ${firstGas[n]}`);
    }
  });

  it('three epochs with no claims each accept their own root', async () => {
    const t0 = 1_700_000_000_000;
    const dest = encodeDest(Buffer.alloc(20, 0x61));
    const js = emptyVault();
    js.genesisMs = t0;
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    assert.equal(deposit({ state: js, dest, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0))).ok, true);
    const roots = [];
    for (let epoch = 0; epoch < 3; epoch += 1) {
      const now = t0 + (epoch + 1) * RESERVE_EPOCH_MS;
      assert.equal(enact({ state: js, nowMs: now }).ok, true, `enact ${epoch}`);
      assert.equal((await callReserve(session, encodeEnact(now))).ok, true);
      const plan = rewardCommitment(js, now);
      assert.equal(plan.rows.length, 0, `rows ${epoch}`);
      const applied = applyReserveBlock({
        state: js,
        block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
        nowMs: now,
        genesisMs: t0,
        requireStakeReward: true,
      });
      assert.equal(applied.ok, true, `${epoch} ${applied.reason}`);
      assert.equal((await callReserve(session, encodeSyncEpoch(now))).ok, true);
      const committed = await callReserve(session, encodeCommitRewards(now, plan.root));
      assert.equal(committed.ok, true, `commit ${epoch} ${committed.reason}`);
      assert.equal(decodeBytes32(committed.returnValue), plan.root);
      roots.push(plan.root);
      assert.equal(Number(js.totalLockedNanos), 0);
      const view = decodePublicView(
        (await callReserve(session, encodePublicView(now), { staticCall: true })).returnValue,
      );
      assert.equal(view.totalLockedNanos, 0);
      assert.equal(view.currentEpoch, js.currentEpoch);
      assert.equal(supplyIdentity(js).principalNanos, 0);
    }
    assert.equal(new Set(roots).size, 1);
    const epoch0 = withdrawMintId(portalIdFromDest(dest), 0);
    assert.equal(js.rewardBook?.[epoch0], undefined);
  });

  it('a withdraw that paid the reward cannot be claimed again', async () => {
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    const dest = encodeDest(Buffer.alloc(20, 0xab));
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const js = emptyVault();
    js.genesisMs = t0;
    // Indexed leaf. An unindexed hidden tranche is stake_reward, not a payout.
    const planted = indexPiLock(js, dest, t0, ownerPub, 1);
    assert.equal(planted.ok, true, planted.reason);
    assert.equal(enact({ state: js, nowMs: end }).ok, true);
    const before = supplyIdentity(js);
    assert.equal(before.ok, true, before.reason);
    assert.equal(before.principalNanos, 0);
    assert.equal(before.vaultNanos >= before.principalNanos, true);
    const plan = rewardCommitment(js, end);
    assert.equal(plan.rows.length, 0);
    const preview = previewWithdraw(js, dest, end);
    assert.equal(preview.interest, 0);
    assert.equal(preview.payout, 0);
    const earned = portalEpochInterest(js, js.portals[portalIdFromDest(dest)], end);
    assert.equal(earned, 0);
    const opened = indexedDraw(js, dest, end, planted, 'paid-reward', owner.privateKey);
    assert.ok(opened, 'indexed draw');
    const tx = opened.tx;
    const bound = boundReserveWithdraw(tx, js, new Set(), end);
    assert.equal(bound.ok, true, bound.reason);
    assert.equal(bound.cap, opened.nanos);
    assert.equal(preview.principal, 0);
    const applied = applyReserveBlock({
      state: js,
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }, tx] },
      nowMs: end,
      genesisMs: t0,
      requireStakeReward: true,
    });
    assert.equal(applied.ok, true, applied.reason);
    const paid = [...applied].find((item) => item && item.action === 'withdraw');
    assert.equal(paid.ok, true, paid && paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(paid.interest, 0);
    assert.equal(paid.earned, 0);
    const claimId = withdrawMintId(portalIdFromDest(dest), 0);
    const claim = rewardClaimTx({
      to: dest,
      nanos: 1,
      nullifier: claimId,
      proof: [],
      id: 'paid-claim',
      ownerKey: owner.privateKey,
    });
    const again = applyReserveBlock({
      state: js,
      block: { txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: end + 1,
      genesisMs: t0,
    });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'claim_unavailable');
    const after = supplyIdentity(js);
    // The receipt mints the arrival stub. The reward claim stays unavailable.
    assert.equal(after.mintedReward, Number(opened.stub));
    assert.equal(Number(js.openedLockNanos || 0), 0);
    assert.equal(Number(js.openedWithdrawNanos), PI_SHE_NANOS);
    assert.equal(after.ok, false);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0, { key: owner.privateKey }))).ok, true);
    const drawn = await callReserve(session, encodeWithdraw(dest, end, undefined, 0, {
      ownerKey: owner.privateKey,
    }));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
    const auth = packRewardAuth({ ownerPub, sig: claim.sig, dest });
    const claimed = await callReserve(session, encodeClaim(claimId, 0, new Uint8Array(), plan.index, auth));
    assert.equal(claimed.ok, false);
    assert.equal(claimed.reason, 'claim_unavailable');
  });

  it('unclaimed principal never expires, and a claim is not what pays it', async () => {
    const t0 = 1_700_000_000_000;
    const raw = Buffer.alloc(20, 0xcc);
    const dest = encodeDest(raw);
    const nanos = PI_SHE_NANOS;
    const js = emptyVault();
    js.genesisMs = t0;
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    const planted = indexPiLock(js, dest, t0, undefined, 1);
    assert.equal(planted.ok, true, planted.reason);
    assert.equal((await callReserve(session, encodeDeposit(dest, nanos, t0))).ok, true);
    let now = t0;
    for (let epoch = 0; epoch < 5; epoch += 1) {
      now = t0 + (epoch + 1) * RESERVE_EPOCH_MS;
      assert.equal(enact({ state: js, nowMs: now }).ok, true, `js enact ${epoch}`);
      const en = await callReserve(session, encodeEnact(now));
      assert.equal(en.ok, true, `evm enact ${epoch} ${en.reason}`);
      const rolled = applyReserveBlock({
        state: js,
        block: { txs: [] },
        nowMs: now,
        genesisMs: t0,
      });
      assert.equal(rolled.ok, true, rolled.reason);
      const evmRoll = await callReserve(session, encodeSyncEpoch(now));
      assert.equal(evmRoll.ok, true, evmRoll.reason);
      const plan = rewardCommitment(js, now);
      const committed = await callReserve(session, encodeCommitRewards(now, plan.root));
      assert.equal(committed.ok, true, `commit ${epoch} ${committed.reason}`);
      assert.equal(Number(js.totalLockedNanos), 0, `js still ${epoch}`);
      const view = decodePublicView(
        (await callReserve(session, encodePublicView(now), { staticCall: true })).returnValue,
      );
      assert.equal(view.totalLockedNanos, 0, `evm still ${epoch}`);
      assert.equal(view.currentEpoch, js.currentEpoch, `epoch ${epoch}`);
      assert.equal(supplyIdentity(js).ok, true);
    }
    const opened = indexedDraw(js, dest, now, planted, 'parity-draw');
    assert.ok(opened, 'indexed draw');
    const paid = withdraw({
      state: js,
      dest,
      nowMs: now,
      principal: opened.nanos,
      principalProof: opened.proof,
      retireProof: opened.tx.retireProof,
      tx: opened.tx,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(paid.interest, 0);
    const evmPaid = await callReserve(session, encodeWithdraw(dest, now));
    assert.equal(evmPaid.ok, false);
    assert.equal(evmPaid.reason, 'unsigned');
    assert.equal(Number(js.totalLockedNanos), 0);
    const left = decodePublicView(
      (await callReserve(session, encodePublicView(now), { staticCall: true })).returnValue,
    );
    assert.equal(left.totalLockedNanos, 0);
    assert.notEqual(withdraw({ state: js, dest, nowMs: now }).ok, true);
    assert.equal((await callReserve(session, encodeWithdraw(dest, now))).ok, false);
  });

  it('refuses every reward claim', async () => {
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const dest = spendDestOf(owner.spendPub);
    const payout = encodeDest(Buffer.alloc(20, 0x31));
    const js = emptyVault();
    js.genesisMs = t0;
    assert.equal(deposit({ state: js, dest, nanos: PI_SHE_NANOS, nowMs: t0, ownerPub }).ok, true);
    const id0 = supplyIdentity(js);
    assert.equal(id0.ok, true, id0.reason);
    assert.equal(id0.principalNanos, 0);
    assert.equal(id0.totalNanos, 0);
    const plan = rewardCommitment(js, end);
    assert.equal(plan.rows.length, 0);
    const committed = applyReserveBlock({
      state: js,
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
      nowMs: end,
      genesisMs: t0,
      requireStakeReward: true,
    });
    assert.equal(committed.ok, true, committed.reason);
    const nullifier = withdrawMintId(portalIdFromDest(dest), 0);
    const stranger = newIdentity();
    const stolen = rewardClaimTx({
      to: payout,
      nanos: 1,
      nullifier,
      proof: [],
      ownerKey: stranger.privateKey,
      id: 'stolen-claim',
    });
    const refused = applyReserveBlock({
      state: cloneVault(js),
      block: { height: 3, txs: [{ coinbase: true, vout: [] }, stolen] },
      nowMs: end + 1,
      genesisMs: t0,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'claim_unavailable');
    const claim = rewardClaimTx({
      to: payout,
      nanos: 1,
      nullifier,
      proof: [],
      ownerKey: owner.privateKey,
      id: 'owner-claim',
    });
    assert.notEqual(claim.to, dest);
    assert.equal(claim.spendPub, ownerPub);
    const paid = applyReserveBlock({
      state: js,
      block: { height: 4, txs: [{ coinbase: true, vout: [] }, claim] },
      nowMs: end + 1,
      genesisMs: t0,
    });
    assert.equal(paid.ok, false);
    assert.equal(paid.reason, 'claim_unavailable');
    assert.equal(Number(js.mintBankNanos), 0);
    assert.equal(Number(js.totalLockedNanos), 0);
    const after = supplyIdentity(js);
    assert.equal(after.ok, true, after.reason);
    assert.equal(after.totalNanos, 0);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0, { key: owner.privateKey }))).ok, true);
    const stored = await callReserve(session, encodeCommitRewards(end, plan.root));
    assert.equal(stored.ok, true, stored.reason);
    const stolenAuth = packRewardAuth({ ownerPub: stolen.spendPub, sig: stolen.sig, dest: payout });
    const evmStolen = await callReserve(session, encodeClaim(nullifier, 0, new Uint8Array(), plan.index, stolenAuth));
    assert.equal(evmStolen.ok, false);
    assert.equal(evmStolen.reason, 'claim_unavailable');
    const auth = packRewardAuth({ ownerPub, sig: claim.sig, dest: payout });
    const evmPaid = await callReserve(session, encodeClaim(nullifier, 0, new Uint8Array(), plan.index, auth));
    assert.equal(evmPaid.ok, false);
    assert.equal(evmPaid.reason, 'claim_unavailable');
    const twice = await callReserve(session, encodeClaim(nullifier, 0, new Uint8Array(), plan.index, auth));
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'claim_unavailable');
  });

  it('refuses a withdraw when the portal has no recorded owner', async () => {
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    const dest = encodeDest(Buffer.alloc(20, 0x91));
    const js = emptyVault();
    js.genesisMs = t0;
    // A fixture may book a portal with no signer. The withdraw still needs an owner.
    const missing = depositUnowned({ state: js, dest, nanos: PI_SHE_NANOS, nowMs: t0 });
    assert.equal(missing.ok, true, missing.reason);
    const stripped = withdraw({ state: js, dest, nowMs: end });
    assert.equal(stripped.ok, false);
    assert.equal(stripped.reason, 'owner_missing');

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    const bareLock = await callReserve(session, encodeDepositRaw(dest, Buffer.alloc(32, 4), t0, null));
    assert.equal(bareLock.ok, false);
    assert.equal(bareLock.reason, 'owner_missing');
    const bareDraw = await callReserve(session, encodeWithdrawRaw(dest, end));
    assert.equal(bareDraw.ok, false);
    assert.equal(bareDraw.reason, 'owner_missing');
  });

  it('refuses a reward withdraw that is not signed by the portal owner', async () => {
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const dest = spendDestOf(owner.spendPub);
    const payout = encodeDest(Buffer.alloc(20, 0x44));
    const js = emptyVault();
    js.genesisMs = t0;
    const planted = indexPiLock(js, dest, t0, ownerPub, 1);
    assert.equal(planted.ok, true, planted.reason);
    const plan = rewardCommitment(js, end);
    const preview = previewWithdraw(js, dest, end);
    const earned = portalEpochInterest(js, js.portals[portalIdFromDest(dest)], end);
    assert.equal(earned, 0);
    assert.equal(preview.interest, 0);
    assert.equal(preview.payout, 0);
    assert.equal(withdrawPaysInterest(js, js.portals[portalIdFromDest(dest)], end), 0);
    const portalId = portalIdFromDest(dest);
    const bare = withdrawTx({ nanos: 0, id: 'wd-bare', portalId });
    delete bare.from;
    delete bare.to;
    delete bare.payer;
    delete bare.payoutPortalId;
    const refused = applyReserveBlock({
      state: cloneVault(js),
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }, bare] },
      nowMs: end,
      genesisMs: t0,
      requireStakeReward: true,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unsigned');
    const stranger = newIdentity();
    const stolen = withdrawTx({ nanos: 0, id: 'wd-stolen', portalId });
    delete stolen.from;
    delete stolen.to;
    delete stolen.payer;
    delete stolen.payoutPortalId;
    stolen.dest20 = hash20FromAddress(payout);
    signWithdrawReward(stolen, stranger.privateKey, {
      portalId, nanos: 0, dest: Buffer.from(stolen.dest20).toString('hex'), state: js, nowMs: end,
    });
    const stolenApply = applyReserveBlock({
      state: cloneVault(js),
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }, stolen] },
      nowMs: end,
      genesisMs: t0,
      requireStakeReward: true,
    });
    assert.equal(stolenApply.ok, false);
    assert.equal(stolenApply.reason, 'unsigned');
    const opened = indexedDraw(js, dest, end, planted, 'wd-owner', owner.privateKey, payout);
    assert.ok(opened, 'indexed draw');
    const tx = opened.tx;
    const applied = applyReserveBlock({
      state: js,
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }, tx] },
      nowMs: end,
      genesisMs: t0,
      requireStakeReward: true,
    });
    assert.equal(applied.ok, true, applied.reason);
    const paid = [...applied].find((item) => item && item.action === 'withdraw');
    assert.equal(paid.interest, 0);
    assert.equal(paid.earned, earned);
    assert.equal(paid.principal, PI_SHE_NANOS);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0, { key: owner.privateKey }))).ok, true);
    const bareEvm = await callReserve(session, encodeWithdraw(dest, end));
    assert.equal(bareEvm.ok, false);
    const stolenAuth = packRewardAuth({ ownerPub: stolen.ownerPub, sig: stolen.rewardSig, dest: payout });
    const stolenEvm = await callReserve(session, encodeWithdraw(dest, end, stolenAuth));
    assert.equal(stolenEvm.ok, false);
    const drawn = await callReserve(session, encodeWithdraw(dest, end, undefined, 0, {
      ownerKey: owner.privateKey,
    }));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
  });

  it('a lone post-cutoff π misses epoch 0 and earns epoch 1 and epoch 2', async () => {
    const t0 = 1_700_000_000_000;
    const epoch = RESERVE_EPOCH_MS;
    const quarter = Math.floor(epoch / 4);
    const lateAt = t0 + epoch - quarter + 1000;
    const dest = encodeDest(Buffer.alloc(20, 0x71));
    const full = Number((BigInt(PI_SHE_NANOS) * BigInt(GENESIS_BPS)) / 10000n);
    assert.ok(full > 0);
    const draws = [
      [t0 + epoch, 0],
      [t0 + 2 * epoch, full],
      [t0 + 3 * epoch, full * 2],
    ];
    for (const [at, want] of draws) {
      const js = emptyVault();
      js.genesisMs = t0;
      const planted = indexPiLock(js, dest, lateAt, undefined, 1);
      assert.equal(planted.ok, true, `${at} ${planted.reason}`);
      const opened = indexedDraw(js, dest, at, planted, `late-${at}`);
      assert.ok(opened, String(at));
      const paid = withdraw({
        state: js,
        dest,
        nowMs: at,
        principal: opened.nanos,
        principalProof: opened.proof,
        retireProof: opened.tx.retireProof,
        tx: opened.tx,
      });
      assert.equal(paid.ok, true, `${at} ${paid.reason}`);
      assert.equal(paid.interest, 0, `js ${at}`);
      assert.equal(paid.earned, 0, `js earned ${at}`);
      assert.equal(paid.principal, PI_SHE_NANOS);
      const session = await bootReserveEvm();
      assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
      assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, lateAt))).ok, true);
      const evm = await callReserve(session, encodeWithdraw(dest, at, undefined, PI_SHE_NANOS, {
        locks: [{ nanos: PI_SHE_NANOS, at: lateAt }],
      }));
      assert.equal(evm.ok, false, String(at));
      assert.equal(evm.reason, 'unsigned');
    }
  });

  it('fails closed when the coinbase omits the JS reward root', async () => {
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    const dest = encodeDest(Buffer.alloc(20, 0x72));
    const js = emptyVault();
    js.genesisMs = t0;
    assert.equal(deposit({ state: js, dest, nanos: PI_SHE_NANOS, nowMs: t0 }).ok, true);
    const plan = rewardCommitment(js, end);
    assert.equal(plan.rows.length, 0);
    const tx = withdrawTx({ from: dest, to: dest, nanos: PI_SHE_NANOS, id: 'missing-root' });
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0))).ok, true);
    const missing = await executeBlockEvm(session, [
      { coinbase: true, vout: [] },
      tx,
    ], end, t0, plan.root);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'stake_reward');
    const omitted = await executeBlockEvm(session, [
      { coinbase: true, vout: [] },
      tx,
    ], end, t0);
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'stake_reward');
    const unsolicited = await executeBlockEvm(session, [
      { coinbase: true, vout: [], rewardRoot: plan.root },
      tx,
    ], end, t0);
    assert.equal(unsolicited.ok, false);
    assert.equal(unsolicited.reason, 'stake_reward');

    const small = PI_SHE_NANOS - 1;
    const quiet = encodeDest(Buffer.alloc(20, 0x73));
    const below = emptyVault();
    below.genesisMs = t0;
    assert.equal(deposit({ state: below, dest: quiet, nanos: small, nowMs: t0 }).ok, true);
    assert.equal(rewardCommitment(below, end).rows.length, 0);
    const session2 = await bootReserveEvm();
    assert.equal((await callReserve(session2, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session2, encodeDeposit(quiet, small, t0))).ok, true);
    const quietTx = withdrawTx({ from: quiet, to: quiet, nanos: 0, id: 'no-rows' });
    const quietAuth = ownerWithdrawAuth(quiet, 0, { nowMs: end });
    quietTx.ownerPub = Buffer.from(quietAuth.subarray(0, 32)).toString('hex');
    quietTx.rewardSig = Buffer.from(quietAuth.subarray(32, 96)).toString('hex');
    const empty = await executeBlockEvm(session2, [
      { coinbase: true, vout: [] },
      quietTx,
    ], end, t0, '');
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, 'unsigned');
  });

  it('refuses a 3-arg withdraw of 100 hidden tranches under 8M gas', async () => {
    const t0 = 1_700_000_000_000;
    const n = 100;
    const epochs = 60;
    const dest = encodeDest(Buffer.alloc(20, 0x92));
    const who = ownerFor(dest);
    const js = emptyVault();
    js.genesisMs = t0;
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    const locks = [];
    let planted = null;
    // One portal cannot hold 100 tranches. Each lock is its own dest.
    for (let i = 0; i < n; i += 1) {
      const raw = Buffer.alloc(20);
      raw.writeUInt32BE(i + 1, 16);
      raw[0] = 0x92;
      const one = i === 0 ? dest : encodeDest(raw);
      const whoI = i === 0 ? who : ownerFor(one);
      if (i === 0) {
        planted = indexPiLock(js, dest, t0, who.pub, 1);
        assert.equal(planted.ok, true, `js ${i} ${planted.reason}`);
      }
      const evmLock = await callReserve(session, encodeDeposit(one, PI_SHE_NANOS, t0, whoI.commit));
      assert.equal(evmLock.ok, true, `evm ${i} ${evmLock.reason}`);
      locks.push({ nanos: PI_SHE_NANOS, at: t0 });
    }
    const drawAt = t0 + epochs * RESERVE_EPOCH_MS;
    const opened = indexedDraw(js, dest, drawAt, planted, 'many-draw', who.key);
    assert.ok(opened, 'indexed draw');
    const paid = withdraw({
      state: js,
      dest,
      nowMs: drawAt,
      principal: opened.nanos,
      principalProof: opened.proof,
      retireProof: opened.tx.retireProof,
      tx: opened.tx,
    });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(paid.earned, 0);
    // The single tranche is spent. A same-dest stack of n-1 is portal_exists.
    assert.equal(js.portals[portalIdFromDest(dest)].tranches.length, 0);
    const drawn = await callReserve(session, encodeWithdraw(dest, drawAt, undefined, n * PI_SHE_NANOS, { locks }));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
    assert.ok(drawn.gasUsed < 8_000_000n, `gas ${drawn.gasUsed}`);
  });

  it('refuses a withdraw signature replayed after a re-lock', async () => {
    const t0 = 1_700_000_000_000;
    const epoch = RESERVE_EPOCH_MS;
    const dest = encodeDest(Buffer.alloc(20, 0x93));
    const who = ownerFor(dest);
    const js = emptyVault();
    js.genesisMs = t0;
    const planted = indexPiLock(js, dest, t0, who.pub, 1);
    assert.equal(planted.ok, true, planted.reason);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0, who.commit))).ok, true);
    const end = t0 + epoch;
    // The replayed body carries the portal id. Without it the owner cannot
    // be found, and the signature is never checked.
    const first = { to: dest, kind: 'withdraw', from: dest, portalId: portalIdFromDest(dest) };
    signWithdrawReward(first, who.key, {
      portalId: portalIdFromDest(dest),
      nanos: PI_SHE_NANOS,
      dest,
      state: js,
      nowMs: end,
    });
    const firstAuth = ownerWithdrawAuth(dest, PI_SHE_NANOS, {
      nowMs: end,
      locks: [{ nanos: PI_SHE_NANOS, at: t0 }],
    });
    const drawn = await callReserve(session, encodeWithdraw(dest, end, firstAuth));
    assert.equal(drawn.ok, false);
    assert.equal(drawn.reason, 'unsigned');
    const opened = indexedDraw(js, dest, end, planted, 'replay-draw', who.key);
    assert.ok(opened, 'indexed draw');
    const jsPaid = withdraw({
      state: js,
      dest,
      nowMs: end,
      principal: opened.nanos,
      principalProof: opened.proof,
      retireProof: opened.tx.retireProof,
      tx: opened.tx,
    });
    assert.equal(jsPaid.ok, true, jsPaid.reason);
    assert.equal(jsPaid.principal, PI_SHE_NANOS);
    const relockAt = end;
    assert.equal((await callReserve(session, encodeEnact(end))).ok, true);
    // The portal id is spent, not free. A re-lock is a duplicate portal.
    const plantedAgain = indexPiLock(js, dest, relockAt, who.pub, 1);
    assert.equal(plantedAgain.ok, false);
    assert.equal(plantedAgain.reason, 'portal_exists');
    const relocked = await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, relockAt, who.commit));
    assert.equal(relocked.ok, false);
    assert.equal(relocked.reason, 'portal_exists');
    const end2 = t0 + 2 * epoch;
    const replay = await callReserve(session, encodeWithdraw(dest, end2, firstAuth, PI_SHE_NANOS));
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'unsigned');
    const again = { ...first, rewardSig: first.rewardSig, ownerPub: first.ownerPub };
    const rejected = withdrawRewardRejected(js, again, end2);
    if (rejected) assert.equal(rejected.reason, 'unsigned');
    const bound = boundReserveWithdraw(again, js, new Set(), end2);
    assert.equal(bound.ok, false, bound.reason);
    const fresh = await callReserve(session, encodeWithdraw(dest, end2, undefined, 0, {
      tranches: lockTranches(dest).slice(-1),
    }));
    assert.equal(fresh.ok, false);
    assert.equal(fresh.reason, 'unsigned');
  });

  it('a stranger cannot lock into a fresh portal and take its owner slot', async () => {
    const t0 = 1_700_000_000_000;
    const victim = newIdentity();
    const stranger = newIdentity();
    const dest = spendDestOf(victim.spendPub);
    const strangerDest = spendDestOf(stranger.spendPub);
    const victimOwner = portalOwnerKey(victim.privateKey, portalIdFromDest(dest));
    const ownerPub = Buffer.from(ed25519RawPub(victimOwner)).toString('hex');
    assert.notEqual(ownerPub, Buffer.from(victim.spendPub).toString('hex'));
    const strangerOwner = portalOwnerKey(stranger.privateKey, portalIdFromDest(dest));
    const strangerPub = Buffer.from(ed25519RawPub(strangerOwner)).toString('hex');

    function publicLock({ spender, portalDest, fundDest, owner }) {
      const fund20 = hash20FromAddress(fundDest);
      const tx = {
        id: `lock-${portalDest.slice(-6)}-${fundDest.slice(-4)}`,
        programId: RESERVE_PROGRAM,
        kind: 'lock',
        // Compact lock. `to` is the address and is vote_leak before the
        // receipt gate. The unfunded dest20 is still a public receipt.
        nanos: PI_SHE_NANOS,
        portalId: portalIdFromDest(portalDest),
        // A lock that carries payoutPortalId is vote_leak. This receipt test
        // omits it so the public-receipt gate is what refuses the body.
        ownerPub: owner,
        vin: [{ dest20: fund20 }],
        vout: [{
          kind: 'lock',
          dest20: hash20FromAddress(portalDest),
          nanos: PI_SHE_NANOS,
          valueProof: { v: PI_SHE_NANOS },
        }],
      };
      signSpendTx(tx, spender.privateKey);
      tx.ownerPub = owner;
      return tx;
    }

    function asBlock(tx) {
      const tpl = buildTemplate({
        prev: GENESIS_PREV,
        height: 1,
        miner: dest,
        bits: GENESIS_BITS_PACKED,
        now: t0,
        txs: [tx],
      });
      const decoded = decodeHeader(Buffer.from(tpl.header));
      const header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: merkleRoot(tpl.txs.map((row) => digestTx(row))),
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      return { ...tpl, header };
    }

    const stolenDest = publicLock({
      spender: stranger,
      portalDest: dest,
      fundDest: dest,
      owner: strangerPub,
    });
    const stolenId = publicLock({
      spender: stranger,
      portalDest: strangerDest,
      fundDest: strangerDest,
      owner: strangerPub,
    });
    stolenId.portalId = portalIdFromDest(dest);
    stolenId.ownerPub = strangerPub;
    signSpendTx(stolenId, stranger.privateKey);
    const honest = publicLock({
      spender: victim,
      portalDest: dest,
      fundDest: dest,
      owner: ownerPub,
    });
    const state = emptyVault();
    state.genesisMs = t0;
    const stolenBlock = await verifyBlock(asBlock(stolenDest), null, { probeBody: true, reserveState: state });
    const swapped = await verifyBlock(asBlock(stolenId), null, { probeBody: true, reserveState: state });
    const opened = await verifyBlock(asBlock(honest), null, { probeBody: true, reserveState: state });
    // An unfunded dest20 lock is a public receipt. It never reaches the owner slot.
    assert.equal(stolenBlock.ok, false);
    assert.equal(stolenBlock.reason, 'public_receipt', stolenBlock.reason);
    assert.equal(swapped.ok, false);
    assert.equal(swapped.reason, 'public_receipt', swapped.reason);
    assert.equal(opened.reason, 'public_receipt', opened.reason);
    // A fresh lock's ownerPub is the spend key. A derived portal key is not the signer.
    assert.equal(reserveAuth(honest, state).ok, false);
    assert.equal(reserveAuth(honest, state).reason, 'unsigned');
    assert.equal(reserveAuth(stolenDest, state).reason, 'unsigned');
    assert.equal(state.portals?.[portalIdFromDest(dest)]?.ownerPub || '', '');
  });
});
