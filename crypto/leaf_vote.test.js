import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_BPS,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
  consensusFingerprint,
} from './asert.js';
import { levyNanos } from './levy.js';
import { typedCommitSum } from './spend.js';
import { VAULT_DAY_BLOCKS } from './vault_accrual.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packVaultOutput, proveLeafVote, proveVaultReward, proveLeafRetire, vaultLockNote } from './vault_reward_fs1.js';
import {
  applyLeafVote,
  applyReserveBlock,
  emptyVault,
  trialReserveApply,
  vote,
} from './reserve_vault.js';
import {
  bootReserveEvm,
  callReserve,
  decodeCastVote,
  decodePublicView,
  decodeTallyStep,
  encodeCastVote,
  encodeCommitEpochCensus,
  encodeCommitEpochStartRoot,
  encodeEnact,
  encodePinClock,
  encodePublicView,
  encodeSyncEpoch,
  encodeTallyBallot,
} from './reserve_evm.js';
import { encodeDeposit } from './owned_portal.js';
import { handleWalletApi } from '../pool/src/wallet_api.js';
import {
  MAX_BLOCK_LEAF_VOTES,
  RATE_CEIL_BPS,
  RATE_FLOOR_BPS,
  VOTE_FINALITY_BLOCKS,
  VOTE_SEQ_CAP,
  ballotDirection,
  castVotePlan,
  loadVotePlan,
  saveVotePlan,
  votePlanPath,
  VOTE_EDGE_BLOCKS,
  VOTE_MIN_SEPARATION,
  commitCensus,
  proposalId,
  recordVote,
  stepRate,
  tallyBallot,
  voteCloseDay,
  voteKey,
  voteWindowOpen,
} from './leaf_vote.js';

const T0 = 1_700_000_000_000;
const DAYS = [0, 1, 300, 301, 302];
const EPOCHS = [1, 3];
const SIZES = [1, 5, 20];

function locksOf(n, salt) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      amount: PI_SHE_NANOS,
      scalar: BigInt(salt * 100 + i + 3),
      blind: BigInt(salt * 1000 + i + 9),
    });
  }
  return rows;
}

function proveVote(locks, which, epoch, { choice = 1, seq = 1, param = 'hb' } = {}) {
  const pid = proposalId(epoch, param);
  return proveLeafVote({
    locks,
    which,
    epoch,
    choice,
    seq,
    proposalId: pid,
    dest20: Buffer.alloc(20, (epoch + which + 1) & 0xff),
  });
}

function openHeight(epoch) {
  return epoch * 3840;
}

function heightAt(epoch, day) {
  return openHeight(epoch) + day * VAULT_DAY_BLOCKS;
}

function voteTx(proved, epoch, { choice = 1, seq = 1, param = 'hb', height, leaves } = {}) {
  const tx = {
    kind: 'leaf-vote',
    programId: RESERVE_PROGRAM,
    voteProof: proved.blob,
    voteOutput: proved.note,
    choice,
    voteSeq: seq,
    voteParam: param,
    earnEpoch: epoch,
    height,
    fee: 0,
  };
  tx.fee = levyNanos(0, { tx });
  void leaves;
  return tx;
}

function arm(state, epoch, proved, leaves) {
  if (!state.epochStartRoots) state.epochStartRoots = Object.create(null);
  state.epochStartRoots[String(epoch)] = proved.rootHex;
  const census = commitCensus(state, epoch, leaves, openHeight(epoch));
  assert.equal(census.ok, true, census.reason);
  state.magic = MAGIC_TESTNET;
  state.epochBps = GENESIS_BPS;
}

describe('leaf ballot window, step, and wording', () => {
  it('uses the stake cutoff, and mainnet closes on day 301', () => {
    assert.equal(voteCloseDay(MAGIC_MAINNET), 301);
    assert.equal(voteCloseDay(MAGIC_TESTNET), 3);
    for (const epoch of EPOCHS) {
      for (const leaves of SIZES) {
        for (const day of DAYS) {
          const open = openHeight(epoch);
          const main = voteWindowOpen(open, heightAt(epoch, day), MAGIC_MAINNET);
          const test = voteWindowOpen(open, heightAt(epoch, day), MAGIC_TESTNET);
          assert.equal(main, day <= 301, `mainnet e${epoch} n${leaves} day ${day}`);
          assert.equal(test, day <= 3, `testnet e${epoch} n${leaves} day ${day}`);
        }
      }
    }
  });

  it('steps at most ten percent, holds a tie, and fails a missing census closed', () => {
    assert.equal(stepRate(281, 1, RATE_FLOOR_BPS, RATE_CEIL_BPS), 309);
    assert.equal(stepRate(281, -1, RATE_FLOOR_BPS, RATE_CEIL_BPS), 253);
    assert.equal(stepRate(281, 0, RATE_FLOOR_BPS, RATE_CEIL_BPS), 281);
    assert.equal(stepRate(9, 1, RATE_FLOOR_BPS, RATE_CEIL_BPS), 9);
    assert.equal(stepRate(1, 1, 1, 1), 1);
    assert.equal(stepRate(1, -1, 1, 1), 1);
    assert.equal(stepRate(2000, 1, RATE_FLOOR_BPS, RATE_CEIL_BPS), 2000);
    assert.equal(stepRate(100, -1, RATE_FLOOR_BPS, RATE_CEIL_BPS), 100);
    assert.equal(ballotDirection(1, 0, 0, 5), 1);
    assert.equal(ballotDirection(1, 1, 0, 2), 0);
    assert.equal(ballotDirection(1, 0, 0, 20), 0);
    assert.equal(ballotDirection(1, 0, 4, 0), 0);
    assert.equal(ballotDirection(2, 1, 0, 3), 1);
    assert.equal(ballotDirection(3, 2, 0, 5), 0);
    const sol = readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    assert.equal(/function\s+\w*veto/i.test(sol), false);
    assert.match(consensusFingerprint(), /VOTE_BALLOT=leaf-v2/);
    assert.match(consensusFingerprint(), /VOTE_VETO=none/);
    assert.match(consensusFingerprint(), new RegExp(`VOTE_CAP=${MAX_BLOCK_LEAF_VOTES}`));
  });

  it('plans one send per locked leaf and does not export the vote key', () => {
    assert.equal(castVotePlan(4), null);
    const fees = ['11', '22', '33', '44'].map((b) => b.repeat(32));
    const plan = castVotePlan(4, { feeInputs: fees });
    assert.equal(plan.label, 'Cast your 4 votes');
    assert.equal(plan.txs.length, 4);
    const heights = plan.txs.map((row) => row.height);
    const lo = VOTE_EDGE_BLOCKS;
    const hi = 3 * VAULT_DAY_BLOCKS - VOTE_EDGE_BLOCKS;
    for (const height of heights) assert.ok(height >= lo && height <= hi, String(height));
    const ordered = [...heights].sort((a, b) => a - b);
    for (let i = 1; i < ordered.length; i += 1) {
      assert.ok(ordered[i] - ordered[i - 1] >= VOTE_MIN_SEPARATION);
    }
    assert.equal(new Set(heights).size, 4);
    assert.equal(new Set(plan.txs.map((row) => row.feeInput)).size, 4);
    const dir = mkdtempSync(join(tmpdir(), 'vote-plan-'));
    saveVotePlan(dir, plan);
    const loaded = loadVotePlan(dir);
    assert.deepEqual(loaded.txs, plan.txs);
    assert.equal(statSync(votePlanPath(dir)).mode & 0o777, 0o600);
    const posted = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', {
      kind: 'send',
      lockedLeaves: [{ commit: 'ab'.repeat(32) }],
      planDir: dir,
    }, { queueSend: () => ({ ok: true }) });
    assert.equal(posted.status, 400);
    assert.equal(posted.json.reason, 'vote_plan_local');
    assert.equal(vote({}).reason, 'vote_retired');
    const proved = proveVote(locksOf(1, 4), 0, 1, { choice: 1, seq: 1 });
    assert.ok(proved);
    const key = voteKey(proved.locks[0].scalar);
    assert.ok(key);
    assert.equal(proved.voteKey, undefined);
    const tx = voteTx(proved, 1, { height: heightAt(1, 0) });
    const wire = JSON.stringify({
      kind: tx.kind,
      choice: tx.choice,
      voteSeq: tx.voteSeq,
      voteParam: tx.voteParam,
      tag: proved.voteTag.toString('hex'),
    });
    assert.equal(wire.includes(key.toString('hex')), false);
    assert.equal(typedCommitSum({ ...tx, fee: 0 }).reason, 'levy');
    assert.equal(typedCommitSum(tx).ok, true);
    assert.equal(typedCommitSum({ kind: 'vote', fee: 0, vout: [] }).ok, true);
  });
});

describe('one proof per live leaf', () => {
  it('matches JS and the EVM, including revote, reorg, quorum, and the window', async () => {
    const trees = new Map();
    for (const epoch of EPOCHS) {
      for (const n of SIZES) {
        const locks = locksOf(n, epoch * 10 + n);
        const proved = proveVote(locks, 0, epoch, { choice: 1, seq: 1, param: 'rr' });
        assert.ok(proved, `prove e${epoch} n${n}`);
        assert.equal(proved.voteKey, undefined);
        trees.set(`${epoch}:${n}`, { locks: proved.locks, proved });
      }
    }
    const revote = proveVote(trees.get('1:20').locks, 0, 1, { choice: 0, seq: 2, param: 'rr' });
    const other = proveVote(trees.get('1:20').locks, 1, 1, { choice: -1, seq: 1, param: 'rr' });
    const bonus = proveVote(trees.get('1:20').locks, 1, 1, { choice: -1, seq: 1, param: 'hb' });
    const over = proveVote(trees.get('1:20').locks, 0, 1, { choice: 1, seq: VOTE_SEQ_CAP + 1, param: 'rr' });
    assert.ok(revote);
    assert.ok(other);
    assert.ok(bonus);
    assert.equal(over, null);

    for (const epoch of EPOCHS) {
      for (const n of SIZES) {
        const { proved } = trees.get(`${epoch}:${n}`);
        for (const day of DAYS) {
          const state = emptyVault();
          arm(state, epoch, proved, n);
          const height = heightAt(epoch, day);
          const got = applyLeafVote(state, voteTx(proved, epoch, { param: 'rr', height }), height);
          const inside = day <= 3;
          assert.equal(got.ok, inside, `e${epoch} n${n} day ${day} ${got.reason}`);
          if (inside) assert.equal(got.up, 1);
        }
      }
    }

    const state = emptyVault();
    const base = trees.get('1:20').proved;
    arm(state, 1, base, 20);
    const day0 = heightAt(1, 0);
    const first = applyLeafVote(state, voteTx(base, 1, { param: 'rr', height: day0 }), day0);
    assert.equal(first.ok, true, first.reason);
    const again = applyLeafVote(state, voteTx(base, 1, { param: 'rr', height: day0 }), day0);
    assert.equal(again.reason, 'vote_locked');
    const batched = applyLeafVote(state, { ...voteTx(base, 1, { param: 'rr', height: day0 }), voteProofs: [base.proof] }, day0);
    assert.equal(batched.reason, 'stake_reward');
    const flipped = applyLeafVote(state, voteTx(base, 1, { param: 'hb', choice: 1, height: day0 }), day0);
    assert.equal(flipped.ok, false);
    const crossed = applyLeafVote(state, voteTx(base, 3, { param: 'rr', height: day0 }), day0);
    assert.equal(crossed.ok, false);
    state.magic = MAGIC_MAINNET;
    const chain = applyLeafVote(state, voteTx(base, 1, { param: 'rr', height: day0 }), day0);
    assert.equal(chain.ok, false);
    state.magic = MAGIC_TESTNET;
    const flash = trees.get('1:1').proved;
    const flashed = applyLeafVote(state, voteTx(flash, 1, { param: 'rr', height: day0 }), day0);
    assert.equal(flashed.ok, false);
    const changed = applyLeafVote(state, voteTx(revote, 1, { choice: 0, seq: 2, param: 'rr', height: day0 }), day0);
    assert.equal(changed.ok, true, changed.reason);
    assert.equal(changed.hold, 1);
    assert.equal(changed.up, 0);
    const same = applyLeafVote(state, voteTx(revote, 1, { choice: 0, seq: 2, param: 'rr', height: heightAt(1, 1) }), heightAt(1, 1));
    assert.equal(same.reason, 'vote_locked');
    const down = applyLeafVote(state, voteTx(other, 1, { choice: -1, seq: 1, param: 'rr', height: day0 }), day0);
    assert.equal(down.ok, true, down.reason);
    const held = tallyBallot(state, {
      epoch: 1,
      param: 'rr',
      height: openHeight(1) + 3 * VAULT_DAY_BLOCKS + VOTE_FINALITY_BLOCKS,
      magic: MAGIC_TESTNET,
    });
    assert.equal(held.ok, true, held.reason);
    assert.equal(held.step, 0);

    const session = await bootReserveEvm();
    const root = base.rootHex;
    assert.equal((await callReserve(session, encodeCommitEpochStartRoot(1, root))).ok, true);
    assert.equal((await callReserve(session, encodeCommitEpochCensus(1, 20, openHeight(1)))).ok, true);
    const packed = packVaultOutput(base.note);
    const cast = await callReserve(session, encodeCastVote({
      proof: base.blob,
      output: packed,
      paramId: 1,
      choice: 1,
      seq: 1,
      height: day0,
      epoch: 1,
    }));
    assert.equal(cast.ok, true, cast.reason);
    const piles = decodeCastVote(cast.returnValue);
    assert.equal(piles.up, 1);
    assert.equal(piles.turnout, 1);
    const late = await callReserve(session, encodeCastVote({
      proof: base.blob,
      output: packed,
      paramId: 1,
      choice: 1,
      seq: 1,
      height: heightAt(1, 302),
      epoch: 1,
    }));
    assert.equal(late.reason, 'epoch_closed');
    const dup = await callReserve(session, encodeCastVote({
      proof: base.blob,
      output: packed,
      paramId: 1,
      choice: 1,
      seq: 1,
      height: day0,
      epoch: 1,
    }));
    assert.equal(dup.reason, 'vote_locked');
    const rev = await callReserve(session, encodeCastVote({
      proof: revote.blob,
      output: packVaultOutput(revote.note),
      paramId: 1,
      choice: 0,
      seq: 2,
      height: day0,
      epoch: 1,
    }));
    assert.equal(rev.ok, true, rev.reason);
    assert.equal(decodeCastVote(rev.returnValue).hold, 1);
    assert.equal(decodeCastVote(rev.returnValue).up, 0);
    const cap = await callReserve(session, encodeCastVote({
      proof: revote.blob,
      output: packVaultOutput(revote.note),
      paramId: 1,
      choice: 0,
      seq: VOTE_SEQ_CAP + 1,
      height: day0,
      epoch: 1,
    }));
    assert.equal(cap.reason, 'vote_locked');
    const second = await callReserve(session, encodeCastVote({
      proof: other.blob,
      output: packVaultOutput(other.note),
      paramId: 1,
      choice: -1,
      seq: 1,
      height: day0,
      epoch: 1,
    }));
    assert.equal(second.ok, true, second.reason);
    assert.ok(Math.abs(Number(cast.gasUsed) - Number(second.gasUsed)) < 80_000);
    assert.ok(Number(cast.gasUsed) < 400_000);
    assert.ok(Number(rev.gasUsed) < 400_000);

    const sm = session.evm.stateManager;
    await sm.checkpoint();
    const third = await callReserve(session, encodeCastVote({
      proof: bonus.blob,
      output: packVaultOutput(bonus.note),
      paramId: 0,
      choice: -1,
      seq: 1,
      height: day0,
      epoch: 1,
    }));
    assert.equal(third.ok, true, third.reason);
    await sm.revert();
    const restored = await callReserve(session, encodeCastVote({
      proof: bonus.blob,
      output: packVaultOutput(bonus.note),
      paramId: 0,
      choice: -1,
      seq: 1,
      height: day0,
      epoch: 1,
    }));
    assert.equal(restored.ok, true, restored.reason);

    const tallyH = openHeight(1) + 3 * VAULT_DAY_BLOCKS + VOTE_FINALITY_BLOCKS;
    const early = await callReserve(session, encodeTallyBallot(1, 1, day0));
    assert.equal(early.reason, 'epoch_open');
    const step = await callReserve(session, encodeTallyBallot(1, 1, tallyH));
    assert.equal(step.ok, true, step.reason);
    assert.equal(decodeTallyStep(step.returnValue), 0);
  });

  it('applies a supermajority at the rollover and a reorg puts the rate back', () => {
    const state = emptyVault();
    state.genesisMs = T0;
    state.epochStartMs = T0 + RESERVE_EPOCH_MS;
    state.currentEpoch = 1;
    state.bonusEnacted = true;
    state.epochBps = 281;
    state.magic = MAGIC_TESTNET;
    assert.equal(commitCensus(state, 1, 5, openHeight(1)).ok, true);
    for (let i = 0; i < 4; i += 1) {
      const tag = Buffer.alloc(32, i + 1);
      const pid = proposalId(1, 'rr');
      const got = tallyReady(state, tag, pid);
      assert.equal(got.ok, true, got.reason);
    }
    const before = state.epochBps;
    const height = openHeight(1) + 3 * VAULT_DAY_BLOCKS + VOTE_FINALITY_BLOCKS;
    const rolled = trialReserveApply({
      state,
      inPlace: true,
      txs: [{
        kind: 'leaf-vote',
        programId: RESERVE_PROGRAM,
        fee: 0,
        voteParam: 'rr',
        choice: 1,
        voteSeq: 1,
        earnEpoch: 1,
      }],
      nowMs: T0 + 2 * RESERVE_EPOCH_MS,
      height,
      genesisMs: T0,
    });
    assert.equal(rolled.ok, false);
    assert.equal(state.epochBps, before);
    assert.equal(state.currentEpoch, 1);
    const applied = applyReserveBlock({
      state,
      block: { txs: [{ coinbase: true, vout: [] }] },
      nowMs: T0 + 2 * RESERVE_EPOCH_MS,
      height,
      genesisMs: T0,
    });
    assert.equal(applied.ok, true, applied.reason);
    assert.equal(state.epochBps, 309);
    assert.equal(Number(state.liveHashBonusNanos), 1);
    assert.equal(state.currentEpoch, 2);
  });

  it('keeps the hash-bonus unit inside the emission bound on the EVM roll', async () => {
    const session = await bootReserveEvm();
    const dest = 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    assert.equal((await callReserve(session, encodePinClock(T0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, T0))).ok, true);
    const end = T0 + RESERVE_EPOCH_MS;
    assert.equal((await callReserve(session, encodeEnact(end))).ok, true);
    assert.equal((await callReserve(session, encodeSyncEpoch(end))).ok, true);
    const view = decodePublicView((await callReserve(session, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(view.liveHashBonusNanos, 1);
    assert.equal(view.currentEpoch, 1);
  });

  it('a vote shares no 32-byte field with that leaf claim or retire', () => {
    const scalar = 7n;
    const blind = 9n;
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind);
    const claim = proveVaultReward({
      locks: [{ amount: PI_SHE_NANOS, scalar, blind }],
      which: 0,
      rootEpoch: 0,
      earnEpoch: 0,
      bps: GENESIS_BPS,
      remainMs: 3840,
      span: 3840,
      dest20: Buffer.alloc(20, 4),
    });
    const voteProof = proveLeafVote({
      locks: [{ amount: PI_SHE_NANOS, scalar, blind }],
      which: 0,
      epoch: 0,
      choice: 1,
      seq: 1,
      proposalId: proposalId(0, 'hb'),
      dest20: Buffer.alloc(20, 5),
    });
    const retire = proveLeafRetire({
      scalar,
      epochs: [0],
      leaf: leaf.note,
      unlockEpoch: 0,
      txBind: Buffer.alloc(32, 2),
    });
    assert.ok(claim && voteProof && retire);
    const windows = (buf) => {
      const set = new Set();
      for (let i = 0; i + 32 <= buf.length; i += 1) set.add(buf.subarray(i, i + 32).toString('hex'));
      return set;
    };
    const voteBytes = windows(voteProof.blob);
    const claimBytes = windows(Buffer.concat([
      claim.blob,
      Buffer.from(claim.nullifier, 'hex'),
    ]));
    const retireBytes = windows(retire.proof);
    for (const word of voteBytes) {
      assert.equal(claimBytes.has(word), false);
      assert.equal(retireBytes.has(word), false);
    }
    assert.equal(voteProof.blob.includes(Buffer.from(claim.nullifier, 'hex')), false);
    const refused = applyLeafVote(emptyVault(), {
      kind: 'leaf-vote',
      programId: RESERVE_PROGRAM,
      voteProof: voteProof.blob,
      nullifier: claim.nullifier,
      choice: 1,
      voteSeq: 1,
      voteParam: 'hb',
      earnEpoch: 0,
      fee: 1,
    }, 0);
    assert.equal(refused.reason, 'stake_reward');
    const carried = applyLeafVote(emptyVault(), {
      kind: 'leaf-vote',
      programId: RESERVE_PROGRAM,
      voteProof: voteProof.blob,
      to: 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      choice: 1,
      voteSeq: 1,
      voteParam: 'hb',
      earnEpoch: 0,
      fee: 1,
    }, 0);
    assert.equal(carried.reason, 'stake_reward');
  });
});

function tallyReady(state, tag, pid) {
  return recordVote(state, { epoch: 1, proposal: pid, tag, choice: 1, seq: 1 });
}
