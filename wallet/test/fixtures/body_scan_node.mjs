// A real v12 node for the wallet body-scan tests (Russell ruling 6, 28 Oct).
//
//   node test/fixtures/body_scan_node.mjs <walletDest> <walletSeedHex>
//
// Builds a chain in a fresh regtest store (the node's 4-bit seed, so every
// block can be mined in a test) with the node's own template and append,
// then serves it over the node's own RPC. Every block is mined: its
// ShearHash meets the bits the template set, and is the parent link of the
// next. The wallet proves the headers above the pin with its own header
// checks (the pin's ASERT anchor is set so its quote is that 4-bit floor),
// and the headers at and below the pin by hash links down from the pin.
// R28: a coinbase pays no miner. The wallet is paid through its own shares
// (mined with real ShearHash on the parent header) in the block's draw, so
// its notes are that block's record notes, named by the next block's
// coinbase (blunote.prev).
//
// Prints one JSON line: the RPC port, the checkpoint pin, the tip, and each
// payment the wallet's seed opens (height, commits, nanos, kind). The node
// keeps serving until stdin closes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegtestStore } from '../../../node/tests/regtest_store.js';
import { createRpc } from '../../../node/src/rpc.js';
import { decodeHeader, setNonce } from '../../../crypto/header.js';
import { shearHash, meetsTarget, setHashBackend } from '../../../crypto/shear_hash.js';
import { encodeDest } from '../../../crypto/address.js';
import { bluWallet, mineBluShares, ownBluNotes } from '../../../node/tests/support/blunote_mine.js';

const [walletDest, seedHex] = process.argv.slice(2);
if (!walletDest || !/^[0-9a-f]{64}$/.test(seedHex || '')) {
  process.stderr.write('usage: body_scan_node.mjs <walletDest> <walletSeedHex>\n');
  process.exit(2);
}
try { setHashBackend('jit'); } catch { /* interpreter */ }
const FLOOR_BITS = 4 * 65536;
const PIN_HEIGHT = 12;
const ABOVE_PIN = 12;
// Heights above the pin whose draw pays the wallet: two deep enough to
// spend at the tip, one still short of 9 confirmations, and the tip, whose
// record no block names yet.
const PAID_ABOVE_PIN = [1, 2, ABOVE_PIN - 2, ABOVE_PIN];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-body-scan-'));
const store = createRegtestStore(dir, { bits: 4 });
const other = encodeDest(Buffer.alloc(20, 3));
// The dest is not paid under R28; the seed's mining keys (B, Y) are.
const who = bluWallet(Buffer.from(seedHex, 'hex'));

function stampOf(b) {
  return Number(decodeHeader(Buffer.from(b.header)).timestamp);
}

async function appendTpl(tpl, header, hash) {
  const got = await Promise.resolve(store.append({
    header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    // R28: a block names no miner (blunote_miner).
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  // Shares are always checked: their ShearHash is recomputed on append.
  }, { trustedPowHash: hash, skipSharePow: !(tpl.shareBatch || []).length }));
  if (!got || got.ok !== true) throw new Error(`append h=${tpl.height} ${got?.reason || ''}`);
}

function mineHeader(tpl) {
  const bits = decodeHeader(Buffer.from(tpl.header)).bits;
  if (bits !== FLOOR_BITS) throw new Error(`h=${tpl.height} bits ${bits}, not the 4-bit seed`);
  for (let nonce = 0; nonce < 1 << 20; nonce += 1) {
    const header = setNonce(tpl.header, BigInt(nonce));
    const hash = shearHash(header);
    if (meetsTarget(hash, bits)) return { header, hash };
  }
  throw new Error(`no nonce at h=${tpl.height}`);
}

// At and below the pin, 90 s apart.
const T0 = Date.now() - 24 * 60 * 60 * 1000;
let at = T0;
while (!store.tip() || store.tip().height < PIN_HEIGHT) {
  const { tpl } = store.template({ miner: other, now: at });
  const { header, hash } = mineHeader(tpl);
  await appendTpl(tpl, header, hash);
  at += 90_000;
}
const pinBlock = store.tip();
const pinHeight = pinBlock.height;

// Above the pin, 90 s apart.
const payments = [];
for (let i = 1; i <= ABOVE_PIN; i += 1) {
  at = stampOf(store.tip()) + 90_000;
  const paid = PAID_ABOVE_PIN.includes(i);
  const shareBatch = paid ? mineBluShares(who, store.tip().header, 1) : [];
  const miner = other;
  const { tpl } = store.template({ miner, now: at, shareBatch });
  const { header, hash } = mineHeader(tpl);
  await appendTpl(tpl, header, hash);
  if (!paid) continue;
  const block = store.tip();
  const own = ownBluNotes(who, block.blunoteRecord);
  if (!own.length) throw new Error(`the draw paid the wallet nothing at h=${block.height}`);
  const commits = own.map((n) => Buffer.from(n.commit).toString('hex'));
  const nanos = own.reduce((s, n) => s + BigInt(n.v), 0n);
  payments.push({ height: block.height, commits, nanos: nanos.toString(), kind: 'blunote' });
}

const times = store.blocks.map((b) => stampOf(b));
const pin = {
  network: 'testnet-v12',
  height: pinHeight,
  hashHex: Buffer.from(pinBlock.hash).toString('hex'),
  timeMs: times[pinHeight - 1],
  bits: decodeHeader(Buffer.from(pinBlock.header)).bits,
  anchorHeight: 1,
  // A wallet pin anchors ASERT at 17 bits; 30 h behind that schedule its
  // quote is the 4-bit floor these regtest headers carry.
  anchorTimeMs: times[0] - 30 * 60 * 60 * 1000,
  anchorBits: 17 * 65536,
  priorTimesMs: times.slice(pinHeight - 11, pinHeight - 1),
};

const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
const bound = await rpc.listen();
process.stdout.write(`${JSON.stringify({
  port: bound.port,
  pin,
  tip: store.tip().height,
  tipMs: times[times.length - 1],
  payments,
})}\n`);
const stop = async () => {
  try { await rpc.close(); } catch { /* closing */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
