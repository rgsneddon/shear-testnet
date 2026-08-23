import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { RESERVE_PROGRAM } from '../../crypto/asert.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';
import { createStore } from '../src/store.js';

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
  };
}

describe('verifyBlock extra mint', () => {
  it('rejects unfunded extra txs and accepts Reserve-only extra mint via append', () => {
    const id = newIdentity();
    const base = {
      prev: GENESIS_PREV,
      height: 1,
      miner: id.address,
      bits: 8,
      now: Date.now(),
    };
    const good = mine(buildTemplate(base));
    const ok = verifyBlock(good, null);
    assert.equal(ok.ok, true);

    const thief = {
      vin: [],
      vout: [{ address: id.address, nanos: 99 }],
      programId: 'third-party-stake',
    };
    const stolen = mine(buildTemplate({ ...base, txs: [thief] }));
    const denied = verifyBlock(stolen, null);
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'mint_forbidden');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-store-'));
    const store = createStore(dir);
    const appended = store.append(stolen);
    assert.equal(appended.ok, false);
    assert.equal(appended.reason, 'mint_forbidden');

    const reserveTx = {
      programId: RESERVE_PROGRAM,
      mint: true,
      vin: [],
      vout: [{ address: id.address, nanos: 7, kind: 'reserve' }],
    };
    const reserved = mine(buildTemplate({ ...base, txs: [reserveTx] }));
    const allowed = verifyBlock(reserved, null);
    assert.equal(allowed.ok, true);
    const stored = store.append(reserved);
    assert.equal(stored.ok, true);
  });
});
