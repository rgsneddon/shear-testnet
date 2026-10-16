import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as asert from './asert.js';
import { PI_SHE_NANOS, RESERVE_EPOCH_MS, NANOS_PER_SHE, MAGIC_TESTNET, MAGIC_TESTNET_V12, MAGIC_TESTNET_V13, EPOCH_DAYS_TESTNET } from './asert.js';
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
  encodeCommitRewards,
  encodeSyncEpoch,
  encodeWithdraw,
  encodePublicView,
  decodePublicView,
  decodeBytes32,
  encodePortalOf,
  decodePortal,
  decodeWithdraw,
  encodeObserveRate,
  selector,
  shearMagicBytes,
} from './reserve_evm.js';
import { GENESIS_BPS } from './reserve_oracle.js';
import { encodeDest } from './address.js';
import {
  applyReserveBlock,
  deposit,
  emptyVault,
  enact,
  rewardCommitment,
  supplyIdentity,
  withdraw,
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
    assert.equal(MAGIC_TESTNET, MAGIC_TESTNET_V13);
    assert.equal(MAGIC_TESTNET_V12, 'shear-testnet-v12');
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v13');
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
    assert.equal(asert.MAGIC_TESTNET, MAGIC_TESTNET_V13);
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v13');
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
    assert.match(walletSrc, /const kBookMagic = 'shear-testnet-v13';/);
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
      'keccak256(bytes("shear-testnet-v13"))',
      'keccak256(bytes("shear-testnet-v99"))',
    );
    assert.notEqual(mutated, sol);
    const bad = compileReserveSource(mutated);
    const live = Buffer.from(shearMagicBytes('shear-testnet-v13')).toString('hex');
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
    assert.equal(paid.interest, Number((BigInt(PI_SHE_NANOS) * BigInt(GENESIS_BPS)) / 10000n));
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

  it('epoch-end gas stays flat in N and JS matches the EVM', async () => {
    const sol = fs.readFileSync(new URL('../contracts/Reserve.sol', import.meta.url), 'utf8');
    const vault = fs.readFileSync(new URL('./reserve_vault.js', import.meta.url), 'utf8');
    assert.equal(sol.includes('_pinLegacyEpochs'), false);
    assert.equal(sol.includes('_releaseMatured'), false);
    assert.equal(vault.includes('pinLegacyLockEpochs'), false);
    const t0 = 1_700_000_000_000;
    const end = t0 + RESERVE_EPOCH_MS;
    const sizes = [1, 40, 257, 1000];
    const gas = {};
    for (const n of sizes) {
      const js = emptyVault();
      js.genesisMs = t0;
      const session = await bootReserveEvm();
      assert.equal((await callReserve(session, encodePinClock(t0))).ok, true);
      let locked = 0;
      for (let i = 0; i < n; i += 1) {
        const raw = Buffer.alloc(20);
        raw.writeUInt32BE(i + 1, 16);
        const dest = encodeDest(raw);
        const nanos = i === 0 ? PI_SHE_NANOS : 1;
        locked += nanos;
        const jsLock = deposit({ state: js, dest, nanos, nowMs: t0 });
        assert.equal(jsLock.ok, true, `${n} js ${i} ${jsLock.reason}`);
        const evmLock = await callReserve(session, encodeDeposit(dest, nanos, t0));
        assert.equal(evmLock.ok, true, `${n} evm ${i} ${evmLock.reason}`);
      }
      assert.equal(enact({ state: js, nowMs: end }).ok, true);
      const en = await callReserve(session, encodeEnact(end));
      assert.equal(en.ok, true, en.reason);
      const jsPass = applyReserveBlock({
        state: js,
        block: { txs: [] },
        nowMs: end,
        genesisMs: t0,
      });
      assert.equal(jsPass.ok, true, jsPass.reason);
      const evmPass = await callReserve(session, encodeSyncEpoch(end));
      assert.equal(evmPass.ok, true, evmPass.reason);
      const committed = await callReserve(session, encodeCommitRewards(end));
      assert.equal(committed.ok, true, `${n} ${committed.reason}`);
      const plan = rewardCommitment(js, end);
      assert.equal(decodeBytes32(committed.returnValue), plan.root, `root ${n}`);
      gas[n] = committed.gasUsed;
      const view = decodePublicView(
        (await callReserve(session, encodePublicView(end), { staticCall: true })).returnValue,
      );
      assert.equal(js.currentEpoch, 1, `js epoch ${n}`);
      assert.equal(view.currentEpoch, 1, `evm epoch ${n}`);
      assert.equal(Number(js.totalLockedNanos), locked, `js locked ${n}`);
      assert.equal(view.totalLockedNanos, locked, `evm locked ${n}`);
      const id = supplyIdentity(js);
      assert.equal(id.ok, true, `${n} ${id.reason}`);
      assert.equal(id.lockedNanos, locked);
    }
    for (const n of sizes) {
      assert.ok(gas[n] > 0n, `gas ${n}`);
      assert.ok(gas[n] < gas[1] * 2n, `gas ${n}=${gas[n]} gas1=${gas[1]}`);
    }
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
      const committed = await callReserve(session, encodeCommitRewards(now));
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
});
