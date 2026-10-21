/**
 * Ingests wire blocks in this process. The parent writes encodeWireBlock
 * lines. This process does not share the parent's store or its FS-1 tree.
 * A compact lock is accepted from dest20 and the carried portal id.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { decodeWireBlock } from '../src/p2p.js';

const wirePath = process.argv[2];
if (!wirePath) {
  process.stderr.write('wire\n');
  process.exit(2);
}

const lines = fs.readFileSync(wirePath, 'utf8').split(/\r?\n/).filter(Boolean);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-wire-'));
const store = createStore(dir);
let lockDest20 = false;
let lockTo = false;
let lockSsa1 = false;

for (const line of lines) {
  const decoded = decodeWireBlock(JSON.parse(line));
  for (const tx of decoded.txs || []) {
    if (String(tx?.kind || tx?.vout?.[0]?.kind || '') !== 'lock') continue;
    if (tx.to != null && String(tx.to) !== '') lockTo = true;
    if (JSON.stringify(tx).includes('ssa1')) lockSsa1 = true;
    const outs = Array.isArray(tx.vout) ? tx.vout : [];
    if (outs.some((row) => row?.dest20)) lockDest20 = true;
  }
  const hash = Buffer.from(decoded.hash);
  const got = await Promise.resolve(store.append(decoded, {
    trustedPowHash: hash,
    skipSharePow: true,
  }));
  if (!got.ok) {
    process.stderr.write(`append h=${decoded.height} ${got.reason || ''} ${got.error || ''}\n`);
    process.exit(1);
  }
}

const tip = store.tip();
process.stdout.write(`${JSON.stringify({
  height: tip ? Number(tip.height) : 0,
  hash: tip ? Buffer.from(tip.hash).toString('hex') : '',
  portals: Object.keys(store.reserveVault.portals || {}).sort(),
  lockDest20,
  lockTo,
  lockSsa1,
})}\n`);
fs.rmSync(dir, { recursive: true, force: true });
