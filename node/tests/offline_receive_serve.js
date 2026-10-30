// Fixture: already-sealed pot vouts inside a real node RPC.
// The node has no notes route (AL-5): the wallet reads these blocks' bodies
// and proves each against its header (ruling 6). So every header here is a
// real one: its merkle root is chain.js digestTx over the block's rows, and
// each parent link is the ShearHash of the header below. The checkpoint pin
// sits at PIN_HEIGHT (printed as a PIN line); blocks above it are mined to
// the ASERT floor the wallet checks, blocks below it are proven by hash
// links down from the pin. This file does not invent a notes route.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { createRpc } from '../src/rpc.js';
import { digestTx } from '../src/chain.js';
import { encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { shearHash, meetsTarget } from '../../crypto/shear_hash.js';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node offline_receive_serve.js spec.json');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const tip = Math.floor(Number(spec.tip) || 0);
const dest = String(spec.dest || '');
const confirmedNanos = Math.floor(Number(spec.confirmedNanos) || 0);

function buf(hex) {
  if (typeof hex !== 'string' || hex.length === 0) return undefined;
  return Buffer.from(hex, 'hex');
}

const byHeight = new Map();
for (const note of spec.notes || []) {
  const height = Math.floor(Number(note.height) || 0);
  if (height < 1) continue;
  const vp = note.valueProof || {};
  byHeight.set(height, {
    kind: note.kind || 'pot',
    noteCommit: buf(note.noteCommit),
    commit: buf(note.commit),
    valueProof: { R: buf(vp.R), z: buf(vp.z), v: Number(vp.v) },
    rEph: buf(note.rEph),
    rCt: buf(note.rCt),
    admitPub: buf(note.admitPub),
    dest20: buf(note.dest20),
    rangeProof: buf(note.rangeProof),
  });
}

// The pin is ten blocks under the tip, so the young seals are above it.
const PIN_HEIGHT = Math.max(11, tip - 10);
const FLOOR_BITS = 4 * 65536;
const ANCHOR_MS = 1_600_000_000_000;
// 30 h behind the 90 s schedule: ASERT sits at its 4-bit floor, 90 s apart.
const timeAt = (h) => (h === 1 ? ANCHOR_MS : ANCHOR_MS + (h - 1) * 90_000 + 30 * 3_600_000);
const txsAt = (h) => {
  const vout = byHeight.get(h);
  return vout ? [{ coinbase: true, vout: [vout] }] : [];
};
const rootAt = (h) => merkleRoot(txsAt(h).map(digestTx));

// Hashing 440 headers is the slow part, so a second run on the same notes
// reuses this fixture's own chain (keyed by every block's merkle root). The
// wallet still hashes and checks every header itself.
const rootsKey = createHash('sha256')
  .update(shearHash(Buffer.alloc(128, 1)))
  .update(Array.from({ length: tip }, (_, i) => rootAt(i + 1).toString('hex')).join(''))
  .digest('hex');
const cachePath = path.join(os.tmpdir(), `shear-offline-chain-${rootsKey}.json`);
let cached = null;
try {
  const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  if (c.tip === tip && Array.isArray(c.hashes) && c.roots.every((r, i) => r === rootAt(i + 1).toString('hex'))) cached = c;
} catch { /* mine */ }

const headers = [];
const hashes = [];
let prev = Buffer.alloc(32);
for (let h = 1; h <= tip; h += 1) {
  let header = encodeHeader({
    prevBlockHash: prev,
    merkleRoot: rootAt(h),
    continuityRoot: Buffer.alloc(32),
    timestamp: timeAt(h),
    bits: FLOOR_BITS,
    nonce: cached ? BigInt(cached.nonces[h - 1]) : 0n,
  });
  let digest = cached ? Buffer.from(cached.hashes[h - 1], 'hex') : shearHash(header);
  if (h > PIN_HEIGHT && !meetsTarget(digest, FLOOR_BITS)) {
    for (let n = 1n; !meetsTarget(digest, FLOOR_BITS); n += 1n) {
      header = encodeHeader({
        prevBlockHash: prev,
        merkleRoot: rootAt(h),
        continuityRoot: Buffer.alloc(32),
        timestamp: timeAt(h),
        bits: FLOOR_BITS,
        nonce: n,
      });
      digest = shearHash(header);
    }
  }
  headers.push(header);
  hashes.push(digest);
  prev = digest;
}
{
  fs.writeFileSync(cachePath, JSON.stringify({
    tip,
    roots: headers.map((_, i) => rootAt(i + 1).toString('hex')),
    nonces: headers.map((hd) => hd.readBigUInt64LE(112).toString()),
    hashes: hashes.map((d) => d.toString('hex')),
  }));
}

const blocks = [];
for (let h = 1; h <= tip; h += 1) {
  blocks.push({ height: h, hash: hashes[h - 1], header: headers[h - 1], txs: txsAt(h) });
}
const header = headers[tip - 1];
const hash = hashes[tip - 1];

const store = new EventEmitter();
store.blocks = blocks;
store.tip = () => ({ height: tip, header, hash });
store.spendableNanos = (address) => (String(address) === dest ? confirmedNanos : 0);
store.historyFor = (address) => {
  if (String(address) !== dest) return [];
  return [{
    id: 'explorer-cb-7',
    kind: 'coinbase',
    from: 'coinbase',
    to: dest,
    nanos: NANOS_PER_SHE,
    height: 7,
    confirmed: true,
  }];
};

const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
const addr = await rpc.listen();
process.stdout.write(`PIN ${JSON.stringify({
  network: 'testnet-v12-fixture',
  height: PIN_HEIGHT,
  hashHex: hashes[PIN_HEIGHT - 1].toString('hex'),
  timeMs: timeAt(PIN_HEIGHT),
  bits: FLOOR_BITS,
  anchorHeight: 1,
  anchorTimeMs: ANCHOR_MS,
  anchorBits: 17 * 65536,
  priorTimesMs: Array.from({ length: 10 }, (_, i) => timeAt(PIN_HEIGHT - 10 + i)),
})}\n`);
process.stdout.write(`PORT ${addr.port}\n`);
const timer = setInterval(() => {
  store.emit('tip', { height: tip, hash: hash.toString('hex') });
}, 200);
timer.unref?.();
store.emit('tip', { height: tip, hash: hash.toString('hex') });
