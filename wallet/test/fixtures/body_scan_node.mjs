// A real v12 node for the wallet body-scan tests (Russell ruling 6, 28 Oct).
//
//   node test/fixtures/body_scan_node.mjs <walletDest> <walletSeedHex>
//
// Builds a chain in a fresh store with the node's own template and append,
// then serves it over the node's own RPC. Below the pin the blocks carry a
// trusted hash (the wallet starts from the pin, as a release wallet does).
// Every block above the pin is mined: its ShearHash meets the ASERT bits the
// template set, so the wallet's own header checks are the ones that run.
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
import { createStore } from '../../../node/src/store.js';
import { createRpc } from '../../../node/src/rpc.js';
import { decodeHeader, setNonce } from '../../../crypto/header.js';
import { shearHash, meetsTarget } from '../../../crypto/shear_hash.js';
import { encodeDest } from '../../../crypto/address.js';
import { bluWallet, mineBluShares, ownBluNotes } from '../../../node/tests/support/blunote_mine.js';

const [walletDest, seedHex] = process.argv.slice(2);
if (!walletDest || !/^[0-9a-f]{64}$/.test(seedHex || '')) {
  process.stderr.write('usage: body_scan_node.mjs <walletDest> <walletSeedHex>\n');
  process.exit(2);
}
const FLOOR_BITS = 4 * 65536;
const ABOVE_PIN = 12;
// Heights above the pin whose draw pays the wallet: two deep enough to
// spend at the tip, one still short of 9 confirmations, and the tip, whose
// record no block names yet.
const PAID_ABOVE_PIN = [1, 2, ABOVE_PIN - 2, ABOVE_PIN];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-body-scan-'));
const store = createStore(dir);
const other = encodeDest(Buffer.alloc(20, 3));
// The dest is not paid under R28; the seed's mining keys (B, Y) are.
const who = bluWallet(Buffer.from(seedHex, 'hex'));

let fakeSeq = 1;
function fakeHash() {
  const h = Buffer.alloc(32);
  h.writeUInt32BE(fakeSeq, 28);
  fakeSeq += 1;
  return h;
}

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

// Below the pin: 20 minutes apart, so the chain falls behind its 90 s
// schedule until ASERT reaches its floor. MTP + 2 h still holds.
const T0 = Date.now() - 4 * 24 * 60 * 60 * 1000;
let at = T0;
for (;;) {
  const { tpl } = store.template({ miner: other, now: at });
  await appendTpl(tpl, tpl.header, fakeHash());
  const h = store.tip().height;
  const bits = decodeHeader(Buffer.from(tpl.header)).bits;
  if (h >= 12 && bits === FLOOR_BITS) break;
  if (h > 400) throw new Error('ASERT never reached its floor');
  at += 20 * 60 * 1000;
}
const pinBlock = store.tip();
const pinHeight = pinBlock.height;

// Above the pin: real ShearHash at the template's bits, 90 s apart.
const payments = [];
for (let i = 1; i <= ABOVE_PIN; i += 1) {
  at = stampOf(store.tip()) + 90_000;
  const paid = PAID_ABOVE_PIN.includes(i);
  const shareBatch = paid ? mineBluShares(who, store.tip().header, 1) : [];
  const miner = other;
  const { tpl } = store.template({ miner, now: at, shareBatch });
  const bits = decodeHeader(Buffer.from(tpl.header)).bits;
  let header = null;
  let hash = null;
  for (let nonce = 0; nonce < 1 << 20; nonce += 1) {
    const tryHeader = setNonce(tpl.header, BigInt(nonce));
    const d = shearHash(tryHeader);
    if (meetsTarget(d, bits)) {
      header = tryHeader;
      hash = d;
      break;
    }
  }
  if (!header) throw new Error(`no nonce at h=${tpl.height}`);
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
  anchorTimeMs: times[0],
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
