// A real R28 regtest node for the wallet BluNote spend e2e
// (tool/blunote_spend_e2e_test.dart).
//
//   node test/fixtures/blunote_spend_node.mjs <walletSeedHex>
//
// Replays the kept regtest checkpoint chain (node/tests/support/
// regtest_checkpoint.js) into a fresh regtest store with the node's own
// append and refuses unless its tip is the pin in node/tests/
// regtest_checkpoint.json. On top, with the node's own template and append
// and real ShearHash, the wallet is paid two ways R28 pays a miner:
//   - solo option (b): an empty round pays its pot to a fresh one-time key
//     of the wallet's mining address (template feeKey, feeBps 0, potToFee),
//     so the coin is the record's fee note;
//   - a share: the wallet's own share (real ShearHash on the parent header)
//     wins the block's draw, so the coin is a record winner note.
// Then empty blocks bury both past 9 confirmations.
//
// Prints one JSON line: the RPC port, the tip, and each coin as the JS spec
// derives it for the seed (crypto/blunote.js): kind, height, admitPub P,
// commit C, value, and the spend tag Hp(P)·x with x = x_base + H(y·R).
// Each "mine" line on stdin mines one block from the node's mempool (what
// /api/wallet/send queued) and prints {mined, height, txs: [{kind,
// spendTags}]} or {mined: false, reason}. The node serves until stdin closes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRegtestStore } from '../../../node/tests/regtest_store.js';
import { createRpc } from '../../../node/src/rpc.js';
import { decodeHeader } from '../../../crypto/header.js';
import { setHashBackend } from '../../../crypto/shear_hash.js';
import { encodeDest } from '../../../crypto/address.js';
import { pointBytes, pointFrom, txSpendTags } from '../../../crypto/note.js';
import { spendTag } from '../../../crypto/admit.js';
import { oneTimeKey } from '../../../crypto/blunote.js';
import { bluWallet, mineBluShares, ownBluNotes } from '../../../node/tests/support/blunote_mine.js';
import { appendMined, mineHeader, replayToCheckpoint } from '../../../node/tests/support/regtest_checkpoint.js';

const [seedHex] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(seedHex || '')) {
  process.stderr.write('usage: blunote_spend_node.mjs <walletSeedHex>\n');
  process.exit(2);
}
try { setHashBackend('jit'); } catch { /* interpreter */ }
const BURY = 11;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-blunote-spend-'));
const store = createRegtestStore(dir, { bits: 4 });
await replayToCheckpoint(store);
const other = encodeDest(Buffer.alloc(20, 3));
const who = bluWallet(Buffer.from(seedHex, 'hex'));
const hex = (b) => Buffer.from(b).toString('hex');

function stampOf(b) {
  return Number(decodeHeader(Buffer.from(b.header)).timestamp);
}

// Above the pin the clock is recent: the first block two hours ago.
let at = Math.max(stampOf(store.tip()) + 90_000, Date.now() - 2 * 60 * 60 * 1000);
async function mineOne(opts = {}) {
  const { tpl } = store.template({ miner: other, now: at, ...opts });
  at += 90_000;
  const { header, hash } = mineHeader(tpl);
  return appendMined(store, { ...tpl, header }, hash);
}

const coins = [];
function take(block, want) {
  const own = ownBluNotes(who, block.blunoteRecord);
  const got = own.filter((n) => n.kind === want);
  if (!got.length) throw new Error(`h=${block.height}: no ${want} note for the wallet`);
  for (const n of got) {
    coins.push({
      kind: n.kind,
      height: block.height,
      admitPub: hex(n.admitPub),
      commit: hex(n.commit),
      nanos: BigInt(n.v).toString(),
      spendTag: hex(pointBytes(spendTag(n.x, pointFrom(Buffer.from(n.admitPub))))),
    });
  }
}

// Solo option (b): an empty round pays its pot to the wallet's one-time key.
const k = oneTimeKey({ B: who.B, Y: who.Y });
const solo = await mineOne({ feeKey: { R: k.R, P: k.P, viewTag: k.tag }, feeBps: 0, potToFee: true });
take(solo, 'pool-fee');
// A share: the wallet's share wins the draw.
const shared = await mineOne({ shareBatch: mineBluShares(who, store.tip().header, 1) });
take(shared, 'blunote');
for (let i = 0; i < BURY; i += 1) await mineOne();

const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
const bound = await rpc.listen();
process.stdout.write(`${JSON.stringify({ port: bound.port, tip: store.tip().height, coins })}\n`);

const stop = async () => {
  try { await rpc.close(); } catch { /* closing */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(0);
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (line.trim() !== 'mine') return;
  try {
    const block = await mineOne();
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
