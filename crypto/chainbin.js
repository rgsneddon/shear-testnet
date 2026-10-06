/**
 * Epoch disk: chain.bin is length-prefixed packed blocks, not JSONL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeHeader, decodeHeader } from './header.js';
import { packShareBatchBytes, unpackShareBatchBytes } from './pack.js';
import { compactTx } from './chronoflux.js';
import { reviveBytes } from './note.js';
import { packHashCreditBytes, unpackHashCreditBytes } from './hash_owed.js';

const MAGIC = Buffer.from('shear-chn-v1\0\0\0');

function leafWire(l) {
  return {
    dest20: Buffer.from(l.dest20 || Buffer.alloc(20)).toString('hex'),
    count: Number(l.count || 0),
    unit: Number(l.unit || 0),
    nonce: Number(l.nonce || 0),
    memoH: l.memoH ? Buffer.from(l.memoH).toString('hex') : '',
    tag: String(l.tag || ''),
  };
}

function leafRead(l) {
  return {
    dest20: Buffer.from(String(l.dest20 || ''), 'hex'),
    count: Number(l.count || 0),
    unit: Number(l.unit || 0),
    nonce: Number(l.nonce || 0),
    memoH: l.memoH ? Buffer.from(String(l.memoH), 'hex') : Buffer.alloc(32),
    tag: String(l.tag || ''),
  };
}

export function packEpochBlock(block) {
  const header = Buffer.from(block.header);
  const rootA = Buffer.from(block.rootA || Buffer.alloc(32));
  const rootB = Buffer.from(block.rootB || Buffer.alloc(32));
  const aJson = Buffer.from(JSON.stringify((block.aLeaves || []).map(leafWire)));
  const bJson = Buffer.from(JSON.stringify((block.bLeaves || []).map(leafWire)));
  const txs = Buffer.from(JSON.stringify((block.txs || []).map(compactTx)));
  const sJson = packShareBatchBytes(block.shareBatch || []);
  const parts = [header, rootA, rootB];
  const lens = Buffer.alloc(12);
  lens.writeUInt32LE(aJson.length, 0);
  lens.writeUInt32LE(bJson.length, 4);
  lens.writeUInt32LE(txs.length, 8);
  const meta = Buffer.alloc(16);
  meta.writeUInt32LE(Number(block.height) || 0, 0);
  let flags = 0;
  if (block.samplesPruned) flags |= 1;
  if (block.bLeavesPruned) flags |= 2;
  meta.writeUInt32LE(flags, 4);
  meta.writeUInt32LE(Number(block.weight || 0), 8);
  const hash = Buffer.from(block.hash || Buffer.alloc(32));
  const sLen = Buffer.alloc(4);
  sLen.writeUInt32LE(sJson.length, 0);
  const chunks = [parts[0], rootA, rootB, hash, meta, lens, aJson, bJson, txs, sLen, sJson];
  // Optional trailer. Old books end at the share batch and have no stamp.
  if (Array.isArray(block.bSpendIds)) {
    const body = Buffer.from(JSON.stringify(block.bSpendIds.map((id) => String(id))));
    const n = Buffer.alloc(4);
    n.writeUInt32LE(body.length, 0);
    chunks.push(n, body);
  }
  if (Array.isArray(block.hashCredits)) {
    const body = packHashCreditBytes(block.hashCredits);
    const n = Buffer.alloc(4);
    n.writeUInt32LE(body.length, 0);
    chunks.push(n, body);
  }
  return Buffer.concat(chunks);
}

export function unpackEpochBlock(buf) {
  const b = Buffer.from(buf);
  const header = Buffer.from(b.subarray(0, 128));
  const rootA = Buffer.from(b.subarray(128, 160));
  const rootB = Buffer.from(b.subarray(160, 192));
  const hash = Buffer.from(b.subarray(192, 224));
  const height = b.readUInt32LE(224);
  const flags = b.readUInt32LE(228);
  const aLen = b.readUInt32LE(240);
  const bLen = b.readUInt32LE(244);
  const tLen = b.readUInt32LE(248);
  let o = 252;
  const aLeaves = JSON.parse(b.subarray(o, o + aLen).toString() || '[]').map(leafRead);
  o += aLen;
  const bLeaves = JSON.parse(b.subarray(o, o + bLen).toString() || '[]').map(leafRead);
  o += bLen;
  const txs = JSON.parse(b.subarray(o, o + tLen).toString() || '[]', reviveBytes);
  o += tLen;
  let shareBatch = [];
  let bSpendIds;
  let sawSpendIds = false;
  let hashCredits;
  let sawCredits = false;
  if (o + 4 <= b.length) {
    const sLen = b.readUInt32LE(o);
    o += 4;
    if (sLen > b.length - o) {
      o = b.length;
    } else {
      if (sLen > 0) shareBatch = unpackShareBatchBytes(b.subarray(o, o + sLen));
      o += sLen;
      while (o + 4 <= b.length) {
        const nLen = b.readUInt32LE(o);
        if (nLen > b.length - (o + 4)) break;
        const body = b.subarray(o + 4, o + 4 + nLen);
        const credits = unpackHashCreditBytes(body);
        if (credits) {
          hashCredits = credits;
          sawCredits = true;
          o += 4 + nLen;
          continue;
        }
        let parsed = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = null; }
        if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
          bSpendIds = parsed;
          sawSpendIds = true;
          o += 4 + nLen;
          continue;
        }
        break;
      }
    }
  }
  decodeHeader(header);
  const block = {
    header,
    rootA,
    rootB,
    hash,
    height,
    aLeaves,
    bLeaves,
    txs,
    shareBatch,
    samples: [],
    samplesPruned: !!(flags & 1),
    bLeavesPruned: !!(flags & 2),
    weight: b.readUInt32LE(232),
  };
  if (sawSpendIds) block.bSpendIds = bSpendIds;
  if (sawCredits) block.hashCredits = hashCredits;
  return block;
}

export function writeChainBin(path, blocks) {
  const chunks = [MAGIC];
  for (const block of blocks || []) {
    const rec = packEpochBlock(block);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(rec.length, 0);
    chunks.push(len, rec);
  }
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat(chunks));
  fs.renameSync(tmp, path);
}

/** Append one packed epoch. Full archival: never drops txs. IBD must not rewrite the book. */
export function appendChainBin(path, block) {
  const rec = packEpochBlock(block);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(rec.length, 0);
  const chunk = Buffer.concat([len, rec]);
  if (!fs.existsSync(path) || fs.statSync(path).size < MAGIC.length) {
    fs.writeFileSync(path, Buffer.concat([MAGIC, chunk]));
    return;
  }
  fs.appendFileSync(path, chunk);
}

export function readChainBin(path) {
  if (!fs.existsSync(path)) return [];
  const buf = fs.readFileSync(path);
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('bad_chain_bin');
  }
  const blocks = [];
  let o = MAGIC.length;
  while (o + 4 <= buf.length) {
    const n = buf.readUInt32LE(o);
    o += 4;
    blocks.push(unpackEpochBlock(buf.subarray(o, o + n)));
    o += n;
  }
  return blocks;
}

/** Blocks per segment file. Prune rewrites one of these, not the whole book. */
export const CHAIN_SEGMENT_BLOCKS = 400;

export function segmentFileName(index) {
  return `seg-${String(index).padStart(6, '0')}.bin`;
}

export function writeChainSegments(dir, blocks, { only = null, segmentBlocks = CHAIN_SEGMENT_BLOCKS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const groups = new Map();
  const limit = Math.max(1, Math.floor(Number(segmentBlocks) || CHAIN_SEGMENT_BLOCKS));
  for (let i = 0; i < (blocks || []).length; i += 1) {
    const idx = Math.floor(i / limit);
    if (only && !only.has(idx)) continue;
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx).push(blocks[i]);
  }
  for (const [idx, slice] of groups) {
    writeChainBin(path.join(dir, segmentFileName(idx)), slice);
  }
}

export function readChainSegments(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((n) => /^seg-\d+\.bin$/.test(n)).sort();
  if (!names.length) return null;
  const blocks = [];
  for (const name of names) blocks.push(...readChainBin(path.join(dir, name)));
  return blocks;
}
