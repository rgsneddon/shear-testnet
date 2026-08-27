/**
 * Epoch disk: chain.bin is length-prefixed packed blocks, not JSONL.
 */
import fs from 'node:fs';
import { encodeHeader, decodeHeader } from './header.js';

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
  const txs = Buffer.from(JSON.stringify(block.txs || []));
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
  return Buffer.concat([parts[0], rootA, rootB, hash, meta, lens, aJson, bJson, txs]);
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
  const txs = JSON.parse(b.subarray(o, o + tLen).toString() || '[]');
  decodeHeader(header);
  return {
    header,
    rootA,
    rootB,
    hash,
    height,
    aLeaves,
    bLeaves,
    txs,
    samples: [],
    samplesPruned: !!(flags & 1),
    bLeavesPruned: !!(flags & 2),
    weight: b.readUInt32LE(232),
  };
}

export function writeChainBin(path, blocks) {
  const chunks = [MAGIC];
  for (const block of blocks || []) {
    const rec = packEpochBlock(block);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(rec.length, 0);
    chunks.push(len, rec);
  }
  fs.writeFileSync(path, Buffer.concat(chunks));
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
