import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, isDestAddress } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import { RESERVE_PROGRAM, wrapMintForbidden, extraMintAllowed, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { withdrawTx } from '../../crypto/reserve_vault.js';
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
    const stolen = mine(buildTemplate({ ...base, txs: [thief] }));
    const denied = await Promise.resolve(verifyBlock(stolen, null, trust(stolen)));
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'mint_forbidden');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-store-'));
    const store = createStore(dir);
    const appended = await Promise.resolve(store.append(stolen, trust(stolen)));
    assert.equal(appended.ok, false);
    assert.equal(appended.reason, 'mint_forbidden');

    const reserveTx = {
      ...withdrawTx({ from: dest, to: vault, nanos: 7, id: 'w-7' }),
      fee: 1,
    };
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
