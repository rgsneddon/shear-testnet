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
import { destForLogin } from '../../crypto/flow_sheet.js';
import { portalIdFromDest } from '../../crypto/reserve_vault.js';

const KINDS = ['lock', 'vote', 'withdraw', 'vortice-register', 'evm-value', 'pool-withdraw'];

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

describe('v12 money outputs are range-proven and withdraws are funded', () => {
  it('rejects an unproven output and an unfunded withdraw for any amount', () => {
    const dest = minerDest();
    for (const nanos of [1, 2_000_000_000, 100_000_000_000]) {
      for (const kind of KINDS) {
        const tx = plainTx(kind, dest, nanos);
        const parked = admitMempool(emptyMempool(), tx, { baseFee: 1 });
        assert.equal(parked.ok, false, kind);
        assert.equal(parked.reason, 'range_proof', `${kind} ${nanos}`);
      }
      const bare = plainTx('withdraw', dest, nanos);
      assert.equal(boundReserveWithdraw(bare, { portals: {}, epochBps: 0 }).reason, 'insufficient');
      const over = boundReserveWithdraw(bare, {
        epochBps: 0,
        portals: { [dest]: { staked: nanos - 1, idle: 0 } },
      });
      if (nanos > 1) assert.equal(over.reason, 'insufficient');
      const exact = boundReserveWithdraw(bare, {
        epochBps: 0,
        portals: { [portalIdFromDest(dest)]: { staked: nanos, idle: 0 } },
      });
      assert.equal(exact.ok, true, String(nanos));
      const body = verifyFundedBody([bare], () => 0, { reserveState: { portals: {}, epochBps: 0 } });
      assert.equal(body.ok, false);
      assert.equal(body.reason, 'insufficient');
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
        cases.push({ name: `${kind}-${nanos}`, tx: plainTx(kind, dest, nanos), reason: 'range_proof' });
      }
      const note = sealNote(nanos, { dest20: hash20FromAddress(dest), kind: 'withdraw' });
      cases.push({
        name: `sealed-unfunded-${nanos}`,
        tx: {
          kind: 'withdraw',
          from: dest,
          nanos,
          fee: 0,
          vin: [{ address: dest }],
          vout: [{ ...note, kind: 'withdraw', address: dest }],
        },
        reason: 'insufficient',
        reserveState: { portals: {}, epochBps: 0 },
      });
      cases.push({
        name: `sealed-over-${nanos}`,
        tx: {
          kind: 'withdraw',
          from: dest,
          nanos,
          fee: 0,
          vin: [{ address: dest }],
          vout: [{ ...note, kind: 'withdraw', address: dest }],
        },
        reason: 'insufficient',
        reserveState: {
          epochBps: 0,
          portals: { [portalIdFromDest(dest)]: { staked: 0, idle: Math.max(0, nanos - 1) } },
        },
      });
    }
    for (const row of cases) {
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
