import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeHeader } from '../../crypto/header.js';
import { P2P_FAIL_DISCONNECT } from '../src/p2p.js';
import {
  activeFailSet,
  failActive,
  isFinalIngestFail,
  isUpgradeableIngestFail,
  nextSequentialHeader,
  noteRefusedBlock,
  noteSoftFail,
  recordIngestFail,
  upgradeableHold,
} from '../src/p2p.js';
import { UPGRADEABLE_REASONS } from '../src/chain.js';

function headerFor(prev) {
  return encodeHeader({
    prevBlockHash: prev,
    merkleRoot: Buffer.alloc(32, 2),
    continuityRoot: Buffer.alloc(32, 3),
    timestamp: 1_000n,
    bits: 4,
  }).toString('hex');
}

// Reasons that are not a refusal of the block: a parent not here yet, a
// burial run not here yet, a branch that has not won, or a local fault
// (p2p.js isFinalIngestFail). A peer asks again for these by design.
const NOT_A_REFUSAL = new Set(['prev', 'hash_bonus', 'side_hold', 'not_heavier', 'samples_pruned', 'apply_stage', 'pow_worker', 'evm_local']);

/** Every refusal reason literal on the arrival and verify path. */
function arrivalReasons() {
  const files = [
    '../src/chain.js', '../src/store.js',
    '../../crypto/arrival_fields.js', '../../crypto/chronoflux.js', '../../crypto/spend.js',
    '../../crypto/note.js', '../../crypto/reserve_vault.js', '../../crypto/fs1_send_gate.js',
    '../../crypto/address.js', '../../crypto/admit_v3.js', '../../crypto/mempool.js',
  ];
  const out = new Set();
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/reason: '([a-z0-9_]+)'/g)) out.add(m[1]);
  }
  return out;
}

describe('a refused block is never fetched again on the same binary', () => {
  it('keeps merkle, pow, and bits final; evm, unsigned, and admit_membership are upgradeable and never ban', () => {
    assert.equal(isFinalIngestFail('merkle'), true);
    assert.equal(isFinalIngestFail('pow'), true);
    assert.equal(isFinalIngestFail('bits'), true);
    assert.deepEqual([...UPGRADEABLE_REASONS].sort(), ['admit_membership', 'evm', 'unsigned']);
    for (const r of UPGRADEABLE_REASONS) {
      assert.equal(isUpgradeableIngestFail(r), true, r);
      assert.equal(isFinalIngestFail(r), false, r);
    }
    const rec = { expensiveFails: 0 };
    for (let i = 0; i < P2P_FAIL_DISCONNECT + 4; i += 1) {
      for (const r of UPGRADEABLE_REASONS) assert.equal(recordIngestFail(rec, r), false);
    }
    assert.equal(rec.expensiveFails, 0);
    // The node's own EVM failing to start or replay is local: no refusal,
    // no score, the block is asked again (a soft fail would hold it until restart).
    assert.equal(isFinalIngestFail('evm_local'), false);
    assert.equal(isUpgradeableIngestFail('evm_local'), false);
    assert.equal(noteRefusedBlock(rec, 'ee'.repeat(32), 'evm_local'), '');
    assert.equal(recordIngestFail(rec, 'evm_local'), false);
    const chainSrc = fs.readFileSync(new URL('../src/chain.js', import.meta.url), 'utf8');
    const evmFn = chainSrc.slice(chainSrc.indexOf('async function verifyBlockEvm'));
    const head = evmFn.slice(0, evmFn.indexOf('executeBlockEvm(session, block.txs'));
    assert.equal((head.match(/reason: 'evm_local'/g) || []).length, 2, 'boot and replay faults are local');
    assert.equal(/reason: 'evm'[,\s]/.test(head), false, 'neither is noted as a block verdict');
  });

  it('a soft fail holds on the same pin with no timer; a pin change retries it exactly once', () => {
    const prev = Buffer.alloc(32, 0x11);
    const localHash = prev.toString('hex');
    const hash = 'ab'.repeat(32);
    const headers = [{ hash, height: 101, header: headerFor(prev) }];
    const now = 1_700_000_000_000;
    const rec = { failed: new Set(), softFailed: new Map() };
    assert.equal(noteRefusedBlock(rec, hash, 'evm', now, '16.0'), 'soft');
    for (const later of [now, now + 60_000, now + 86_400_000, now + 365 * 86_400_000]) {
      assert.equal(failActive(rec, hash, later, '16.0'), true, `held at +${later - now} ms`);
      assert.equal(nextSequentialHeader({ headers, localHeight: 100, localHash, failed: activeFailSet(rec, later, '16.0') }), null);
    }
    assert.equal(upgradeableHold(rec, headers, 100, now, '16.0'), hash);
    // A new binary asks once: the fail noted under the old pin ends.
    assert.equal(failActive(rec, hash, now, '16.1'), false);
    const retried = nextSequentialHeader({ headers, localHeight: 100, localHash, failed: activeFailSet(rec, now, '16.1') });
    assert.equal(retried?.hash, hash);
    // It refuses it again: noted under the new pin, held again for good.
    assert.equal(noteRefusedBlock(rec, hash, 'evm', now, '16.1'), 'soft');
    assert.equal(failActive(rec, hash, now + 365 * 86_400_000, '16.1'), true);
    assert.equal(nextSequentialHeader({ headers, localHeight: 100, localHash, failed: activeFailSet(rec, now, '16.1') }), null);
  });

  it('a pin change clears admit_membership once and leaves merkle in failed', () => {
    const now = 1_700_000_000_000;
    const rec = { failed: new Set(['cc'.repeat(32)]), softFailed: new Map() };
    noteSoftFail(rec, 'dd'.repeat(32), 'admit_membership', now, '16.0');
    assert.equal(failActive(rec, 'dd'.repeat(32), now, '16.0'), true);
    assert.equal(failActive(rec, 'dd'.repeat(32), now, '15.1'), false);
    assert.equal(rec.softFailed.has('dd'.repeat(32)), false);
    assert.equal(failActive(rec, 'cc'.repeat(32), now + 365 * 86_400_000, '15.1'), true);
    const blocked = activeFailSet(rec, now, '15.1');
    assert.equal(blocked.has('cc'.repeat(32)), true);
    assert.equal(blocked.has('dd'.repeat(32)), false);
  });

  it('wiring: p2p records a refusal only through noteRefusedBlock or notePeerOnlyRefusal', () => {
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    const body = (name) => {
      const at = src.indexOf(`export function ${name}(`);
      assert.ok(at >= 0, name);
      return src.slice(at, src.indexOf(`${String.fromCharCode(10)}}${String.fromCharCode(10)}`, at));
    };
    const writes = (s, re) => (s.match(re) || []).length;
    // Every write to a peer's fail sets sits in one of the three recorders.
    const recorders = ['noteSoftFail', 'noteRefusedBlock', 'notePeerOnlyRefusal'].map(body).join(String.fromCharCode(10));
    assert.equal(writes(src, /failed\.add\(/g), writes(recorders, /failed\.add\(/g), 'failed.add only in a recorder');
    assert.equal(writes(src, /softFailed\.set\(/g), writes(recorders, /softFailed\.set\(/g), 'softFailed.set only in a recorder');
    assert.equal(writes(src, /noteSoftFail\(/g), 2, 'noteSoftFail is defined once and called only by noteRefusedBlock');
    // The ingest result handler routes every refusal through them.
    const handler = src.slice(src.indexOf('function ingestDecodedFork('));
    const done = handler.slice(0, handler.indexOf('noteCapIdle(sock);'));
    assert.ok(writes(done, /noteRefusedBlock\(rec, refusedHash, reason\)/g) >= 3, 'final and soft refusals are noted');
    assert.match(done, /notePeerOnlyRefusal\(rec, refusedHash\)/, 'a peer-only fault is scored');
  });

  it('liveness: every reason the arrival path can return is never fetched again from that peer on the same binary', () => {
    const reasons = arrivalReasons();
    assert.ok(reasons.size > 50, `found ${reasons.size} reasons`);
    for (const r of ['unsigned', 'range_proof', 'merkle', 'value_open', 'dropped_field', 'coinbase_output', 'rest_frame_on_chain', 'amount_field']) {
      assert.ok(reasons.has(r), `the scan finds ${r}`);
    }
    const now = 1_700_000_000_000;
    const year = 365 * 86_400_000;
    let held = 0;
    for (const r of reasons) {
      const hash = Buffer.from(r.padEnd(32, '.')).toString('hex').slice(0, 64);
      const rec = { failed: new Set(), softFailed: new Map() };
      const noted = noteRefusedBlock(rec, hash, r, now, '16.0');
      if (NOT_A_REFUSAL.has(r)) {
        assert.equal(noted, '', `${r} is not a refusal`);
        continue;
      }
      assert.ok(noted === 'final' || noted === 'soft', `${r} is noted`);
      assert.equal(noted === 'soft', UPGRADEABLE_REASONS.has(r), `${r}: soft only when upgradeable`);
      assert.equal(failActive(rec, hash, now + year, '16.0'), true, `${r}: never fetched again on the same binary`);
      assert.equal(activeFailSet(rec, now + year, '16.0').has(hash), true, `${r}: in the skip set`);
      held += 1;
    }
    assert.ok(held > 50, `held ${held}`);
  });
});
