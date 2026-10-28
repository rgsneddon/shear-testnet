// A real R28 node for the wallet BluNote spend test.
//
//   node test/fixtures/blunote_spend_node.mjs <walletSeedHex>
//
// A fresh regtest store (the node's 4-bit seed, so a test can mine every
// block) built with the node's own template and append and served over the
// node's own RPC. The wallet is paid two ways R28 pays a miner:
//   - solo option (b): an empty round pays its pot to a fresh one-time key
//     of the wallet's mining address (template feeKey, feeBps 0, potToFee),
//     so the coin is the record's fee note;
//   - a share: the wallet's own share (real ShearHash on the parent header)
//     wins the block's draw, so the coin is a record winner note.
// Then empty blocks bury both past 9 confirmations.
//
// Prints one JSON line: the RPC port, the checkpoint pin, the tip, and each
// coin as the JS spec derives it for the seed (crypto/blunote.js): kind,
// height, admitPub P, commit C, value, and the spend tag Hp(P)·x with
// x = x_base + H(y·R). The node keeps serving until stdin closes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegtestStore } from '../../../node/tests/regtest_store.js';
import { createRpc } from '../../../node/src/rpc.js';
import { decodeHeader, setNonce } from '../../../crypto/header.js';
import { shearHash, meetsTarget, setHashBackend } from '../../../crypto/shear_hash.js';
import { encodeDest } from '../../../crypto/address.js';
import { pointBytes, pointFrom } from '../../../crypto/note.js';
import { spendTag } from '../../../crypto/admit.js';
import { oneTimeKey } from '../../../crypto/blunote.js';
import { bluWallet, mineBluShares, ownBluNotes } from '../../../node/tests/support/blunote_mine.js';

const [seedHex] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(seedHex || '')) {
  process.stderr.write('usage: blunote_spend_node.mjs <walletSeedHex>\n');
  process.exit(2);
}
try { setHashBackend('jit'); } catch { /* interpreter */ }
const FLOOR_BITS = 4 * 65536;
const PIN_HEIGHT = 12;
const BURY = 11;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-blunote-spend-'));
const store = createRegtestStore(dir, { bits: 4 });
const other = encodeDest(Buffer.alloc(20, 3));
const who = bluWallet(Buffer.from(seedHex, 'hex'));
const hex = (b) => Buffer.from(b).toString('hex');

function stampOf(b) {
  return Number(decodeHeader(Buffer.from(b.header)).timestamp);
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

async function mineOne(opts = {}) {
  const now = store.tip() ? stampOf(store.tip()) + 90_000 : T0;
  const { tpl } = store.template({ miner: other, now, ...opts });
  const { header, hash } = mineHeader(tpl);
  const got = await Promise.resolve(store.append({
    header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  // Shares are always checked: their ShearHash is recomputed on append.
  }, { trustedPowHash: hash, skipSharePow: !(tpl.shareBatch || []).length }));
  if (!got || got.ok !== true) throw new Error(`append h=${tpl.height} ${got?.reason || ''}`);
  return store.tip();
}

const T0 = Date.now() - 24 * 60 * 60 * 1000;
while (!store.tip() || store.tip().height < PIN_HEIGHT) await mineOne();
const pinBlock = store.tip();

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

const times = store.blocks.map((b) => stampOf(b));
const pin = {
  network: 'testnet-v12',
  height: pinBlock.height,
  hashHex: hex(pinBlock.hash),
  timeMs: times[pinBlock.height - 1],
  bits: decodeHeader(Buffer.from(pinBlock.header)).bits,
  anchorHeight: 1,
  // A wallet pin anchors ASERT at 17 bits; 30 h behind that schedule its
  // quote is the 4-bit floor these regtest headers carry.
  anchorTimeMs: times[0] - 30 * 60 * 60 * 1000,
  anchorBits: 17 * 65536,
  priorTimesMs: times.slice(pinBlock.height - 11, pinBlock.height - 1),
};

const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
const bound = await rpc.listen();
process.stdout.write(`${JSON.stringify({ port: bound.port, pin, tip: store.tip().height, coins })}\n`);

const stop = async () => {
  try { await rpc.close(); } catch { /* closing */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
