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
  encodeDeposit,
  encodePinClock,
  encodeVote,
  encodeEnact,
  encodeClaim,
  encodeCommitRewards,
  encodeSyncEpoch,
  encodeWithdraw,
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
import { encodeDest, newIdentity, spendDestOf } from './address.js';
import { boundReserveWithdraw } from './spend.js';
import {
  applyReserveBlock,
  cloneVault,
  deposit,
  emptyVault,
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
  withdraw,
  withdrawMintId,
  withdrawPaysInterest,
  withdrawTx,
} from './reserve_vault.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const destA = 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const destB = 'ssa1ppppppppppppppppppppppppppppppppppppppppppppppppppppp';

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
    assert.equal(v.ok, true, v.reason);
    const epochMs = EPOCH_DAYS_TESTNET * 86_400_000;
    const cutoffMs = Math.floor(epochMs / 4);
    const late = t0 + epochMs - cutoffMs + 1_000;
    const bob = await callReserve(s, encodeDeposit(destB, PI_SHE_NANOS, late));
    assert.equal(bob.ok, true, bob.reason);
    const portalB = decodePortal((await callReserve(s, encodePortalOf(destB), { staticCall: true })).returnValue);
    assert.equal(portalB.idle, PI_SHE_NANOS);
    assert.equal(portalB.staked, 0);
    assert.equal(portalB.joined, true);
    const bobVote = await callReserve(s, encodeVote(destB, 1, late));
    assert.equal(bobVote.ok, true, bobVote.reason);
    const change = await callReserve(s, encodeVote(destA, 3, late));
    assert.equal(change.ok, false);
    const end = t0 + RESERVE_EPOCH_MS;
    const en = await callReserve(s, encodeEnact(end));
    assert.equal(en.ok, true, en.reason);
    const view = decodePublicView((await callReserve(s, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(view.liveHashBonusNanos, 2);
    assert.equal(view.oracleBps, 284);
    assert.equal(view.bonusEnacted, true);
    const w = await callReserve(s, encodeWithdraw(destB, end));
    assert.equal(w.ok, true, w.reason);
    const paid = decodeWithdraw(w.returnValue);
    assert.equal(paid.principal, PI_SHE_NANOS);
    assert.equal(paid.interest, 0);
    const after = decodePublicView((await callReserve(s, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(after.votesIncrease, 2);
    assert.equal(after.votesDecrease, 0);
    assert.notEqual(after.votesIncrease + after.votesDecrease + after.votesHold, 0);
  });

  it('constructor freezes the trimmed bundle; second vote is VoteLocked; mid-epoch observe does not mint', async () => {
    const s = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
    assert.equal((await callReserve(s, encodePinClock(t0))).ok, true);
    const view0 = decodePublicView((await callReserve(s, encodePublicView(t0), { staticCall: true })).returnValue);
    assert.equal(view0.oracleBps, 284);
    const d = await callReserve(s, encodeDeposit(destA, NANOS_PER_SHE, t0));
    assert.equal(d.ok, true, d.reason);
    const rest = PI_SHE_NANOS - NANOS_PER_SHE;
    assert.equal((await callReserve(s, encodeDeposit(destA, rest, t0))).ok, true);
    assert.equal((await callReserve(s, encodeVote(destA, 1, t0 + 2))).ok, true);
    const locked = await callReserve(s, encodeVote(destA, 3, t0 + 3));
    assert.equal(locked.ok, false);
    assert.equal((await callReserve(s, encodeObserveRate(9999, t0 + 4))).ok, false);
    const end = t0 + RESERVE_EPOCH_MS;
    assert.equal((await callReserve(s, encodeEnact(end))).ok, true);
    const w = await callReserve(s, encodeWithdraw(destA, end));
    assert.equal(w.ok, true, w.reason);
    const paid = decodeWithdraw(w.returnValue);
    assert.equal(paid.interest, 0);
    assert.equal(decodeWithdrawEarned(w.returnValue), Number((BigInt(PI_SHE_NANOS) * BigInt(GENESIS_BPS)) / 10000n));
    const view = decodePublicView((await callReserve(s, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(view.votesIncrease, 1);
    assert.notEqual(view.votesIncrease + view.votesDecrease + view.votesHold, 0);
  });

  it('withdraw after a new epoch opens does not decrement the new piles', async () => {
    const s = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
    assert.equal((await callReserve(s, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(s, encodeDeposit(destA, PI_SHE_NANOS, t0))).ok, true);
    assert.equal((await callReserve(s, encodeVote(destA, 1, t0 + 2))).ok, true);
    const end1 = t0 + RESERVE_EPOCH_MS;
    assert.equal((await callReserve(s, encodeEnact(end1))).ok, true);
    assert.equal((await callReserve(s, encodeDeposit(destB, PI_SHE_NANOS, end1 + 1))).ok, true);
    assert.equal((await callReserve(s, encodeVote(destB, 3, end1 + 2))).ok, true);
    const end2 = end1 + 1 + RESERVE_EPOCH_MS;
    assert.equal((await callReserve(s, encodeEnact(end2))).ok, true);
    assert.equal((await callReserve(s, encodeWithdraw(destA, end2))).ok, true);
    const view = decodePublicView((await callReserve(s, encodePublicView(end2), { staticCall: true })).returnValue);
    assert.equal(view.votesIncrease, 0);
    assert.equal(view.votesHold, 1);
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
      const locked = n * PI_SHE_NANOS;
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
        const evmLock = await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0, ownerCommit));
        assert.equal(evmLock.ok, true, `${n} evm ${i} ${evmLock.reason}`);
      }
      let firstRow = null;
      for (let epoch = 0; epoch < epochCount; epoch += 1) {
        const now = t0 + (epoch + 1) * RESERVE_EPOCH_MS;
        assert.equal(enact({ state: js, nowMs: now }).ok, true, `js enact ${n} ${epoch}`);
        const en = await callReserve(session, encodeEnact(now));
        assert.equal(en.ok, true, `evm enact ${n} ${epoch} ${en.reason}`);
        const plan = rewardCommitment(js, now);
        assert.equal(plan.rows.length, n, `rows ${n} ${epoch}`);
        assert.equal(plan.rows.every((row) => row.epoch === epoch), true, `only epoch ${epoch}`);
        if (epoch === 0) {
          firstRow = plan.rows.find((row) => row.portalId === portalIdFromDest(firstDest));
          assert.ok(firstRow, 'epoch 0 leaf');
        }
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
        assert.equal(view.totalLockedNanos, locked, `evm locked ${n} ${epoch}`);
        assert.equal(Number(js.totalLockedNanos), locked, `js locked ${n} ${epoch}`);
        const id = supplyIdentity(js);
        assert.equal(id.ok, true, `${n} ${epoch} ${id.reason}`);
        assert.equal(id.principalNanos, locked, `principal ${n} ${epoch}`);
      }
      if (n === 1) {
        const steps = rewardClaimProof(js, firstRow.nullifier);
        const proof = packRewardProof(steps);
        const bad = await callReserve(session, encodeClaim(firstRow.nullifier, firstRow.nanos, Buffer.alloc(33, 9), 1, Buffer.alloc(96)));
        assert.equal(bad.ok, false, 'bad proof');
        assert.equal(bad.reason, 'claim_unavailable');
        const signed = rewardClaimTx({
          to: firstDest,
          nanos: firstRow.nanos,
          nullifier: firstRow.nullifier,
          proof: steps,
          ownerKey: firstOwner.privateKey,
          id: 'gas-claim',
        });
        const stranger = newIdentity();
        const stolen = rewardClaimTx({
          to: encodeDest(Buffer.alloc(20, 9)),
          nanos: firstRow.nanos,
          nullifier: firstRow.nullifier,
          proof: steps,
          ownerKey: stranger.privateKey,
          id: 'gas-stolen',
        });
        const stolenAuth = packRewardAuth({
          ownerPub: stolen.spendPub, sig: stolen.sig, dest: stolen.to,
        });
        const refused = await callReserve(session, encodeClaim(
          firstRow.nullifier, firstRow.nanos, proof, 1, stolenAuth,
        ));
        assert.equal(refused.ok, false, 'third party');
        assert.equal(refused.reason, 'claim_unavailable');
        const auth = packRewardAuth({ ownerPub: signed.spendPub, sig: signed.sig, dest: firstDest });
        const claimed = await callReserve(session, encodeClaim(firstRow.nullifier, firstRow.nanos, proof, 1, auth));
        assert.equal(claimed.ok, false);
        assert.equal(claimed.reason, 'claim_unavailable');
        const twice = await callReserve(session, encodeClaim(firstRow.nullifier, firstRow.nanos, proof, 1, auth));
        assert.equal(twice.ok, false);
        assert.equal(twice.reason, 'claim_unavailable');
        const later = rewardCommitment(js, t0 + (epochs + 1) * RESERVE_EPOCH_MS);
        assert.equal(later.rows.some((row) => row.nullifier === firstRow.nullifier), false);
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
      assert.equal(plan.rows.length, 1, `rows ${epoch}`);
      assert.equal(plan.rows[0].epoch, epoch, `leaf epoch ${epoch}`);
      assert.equal(plan.rows.some((row) => row.epoch < epoch), false, `archived ${epoch}`);
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
      assert.equal(Number(js.totalLockedNanos), PI_SHE_NANOS);
      const view = decodePublicView(
        (await callReserve(session, encodePublicView(now), { staticCall: true })).returnValue,
      );
      assert.equal(view.totalLockedNanos, PI_SHE_NANOS);
      assert.equal(view.currentEpoch, js.currentEpoch);
      assert.equal(supplyIdentity(js).principalNanos, PI_SHE_NANOS);
    }
    assert.equal(new Set(roots).size, 3);
    const epoch0 = withdrawMintId(portalIdFromDest(dest), 0);
    assert.equal(js.rewardBook[epoch0].epoch, 0);
    assert.notEqual(js.rewardBook[epoch0].rootKey, '3');
  });

  it('a withdraw that paid the reward cannot be claimed again', async () => {
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    const dest = encodeDest(Buffer.alloc(20, 0xab));
    const owner = newIdentity();
    const ownerPub = Buffer.from(owner.spendPub).toString('hex');
    const js = emptyVault();
    js.genesisMs = t0;
    assert.equal(deposit({ state: js, dest, nanos: PI_SHE_NANOS, nowMs: t0, ownerPub }).ok, true);
    assert.equal(enact({ state: js, nowMs: end }).ok, true);
    const before = supplyIdentity(js);
    assert.equal(before.ok, true, before.reason);
    assert.equal(before.principalNanos, PI_SHE_NANOS);
    assert.equal(before.vaultNanos >= before.principalNanos, true);
    const plan = rewardCommitment(js, end);
    assert.equal(plan.rows.length, 1);
    const preview = previewWithdraw(js, dest, end);
    assert.equal(preview.interest, 0);
    assert.equal(preview.payout, PI_SHE_NANOS);
    const earned = portalEpochInterest(js, js.portals[portalIdFromDest(dest)], end);
    assert.equal(earned, plan.rows[0].nanos);
    const tx = withdrawTx({ from: dest, to: dest, nanos: preview.payout, id: 'paid-reward' });
    signWithdrawReward(tx, owner.privateKey, {
      portalId: portalIdFromDest(dest),
      nanos: preview.principal,
      dest,
    });
    const bound = boundReserveWithdraw(tx, js, new Set(), end);
    assert.equal(bound.ok, true, bound.reason);
    assert.equal(bound.cap, preview.principal);
    assert.equal(bound.cap, PI_SHE_NANOS);
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
    assert.equal(paid.earned, plan.rows[0].nanos);
    const claim = rewardClaimTx({
      to: dest,
      nanos: plan.rows[0].nanos,
      nullifier: plan.rows[0].nullifier,
      proof: rewardClaimProof(js, plan.rows[0].nullifier),
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
    assert.equal(after.ok, true, after.reason);
    assert.equal(after.principalNanos, 0);
    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0, rewardOwnerCommit(ownerPub)))).ok, true);
    const drawn = await executeBlockEvm(session, [
      { coinbase: true, vout: [], rewardRoot: plan.root },
      tx,
    ], end, t0);
    assert.equal(drawn.ok, true, drawn.reason);
    assert.equal(drawn.withdrawInterest, 0);
    assert.equal(drawn.withdrawEarned, plan.rows[0].nanos);
    assert.equal(drawn.totalLocked, 0);
    const proof = packRewardProof(rewardClaimProof(js, plan.rows[0].nullifier));
    const auth = packRewardAuth({ ownerPub, sig: claim.sig, dest });
    const claimed = await callReserve(session, encodeClaim(plan.rows[0].nullifier, plan.rows[0].nanos, proof, plan.index, auth));
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
    assert.equal(deposit({ state: js, dest, nanos, nowMs: t0 }).ok, true);
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
      assert.equal(Number(js.totalLockedNanos), nanos, `js still ${epoch}`);
      const view = decodePublicView(
        (await callReserve(session, encodePublicView(now), { staticCall: true })).returnValue,
      );
      assert.equal(view.totalLockedNanos, nanos, `evm still ${epoch}`);
      assert.equal(view.currentEpoch, js.currentEpoch, `epoch ${epoch}`);
      assert.equal(supplyIdentity(js).ok, true);
    }
    const paid = withdraw({ state: js, dest, nowMs: now });
    assert.equal(paid.ok, true, paid.reason);
    assert.equal(paid.principal, nanos);
    const evmPaid = await callReserve(session, encodeWithdraw(dest, now));
    assert.equal(evmPaid.ok, true, evmPaid.reason);
    assert.equal(decodeWithdraw(evmPaid.returnValue).principal, nanos);
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
    assert.equal(id0.principalNanos, PI_SHE_NANOS);
    assert.equal(id0.totalNanos, PI_SHE_NANOS);
    const plan = rewardCommitment(js, end);
    assert.equal(plan.rows.length, 1);
    const committed = applyReserveBlock({
      state: js,
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }] },
      nowMs: end,
      genesisMs: t0,
      requireStakeReward: true,
    });
    assert.equal(committed.ok, true, committed.reason);
    const row = plan.rows[0];
    const proof = rewardClaimProof(js, row.nullifier);
    const stranger = newIdentity();
    const stolen = rewardClaimTx({
      to: payout,
      nanos: row.nanos,
      nullifier: row.nullifier,
      proof,
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
      nanos: row.nanos,
      nullifier: row.nullifier,
      proof,
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
    assert.equal(Number(js.totalLockedNanos), PI_SHE_NANOS);
    const after = supplyIdentity(js);
    assert.equal(after.ok, true, after.reason);
    assert.equal(after.totalNanos, PI_SHE_NANOS);

    const session = await bootReserveEvm();
    assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0, rewardOwnerCommit(ownerPub)))).ok, true);
    const stored = await callReserve(session, encodeCommitRewards(end, plan.root));
    assert.equal(stored.ok, true, stored.reason);
    const packed = packRewardProof(proof);
    const stolenAuth = packRewardAuth({ ownerPub: stolen.spendPub, sig: stolen.sig, dest: payout });
    const evmStolen = await callReserve(session, encodeClaim(row.nullifier, row.nanos, packed, plan.index, stolenAuth));
    assert.equal(evmStolen.ok, false);
    assert.equal(evmStolen.reason, 'claim_unavailable');
    const auth = packRewardAuth({ ownerPub, sig: claim.sig, dest: payout });
    const evmPaid = await callReserve(session, encodeClaim(row.nullifier, row.nanos, packed, plan.index, auth));
    assert.equal(evmPaid.ok, false);
    assert.equal(evmPaid.reason, 'claim_unavailable');
    const twice = await callReserve(session, encodeClaim(row.nullifier, row.nanos, packed, plan.index, auth));
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'claim_unavailable');
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
    assert.equal(deposit({ state: js, dest, nanos: PI_SHE_NANOS, nowMs: t0, ownerPub }).ok, true);
    const plan = rewardCommitment(js, end);
    const preview = previewWithdraw(js, dest, end);
    const earned = portalEpochInterest(js, js.portals[portalIdFromDest(dest)], end);
    assert.ok(earned > 0);
    assert.equal(preview.interest, 0);
    assert.equal(preview.payout, PI_SHE_NANOS);
    assert.equal(withdrawPaysInterest(js, js.portals[portalIdFromDest(dest)], end), 0);
    const portalId = portalIdFromDest(dest);
    const bare = withdrawTx({ from: dest, to: payout, nanos: preview.payout, id: 'wd-bare' });
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
    const stolen = withdrawTx({ from: dest, to: payout, nanos: preview.payout, id: 'wd-stolen' });
    signWithdrawReward(stolen, stranger.privateKey, { portalId, nanos: preview.principal, dest: payout });
    const stolenApply = applyReserveBlock({
      state: cloneVault(js),
      block: { txs: [{ coinbase: true, vout: [], rewardRoot: plan.root }, stolen] },
      nowMs: end,
      genesisMs: t0,
      requireStakeReward: true,
    });
    assert.equal(stolenApply.ok, false);
    assert.equal(stolenApply.reason, 'unsigned');
    const tx = withdrawTx({ from: dest, to: payout, nanos: preview.payout, id: 'wd-owner' });
    signWithdrawReward(tx, owner.privateKey, { portalId, nanos: preview.principal, dest: payout });
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
    assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, t0, rewardOwnerCommit(ownerPub)))).ok, true);
    const bareEvm = await callReserve(session, encodeWithdraw(dest, end));
    assert.equal(bareEvm.ok, false);
    const stolenAuth = packRewardAuth({ ownerPub: stolen.spendPub, sig: stolen.rewardSig, dest: payout });
    const stolenEvm = await callReserve(session, encodeWithdraw(dest, end, stolenAuth));
    assert.equal(stolenEvm.ok, false);
    const auth = packRewardAuth({ ownerPub, sig: tx.rewardSig, dest: payout });
    const drawn = await callReserve(session, encodeWithdraw(dest, end, auth));
    assert.equal(drawn.ok, true, drawn.reason);
    assert.equal(decodeWithdraw(drawn.returnValue).interest, 0);
    assert.equal(decodeWithdrawEarned(drawn.returnValue), earned);
    assert.equal(decodeWithdraw(drawn.returnValue).principal, PI_SHE_NANOS);
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
      assert.equal(deposit({ state: js, dest, nanos: PI_SHE_NANOS, nowMs: lateAt }).ok, true);
      const paid = withdraw({ state: js, dest, nowMs: at });
      assert.equal(paid.ok, true, `${at} ${paid.reason}`);
      assert.equal(paid.interest, 0, `js ${at}`);
      assert.equal(paid.earned, want, `js earned ${at}`);
      assert.equal(paid.principal, PI_SHE_NANOS);
      const session = await bootReserveEvm();
      assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
      assert.equal((await callReserve(session, encodeDeposit(dest, PI_SHE_NANOS, lateAt))).ok, true);
      const evm = await callReserve(session, encodeWithdraw(dest, at));
      assert.equal(evm.ok, true, `${at} ${evm.reason}`);
      const decoded = decodeWithdraw(evm.returnValue);
      assert.equal(decoded.interest, 0, `evm ${at}`);
      assert.equal(decodeWithdrawEarned(evm.returnValue), want, `evm earned ${at}`);
      assert.equal(decoded.principal, PI_SHE_NANOS);
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
    assert.equal(plan.rows.length, 1);
    const tx = withdrawTx({ from: dest, to: dest, nanos: PI_SHE_NANOS + plan.rows[0].nanos, id: 'missing-root' });
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

    const small = PI_SHE_NANOS - 1;
    const quiet = encodeDest(Buffer.alloc(20, 0x73));
    const below = emptyVault();
    below.genesisMs = t0;
    assert.equal(deposit({ state: below, dest: quiet, nanos: small, nowMs: t0 }).ok, true);
    assert.equal(rewardCommitment(below, end).rows.length, 0);
    const session2 = await bootReserveEvm();
    assert.equal((await callReserve(session2, encodePinClock(t0))).ok, true);
    assert.equal((await callReserve(session2, encodeDeposit(quiet, small, t0))).ok, true);
    const empty = await executeBlockEvm(session2, [
      { coinbase: true, vout: [] },
      withdrawTx({ from: quiet, to: quiet, nanos: small, id: 'no-rows' }),
    ], end, t0, '');
    assert.equal(empty.ok, true, empty.reason);
    assert.equal(empty.withdrawInterest, 0);
    assert.equal(empty.totalLocked, 0);
  });
});
