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
  encodeVote,
  encodeEnact,
  encodeWithdraw,
  encodePublicView,
  decodePublicView,
  encodePortalOf,
  decodePortal,
  decodeWithdraw,
  encodeObserveRate,
  selector,
  shearMagicBytes,
} from './reserve_evm.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const destA = 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const destB = 'ssa1ppppppppppppppppppppppppppppppppppppppppppppppppppppp';

describe('Reserve bytecode on the Shear EVM', () => {
  it('bootReserveEvm defaults to MAGIC_TESTNET', async () => {
    const src = fs.readFileSync(fileURLToPath(new URL('./reserve_evm.js', import.meta.url)), 'utf8');
    assert.match(src, /bootReserveEvm\(\{ network = MAGIC_TESTNET \}/);
    assert.match(src, /shearMagicBytes\(network = MAGIC_TESTNET\)/);
    assert.equal(MAGIC_TESTNET, MAGIC_TESTNET_V12);
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
    const d = await callReserve(s, encodeDeposit(destA, PI_SHE_NANOS, t0));
    assert.equal(d.ok, true, d.reason);
    const view0 = decodePublicView((await callReserve(s, encodePublicView(t0), { staticCall: true })).returnValue);
    assert.equal(view0.currentEpoch, 1);
    assert.equal(view0.liveHashBonusNanos, 1);
    const v = await callReserve(s, encodeVote(destA, 1, t0 + 2));
    assert.equal(v.ok, true, v.reason);
    const epochMs = EPOCH_DAYS_TESTNET * 86_400_000;
    const cutoffMs = Math.floor((99 * epochMs) / 400);
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

  it('constructor freezes 264; second vote is VoteLocked; mid-epoch observe does not mint', async () => {
    const s = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
    const view0 = decodePublicView((await callReserve(s, encodePublicView(t0), { staticCall: true })).returnValue);
    assert.equal(view0.oracleBps, 264);
    const d = await callReserve(s, encodeDeposit(destA, NANOS_PER_SHE, t0));
    assert.equal(d.ok, true, d.reason);
    const rest = PI_SHE_NANOS - NANOS_PER_SHE;
    assert.equal((await callReserve(s, encodeDeposit(destA, rest, t0))).ok, true);
    assert.equal((await callReserve(s, encodeVote(destA, 1, t0 + 2))).ok, true);
    const locked = await callReserve(s, encodeVote(destA, 3, t0 + 3));
    assert.equal(locked.ok, false);
    assert.equal((await callReserve(s, encodeObserveRate(9999, t0 + 4))).ok, true);
    const end = t0 + RESERVE_EPOCH_MS;
    assert.equal((await callReserve(s, encodeEnact(end))).ok, true);
    const w = await callReserve(s, encodeWithdraw(destA, end));
    assert.equal(w.ok, true, w.reason);
    const paid = decodeWithdraw(w.returnValue);
    assert.equal(paid.interest, Number((BigInt(PI_SHE_NANOS) * 264n) / 10000n));
    const view = decodePublicView((await callReserve(s, encodePublicView(end), { staticCall: true })).returnValue);
    assert.equal(view.votesIncrease, 1);
    assert.notEqual(view.votesIncrease + view.votesDecrease + view.votesHold, 0);
  });

  it('withdraw after a new epoch opens does not decrement the new piles', async () => {
    const s = await bootReserveEvm();
    const t0 = 1_700_000_000_000;
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
});
