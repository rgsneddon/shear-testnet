import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { verifyBlock, digestTx } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { sealNote } from '../../crypto/note.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { boundReserveWithdraw, verifyFundedBody } from '../../crypto/spend.js';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { RESERVE_EPOCH_MS, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { portalIdFromDest, compactLockLeakRejected, withdrawLeakRejected } from '../../crypto/reserve_vault.js';

const KINDS = ['lock', 'vote', 'withdraw', 'vortice-register', 'evm-value', 'pool-withdraw'];
const ADDRESS_KINDS = new Set(['vortice-register', 'evm-value', 'pool-withdraw']);
// A lock or withdraw on the wire names dest20 only. from, to, payer, and an
// ssa1 address on it are vote_leak, which runs before the range check.
const COMPACT_KINDS = new Set(['lock', 'withdraw']);

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

// One epoch after genesis. A tranche-less lump locked in epoch 0 is due.
// The cap tests are not a mid-epoch withdraw.
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

function plainTx(kind, dest, nanos) {
  return {
    kind,
    from: dest,
    payer: dest,
    to: dest,
    nanos,
    fee: 0,
    vin: [{ address: dest }],
    vout: [{ kind, address: dest, nanos, dest20: hash20FromAddress(dest) }],
  };
}

/** The same plaintext output in the shape a peer posts. Lock and withdraw carry no address. */
function wireTx(kind, dest, nanos) {
  if (!COMPACT_KINDS.has(kind)) return plainTx(kind, dest, nanos);
  const d20 = Buffer.from(hash20FromAddress(dest));
  const tx = {
    kind,
    nanos,
    fee: 0,
    vin: [{ dest20: d20 }],
    vout: [{ kind, nanos, dest20: d20 }],
  };
  assert.equal(compactLockLeakRejected(tx), null, `${kind} lock leak`);
  assert.equal(withdrawLeakRejected(tx), null, `${kind} withdraw leak`);
  return tx;
}

describe('v12 money outputs are range-proven and withdraws are funded', () => {
  it('rejects an unproven output and an unfunded withdraw for any amount', () => {
    const dest = minerDest();
    for (const nanos of [1, 2_000_000_000, 100_000_000_000]) {
      for (const kind of KINDS) {
        const tx = wireTx(kind, dest, nanos);
        const parked = admitMempool(emptyMempool(), tx, { baseFee: 1 });
        assert.equal(parked.ok, false, kind);
        // The mempool refuses a portal vote outright (vote_retired) before any
        // output check. verifyBlock below still holds a vote to range_proof.
        let want = ADDRESS_KINDS.has(kind) ? 'kind' : 'range_proof';
        if (kind === 'vote') want = 'vote_retired';
        // A pool withdraw is custodial_pull on every network (f9897d50), before
        // any kind or output check. The pool never pays out of custody.
        if (kind === 'pool-withdraw') want = 'custodial_pull';
        assert.equal(parked.reason, want, `${kind} ${nanos}`);
      }
      const bare = plainTx('withdraw', dest, nanos);
      assert.equal(boundReserveWithdraw(bare, { portals: {}, epochBps: 0 }).reason, 'owner_missing');
      const over = boundReserveWithdraw(bare, {
        epochBps: 0,
        portals: { [dest]: { staked: nanos - 1, idle: 0, ownerPub: '11'.repeat(32) } },
      });
      if (nanos > 1) assert.equal(over.reason, 'insufficient');
      const exact = boundReserveWithdraw(bare, {
        epochBps: 0,
        genesisMs: LUMP_GENESIS,
        portals: { [portalIdFromDest(dest)]: dueLump(nanos) },
      }, null, LUMP_CLOCK);
      assert.equal(exact.ok, false, String(nanos));
      assert.equal(exact.reason, 'mint_forbidden', `${nanos} ${exact.reason}`);
      const unlabeled = boundReserveWithdraw({
        ...bare,
        programId: RESERVE_PROGRAM,
      }, {
        epochBps: 0,
        genesisMs: LUMP_GENESIS,
        portals: { [portalIdFromDest(dest)]: dueLump(nanos) },
      }, null, LUMP_CLOCK);
      assert.equal(unlabeled.reason, 'mint_amount', `${nanos} ${unlabeled.reason}`);
      const note = sealNote(nanos, { dest20: hash20FromAddress(dest), kind: 'withdraw' });
      const opened = boundReserveWithdraw({
        kind: 'withdraw',
        programId: RESERVE_PROGRAM,
        portalId: portalIdFromDest(dest),
        nanos,
        vout: [{ ...note, kind: 'withdraw' }],
      }, {
        epochBps: 0,
        genesisMs: LUMP_GENESIS,
        currentEpoch: 1,
        portals: { [portalIdFromDest(dest)]: dueLump(nanos) },
      }, null, LUMP_CLOCK);
      assert.equal(opened.ok, true, `${nanos} ${opened.reason}`);
      const body = verifyFundedBody([bare], () => 0, { reserveState: { portals: {}, epochBps: 0 } });
      assert.equal(body.ok, false);
      assert.equal(body.reason, 'owner_missing');
    }
  });

  it('verifyBlock rejects a plaintext money output and an unfunded sealed withdraw', async () => {
    const dest = minerDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-money-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    const tpl = store.template({ miner: dest, shareBits: 4, now: t0 }).tpl;
    const amounts = [1, 100_000_000_000];
    const cases = [];
    for (const nanos of amounts) {
      for (const kind of KINDS) {
        const reason = kind === 'pool-withdraw' ? 'custodial_pull' : 'range_proof';
        cases.push({ name: `${kind}-${nanos}`, tx: wireTx(kind, dest, nanos), reason });
      }
      const d20 = Buffer.from(hash20FromAddress(dest));
      const note = sealNote(nanos, { dest20: d20, kind: 'withdraw' });
      cases.push({
        name: `sealed-unfunded-${nanos}`,
        tx: {
          kind: 'withdraw',
          nanos,
          fee: 0,
          vin: [{ dest20: d20 }],
          vout: [{ ...note, kind: 'withdraw', dest20: d20 }],
        },
        reason: 'admit_version',
        reserveState: { portals: {}, epochBps: 0 },
      });
      cases.push({
        name: `sealed-over-${nanos}`,
        tx: {
          kind: 'withdraw',
          nanos,
          fee: 0,
          vin: [{ dest20: d20 }],
          vout: [{ ...note, kind: 'withdraw', dest20: d20 }],
        },
        reason: 'admit_version',
        reserveState: {
          epochBps: 0,
          portals: { [portalIdFromDest(dest)]: { staked: 0, idle: Math.max(0, nanos - 1) } },
        },
      });
    }
    for (const row of cases) {
      assert.equal(withdrawLeakRejected(row.tx), null, `${row.name} leak`);
      const txs = tpl.txs.concat([row.tx]);
      const decoded = decodeHeader(Buffer.from(tpl.header));
      decoded.merkleRoot = merkleRoot(txs.map(digestTx));
      const got = verifyBlock({
        header: encodeHeader(decoded),
        txs,
        samples: tpl.samples,
        shareBatch: [],
        miner: dest,
      }, null, {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
        nowMs: t0,
        genesisMs: t0,
        reserveState: row.reserveState || { portals: {}, epochBps: 0 },
      });
      assert.equal(got.ok, false, row.name);
      assert.equal(got.reason, row.reason, row.name);
    }
  });
});
