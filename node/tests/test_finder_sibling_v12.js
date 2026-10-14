import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { SHARE_FLOOR_BITS, GENESIS_BITS_PACKED, shareCreditMaxBits, MAX_SHARES_PER_BLOCK } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { splitLevy } from '../../crypto/levy.js';
import { noteCommitOfDest20 } from '../../crypto/note.js';
import {
  ENC_MAGIC,
  ENC_SHARE_WORK,
  ENC_SHARE_WORK_KIN,
  packShareBatch,
  unpackShareBatch,
} from '../../crypto/pack.js';
import {
  bindShareProofSlots,
  clearLiveSharePow,
  hasLiveSharePow,
  nonceWithShareTarget,
  rememberLiveSharePow,
  resetSharePowCounters,
  sharePowCounters,
  splitDeferWindow,
  verifyShareBatch,
} from '../../crypto/share_batch.js';
import {
  GENESIS_PREV,
  buildTemplate,
  coinbaseLevyPays,
  templateForFinder,
} from '../src/chain.js';
import { provenLag1Shares } from '../../pool/src/pool.js';

const NOW = 1_700_000_000_000;
const MINER_COUNTS = [1, 2, 4];
const FEES = [2, 3, 100, 1000];
const OUT_OFFSETS = [0, 4, 36, 68, 100, 108, 120];
const IN_OFFSETS = [112];

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function widths() {
  const top = shareCreditMaxBits();
  assert.ok(top > SHARE_FLOOR_BITS);
  return [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 1, top];
}

function makeShare(dest, header, low, bits) {
  const d20 = hash20FromAddress(dest);
  return {
    dest,
    nonce: nonceWithShareTarget(low, bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    noteCommit: noteCommitOfDest20(d20),
    verifiedHeader: Buffer.from(header),
  };
}

function finderCommit(tpl) {
  const note = tpl.txs[0].vout.find((o) => o.kind === 'finder-fee');
  assert.ok(note?.commit, 'finder note');
  return Buffer.from(note.commit);
}

describe('finder siblings stay in the sealed round', () => {
  it('slots an issued same-round header and holds the shared finder half', () => {
    const band = widths();
    let low = 1n;
    for (const miners of MINER_COUNTS) {
      for (const fee of FEES) {
        assert.ok(splitLevy(fee).finder > 0, `fee ${fee}`);
        const dests = Array.from({ length: miners }, () => minerDest());
        const feeTo = minerDest();
        const shared = buildTemplate({
          prev: GENESIS_PREV,
          height: 1,
          miner: dests[0],
          finderDest: '',
          poolDest: feeTo,
          feeDest: feeTo,
          txs: [{ id: `fee-${miners}-${fee}`, kind: 'send', fee }],
          bits: GENESIS_BITS_PACKED,
          now: NOW,
        });
        const held = coinbaseLevyPays(shared.txs[0], fee);
        assert.equal(held.ok, true, held.reason || `fee ${fee}`);

        const t0 = performance.now();
        const first = templateForFinder(shared, dests[0]);
        const sealMs = performance.now() - t0;
        const t1 = performance.now();
        const second = templateForFinder(shared, dests[0]);
        const hitMs = performance.now() - t1;
        assert.ok(finderCommit(first).equals(finderCommit(second)), `miners ${miners} fee ${fee}`);
        const bumped = Buffer.from(shared.header);
        const stamp = bumped.readBigUInt64LE(100) + 90_000n;
        bumped.writeBigUInt64LE(stamp, 100);
        const restamped = templateForFinder({ ...shared, header: bumped }, dests[0]);
        assert.ok(Buffer.from(restamped.merkleRoot).equals(Buffer.from(first.merkleRoot)));
        assert.equal(decodeHeader(Buffer.from(restamped.header)).timestamp, stamp);
        const outsider = minerDest();
        const other = templateForFinder(shared, outsider);
        assert.equal(Buffer.from(other.merkleRoot).equals(Buffer.from(first.merkleRoot)), false);
        console.error(JSON.stringify({
          psa: 'finder-aim-cache',
          miners,
          fee,
          sealMs,
          hitMs,
        }));

        const aimed = dests.map((dest, i) => (i === 0 ? first : templateForFinder(shared, dest)));
        const parent = Buffer.from(aimed[0].header);
        const issued = [shared.header, ...aimed.map((tpl) => tpl.header)];
        const shares = [
          makeShare(dests[0], shared.header, low, band[0]),
        ];
        low += 1n;
        dests.forEach((dest, i) => {
          shares.push(makeShare(dest, aimed[i].header, low, band[i % band.length]));
          low += 1n;
        });
        const kept = provenLag1Shares(parent, shares, null, null, issued);
        assert.equal(kept.length, shares.length, `miners ${miners} fee ${fee}`);
        const window = splitDeferWindow(shares, parent, null, MAX_SHARES_PER_BLOCK, issued);
        assert.equal(window.stale.length, 0, `miners ${miners} fee ${fee}`);
        assert.equal(window.seal.length, shares.length, `miners ${miners} fee ${fee}`);
        assert.equal(window.carry.length, 0);
        assert.equal(window.owe.length, 0);
        const bound = bindShareProofSlots(shares.map((s) => ({ ...s })), parent, null, { issuedJobKeys: issued });
        assert.equal(bound.unslotted.length, 0);
        assert.equal(bound.slotted.length, shares.length);
        const finderRow = bound.slotted.find((s) => Buffer.from(s.verifiedHeader).equals(parent));
        assert.equal(finderRow.proofSlot, 0);
        assert.equal(finderRow.kinHeader, false);
        const kinRows = bound.slotted.filter((s) => s.kinHeader);
        assert.ok(kinRows.length >= 1);
        for (const row of kinRows) assert.equal(row.proofSlot, 0);

        const kinPacked = packShareBatch([kinRows[0]]);
        const exactPacked = packShareBatch([finderRow]);
        assert.equal(kinPacked[0][ENC_MAGIC.length], ENC_SHARE_WORK_KIN);
        assert.equal(exactPacked[0][ENC_MAGIC.length], ENC_SHARE_WORK);
        assert.equal(kinPacked[0].length, exactPacked[0].length + 128);
        const unpacked = unpackShareBatch(kinPacked)[0];
        assert.equal(unpacked.kinHeader, true);
        assert.ok(Buffer.from(unpacked.verifiedHeader).equals(Buffer.from(kinRows[0].verifiedHeader)));

        clearLiveSharePow();
        resetSharePowCounters();
        const kin = kinRows[0];
        const remembered = rememberLiveSharePow(kin.verifiedHeader, kin.nonce, {
          noteCommit: kin.noteCommit,
          shareBits: kin.shareBits,
          lz: kin.shareBits,
        });
        assert.equal(remembered, true);
        const verdict = verifyShareBatch({ parentHeader: parent, shares: [kin], issuedJobKeys: issued });
        assert.equal(verdict.ok, true, verdict.reason || `miners ${miners} fee ${fee}`);
        assert.equal(sharePowCounters().sync, 0);
        assert.equal(hasLiveSharePow(kin.verifiedHeader, kin.nonce), true);

        const sample = Buffer.from(miners > 1 ? aimed[1].header : shared.header);
        const sampleIssued = [sample];
        for (const off of OUT_OFFSETS) {
          const bad = Buffer.from(sample);
          bad[off] ^= 0x01;
          const badShare = makeShare(dests[0], bad, low, band[0]);
          low += 1n;
          assert.equal(provenLag1Shares(parent, [badShare], null, null, sampleIssued).length, 0, `out ${off}`);
          const deniedSlot = bindShareProofSlots([{ ...badShare }], parent, null, { issuedJobKeys: sampleIssued });
          assert.equal(deniedSlot.unslotted.length, 1, `out ${off}`);
          clearLiveSharePow();
          resetSharePowCounters();
          const forced = { ...badShare, proofSlot: 0 };
          const denied = verifyShareBatch({
            parentHeader: parent,
            shares: [forced],
            issuedJobKeys: sampleIssued,
          });
          assert.equal(denied.ok, false, `out ${off}`);
          assert.equal(denied.reason, 'share_slot', `out ${off}`);
          assert.equal(sharePowCounters().sync, 0, `out ${off}`);
        }
        for (const off of IN_OFFSETS) {
          const tweaked = Buffer.from(sample);
          tweaked[off] ^= 0x01;
          const okShare = makeShare(dests[0], tweaked, low, band[0]);
          low += 1n;
          assert.equal(provenLag1Shares(parent, [okShare], null, null, sampleIssued).length, 1, `in ${off}`);
          const keptSlot = bindShareProofSlots([{ ...okShare }], parent, null, { issuedJobKeys: sampleIssued });
          assert.equal(keptSlot.unslotted.length, 0, `in ${off}`);
          assert.equal(keptSlot.slotted[0].proofSlot, 0, `in ${off}`);
          assert.equal(keptSlot.slotted[0].kinHeader, true, `in ${off}`);
        }
      }
    }
  });
});
