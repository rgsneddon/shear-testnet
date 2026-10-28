#!/usr/bin/env node
/**
 * Re-seals p2p-wedge-v12.json and lose-block-nonce.json on R28 BluNotes.
 *
 * The three wedge blocks are rebuilt from the store's own templates at the
 * fixture's header times: no miner and no samples on any block (option 2),
 * and the coinbase names its parent's record root. Blocks 2 and 3 seat one
 * real BluNotes share each, ground with ShearHash on the parent header under
 * a one-time key of a fixed test wallet. Each header nonce is a ShearHash-v3
 * hit at GENESIS_BITS_PACKED, and each block is appended to a check store
 * with that real work and no trusted hash. The loser is a second hit on the
 * height-1 header whose hash is greater, and the cap nonces are hits on the
 * three bodiless headers test_p2p_wedge.js builds on that block.
 *
 * A refusal at any step stops the run and writes nothing. SEAL_HINTS names
 * a JSON of nonces from an earlier run; a header nonce is reused only if it
 * still hits (one hash).
 *
 * Run on a CI server (heavy RandomX), never on a laptop:
 *   node node/tests/fixtures/seal_wedge_v12.mjs
 * Each header nonce search is split over SEAL_WORKERS child processes
 * (default: one per core, at most 3), each walking its own stride. Child
 * processes, not threads: the native hash is not safe across threads in one
 * process.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENESIS_BITS_PACKED } from '../../../crypto/asert.js';
import { VERSION, decodeHeader, encodeHeader, setNonce } from '../../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../../crypto/shear_hash.js';
import { decodeWireBlock, encodeWireBlock, jsonWire } from '../../src/p2p.js';
import { createStore } from '../../src/store.js';
import { bluWallet, mineBluShare } from '../support/blunote_mine.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const here = path.dirname(fileURLToPath(import.meta.url));
const WEDGE = path.join(here, 'p2p-wedge-v12.json');
const LOSE = path.join(here, 'lose-block-nonce.json');
const CAP_T0 = 1_700_000_000_000;
// The template's miner input (a dest the coinbase never names under R28).
const MINER = 'ssa1qq5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg985gftj';

// Worker: --worker <headerHex> <start> <stride>: prints the first nonce of
// its stride that hits GENESIS_BITS_PACKED, then exits.
if (process.argv[2] === '--worker') {
  const [, , , headerHex, startRaw, strideRaw] = process.argv;
  const header = Buffer.from(headerHex, 'hex');
  const stride = BigInt(strideRaw);
  for (let n = BigInt(startRaw); ; n += stride) {
    if (meetsTarget(shearHash(setNonce(header, n)), GENESIS_BITS_PACKED)) {
      process.stdout.write(`${n}\n`);
      process.exit(0);
    }
  }
}

const WORKERS = Math.max(1, Math.min(3, Number(process.env.SEAL_WORKERS) || os.cpus().length));
const SELF = fileURLToPath(import.meta.url);

/** The first hit any worker finds, its stride starting at `from`. */
function race(headerHex, from) {
  return new Promise((resolve, reject) => {
    const kids = [];
    let done = false;
    for (let w = 0; w < WORKERS; w += 1) {
      const kid = spawn(process.execPath, [SELF, '--worker', headerHex, String(from + BigInt(w)), String(WORKERS)], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      kid.stdout.on('data', (d) => { out += d; });
      kid.on('exit', (code) => {
        if (done) return;
        if (code === 0 && out.trim()) {
          done = true;
          for (const k of kids) if (k !== kid) k.kill();
          resolve(BigInt(out.trim()));
        } else if (kids.every((k) => k.exitCode != null || k.signalCode != null)) {
          reject(new Error('every worker exited without a hit'));
        }
      });
      kids.push(kid);
    }
  });
}

const HINTS = process.env.SEAL_HINTS ? JSON.parse(fs.readFileSync(process.env.SEAL_HINTS, 'utf8')) : {};

/** A hinted header nonce, if it still hits on this header. */
function hinted(header, raw) {
  if (raw == null) return null;
  const nonce = BigInt(raw);
  const h = setNonce(header, nonce);
  const hash = shearHash(h);
  return meetsTarget(hash, GENESIS_BITS_PACKED) ? { nonce, header: h, hash } : null;
}

async function hit(header, from = 0n, hint = null) {
  const reused = hinted(header, hint);
  if (reused) return reused;
  const nonce = await race(Buffer.from(header).toString('hex'), from);
  const h = setNonce(header, nonce);
  const hash = shearHash(h);
  if (!meetsTarget(hash, GENESIS_BITS_PACKED)) throw new Error(`worker nonce ${nonce} misses the target`);
  return { nonce, header: h, hash };
}

const raw = JSON.parse(fs.readFileSync(WEDGE, 'utf8'));
// The fixture's own header times; blocks are 90 s apart on genesis bits.
const stamps = raw.blocks.map((row) => Number(decodeHeader(Buffer.from(decodeWireBlock(row).header)).timestamp));
// A fixed test wallet, so a re-run seats shares under keys of one owner.
const sharer = bluWallet(createHash('sha256').update('shear-wedge-fixture-v12').digest());
const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seal-wedge-')));
const headerNonces = [];
const shareNonces = [];
const rows = [];
for (let i = 0; i < stamps.length; i += 1) {
  const parent = store.tip();
  const shares = parent ? [mineBluShare(sharer, Buffer.from(parent.header))] : [];
  const { tpl } = store.template({ miner: MINER, now: stamps[i], shareBatch: shares });
  if (Number(decodeHeader(Buffer.from(tpl.header)).bits) !== GENESIS_BITS_PACKED) {
    console.error(`block ${i + 1} is not on genesis bits; nothing written`);
    process.exit(1);
  }
  if ((tpl.shareBatch || []).length !== shares.length) {
    console.error(`block ${i + 1} template seated ${(tpl.shareBatch || []).length} of ${shares.length} shares; nothing written`);
    process.exit(1);
  }
  const sealed = await hit(Buffer.from(tpl.header), 0n, HINTS.headerNonces?.[i]);
  const block = {
    header: sealed.header,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
  const stored = await Promise.resolve(store.append(block));
  if (!stored.ok) {
    console.error(`block ${i + 1} refused: ${stored.reason}${stored.field ? ` (${stored.field})` : ''}; nothing written`);
    process.exit(1);
  }
  headerNonces.push(sealed.nonce.toString());
  shareNonces.push(shares.length ? (tpl.shareBatch || []).map((s) => String(s.nonce)) : null);
  // The row as the node serves it (p2p.js encodeWireBlock, jsonWire).
  rows.push(JSON.parse(jsonWire(encodeWireBlock(store.tip()))));
  console.log(`block ${i + 1}: header nonce ${sealed.nonce} share nonces ${JSON.stringify(shareNonces[i])}`);
}

// The loser: another hit on the height-1 header, hashing greater.
const first = store.blocks[0];
let loser = await hit(Buffer.from(first.header), BigInt(headerNonces[0]) + 1n, HINTS.loserNonce);
while (Buffer.compare(loser.hash, Buffer.from(first.hash)) <= 0) loser = await hit(Buffer.from(first.header), loser.nonce + 1n);
console.log(`loser nonce ${loser.nonce}`);

// The three bodiless cap headers test_p2p_wedge.js builds on block 1.
const capNonces = [];
for (let i = 0; i < 3; i += 1) {
  const capHeader = encodeHeader({
    version: VERSION,
    prevBlockHash: Buffer.from(first.hash),
    merkleRoot: Buffer.alloc(32, i + 1),
    continuityRoot: Buffer.alloc(32, 9),
    timestamp: BigInt(CAP_T0 + 90_000),
    bits: GENESIS_BITS_PACKED,
    nonce: BigInt(i + 1),
    baseFee: 1n,
  });
  capNonces.push((await hit(capHeader, 0n, HINTS.capNonces?.[i])).nonce.toString());
}
console.log(`cap nonces ${JSON.stringify(capNonces)}`);

// A fresh store must take the rows as written, decoded back, before
// anything is written to disk.
const fresh = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seal-wedge-')));
const written = rows.map((row) => decodeWireBlock(JSON.parse(JSON.stringify(row))));
for (let i = 0; i < written.length; i += 1) {
  const got = await Promise.resolve(fresh.append(written[i]));
  if (!got.ok) {
    console.error(`block ${i + 1} refused on re-read: ${got.reason}${got.field ? ` (${got.field})` : ''}; nothing written`);
    process.exit(1);
  }
}

const out = {
  headerNonces,
  shareNonces,
  loserNonce: loser.nonce.toString(),
  loserHash: Buffer.from(loser.hash).toString('hex'),
  winnerHash: Buffer.from(first.hash).toString('hex'),
  blocks: rows,
  capNonces,
};
fs.writeFileSync(WEDGE, JSON.stringify(out));
fs.writeFileSync(LOSE, `${JSON.stringify({
  nonce: out.loserNonce,
  hash: out.loserHash,
  winnerHash: out.winnerHash,
}, null, 2)}\n`);
console.log('sealed: p2p-wedge-v12.json, lose-block-nonce.json');
