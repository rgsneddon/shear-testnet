#!/usr/bin/env node
/**
 * Wallet prove helper. Range blobs stay byte 2.
 * prove_membership is the interim testnet membership proof pending FS-1
 * (byte 3 plus a statement). prove_spend remains the byte-2 helper.
 * Stdin JSON { op, ... } → stdout JSON. Fail closed if shearadmit.node is missing.
 */
import fs from 'node:fs';
import { admitProve, admitScalarFromSeed, fluxsetIndexOf } from './admit.js';
import { proveMembershipSpend } from './flow_membership.js';
import { proveRange, verifyRange, randomScalar, scalarFrom, asU8 } from './note.js';
import { nativeLoaded } from './native_admit.js';

function hex(b) {
  return Buffer.from(asU8(b)).toString('hex');
}

function unhex(s) {
  return Buffer.from(String(s || ''), 'hex');
}

const raw = process.argv[2]
  ? fs.readFileSync(process.argv[2], 'utf8')
  : await new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });

let req;
try {
  req = JSON.parse(raw || '{}');
} catch {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'bad_json' }));
  process.exit(1);
}

if (!nativeLoaded()) {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'admit_native_required' }));
  process.exit(2);
}

const op = String(req.op || '');
if (op === 'prove_range') {
  const r = unhex(req.r);
  const proof = proveRange(req.v, r);
  if (!proof || !proof.length || proof[0] !== 2) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'range_native_required' }));
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({ ok: true, v: 2, proof: hex(proof) }));
  process.exit(0);
}

if (op === 'verify_ranges') {
  const rows = Array.isArray(req.rows) ? req.rows : [];
  const verified = rows.map((row) => {
    try {
      const commit = unhex(row?.commit);
      const proof = unhex(row?.proof);
      return commit.length === 32 && proof.length > 0 && verifyRange(commit, proof);
    } catch {
      return false;
    }
  });
  process.stdout.write(JSON.stringify({ ok: true, v: 2, verified }));
  process.exit(0);
}

if (op === 'prove_membership') {
  const x = scalarFrom(unhex(req.x));
  const index = Number(req.index);
  const t = scalarFrom(unhex(req.t));
  const statement = unhex(req.statement);
  const pubs = (req.pubs || []).map(unhex).filter(Boolean);
  const commits = (req.commits || []).map(unhex).filter(Boolean);
  const spentNote = {
    commit: unhex(req.spentNote?.commit),
  };
  if (!pubs.length || commits.length !== pubs.length || !Number.isInteger(index)) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'membership_native_required' }));
    process.exit(4);
  }
  const proof = proveMembershipSpend({
    x,
    index,
    pubs,
    commits,
    c: spentNote.commit,
    t,
    statement,
  });
  if (!proof || proof.v !== 3 || proof.r || !proof.blob || proof.blob[0] !== 3) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'membership_native_required' }));
    process.exit(4);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    v: 3,
    spendTag: hex(proof.spendTag),
    blob: hex(proof.blob),
    cTilde: hex(proof.cTilde),
  }));
  process.exit(0);
}

if (op === 'prove_spend') {
  const spendSeed = unhex(req.spendSeed);
  const spentNote = {
    kind: req.spentNote?.kind,
    commit: unhex(req.spentNote?.commit),
    noteCommit: unhex(req.spentNote?.noteCommit),
    r: req.spentNote?.r ? unhex(req.spentNote.r) : undefined,
  };
  const pubs = (req.pubs || []).map(unhex).filter(Boolean);
  const commits = (req.commits || []).map(unhex).filter(Boolean);
  if (!pubs.length || commits.length !== pubs.length) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'admit_commits' }));
    process.exit(4);
  }
  const x = admitScalarFromSeed(spendSeed, spentNote);
  const index = Number.isInteger(req.index) ? req.index : fluxsetIndexOf(pubs, spendSeed, spentNote);
  const proof = admitProve({
    x,
    index,
    pubs,
    commits,
    c: spentNote.commit,
    t: req.t != null ? scalarFrom(unhex(req.t)) : randomScalar(),
  });
  if (!proof || proof.v !== 2 || proof.r) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'admit_native_required' }));
    process.exit(4);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    admit_proof: true,
    v: 2,
    spendTag: hex(proof.spendTag),
    blob: hex(proof.blob),
    cTilde: hex(proof.cTilde),
    t: proof.t ? hex(proof.t) : undefined,
  }));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ ok: false, reason: 'unknown_op' }));
process.exit(5);
