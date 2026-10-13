#!/usr/bin/env node
/**
 * Walk a sealed book from genesis to tip and count admit blobs whose first byte is 2.
 * Range proofs also start with byte 2. This walk does not count those.
 *
 *   node scripts/audit_admit_byte2.js <datadir|chain.bin|segments-dir>
 *
 * Exit 0: the book is contiguous from height 1 and no admit blob starts with 2.
 * Exit 1: a sealed admit blob starts with 2.
 * Exit 2: the walk cannot prove absence (no book, empty book, or not genesis-to-tip).
 *
 * A clean exit is the only result that shows no sealed byte-2 admit blob.
 * Snaps and older binaries are outside this walk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readChainBin, readChainSegments, writeChainBin } from '../crypto/chainbin.js';
import { reviveBytes } from '../crypto/note.js';

function blobBytes(raw) {
  if (raw == null || raw === '') return null;
  if (Buffer.isBuffer(raw)) return raw.length ? raw : null;
  if (raw instanceof Uint8Array) {
    const b = Buffer.from(raw);
    return b.length ? b : null;
  }
  if (typeof raw === 'object' && raw.type === 'Buffer' && Array.isArray(raw.data)) {
    const b = Buffer.from(raw.data);
    return b.length ? b : null;
  }
  if (typeof raw === 'object' && typeof raw.$hex === 'string') {
    const b = Buffer.from(raw.$hex, 'hex');
    return b.length ? b : null;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length >= 2) return Buffer.from(s, 'hex');
  }
  return null;
}

function proofBlob(proof) {
  if (!proof || typeof proof !== 'object') return null;
  return blobBytes(proof.blob ?? proof.proof);
}

/** Admit blobs on one tx. Range proofs are not admit blobs. */
export function admitBlobsOf(tx) {
  const out = [];
  if (tx?.admit_proof) out.push({ field: 'admit_proof', blob: proofBlob(tx.admit_proof) });
  if (Array.isArray(tx?.admit_proofs)) {
    tx.admit_proofs.forEach((proof, i) => {
      out.push({ field: `admit_proofs[${i}]`, blob: proofBlob(proof) });
    });
  }
  return out.filter((row) => row.blob);
}

export function auditBlocks(blocks) {
  const rows = Array.isArray(blocks) ? blocks : [];
  const heights = rows.map((b) => Number(b?.height) || 0);
  const hits = [];
  let admitBlobs = 0;
  let byte2 = 0;
  let byte3 = 0;
  let other = 0;
  rows.forEach((block, bi) => {
    const height = Number(block?.height) || 0;
    const txs = Array.isArray(block?.txs) ? block.txs : [];
    txs.forEach((tx, ti) => {
      for (const row of admitBlobsOf(tx)) {
        admitBlobs += 1;
        const byte = row.blob[0];
        if (byte === 2) byte2 += 1;
        else if (byte === 3) byte3 += 1;
        else other += 1;
        if (byte === 2) {
          hits.push({
            height,
            block: bi,
            tx: ti,
            id: tx?.id || tx?.txid || null,
            field: row.field,
            len: row.blob.length,
          });
        }
      }
    });
  });
  const chain = chainShape(heights);
  const proved = chain.ok && byte2 === 0;
  let reason = null;
  if (!rows.length) reason = 'empty_chain';
  else if (!chain.ok) reason = chain.reason;
  else if (byte2 > 0) reason = 'byte2_present';
  return {
    ok: proved,
    proved,
    reason,
    blocks: rows.length,
    firstHeight: chain.first,
    tip: chain.tip,
    gap: chain.gap || null,
    admitBlobs,
    byte2,
    byte3,
    other,
    hits,
  };
}

function chainShape(heights) {
  if (!heights.length) return { ok: false, reason: 'empty_chain', first: null, tip: null };
  const sorted = heights.slice().sort((a, b) => a - b);
  const first = sorted[0];
  const tip = sorted[sorted.length - 1];
  if (first !== 1) return { ok: false, reason: 'not_from_genesis', first, tip };
  const seen = new Set();
  for (let i = 0; i < sorted.length; i += 1) {
    if (seen.has(sorted[i])) return { ok: false, reason: 'duplicate_height', first, tip, gap: sorted[i] };
    seen.add(sorted[i]);
    if (i > 0 && sorted[i] !== sorted[i - 1] + 1) {
      return { ok: false, reason: 'height_gap', first, tip, gap: sorted[i] };
    }
  }
  return { ok: true, reason: null, first, tip };
}

function readJsonl(file) {
  const blocks = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const b = JSON.parse(line, reviveBytes);
    if (!b || b.header == null) continue;
    blocks.push(b);
  }
  return blocks;
}

/** Same order as createStore: segments, then chain.bin, then chain.jsonl. */
export function loadBook(target) {
  if (!target) return { blocks: [], source: null, reason: 'no_path' };
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return { blocks: [], source: null, reason: 'missing' };
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (abs.endsWith('.jsonl')) return { blocks: readJsonl(abs), source: abs, reason: null };
    return { blocks: readChainBin(abs), source: abs, reason: null };
  }
  const segDir = path.join(abs, 'segments');
  const segs = readChainSegments(segDir);
  if (segs && segs.length) return { blocks: segs, source: segDir, reason: null };
  const directSegs = readChainSegments(abs);
  if (directSegs && directSegs.length) return { blocks: directSegs, source: abs, reason: null };
  const binFile = path.join(abs, 'chain.bin');
  if (fs.existsSync(binFile)) return { blocks: readChainBin(binFile), source: binFile, reason: null };
  const jsonl = path.join(abs, 'chain.jsonl');
  if (fs.existsSync(jsonl)) return { blocks: readJsonl(jsonl), source: jsonl, reason: null };
  return { blocks: [], source: abs, reason: 'no_chain' };
}

export function auditPath(target) {
  const loaded = loadBook(target);
  if (!loaded.blocks.length) {
    return {
      ok: false,
      proved: false,
      reason: loaded.reason || 'no_chain',
      source: loaded.source,
      blocks: 0,
      firstHeight: null,
      tip: null,
      admitBlobs: 0,
      byte2: 0,
      byte3: 0,
      other: 0,
      hits: [],
    };
  }
  const report = auditBlocks(loaded.blocks);
  report.source = loaded.source;
  return report;
}

export function exitCode(report) {
  if (report.proved) return 0;
  if (report.reason === 'byte2_present') return 1;
  return 2;
}

/** In-memory books used by the self-check. Not a sealed network. */
export function selfCheck() {
  const tag = Buffer.alloc(33, 7);
  const byte2 = Buffer.from(tag);
  byte2[0] = 2;
  const byte3 = Buffer.from(tag);
  byte3[0] = 3;
  const range = Buffer.from([2, 9, 9, 9]);
  const clean = auditBlocks([
    {
      height: 1,
      txs: [{ id: 'cb', coinbase: true, vout: [{ rangeProof: range }] }],
    },
    {
      height: 2,
      txs: [{ id: 'flow', admit_proof: { blob: byte3 }, vout: [{ rangeProof: range }] }],
    },
  ]);
  const dirty = auditBlocks([
    { height: 1, txs: [{ id: 'old', admit_proof: { blob: byte2 } }] },
  ]);
  const gapped = auditBlocks([
    { height: 5, txs: [{ id: 'late', admit_proof: { blob: byte3 } }] },
  ]);
  const listed = auditBlocks([
    { height: 1, txs: [{ id: 'multi', admit_proofs: [{ blob: byte2 }, { blob: byte3 }] }] },
  ]);
  const failures = [];
  if (!clean.proved || clean.byte2 !== 0 || clean.byte3 !== 1) failures.push('clean');
  if (dirty.proved || dirty.byte2 !== 1 || dirty.reason !== 'byte2_present') failures.push('dirty');
  if (gapped.proved || gapped.reason !== 'not_from_genesis') failures.push('gapped');
  if (listed.byte2 !== 1 || listed.byte3 !== 1 || listed.hits[0]?.field !== 'admit_proofs[0]') failures.push('listed');
  const dir = fs.mkdtempSync(path.join('/tmp', 'admit-byte2-audit-'));
  try {
    const bin = path.join(dir, 'chain.bin');
    writeChainBin(bin, [
      fakeEpoch(1, [{ id: 'cb', coinbase: true, height: 1, vout: [{ rangeProof: range }] }]),
      fakeEpoch(2, [{ id: 'flow', admit_proof: { v: 3, blob: byte3, cTilde: Buffer.alloc(32, 4) } }]),
    ]);
    const round = auditPath(bin);
    if (!round.proved || round.byte2 !== 0 || round.byte3 !== 1) failures.push(`roundtrip:${JSON.stringify(round)}`);
    const stubDir = fs.mkdtempSync(path.join('/tmp', 'admit-byte2-empty-'));
    const empty = auditPath(stubDir);
    if (empty.proved || empty.reason !== 'no_chain') failures.push('empty');
    fs.rmSync(stubDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, failures };
}

function fakeEpoch(height, txs) {
  return {
    header: Buffer.alloc(128),
    rootA: Buffer.alloc(32),
    rootB: Buffer.alloc(32),
    hash: Buffer.alloc(32, height & 0xff),
    height,
    aLeaves: [],
    bLeaves: [],
    txs,
    shareBatch: [],
  };
}

function runCli(argv) {
  if (argv.includes('--self-check')) {
    const got = selfCheck();
    console.log(JSON.stringify(got));
    return got.ok ? 0 : 1;
  }
  const target = argv.find((a) => a && !a.startsWith('-'));
  const report = auditPath(target);
  console.log(JSON.stringify(report));
  return exitCode(report);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) process.exit(runCli(process.argv.slice(2)));
