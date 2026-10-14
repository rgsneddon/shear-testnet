import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import {
  GENESIS_BITS_PACKED,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
} from '../../crypto/asert.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import {
  GENESIS_BPS,
  ORACLE_QUORUM,
  RESERVE_ORACLE_ID,
  RESERVE_ORACLE_MAX_BPS,
  canonicalObserve,
  observeVerdict,
} from '../../crypto/reserve_oracle.js';
import {
  emptyVault,
  deposit,
  enact,
  observeRate,
  previewWithdraw,
} from '../../crypto/reserve_vault.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { GENESIS_PREV, buildTemplate, verifyBlock, digestTx } from '../src/chain.js';
import { createStore } from '../src/store.js';

const T0 = 1_700_000_000_000;
const BPS = [0, 1, 50, 100, 164, 264, 300, 364, 1000, 5000, 9999, RESERVE_ORACLE_MAX_BPS];
const BAD_BPS = [-1, RESERVE_ORACLE_MAX_BPS + 1, 1.5, Number.NaN, true, '9999', null, 2 ** 53];

function destOf(id) {
  return vaultDest(id.address, { viewKey: id.viewKey });
}

function payOf(id) {
  return destForLogin(id.address, { viewKey: id.viewKey });
}

function openEpoch(state, dest, nowMs) {
  const got = deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs });
  assert.equal(got.ok, true, got.reason);
  return got;
}

describe('oracle observe is sealed in a block', () => {
  it('any local rate, disk snapshot, or single block observe leaves the epoch on the bundle', () => {
    for (const bps of BPS) {
      const alice = newIdentity();
      const bob = newIdentity();
      const local = emptyVault();
      openEpoch(local, destOf(alice), T0);
      assert.equal(enact({ state: local, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      const refused = observeRate({
        state: local,
        annualBps: bps,
        nowMs: T0 + RESERVE_EPOCH_MS + 1,
      });
      assert.equal(refused.ok, false, `local ${bps}`);
      assert.equal(refused.reason, 'rate_bundled', `local ${bps}`);
      openEpoch(local, destOf(bob), T0 + RESERVE_EPOCH_MS + 2);
      assert.equal(local.epochBps, GENESIS_BPS, `local ${bps}`);

      const disk = emptyVault();
      openEpoch(disk, destOf(newIdentity()), T0);
      assert.equal(enact({ state: disk, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      disk.oracle = {
        id: RESERVE_ORACLE_ID,
        annualBps: bps,
        observedAtMs: T0 + RESERVE_EPOCH_MS + 1,
        components: [{ id: 'basket', bps }],
      };
      openEpoch(disk, destOf(newIdentity()), T0 + RESERVE_EPOCH_MS + 2);
      assert.equal(disk.epochBps, GENESIS_BPS, `disk ${bps}`);

      const held = emptyVault();
      const holder = destOf(newIdentity());
      openEpoch(held, holder, T0);
      const due = previewWithdraw(held, holder).interest;
      assert.equal(observeVerdict({ annualBps: bps, observedAtMs: T0 + 1 }).reason, 'oracle_quorum');
      assert.equal(previewWithdraw(held, holder).interest, due, `preview ${bps}`);
      assert.equal(held.epochBps, GENESIS_BPS, `single observe ${bps}`);
    }
  });

  it('createStore ignores a reserve.json oracle for every rate', () => {
    for (const bps of BPS) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-oracle-'));
      fs.writeFileSync(path.join(dir, 'reserve.json'), JSON.stringify({
        oracle: {
          id: RESERVE_ORACLE_ID,
          annualBps: bps,
          observedAtMs: T0,
          components: [{ id: 'basket', bps }],
        },
        epochBps: bps,
        portals: { dead: { staked: '1', idle: '0' } },
      }));
      const store = createStore(dir);
      assert.equal(store.reserveVault.epochBps, GENESIS_BPS, `boot ${bps}`);
      const refused = observeRate({
        state: store.reserveVault,
        annualBps: bps,
        nowMs: T0 + RESERVE_EPOCH_MS + 1,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'rate_bundled');
      assert.equal(store.reserveVault.epochBps, GENESIS_BPS, `store roll ${bps}`);
    }
  });

  it('the coinbase digest binds a sealed observe, and compact keeps the canonical fields', () => {
    const plain = { coinbase: true, height: 1, vin: [{ coinbase: true }], vout: [] };
    const bare = digestTx(plain);
    for (const bps of [0, 264, RESERVE_ORACLE_MAX_BPS]) {
      const row = {
        ...plain,
        observe: { annualBps: bps, observedAtMs: T0, extra: 'not-consensus' },
      };
      const dig = digestTx(row);
      assert.equal(dig.equals(bare), false, `bare ${bps}`);
      const other = bps === RESERVE_ORACLE_MAX_BPS ? 0 : bps + 1;
      const flipped = digestTx({ ...plain, observe: { annualBps: other, observedAtMs: T0 } });
      assert.equal(dig.equals(flipped), false, `flip ${bps}`);
      const compact = compactTx(row);
      assert.equal(compact.observe.annualBps, bps);
      assert.equal(compact.observe.observedAtMs, T0);
      assert.equal(Object.prototype.hasOwnProperty.call(compact.observe, 'extra'), false);
      assert.deepEqual(compact.observe, canonicalObserve(row.observe));
      assert.equal(digestTx(compact).equals(dig), true, `compact ${bps}`);
    }
  });

  it('verifyBlock rejects a non-canonical observe and rejects a canonical one without quorum', async () => {
    const who = payOf(newIdentity());
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      finderDest: '',
      txs: [],
      bits: GENESIS_BITS_PACKED,
      now: T0,
    });
    const decoded = decodeHeader(Buffer.from(tpl.header));
    function blockFor(observe) {
      const cb = { ...tpl.txs[0], observe };
      const header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: merkleRoot([digestTx(cb)]),
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      return {
        header,
        txs: [cb],
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: tpl.miner,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        weight: tpl.weight,
        height: tpl.height,
      };
    }
    for (const bps of BPS) {
      const got = await verifyBlock(blockFor({ annualBps: bps, observedAtMs: T0 }), null, { probeBody: true });
      assert.equal(got.ok, false, `${bps} ${got.reason}`);
      assert.equal(got.reason, 'oracle_quorum', `${bps}`);
    }
    for (const annualBps of BAD_BPS) {
      const got = await verifyBlock(blockFor({ annualBps, observedAtMs: T0 }), null, { probeBody: true });
      assert.equal(got.ok, false, String(annualBps));
      assert.equal(got.reason, 'bad_rate', String(annualBps));
    }
    assert.equal(ORACLE_QUORUM, 14);
  });
});
