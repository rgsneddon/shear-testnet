// Fixture: already-sealed pot vouts inside a real node RPC.
// notesForAddress scans the blocks. This file does not invent a notes route.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { createRpc } from '../src/rpc.js';

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
  });
}

const header = Buffer.alloc(128, 0x11);
const hash = Buffer.alloc(32, 0x22);
const blocks = [];
for (let h = 1; h <= tip; h += 1) {
  const vout = byHeight.get(h);
  blocks.push({
    height: h,
    hash,
    header,
    txs: vout ? [{ coinbase: true, vout: [vout] }] : [],
  });
}

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
process.stdout.write(`PORT ${addr.port}\n`);
const timer = setInterval(() => {
  store.emit('tip', { height: tip, hash: hash.toString('hex') });
}, 200);
timer.unref?.();
store.emit('tip', { height: tip, hash: hash.toString('hex') });
