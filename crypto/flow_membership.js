/**
 * Interim testnet membership proof pending FS-1.
 *
 * v12 consensus accepts a byte-3 blob plus an anchor. This module builds that
 * statement and proves it. FS-1 replaces membershipStatement(); the prover
 * keeps taking the statement bytes that function returns.
 *
 * The group of 32 is not full-set hiding. Do not describe it as such.
 * Byte-2 prove and verify stay in admit.js for their existing callers.
 */
import fs from 'node:fs';
import { MAGIC_TESTNET } from './asert.js';
import { admitProveV3 } from './admit.js';
import { admitV3Context, fundingJroot, txDigestV3 } from './admit_v3.js';
import { nativeBindInput } from './native_admit.js';
import { asU8, scalarBytes } from './note.js';

function membershipProgress(row) {
  const dest = process.env.SHEAR_MEMBERSHIP_PROGRESS;
  if (!dest) return;
  const line = JSON.stringify({ t: new Date().toISOString(), ...row });
  try { fs.appendFileSync(dest, `${line}\n`); } catch { /* a log miss is not a verdict */ }
}

export const MEMBERSHIP_STATEMENT_BYTES = 64;
export const MEMBERSHIP_INPUT_CAP = 8;

/** FS-1 replaces this statement. Today it is the 64-byte testnet context. */
export function membershipStatement({ magic = MAGIC_TESTNET, anchor, root, n, digest }) {
  return admitV3Context({ magic, anchor, root, n, digest });
}

/**
 * One input. [statement] is membershipStatement(). The native prover does not
 * choose the statement.
 */
export function proveMembershipSpend({ x, index, pubs, commits, c, t, statement }) {
  const ctx = Buffer.isBuffer(statement) ? statement : Buffer.from(statement || []);
  if (ctx.length !== MEMBERSHIP_STATEMENT_BYTES) return null;
  const proof = admitProveV3({
    x,
    index,
    pubs,
    commits,
    c,
    t,
    ctx,
  });
  if (!proof || proof.v !== 3 || !proof.blob || proof.blob[0] !== 3 || proof.r) return null;
  return {
    admit_proof: true,
    v: 3,
    spendTag: Buffer.from(asU8(proof.spendTag)),
    blob: proof.blob,
    cTilde: Buffer.from(asU8(proof.cTilde)),
    t: proof.t,
  };
}

/**
 * Seal a send or transfer. [inputs] is 1..8 rows of { x, index, c, t }.
 * One statement covers every input. The returned body is what queueTx checks:
 * byte 3, one anchor, cTilde on each vin.
 */
export function sealFlowMembership(tx, {
  inputs,
  pubs,
  commits,
  root = null,
  n = null,
  magic = MAGIC_TESTNET,
} = {}) {
  const kind = String(tx?.kind || '');
  if (kind !== 'send' && kind !== 'transfer') return null;
  const anchor = Number(tx?.anchor);
  if (!Number.isInteger(anchor)) return null;
  const rowsIn = Array.isArray(inputs) ? inputs : [];
  if (rowsIn.length < 1 || rowsIn.length > MEMBERSHIP_INPUT_CAP) return null;
  const ps = Array.isArray(pubs) ? pubs : [];
  const cs = Array.isArray(commits) ? commits : [];
  if (!ps.length || ps.length !== cs.length) return null;
  const count = Number.isInteger(n) && n >= 1 ? n : ps.length;
  const pointRoot = root || fundingJroot({ pubs: ps, commits: cs, n: count });
  if (!pointRoot || Buffer.from(asU8(pointRoot)).length !== 32) return null;
  const fee = Math.max(0, Math.floor(Number(tx?.fee || 0)));
  const maxLevy = tx?.maxLevy == null ? fee : Math.max(0, Math.floor(Number(tx.maxLevy)));
  const rows = [];
  for (const inp of rowsIn) {
    const index = Number(inp?.index);
    if (!Number.isInteger(index) || index < 0 || index >= ps.length) return null;
    if (inp?.t == null || inp?.x == null || inp?.c == null) return null;
    const bound = nativeBindInput({
      x: scalarBytes(inp.x),
      p: Buffer.from(asU8(ps[index])),
      c: Buffer.from(asU8(inp.c)),
      t: scalarBytes(inp.t),
    });
    if (!bound) return null;
    rows.push({
      ...inp,
      index,
      cTilde: Buffer.from(bound.cTilde),
      spendTag: Buffer.from(bound.spendTag),
    });
  }
  const stubs = rows.map((row) => ({
    admit_proof: true,
    v: 3,
    spendTag: row.spendTag,
    cTilde: row.cTilde,
  }));
  const draft = {
    ...tx,
    kind,
    anchor,
    fee,
    maxLevy,
    vin: rows.map((row) => ({ commit: row.cTilde })),
    spendTag: rows[0].spendTag,
  };
  if (rows.length === 1) {
    draft.admit_proof = stubs[0];
    delete draft.admit_proofs;
  } else {
    delete draft.admit_proof;
    draft.admit_proofs = stubs;
  }
  const digest = txDigestV3(draft, magic);
  const statement = membershipStatement({
    magic,
    anchor,
    root: pointRoot,
    n: count,
    digest,
  });
  const proofs = [];
  for (const row of rows) {
    membershipProgress({
      phase: 'prove-start',
      kind,
      index: row.index,
      done: proofs.length,
      total: rows.length,
    });
    const tProve = Date.now();
    const proof = proveMembershipSpend({
      x: row.x,
      index: row.index,
      pubs: ps,
      commits: cs,
      c: row.c,
      t: row.t,
      statement,
    });
    if (!proof) return null;
    if (!Buffer.from(proof.spendTag).equals(row.spendTag)) return null;
    if (!Buffer.from(proof.cTilde).equals(row.cTilde)) return null;
    membershipProgress({
      phase: 'prove-done',
      kind,
      index: row.index,
      ms: Date.now() - tProve,
      blob: proof.blob.length,
      done: proofs.length + 1,
      total: rows.length,
    });
    proofs.push({
      admit_proof: true,
      v: 3,
      spendTag: Buffer.from(proof.spendTag),
      blob: proof.blob,
      cTilde: Buffer.from(proof.cTilde),
    });
  }
  const sealed = {
    ...draft,
    vin: proofs.map((proof) => ({ commit: proof.cTilde })),
    spendTag: proofs[0].spendTag,
  };
  if (proofs.length === 1) {
    sealed.admit_proof = proofs[0];
    delete sealed.admit_proofs;
  } else {
    delete sealed.admit_proof;
    sealed.admit_proofs = proofs;
  }
  return sealed;
}
