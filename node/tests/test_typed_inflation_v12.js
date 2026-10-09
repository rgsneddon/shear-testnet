import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { GENESIS_BITS_PACKED, PI_SHE_NANOS, RESERVE_EPOCH_MS, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { sealNote, sealCoinbaseNote } from '../../crypto/note.js';
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
  deposit,
  withdraw,
  applyReserveBlock,
  verifyReservePayout,
  portalIdFromDest,
  portalPrincipalNanos,
} from '../../crypto/reserve_vault.js';
import { noteCommitSpendableNanos } from '../../crypto/coinbase_notes.js';

const KINDS = ['lock', 'vote', 'withdraw', 'vortice-register'];
const AMOUNTS = [1, 1_000_000_000, 50_000_000_000];

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
        const tx = {
          id: `${kind}-${nanos}`,
          kind,
          programId: kind === 'lock' || kind === 'vote' || kind === 'withdraw' ? RESERVE_PROGRAM : '',
          from: dest,
          to: dest,
          nanos,
          fee: 0,
          vin: [{ commit: note.commit, address: dest, dest20: d20 }],
          vout: [{ ...note, kind, address: dest }],
        };
        signSpendTx(tx, box.key);
        assert.equal(typedCommitRejected(tx)?.reason, 'admit_membership', `${kind} ${nanos}`);
        const body = verifyFundedBody([tx], () => nanos * 4, {
          reserveState: { portals: { [portalIdFromDest(dest)]: { staked: nanos, idle: 0, ownerPub: tx.spendPub } }, epochBps: 0 },
        });
        assert.equal(body.ok, false, `${kind} ${nanos}`);
        assert.equal(body.reason, 'admit_membership', `${kind} ${nanos}`);
        const queued = store.queueTx(tx);
        assert.equal(queued.ok, false, `${kind} ${nanos} ${queued.reason}`);
        assert.equal(queued.reason, 'admit_membership', `${kind} ${nanos}`);
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
        assert.equal(got.reason, 'admit_membership', `${kind} ${nanos} ${got.reason}`);
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
      assert.equal(funded.reason, 'admit_anchor_window', String(nanos));
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
        portals: {
          [victimId]: {
            staked: nanos,
            idle: 0,
            ownerPub: owner.id.spendPub.toString('hex'),
            payout: owner.dest,
            payoutPortalId: portalIdFromDest(owner.dest),
          },
        },
      };
      const cap = boundReserveWithdraw(redirected, state);
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

  it('paid principal stays subtracted, and a lock receipt is not a coin', () => {
    const box = stealthBox();
    const dest = box.dest;
    const pub = box.id.spendPub.toString('hex');
    for (const nanos of [1, PI_SHE_NANOS, PI_SHE_NANOS + 1]) {
      const state = emptyVault();
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
      const paid = withdraw({
        state,
        dest,
        portalId: portalIdFromDest(dest),
        nowMs: 1 + RESERVE_EPOCH_MS,
        payout: dest,
        payoutPortalId: portalIdFromDest(dest),
      });
      assert.equal(paid.ok, true, `${nanos} ${paid.reason}`);
      assert.equal(portalPrincipalNanos(state, dest), nanos);
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
  });

  it('a withdraw mints only an opened principal plus interest, once per portal', () => {
    const dest = stealthBox().dest;
    const id = portalIdFromDest(dest);
    for (const nanos of AMOUNTS) {
      const portal = {
        staked: nanos,
        idle: 0,
        payout: dest,
        payoutPortalId: id,
      };
      const state = {
        epochBps: 0,
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
      const first = boundReserveWithdraw(tx, state, drawn);
      assert.equal(first.ok, true, `${nanos} ${first.reason}`);
      drawn.add(first.mintId);
      const second = boundReserveWithdraw({ ...tx, id: 'again' }, state, drawn);
      assert.equal(second.reason, 'double_mint', `${nanos} ${second.reason}`);
      state.mintedIds[first.mintId] = true;
      const later = boundReserveWithdraw({ ...tx, id: 'later' }, state, new Set());
      assert.equal(later.reason, 'double_mint', `${nanos} later ${later.reason}`);

      const foreign = boundReserveWithdraw({
        ...tx,
        programId: 'not-the-reserve',
        vin: [{ commit: Buffer.alloc(32, 9) }],
      }, {
        epochBps: 0,
        currentEpoch: 4,
        portals: { [id]: { ...portal } },
      });
      assert.equal(foreign.reason, 'mint_forbidden', `${nanos} ${foreign.reason}`);

      const broken = sealNote(nanos, { dest20: hash20FromAddress(dest), kind: 'withdraw' });
      broken.valueProof = { ...broken.valueProof, z: Buffer.alloc(32, 1) };
      const unopened = boundReserveWithdraw({
        ...tx,
        vout: [{ ...broken, kind: 'withdraw' }],
      }, {
        epochBps: 0,
        currentEpoch: 4,
        portals: { [id]: { ...portal } },
      });
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
        currentEpoch: 9,
        portals: { [id]: { ...portal } },
      });
      assert.equal(short.reason, 'mint_amount', `${nanos} short ${short.reason}`);

      const vault = emptyVault();
      assert.equal(deposit({ state: vault, dest, nanos, nowMs: 1, payout: dest, payoutPortalId: id }).ok, true);
      const before = Number(vault.totalLockedNanos);
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
        nowMs: 1 + RESERVE_EPOCH_MS,
      });
      assert.equal(skipped.some((r) => r.action === 'withdraw' && r.ok === true), false);
      assert.equal(Number(vault.totalLockedNanos), before);
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
