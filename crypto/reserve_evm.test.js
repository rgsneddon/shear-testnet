import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PI_SHE_NANOS, RESERVE_EPOCH_MS } from './asert.js';
import {
  bootReserveEvm,
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
} from './reserve_evm.js';
import { NANOS_PER_SHE } from './asert.js';

const destA = 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const destB = 'ssa1ppppppppppppppppppppppppppppppppppppppppppppppppppppp';

describe('Reserve bytecode on the Shear EVM', () => {
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
    const late = t0 + (400 - 98) * 86_400_000;
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
});
