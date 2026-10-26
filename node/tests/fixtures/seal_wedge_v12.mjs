#!/usr/bin/env node
/**
 * Re-seals p2p-wedge-v12.json and lose-block-nonce.json under the current
 * tx digest. Each block's merkle is the body's (chain.js digestTx), each
 * header links to its re-sealed parent, each share nonce is a ShearHash-v3
 * hit on that parent at the credit width in its high byte, and each header
 * nonce is a hit at GENESIS_BITS_PACKED. The loser is a second hit on the
 * height-1 header whose hash is greater, and the cap nonces are hits on the
 * three bodiless headers test_p2p_wedge.js builds on that block.
 *
 * Each block's coinbase commits its share frames (shareSlotRoot), so the
 * root is rebuilt after the share nonces and before the merkle. Before any
 * header PoW is spent, the block is appended to a throwaway store holding the
 * sealed parents, under a trusted header hash: every check runs, share PoW
 * included, except the header PoW the search then finds. After it, the
 * sealed block is appended to the check store.
 * A refusal at either step stops the run and writes nothing. SEAL_HINTS
 * names a JSON of nonces from an earlier run; each is reused only if it
 * still hits (one hash).
 *
 * Run on a CI server (heavy RandomX), never on a laptop:
 *   node node/tests/fixtures/seal_wedge_v12.mjs
 * Each nonce search is split over SEAL_WORKERS child processes (default:
 * one per core), each walking its own stride. Child processes, not threads:
 * the native hash is not safe across threads in one process.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENESIS_BITS_PACKED } from '../../../crypto/asert.js';
import { VERSION, decodeHeader, encodeHeader, setNonce } from '../../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../../crypto/shear_hash.js';
import { merkleRoot } from '../../../crypto/merkle.js';
import { shareMeetsFloor, shareTargetByte, nonceWithShareTarget } from '../../../crypto/share_batch.js';
import { shareSlotRoot } from '../../../crypto/pack.js';
import { decodeWireBlock, encodeWireBlock, jsonWire } from '../../src/p2p.js';
import { digestTx } from '../../src/chain.js';
import { createStore } from '../../src/store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const here = path.dirname(fileURLToPath(import.meta.url));
const WEDGE = path.join(here, 'p2p-wedge-v12.json');
const LOSE = path.join(here, 'lose-block-nonce.json');
const CAP_T0 = 1_700_000_000_000;

// Worker: --worker <kind> <headerHex> <start> <stride> [shareJson width]
// prints the first nonce of its stride that hits, then exits.
if (process.argv[2] === '--worker') {
  const [, , , kind, headerHex, startRaw, strideRaw, shareJson, widthRaw] = process.argv;
  const header = Buffer.from(headerHex, 'hex');
  const stride = BigInt(strideRaw);
  const share = shareJson
    ? JSON.parse(shareJson, (_k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? Buffer.from(v.data) : v))
    : null;
  const width = widthRaw != null ? Number(widthRaw) : 0;
  for (let n = BigInt(startRaw); ; n += stride) {
    if (kind === 'header') {
      if (meetsTarget(shearHash(setNonce(header, n)), GENESIS_BITS_PACKED)) {
        process.stdout.write(`${n}\n`);
        process.exit(0);
      }
    } else {
      const nonce = nonceWithShareTarget(n, width);
      if (shareMeetsFloor(shearHash(setNonce(header, nonce)), share, width)) {
        process.stdout.write(`${nonce}\n`);
        process.exit(0);
      }
    }
  }
}

const WORKERS = Math.max(1, Number(process.env.SEAL_WORKERS) || os.cpus().length);
const SELF = fileURLToPath(import.meta.url);

/** The first hit any worker finds, its stride starting at `from`. */
function race(args, from) {
  return new Promise((resolve, reject) => {
    const kids = [];
    let done = false;
    for (let w = 0; w < WORKERS; w += 1) {
      const kid = spawn(process.execPath, [SELF, '--worker', args[0], args[1], String(from + BigInt(w)), String(WORKERS), ...args.slice(2)], { stdio: ['ignore', 'pipe', 'inherit'] });
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
  const nonce = await race(['header', Buffer.from(header).toString('hex')], from);
  const h = setNonce(header, nonce);
  const hash = shearHash(h);
  if (!meetsTarget(hash, GENESIS_BITS_PACKED)) throw new Error(`worker nonce ${nonce} misses the target`);
  return { nonce, header: h, hash };
}

async function shareHit(parentHeader, share, oldNonce, hint = null) {
  const width = shareTargetByte(oldNonce);
  if (hint != null && shareMeetsFloor(shearHash(setNonce(parentHeader, BigInt(hint))), share, width)) return BigInt(hint);
  const plain = JSON.parse(JSON.stringify(share, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const nonce = await race(['share', Buffer.from(parentHeader).toString('hex'), JSON.stringify(plain), String(width)], 0n);
  if (!shareMeetsFloor(shearHash(setNonce(parentHeader, nonce)), share, width)) throw new Error(`worker share nonce ${nonce} misses`);
  return nonce;
}

const raw = JSON.parse(fs.readFileSync(WEDGE, 'utf8'));
const blocks = raw.blocks.map((row) => decodeWireBlock(row));
const headerNonces = [];
const shareNonces = [];
const check = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seal-wedge-')));
let parent = null;
for (let i = 0; i < blocks.length; i += 1) {
  const block = blocks[i];
  const old = decodeHeader(Buffer.from(block.header));
  const oldShares = raw.shareNonces?.[i];
  let nonces = null;
  if (oldShares) {
    nonces = [];
    for (let j = 0; j < (block.shareBatch || []).length; j += 1) {
      const hint = HINTS.shareNonces?.[i]?.[j];
      nonces.push(oldShares[j] == null ? null : (await shareHit(parent.header, block.shareBatch[j], BigInt(oldShares[j]), hint)).toString());
    }
    block.shareBatch = block.shareBatch.map((share, j) => (nonces[j] == null ? share : { ...share, nonce: nonces[j] }));
  }
  // The coinbase commits the share frames, nonces included.
  if (block.txs[0]?.shareSlotRoot != null) {
    const root = shareSlotRoot(block.shareBatch || []);
    block.txs[0] = { ...block.txs[0], shareSlotRoot: root };
  }
  const unsealed = encodeHeader({
    ...old,
    prevBlockHash: parent ? parent.hash : old.prevBlockHash,
    merkleRoot: merkleRoot(block.txs.map(digestTx)),
    nonce: 0n,
  });
  const trial = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seal-trial-')));
  for (let k = 0; k < i; k += 1) {
    const back = await Promise.resolve(trial.append(blocks[k]));
    if (!back.ok) throw new Error(`trial parent ${k + 1}: ${back.reason}`);
  }
  const STAND_IN = Buffer.alloc(32, 0);
  const tried = await Promise.resolve(trial.append({ ...block, header: unsealed, hash: STAND_IN }, { trustedPowHash: STAND_IN }));
  if (!tried.ok) {
    console.error(`block ${i + 1} trial refused: ${tried.reason}${tried.field ? ` (${tried.field})` : ''}; nothing written`);
    process.exit(1);
  }
  const sealed = await hit(unsealed, 0n, HINTS.headerNonces?.[i]);
  block.header = sealed.header;
  block.hash = sealed.hash;
  headerNonces.push(sealed.nonce.toString());
  shareNonces.push(nonces);
  parent = { header: sealed.header, hash: sealed.hash };
  const stored = await Promise.resolve(check.append(block));
  if (!stored.ok) {
    console.error(`block ${i + 1} refused: ${stored.reason}${stored.field ? ` (${stored.field})` : ''}; nothing written`);
    process.exit(1);
  }
  // The row as the node serves it (p2p.js encodeWireBlock, jsonWire).
  raw.blocks[i] = JSON.parse(jsonWire(encodeWireBlock(block)));
  console.log(`block ${i + 1}: header nonce ${sealed.nonce} share nonces ${JSON.stringify(nonces)}`);
}

// The loser: another hit on the height-1 header, hashing greater.
const first = blocks[0];
let loser = await hit(first.header, BigInt(headerNonces[0]) + 1n, HINTS.loserNonce);
while (Buffer.compare(loser.hash, Buffer.from(first.hash)) <= 0) loser = await hit(first.header, loser.nonce + 1n);
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
const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-seal-wedge-')));
const written = raw.blocks.map((row) => decodeWireBlock(JSON.parse(JSON.stringify(row))));
for (let i = 0; i < written.length; i += 1) {
  const got = await Promise.resolve(store.append(written[i]));
  if (!got.ok) {
    console.error(`block ${i + 1} refused: ${got.reason}${got.field ? ` (${got.field})` : ''}; nothing written`);
    process.exit(1);
  }
}

raw.headerNonces = headerNonces;
raw.shareNonces = shareNonces;
raw.capNonces = capNonces;
raw.loserNonce = loser.nonce.toString();
raw.loserHash = Buffer.from(loser.hash).toString('hex');
raw.winnerHash = Buffer.from(first.hash).toString('hex');
fs.writeFileSync(WEDGE, JSON.stringify(raw));
fs.writeFileSync(LOSE, `${JSON.stringify({
  nonce: raw.loserNonce,
  hash: raw.loserHash,
  winnerHash: raw.winnerHash,
}, null, 2)}\n`);
console.log('sealed: p2p-wedge-v12.json, lose-block-nonce.json');
