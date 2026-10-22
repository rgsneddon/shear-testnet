// One regtest book, one invalid-PoW and one honest tip extension, both
// ingested off-loop. Prints one JSON line. test_pow_worker_fault_v12.js
// runs this under each hash-lane fault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';
import { createRegtestStore } from './regtest_store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const dest = encodeDest(Buffer.alloc(20, 7));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pow-worker-'));

function nextBlock(store, wantValid) {
  const tip = store.tip();
  const now = tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000 : 1_700_000_000_000;
  const { tpl } = store.template({ miner: dest, now, shareBatch: [] });
  const bits = decodeHeader(Buffer.from(tpl.header)).bits;
  for (let n = 1n; n < 1_000_000n; n += 1n) {
    const header = setNonce(Buffer.from(tpl.header), n);
    const hash = Buffer.from(shearHash(header));
    if (meetsTarget(hash, bits) !== wantValid) continue;
    return {
      header,
      hash,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
      height: (Number(tip?.height) || 0) + 1,
    };
  }
  throw new Error('nonce search');
}

const store = createRegtestStore(dir, { bits: 4 });
for (let i = 0; i < 2; i += 1) {
  const got = store.append(nextBlock(store, true));
  if (!got.ok) throw new Error(`seed ${got.reason}`);
}
const tipBefore = store.tip().height;
const invalid = await store.ingest([nextBlock(store, false)], { offLoopPow: true });
const honest = await store.ingest([nextBlock(store, true)], { offLoopPow: true });
process.stdout.write(`${JSON.stringify({
  tipBefore,
  tipAfter: store.tip().height,
  invalid: { ok: !!invalid?.ok, reason: invalid?.reason || null },
  honest: { ok: !!honest?.ok, reason: honest?.reason || null },
})}\n`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
