// Regenerates fs1_digest_v1.json, the shared FS-1 body digest vector.
// Deterministic. Checked by crypto/fs1_spend.test.js and
// wallet/test/fs1_digest_v1_test.dart. Run: node crypto/vectors/gen_fs1_digest_v1.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { txBodyDigestFs1 } from '../fs1_spend.js';
import { MAGIC_TESTNET } from '../asert.js';

const hex = (b) => Buffer.from(b).toString('hex');
const fill = (seed, n) => {
  const out = Buffer.alloc(n);
  let k = 0;
  let ctr = 0;
  while (k < n) {
    const h = createHash('sha256').update(`${seed}:${ctr}`).digest();
    h.copy(out, k, 0, Math.min(32, n - k));
    k += 32;
    ctr += 1;
  }
  return out;
};

function out(seed, { kind = 'send', dest20 = true, viewTag = false, wrap = true } = {}) {
  const o = {
    kind,
    noteCommit: hex(fill(`${seed}nc`, 32)),
    commit: hex(fill(`${seed}c`, 32)),
    admitPub: hex(fill(`${seed}p`, 32)),
    rangeProof: hex(fill(`${seed}rp`, 96)),
  };
  if (wrap) {
    o.rEph = hex(fill(`${seed}e`, 32));
    o.rCt = hex(fill(`${seed}ct`, 32));
    o.amtCt = hex(fill(`${seed}a`, 8));
  }
  if (dest20) o.dest20 = hex(fill(`${seed}d`, 20));
  if (viewTag) o.viewTag = hex(fill(`${seed}v`, 1));
  return o;
}

const cases = [
  {
    kind: 'send',
    anchor: 8,
    fee: 100,
    nIn: 1,
    vout: [out('a0'), out('a1'), out('a2', { kind: 'dummy', wrap: false })],
  },
  {
    kind: 'send',
    anchor: 4096,
    fee: 4_000_000_123,
    nIn: 8,
    vout: [out('b0', { viewTag: true }), out('b1', { dest20: false }), out('b2', { kind: '', wrap: false })],
  },
  {
    kind: 'transfer',
    anchor: 9_007_199_254_740_984,
    fee: 0,
    nIn: 5,
    vout: [out('c0', { kind: 'dummy', wrap: false, dest20: false })],
  },
];

for (const c of cases) {
  const tx = { kind: c.kind, anchor: c.anchor, fee: c.fee, vin: Array.from({ length: c.nIn }, () => ({ commit: hex(Buffer.alloc(32, 7)) })), vout: c.vout };
  c.digest = hex(txBodyDigestFs1(tx, MAGIC_TESTNET));
}

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fs1_digest_v1.json');
fs.writeFileSync(file, `${JSON.stringify({ magic: MAGIC_TESTNET, cases }, null, 2)}\n`);
console.log(file);
