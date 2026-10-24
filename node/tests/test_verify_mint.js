import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, isDestAddress } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import { RESERVE_PROGRAM, wrapMintForbidden, extraMintAllowed, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { withdrawLeakRejected, withdrawTx } from '../../crypto/reserve_vault.js';
import {
  buildTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';
import { createStore } from '../src/store.js';

let powTag = 1;
function mine(tpl) {
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    trustedPowHash: pow,
  };
}
function trust(block) {
  return { trustedPowHash: block.trustedPowHash, skipSharePow: true };
}

describe('verifyBlock extra mint', () => {
  it('rejects unfunded extra txs and accepts Reserve-only extra mint via append', async () => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const base = {
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: Date.now(),
    };
    const good = mine(buildTemplate(base));
    const ok = await Promise.resolve(verifyBlock(good, null, trust(good)));
    assert.equal(ok.ok, true, ok.reason);

    const thief = {
      vin: [],
      vout: [{ address: dest, nanos: 99 }],
      programId: 'third-party-stake',
    };
    // The thief is an unfunded mint under a program that may not mint.
    assert.equal(extraMintAllowed(thief.programId, { kind: thief.kind }), false);
    // Since e136cdf7 the range gate runs first: a kindless output with no
    // commit or range proof is range_proof before the extra-mint check, the
    // same reason test_gate_evm pins for this thief. It is still refused.
    const stolen = mine(buildTemplate({ ...base, txs: [thief] }));
    const denied = await Promise.resolve(verifyBlock(stolen, null, trust(stolen)));
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'range_proof');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-store-'));
    const store = createStore(dir);
    const appended = await Promise.resolve(store.append(stolen, trust(stolen)));
    assert.equal(appended.ok, false);
    assert.equal(appended.reason, 'range_proof');

    // The compact wire shape: from, to, payoutPortalId and a vout address are
    // vote_leak (325b50f5) before the mint check this case targets.
    const wd = withdrawTx({ from: dest, to: vault, nanos: 7, id: 'w-7' });
    delete wd.from;
    delete wd.to;
    delete wd.payoutPortalId;
    wd.vout = wd.vout.map(({ address: _address, r: _r, ...row }) => row);
    assert.equal(withdrawLeakRejected(wd), null);
    const reserveTx = { ...wd, fee: 1 };
    const reserved = mine(buildTemplate({ ...base, txs: [reserveTx] }));
    const allowed = await Promise.resolve(verifyBlock(reserved, null, trust(reserved)));
    assert.equal(allowed.ok, false);
    assert.equal(allowed.reason, 'mint_amount');
    const stored = await Promise.resolve(store.append(reserved, trust(reserved)));
    assert.equal(stored.ok, false);
    assert.equal(stored.reason, 'mint_amount');
    assert.equal(wrapMintForbidden({ kind: 'wrap', programId: 'wrap-she-v1', ticker: 'wSHE' }), true);
    assert.equal(wrapMintForbidden({ programId: 'vort1.random-printer', mint: true }), false);
    assert.equal(extraMintAllowed('vort1.random-printer', { kind: 'mint' }), false);
    assert.equal(extraMintAllowed('shear-reserve-v1-fee', { kind: 'reserve-fee' }), false);
    assert.equal(extraMintAllowed('', { kind: 'reserve-fee' }), false);
  });
});
