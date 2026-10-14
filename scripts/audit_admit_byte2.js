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
 *
 * A datadir also has its snaps walked. bootstrap/latest.bin is a book and is
 * walked the same way. book.snap carries no blobs, only spend tags and a frame
 * digest, so it is clean only when its frames are this book's prefix and every
 * tag it carries comes from a byte-3 blob or a blob-less shape proof in that
 * prefix. book.snap is HMAC-keyed per install. Without the key
 * (--snap-key FILE, or this install's own seal key) it cannot be read, and the
 * walk exits 2. Older binaries are outside this walk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readChainBin, readChainSegments, writeChainBin } from '../crypto/chainbin.js';
import { reviveBytes } from '../crypto/note.js';
import { frameDigest, readBookSnap, writeBookSnap } from '../node/src/book_snap.js';
import { bookSealKeyPath } from '../node/src/book_seal_key.js';

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

function tagHex(raw) {
  const b = blobBytes(raw);
  return b && b.length === 32 ? b.toString('hex') : null;
}

/** Spend tags a clean prefix may put in a snap, and the ones only byte 2 could. */
function prefixTags(blocks) {
  const clean = new Set();
  const byte2 = new Set();
  for (const block of blocks) {
    for (const tx of Array.isArray(block?.txs) ? block.txs : []) {
      const proofs = [];
      if (tx?.admit_proof) proofs.push(tx.admit_proof);
      if (Array.isArray(tx?.admit_proofs)) proofs.push(...tx.admit_proofs);
      for (const proof of proofs) {
        if (!proof || typeof proof !== 'object') continue;
        const blob = proofBlob(proof);
        const posted = tagHex(proof.spendTag);
        if (!blob) {
          if (posted) clean.add(posted);
          continue;
        }
        const own = blob.length >= 33 ? blob.subarray(1, 33).toString('hex') : null;
        const into = blob[0] === 3 ? clean : blob[0] === 2 ? byte2 : null;
        if (!into) continue;
        if (own) into.add(own);
        if (posted) into.add(posted);
      }
    }
  }
  return { clean, byte2 };
}

/** One decoded book.snap against the book it claims to be a prefix of. */
export function auditBookSnap(snap, blocks) {
  if (!snap) return { proved: false, reason: 'snap_unreadable', height: null, tags: 0, byte2Tags: 0, unaccounted: 0, hits: [] };
  const height = Number(snap.height) || 0;
  const rows = (Array.isArray(blocks) ? blocks : [])
    .slice()
    .sort((a, b) => (Number(a?.height) || 0) - (Number(b?.height) || 0));
  const prefix = rows.slice(0, height);
  const base = { height, tags: 0, byte2Tags: 0, unaccounted: 0, hits: [] };
  if (prefix.length !== height || Number(prefix.at(-1)?.height) !== height) {
    return { ...base, proved: false, reason: 'snap_past_book' };
  }
  let frame = null;
  try { frame = frameDigest(prefix); } catch { frame = null; }
  if (!frame || frame !== snap.frameDigest) return { ...base, proved: false, reason: 'snap_frame_mismatch' };
  const { clean, byte2 } = prefixTags(prefix);
  const tags = Array.isArray(snap.spendTags) ? snap.spendTags.map((t) => String(t).toLowerCase()) : [];
  const hits = [];
  let byte2Tags = 0;
  let unaccounted = 0;
  for (const tag of tags) {
    if (byte2.has(tag) && !clean.has(tag)) {
      byte2Tags += 1;
      hits.push({ tag, why: 'byte2' });
    } else if (!clean.has(tag)) {
      unaccounted += 1;
      hits.push({ tag, why: 'unaccounted' });
    }
  }
  let reason = null;
  if (byte2Tags) reason = 'snap_byte2_tag';
  else if (unaccounted) reason = 'snap_tag_unaccounted';
  return { height, tags: tags.length, byte2Tags, unaccounted, hits, proved: !reason, reason };
}

function readKey(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const k = fs.readFileSync(file);
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

/** bootstrap/latest.bin and book.snap under a datadir. A plain file has no snaps. */
function auditSnaps(dir, blocks, { snapKey = null } = {}) {
  const out = [];
  const latest = path.join(dir, 'bootstrap', 'latest.bin');
  if (fs.existsSync(latest)) {
    const boot = auditBlocks(readChainBin(latest));
    out.push({ kind: 'bootstrap', source: latest, ...boot });
  }
  const snapFile = path.join(dir, 'book.snap');
  if (fs.existsSync(snapFile)) {
    const key = snapKey || readKey(bookSealKeyPath(dir));
    if (!key) {
      out.push({ kind: 'book.snap', source: snapFile, proved: false, reason: 'snap_unkeyed', hits: [] });
    } else {
      out.push({ kind: 'book.snap', source: snapFile, ...auditBookSnap(readBookSnap(snapFile, key), blocks) });
    }
  }
  return out;
}

export function auditPath(target, { snapKey = null } = {}) {
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
      snaps: [],
    };
  }
  const report = auditBlocks(loaded.blocks);
  report.source = loaded.source;
  const abs = path.resolve(target);
  report.snaps = fs.statSync(abs).isDirectory() ? auditSnaps(abs, loaded.blocks, { snapKey }) : [];
  const bad = report.snaps.find((s) => !s.proved);
  if (report.proved && bad) {
    report.proved = false;
    report.ok = false;
    report.reason = bad.kind === 'bootstrap' && bad.reason === 'byte2_present'
      ? 'snap_byte2_present'
      : bad.reason;
  }
  return report;
}

const DIRTY = new Set(['byte2_present', 'snap_byte2_present', 'snap_byte2_tag', 'snap_tag_unaccounted']);

export function exitCode(report) {
  if (report.proved) return 0;
  if (DIRTY.has(report.reason)) return 1;
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
    failures.push(...snapChecks({ range, byte2, byte3 }));
    const stubDir = fs.mkdtempSync(path.join('/tmp', 'admit-byte2-empty-'));
    const empty = auditPath(stubDir);
    if (empty.proved || empty.reason !== 'no_chain') failures.push('empty');
    fs.rmSync(stubDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, failures };
}

function snapState(blocks, spendTags) {
  const height = blocks.length;
  return {
    rules: 'audit-self-check',
    height,
    tipHash: Buffer.alloc(32, height & 0xff),
    diskDigest: '11'.repeat(32),
    frameDigest: frameDigest(blocks),
    vaultCommitment: '22'.repeat(32),
    genesisMs: 1_700_000_000_000,
    acceptedSeries: blocks.map(() => 0),
    unitAt: blocks.map(() => 0),
    spendTags,
  };
}

function snapChecks({ range, byte2, byte3 }) {
  const failures = [];
  const dir = fs.mkdtempSync(path.join('/tmp', 'admit-byte2-snaps-'));
  try {
    const key = Buffer.alloc(32, 5);
    const clean = [
      fakeEpoch(1, [{ id: 'cb', coinbase: true, height: 1, vout: [{ rangeProof: range }] }]),
      fakeEpoch(2, [{ id: 'flow', admit_proof: { v: 3, blob: byte3, cTilde: Buffer.alloc(32, 4) } }]),
    ];
    const tag3 = byte3.subarray(1, 33).toString('hex');
    const tag2 = Buffer.from(byte2.subarray(1, 33));
    tag2[0] ^= 0xff;
    const dirtyTag = tag2.toString('hex');
    writeChainBin(path.join(dir, 'chain.bin'), clean);
    const loaded = readChainBin(path.join(dir, 'chain.bin'));
    const snapFile = path.join(dir, 'book.snap');

    writeBookSnap(snapFile, key, snapState(loaded, [tag3]));
    const ok = auditPath(dir, { snapKey: key });
    if (!ok.proved || ok.snaps.length !== 1 || !ok.snaps[0].proved) failures.push(`snap_clean:${JSON.stringify(ok.snaps)}`);

    const unkeyed = auditPath(dir, { snapKey: null });
    if (unkeyed.proved || unkeyed.reason !== 'snap_unkeyed' || exitCode(unkeyed) !== 2) failures.push('snap_unkeyed');

    writeBookSnap(snapFile, key, snapState(loaded, [tag3, dirtyTag]));
    const extra = auditPath(dir, { snapKey: key });
    if (extra.proved || extra.reason !== 'snap_tag_unaccounted' || exitCode(extra) !== 1) failures.push('snap_extra');

    const withByte2 = [
      ...clean,
      fakeEpoch(3, [{ id: 'old', admit_proof: { blob: Buffer.concat([Buffer.from([2]), tag2, Buffer.alloc(7)]) } }]),
    ];
    writeBookSnap(snapFile, key, snapState(withByte2, [tag3, dirtyTag]));
    writeChainBin(path.join(dir, 'chain.bin'), withByte2);
    const tagged = auditBookSnap(readBookSnap(snapFile, key), withByte2);
    if (tagged.proved || tagged.reason !== 'snap_byte2_tag' || tagged.byte2Tags !== 1) failures.push('snap_byte2_tag');

    writeChainBin(path.join(dir, 'chain.bin'), clean);
    writeBookSnap(snapFile, key, snapState(withByte2.slice(0, 2), [tag3]));
    const other = [clean[0], fakeEpoch(2, [{ id: 'flow2', admit_proof: { v: 3, blob: byte3, cTilde: Buffer.alloc(32, 9) } }])];
    const moved = auditBookSnap(readBookSnap(snapFile, key), other);
    if (moved.proved || moved.reason !== 'snap_frame_mismatch') failures.push('snap_frame');

    fs.rmSync(snapFile);
    fs.mkdirSync(path.join(dir, 'bootstrap'));
    writeChainBin(path.join(dir, 'bootstrap', 'latest.bin'), withByte2);
    const boot = auditPath(dir);
    if (boot.proved || boot.reason !== 'snap_byte2_present' || exitCode(boot) !== 1) failures.push(`bootstrap:${boot.reason}`);
  } catch (err) {
    failures.push(`snap_checks:${err?.message || err}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return failures;
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
  const at = argv.indexOf('--snap-key');
  const keyFile = at >= 0 ? argv[at + 1] : null;
  const target = argv.find((a, i) => a && !a.startsWith('-') && !(at >= 0 && i === at + 1));
  const snapKey = keyFile ? readKey(keyFile) : null;
  if (keyFile && !snapKey) {
    console.log(JSON.stringify({ ok: false, proved: false, reason: 'snap_key' }));
    return 2;
  }
  const report = auditPath(target, { snapKey });
  console.log(JSON.stringify(report));
  return exitCode(report);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) process.exit(runCli(process.argv.slice(2)));
