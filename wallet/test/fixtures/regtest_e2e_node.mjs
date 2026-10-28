// A real regtest node on the pinned regtest checkpoint, for the R01b
// checkpoint e2e (wallet/tool/regtest_checkpoint_e2e_test.dart).
//
//   node test/fixtures/regtest_e2e_node.mjs <walletDest>
//
// Replays the kept checkpoint chain (node/tests/support/regtest_checkpoint.js)
// into a fresh regtest store with the node's own append and refuses unless
// its tip is the pin in node/tests/regtest_checkpoint.json. Then it mines on
// top with the node's own template, append and real ShearHash: two blocks
// whose coinbase pays the wallet, buried past 9 confirmations. It serves the
// chain over the node's own RPC and prints one JSON line: the port, the tip,
// and each payment (height, commits, nanos).
//
// Each "mine" line on stdin mines one block from the node's mempool (what
// /api/wallet/send queued) and prints {mined, height, txs: [{spendTags}]}
// or {mined: false, reason}. The node serves until stdin closes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRegtestStore } from '../../../node/tests/regtest_store.js';
import { createRpc } from '../../../node/src/rpc.js';
import { decodeHeader } from '../../../crypto/header.js';
import { setHashBackend } from '../../../crypto/shear_hash.js';
import { encodeDest, hash20FromAddress } from '../../../crypto/address.js';
import { asU8, noteCommitOfDest20, openedCoinbaseNanos, txSpendTags } from '../../../crypto/note.js';
import { appendMined, mineHeader, replayToCheckpoint } from '../../../node/tests/support/regtest_checkpoint.js';

const [walletDest] = process.argv.slice(2);
if (!walletDest) {
  process.stderr.write('usage: regtest_e2e_node.mjs <walletDest>\n');
  process.exit(2);
}
try { setHashBackend('jit'); } catch { /* interpreter */ }
const PAID = 2;
const BURY = 10;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-regtest-e2e-'));
const store = createRegtestStore(dir, { bits: 4 });
const pin = await replayToCheckpoint(store);
const other = encodeDest(Buffer.alloc(20, 3));
const want = Buffer.from(noteCommitOfDest20(hash20FromAddress(walletDest)));
const hex = (b) => Buffer.from(b).toString('hex');

function stampOf(b) {
  return Number(decodeHeader(Buffer.from(b.header)).timestamp);
}

// Above the pin the clock is recent: the first block two hours ago.
let at = Math.max(stampOf(store.tip()) + 90_000, Date.now() - 2 * 60 * 60 * 1000);
async function mineOne(miner) {
  const { tpl } = store.template({ miner, now: at });
  at += 90_000;
  const { header, hash } = mineHeader(tpl);
  return appendMined(store, { ...tpl, header, miner }, hash);
}

const payments = [];
for (let i = 0; i < PAID; i += 1) {
  const block = await mineOne(walletDest);
  const commits = [];
  let nanos = 0n;
  for (const tx of block.txs || []) {
    for (const o of tx.vout || []) {
      if (!o?.noteCommit || !Buffer.from(asU8(o.noteCommit)).equals(want)) continue;
      const v = openedCoinbaseNanos(o);
      if (v == null) continue;
      commits.push(hex(asU8(o.commit)));
      nanos += BigInt(v);
    }
  }
  if (!commits.length) throw new Error(`the coinbase paid the wallet nothing at h=${block.height}`);
  payments.push({ height: block.height, commits, nanos: nanos.toString() });
}
for (let i = 0; i < BURY; i += 1) await mineOne(other);

const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
const bound = await rpc.listen();
process.stdout.write(`${JSON.stringify({ port: bound.port, pinHeight: pin.height, tip: store.tip().height, payments })}\n`);

const stop = async () => {
  try { await rpc.close(); } catch { /* closing */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(0);
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (line.trim() !== 'mine') return;
  try {
    const block = await mineOne(other);
    const txs = (block.txs || []).filter((t) => !t.coinbase).map((t) => ({
      kind: t.kind || 'send',
      spendTags: txSpendTags(t).tags.map((g) => hex(g)),
    }));
    process.stdout.write(`${JSON.stringify({ mined: true, height: block.height, txs })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ mined: false, reason: String(err?.message || err) })}\n`);
  }
});
lines.on('close', stop);
