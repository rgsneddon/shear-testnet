import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeader } from '../../crypto/header.js';
import { P2P_FAIL_DISCONNECT } from '../src/p2p.js';
import {
  activeFailSet,
  failActive,
  isFinalIngestFail,
  isUpgradeableIngestFail,
  nextSequentialHeader,
  noteSoftFail,
  recordIngestFail,
  SOFT_FAIL_TTL_MS,
  upgradeableHold,
} from '../src/p2p.js';

function headerFor(prev) {
  return encodeHeader({
    prevBlockHash: prev,
    merkleRoot: Buffer.alloc(32, 2),
    continuityRoot: Buffer.alloc(32, 3),
    timestamp: 1_000n,
    bits: 4,
  }).toString('hex');
}

describe('upgradeable ingest fails do not freeze want', () => {
  it('keeps merkle, pow, and bits final and treats evm as a TTL fail', () => {
    assert.equal(isFinalIngestFail('merkle'), true);
    assert.equal(isFinalIngestFail('pow'), true);
    assert.equal(isFinalIngestFail('bits'), true);
    assert.equal(isUpgradeableIngestFail('unsigned'), true);
    assert.equal(isFinalIngestFail('unsigned'), false);
    assert.equal(isUpgradeableIngestFail('evm'), true);
    assert.equal(isUpgradeableIngestFail('admit_membership'), true);
    assert.equal(isFinalIngestFail('evm'), false);
    assert.equal(isFinalIngestFail('admit_membership'), false);
    const rec = { expensiveFails: 0 };
    for (let i = 0; i < P2P_FAIL_DISCONNECT + 4; i += 1) {
      assert.equal(recordIngestFail(rec, 'evm'), false);
      assert.equal(recordIngestFail(rec, 'unsigned'), false);
      assert.equal(recordIngestFail(rec, 'admit_membership'), false);
    }
    assert.equal(rec.expensiveFails, 0);
  });

  it('skips the next header while evm is soft-failed, then resumes after the TTL', () => {
    const prev = Buffer.alloc(32, 0x11);
    const localHash = prev.toString('hex');
    const hash = 'ab'.repeat(32);
    const headers = [{ hash, height: 101, header: headerFor(prev) }];
    const now = 1_700_000_000_000;
    const rec = { failed: new Set(), softFailed: new Map() };
    noteSoftFail(rec, hash, 'evm', now, '15.0');
    assert.equal(failActive(rec, hash, now, '15.0'), true);
    assert.equal(upgradeableHold(rec, headers, 100, now, '15.0'), hash);
    const held = nextSequentialHeader({
      headers,
      localHeight: 100,
      localHash,
      failed: activeFailSet(rec, now, '15.0'),
    });
    assert.equal(held, null);
    const later = now + SOFT_FAIL_TTL_MS;
    assert.equal(failActive(rec, hash, later, '15.0'), false);
    const resumed = nextSequentialHeader({
      headers,
      localHeight: 100,
      localHash,
      failed: activeFailSet(rec, later, '15.0'),
    });
    assert.equal(resumed?.hash, hash);
    assert.equal(resumed?.height, 101);
  });

  it('clears admit_membership when the pin changes and leaves merkle in failed', () => {
    const now = 1_700_000_000_000;
    const rec = { failed: new Set(['cc'.repeat(32)]), softFailed: new Map() };
    noteSoftFail(rec, 'dd'.repeat(32), 'admit_membership', now, '15.0');
    assert.equal(failActive(rec, 'dd'.repeat(32), now, '15.0'), true);
    assert.equal(failActive(rec, 'dd'.repeat(32), now, '15.1'), false);
    assert.equal(rec.softFailed.has('dd'.repeat(32)), false);
    assert.equal(failActive(rec, 'cc'.repeat(32), now + SOFT_FAIL_TTL_MS * 10, '15.1'), true);
    const blocked = activeFailSet(rec, now, '15.1');
    assert.equal(blocked.has('cc'.repeat(32)), true);
    assert.equal(blocked.has('dd'.repeat(32)), false);
  });
});
