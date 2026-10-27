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
  RESERVE_ORACLE_ID,
  observeRate as observeOracle,
} from '../../crypto/reserve_oracle.js';
import {
  emptyVault,
  enact,
  observeRate,
  applyReserveBlock,
  portalEpochInterest,
  portalIdFromDest,
  previewWithdraw,
} from '../../crypto/reserve_vault.js';
import { deposit } from '../../crypto/owned_portal.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { arrivalFieldRejected, blockArrivalRejected } from '../../crypto/arrival_fields.js';
import { GENESIS_PREV, buildTemplate, verifyBlock, digestTx } from '../src/chain.js';
import { createStore } from '../src/store.js';

const T0 = 1_700_000_000_000;
const RATES = [0, 1, 50, 100, 284, 300, 1000, 5000, 10000];

function destOf(id) {
  return vaultDest(id.address, { viewKey: id.viewKey });
}

function openEpoch(state, dest, nowMs) {
  if (!(Number(state.genesisMs) > 0)) state.genesisMs = T0;
  const got = deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs });
  assert.equal(got.ok, true, got.reason);
  return got;
}

describe('oracle observe is not a rate', () => {
  it('a local rate and a coinbase observe leave the epoch on the genesis bps', () => {
    for (const bps of RATES) {
      const alice = newIdentity();
      const local = emptyVault();
      openEpoch(local, destOf(alice), T0);
      assert.equal(enact({ state: local, nowMs: T0 + RESERVE_EPOCH_MS }).ok, true);
      const seen = observeRate({
        state: local,
        annualBps: bps,
        nowMs: T0 + RESERVE_EPOCH_MS + 1,
      });
      assert.equal(seen.ok, false);
      assert.equal(seen.reason, 'rate_bundled');
      assert.equal(observeOracle(local.oracle, { annualBps: bps }).reason, 'rate_bundled');
      openEpoch(local, destOf(newIdentity()), T0 + RESERVE_EPOCH_MS + 2);
      assert.equal(local.epochBps, GENESIS_BPS, `local ${bps}`);

      const held = emptyVault();
      const holder = destOf(newIdentity());
      openEpoch(held, holder, T0);
      const due = portalEpochInterest(
        held,
        held.portals[portalIdFromDest(holder)],
        T0 + RESERVE_EPOCH_MS,
      );
      const mid = applyReserveBlock({
        state: held,
        block: { txs: [{ coinbase: true, vout: [], observe: { annualBps: bps, observedAtMs: T0 + 1 } }] },
        nowMs: T0 + 1,
      });
      assert.equal(mid.ok, false);
      assert.equal(mid.reason, 'observe_unattested');
      assert.equal(held.epochBps, GENESIS_BPS);
      assert.equal(previewWithdraw(held, holder).interest, 0);
      assert.equal(portalEpochInterest(
        held,
        held.portals[portalIdFromDest(holder)],
        T0 + RESERVE_EPOCH_MS,
      ), due);
      // Hidden locks keep the amount inside the commitment. A withdraw pays
      // principal only; the stake reward is a later claim. This reading stays 0.
      assert.equal(due, 0);
    }
  });

  it('a coinbase naming an observe is refused on arrival, not compacted into the bare one', () => {
    // An observe is not body (compaction would drop it, TX_DIGEST=body-v2),
    // and a coinbase may not carry one: it is refused as it arrives, before
    // compaction, so compaction never decides that it is allowed.
    const plain = { coinbase: true, height: 1, vin: [{ coinbase: true }], vout: [] };
    assert.equal(arrivalFieldRejected(plain), null, 'the bare coinbase arrives');
    for (const bps of RATES) {
      const row = { ...plain, observe: { annualBps: bps, observedAtMs: T0 } };
      assert.deepEqual(arrivalFieldRejected(row), { ok: false, reason: 'observe_unattested' }, `observe ${bps}`);
      assert.deepEqual(blockArrivalRejected({ txs: [row] }), { ok: false, reason: 'observe_unattested' }, `block ${bps}`);
      assert.equal(compactTx(row).observe, undefined, `compact ${bps}`);
    }
  });

  it('createStore ignores a reserve.json oracle', () => {
    for (const bps of RATES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-oracle-'));
      // Lock the empty datadir down first. icacls /setowner denies a file
      // planted before that ACL exists, so the bad oracle is written after
      // the warm open and read on the reload.
      createStore(dir);
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
      assert.equal(store.reserveVault.oracle.annualBps, GENESIS_BPS, `oracle ${bps}`);
    }
  });

  it('verifyBlock rejects every observe', async () => {
    const who = destForLogin(newIdentity().address, { viewKey: newIdentity().viewKey });
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
      return { ...tpl, header, txs: [cb] };
    }
    for (const bps of RATES) {
      const got = await verifyBlock(blockFor({ annualBps: bps, observedAtMs: T0 }), null, { probeBody: true });
      assert.equal(got.ok, false, String(bps));
      assert.equal(got.reason, 'observe_unattested', String(bps));
    }
    const stray = await verifyBlock(blockFor(null), null, { probeBody: true });
    void stray;
    const body = blockFor(undefined);
    body.txs = [
      { ...tpl.txs[0] },
      { kind: 'send', observe: { annualBps: 300, observedAtMs: T0 } },
    ];
    const decodedBody = decodeHeader(Buffer.from(tpl.header));
    body.header = encodeHeader({
      version: decodedBody.version,
      prevBlockHash: decodedBody.prevBlockHash,
      merkleRoot: merkleRoot(body.txs.map(digestTx)),
      continuityRoot: decodedBody.continuityRoot,
      timestamp: decodedBody.timestamp,
      bits: decodedBody.bits,
      nonce: 0n,
      baseFee: decodedBody.baseFee,
    });
    const offCoinbase = await verifyBlock(body, null, { probeBody: true });
    assert.equal(offCoinbase.reason, 'observe_unattested');
  });
});
