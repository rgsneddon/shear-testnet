/**
 * Real FS-1 sends for regtest tests: hidden outputs, the levy settled against
 * the exact final byte length, and the native FS-1 proof. Shared by
 * test_fs1_spend_v12 and the Dart lock e2e, so both spend the same way.
 */
import assert from 'node:assert/strict';
import { MAGIC_REGTEST } from '../../crypto/regtest_bits.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { attachAdmitPub, blindCommit } from '../../crypto/admit.js';
import { asU8, kernelExcess, sealHiddenNote, sealNote } from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { FS1_RECORD_BYTES, FS1_WIRE, fs1BlobLen, fs1ProveSpend, txBodyDigestFs1 } from '../../crypto/fs1_spend.js';

/** One sealed output. A dummy keeps its zero opening; any other output is hidden. */
export function hiddenOut(nanos, dest20, admitBase, kind) {
  const sealed = admitBase
    ? sealHiddenNote(nanos, { dest20, kind, admitBase })
    : sealNote(nanos, { dest20, kind });
  let note = attachAdmitPub(sealed, admitBase ? { admitBase } : {});
  note = { ...note, kind, dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  if (kind !== 'dummy') delete note.valueProof;
  return note;
}

export function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

/** Placeholder FS-1 fields of the exact final length, with the widest JSON bytes. */
export function placeholders(k) {
  const fs1 = Buffer.alloc(fs1BlobLen(k), 255);
  fs1[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < k; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({ admit_proof: true, v: 3, spendTag: Buffer.alloc(32, 255), blob, cTilde: Buffer.alloc(32, 255) });
  }
  return { fs1, proofs, vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })) };
}

/**
 * Build, settle the levy, and prove one send of `coins` (each
 * { index, x, r, v, commit }). `outsOf(room)` builds the outputs.
 */
export function buildSend({ id, kind = 'send', coins, anchor, live, outsOf, magic = MAGIC_REGTEST }) {
  const total = coins.reduce((s, c) => s + c.v, 0);
  const k = coins.length;
  const ph = placeholders(k);
  let fee = LEVY_FLOOR_UNITS;
  let outs = null;
  let draft = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const room = total - fee;
    assert.ok(room >= 1, `fee consumes the coins ${total} ${fee}`);
    outs = outsOf(room);
    draft = compactTx({
      id,
      kind,
      anchor,
      fee,
      vin: ph.vin,
      vout: outs,
      fs1: ph.fs1,
      admit_proofs: ph.proofs,
      excess: Buffer.alloc(32, 255),
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    const next = need + rangeSlack(outs);
    assert.ok(next > fee && next <= LEVY_CAP_NANOS, `levy ${need} fee ${fee}`);
    fee = next;
    draft = null;
  }
  assert.ok(draft, 'fee did not settle');
  const t0 = process.hrtime.bigint();
  const proven = fs1ProveSpend({
    live,
    anchor,
    indices: coins.map((c) => c.index),
    xs: coins.map((c) => c.x),
    tx: draft,
    magic,
  });
  const proveMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(proven, `${id} prove`);
  assert.equal(proven.fs1.length, fs1BlobLen(k));
  for (let i = 0; i < k; i += 1) {
    const want = Buffer.from(blindCommit(coins[i].commit, proven.t[i]));
    assert.ok(want.equals(proven.proofs[i].cTilde), `${id} C~ ${i} is C + t·H`);
  }
  const excess = kernelExcess(outs, coins.map((c, i) => ({ r: c.r, t: proven.t[i] })));
  assert.ok(excess, `${id} excess`);
  const tx = compactTx({
    id,
    kind,
    anchor,
    fee: draft.fee,
    vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
    vout: outs,
    fs1: proven.fs1,
    admit_proofs: proven.proofs,
    excess,
  });
  const need = levyNeed(tx);
  assert.ok(tx.fee >= need, `${id} levy ${need} fee ${tx.fee}`);
  assert.ok(txBodyDigestFs1(tx, magic).equals(proven.digest), `${id} compact digest`);
  return { tx, outs, proven, proveMs, fee: tx.fee, total };
}
