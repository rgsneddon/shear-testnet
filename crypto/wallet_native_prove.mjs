#!/usr/bin/env node
/**
 * Wallet BP+ range helper. prove_spend fails closed until FS-1.
 * Stdin JSON { op, ... } → stdout JSON. Fail closed if shearadmit.node is missing.
 */
import fs from 'node:fs';
import { proveRange, verifyRange, asU8 } from './note.js';
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

if (op === 'prove_spend') {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'send unavailable until FS-1' }));
  process.exit(4);
}

process.stdout.write(JSON.stringify({ ok: false, reason: 'unknown_op' }));
process.exit(5);
