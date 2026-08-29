import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newIdentity } from './address.js';
import { destForLogin, joinDest } from './flow_sheet.js';
import {
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  JOIN_WINDOW_MS,
  NANOS_PER_SHE,
  extraMintAllowed,
  RESERVE_PROGRAM,
} from './asert.js';
import {
  buildSnapshot,
  encodeJoinKey,
  decodeJoinKey,
  emptyJoin,
  fundGenesis,
  claim,
  burnUnclaimed,
  publicJoinView,
  shearNanosFromPriorUnits,
  priorUnitsFromCoins,
  JOIN_LEAF_PERSONAL,
} from './join_vault.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

describe('The Join vault', () => {
  it('maps one prior coin to one SHE and funds the vault once', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), true);
    assert.equal(priorUnitsFromCoins(1), 100_000_000_000);
    assert.equal(shearNanosFromPriorUnits(100_000_000_000), NANOS_PER_SHE);
    const snap = buildSnapshot([
      { owner: 'prior1alice', coins: 1 },
      { owner: 'prior1bob', coins: 2.5 },
    ]);
    assert.equal(snap.circulatingNanos, 3.5 * NANOS_PER_SHE);
    const t0 = 1_800_000_000_000;
    const state = emptyJoin();
    const funded = fundGenesis({ state, nanos: snap.circulatingNanos, nowMs: t0, root: snap.root });
    assert.equal(funded.ok, true);
    assert.equal(funded.mint, true);
    assert.equal(state.circulatingNanos, snap.circulatingNanos);
    assert.equal(state.remainingNanos, snap.circulatingNanos);
    assert.equal(JOIN_WINDOW_MS, 99 * 86_400_000);
    assert.equal(fundGenesis({ state, nanos: 1, nowMs: t0, root: snap.root }).ok, false);
  });

  it('credits a valid key 1:1, refuses a second claim, burns the rest after 99 days', () => {
    const alice = newIdentity();
    const payout = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const vault = joinDest(alice.address, { viewKey: alice.viewKey });
    assert.ok(payout.startsWith('ssa1'));
    assert.notEqual(payout, vault);
    const snap = buildSnapshot([
      { owner: 'prior1alice', coins: 1 },
      { owner: 'prior1bob', coins: 3 },
    ]);
    const t0 = 1_800_000_000_000;
    const state = emptyJoin();
    fundGenesis({ state, nanos: snap.circulatingNanos, nowMs: t0, root: snap.root });
    const row = snap.rows.find((r) => r.owner === 'prior1alice');
    const key = encodeJoinKey(row);
    const parsed = decodeJoinKey(key);
    assert.equal(parsed.ok, true);
    const got = claim({ state, key, payout, nowMs: t0 + DAY });
    assert.equal(got.ok, true);
    assert.equal(got.nanos, NANOS_PER_SHE);
    assert.equal(got.she, 1);
    assert.equal(got.to, payout);
    const again = claim({ state, key, payout, nowMs: t0 + 2 * DAY });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already_claimed');
    const pub = JSON.stringify(publicJoinView(state, t0 + DAY));
    assert.equal(pub.includes(alice.address), false);
    assert.equal(pub.includes(alice.viewKey), false);
    assert.equal(pub.includes('shear1'), false);
    assert.equal(pub.includes(payout), false);
    assert.match(pub, /shear-join-v1/);
    assert.equal(JOIN_LEAF_PERSONAL.startsWith('shear-join'), true);

    const earlyBurn = burnUnclaimed({ state, nowMs: t0 + 10 * DAY });
    assert.equal(earlyBurn.ok, false);
    const late = t0 + JOIN_WINDOW_MS;
    const leftover = state.remainingNanos;
    assert.equal(leftover, 3 * NANOS_PER_SHE);
    const burned = burnUnclaimed({ state, nowMs: late });
    assert.equal(burned.ok, true);
    assert.equal(burned.nanos, leftover);
    assert.equal(state.remainingNanos, 0);
    assert.equal(state.burned, true);
    const bob = snap.rows.find((r) => r.owner === 'prior1bob');
    const tooLate = claim({
      state,
      key: encodeJoinKey(bob),
      payout,
      nowMs: late + 1,
    });
    assert.equal(tooLate.ok, false);
    assert.equal(tooLate.reason, 'window_closed');
  });
});

describe('Join Solidity is Shear-only copy', () => {
  it('names Shear magics, 99-day window, burn, and refuses foreign chain ids', () => {
    const src = readFileSync(join(rootDir, 'contracts/Join.sol'), 'utf8');
    assert.match(src, /shear-testnet-v1/);
    assert.match(src, /shear-v1/);
    assert.match(src, /shear-join-v1/);
    assert.match(src, /99/);
    assert.match(src, /burned/);
    assert.match(src, /NotShear/);
    assert.equal(src.includes('Bank of England'), false);
    assert.ok(existsSync(join(rootDir, 'contracts/Join.sol')));
  });
});
