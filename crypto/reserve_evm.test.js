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
} from './reserve_evm.js';

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
  });
});
