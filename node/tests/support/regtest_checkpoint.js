// The regtest checkpoint (Russell, 28 Oct, R01b): a wallet trust root for the
// shear-regtest book only, built from a real mined regtest chain.
//
// node/tests/gen_regtest_checkpoint.mjs mines heights 1..REGTEST_CHECKPOINT_HEIGHT
// into a fresh regtest store with the node's own template and append and real
// ShearHash at the 4-bit seed, then writes two files:
//   node/tests/fixtures/regtest_checkpoint_chain.json  the mined blocks
//   node/tests/regtest_checkpoint.json                 the pin of the last one
// A coinbase carries fresh blinding, so a chain is mined once and kept, not
// re-mined. A test that needs the checkpoint replays the kept blocks into a
// fresh store with the node's own append (each block's ShearHash recomputed
// from its header and checked against its bits), refuses unless the replayed
// tip is the pin, then mines on top.
//
// Everything here lives under node/tests, which no release pack ships
// (node/pack/bundle_modules.py refuses a release graph that reaches it;
// node/pack/test_regtest_checkpoint_pack.py checks a built pack).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHeader, setNonce } from '../../../crypto/header.js';
import { shearHash, meetsTarget } from '../../../crypto/shear_hash.js';
import { encodeDest } from '../../../crypto/address.js';

export const REGTEST_CHECKPOINT_HEIGHT = 12;
export const REGTEST_CHECKPOINT_NETWORK = 'shear-regtest';
// 2026-10-01T00:00:00Z. Block i is stamped T0 + (i - 1) * 90 s.
export const REGTEST_CHECKPOINT_T0 = 1_790_812_800_000;
const FLOOR_BITS = 4 * 65536;
const MINER = encodeDest(Buffer.alloc(20, 3));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BLOCK_KEYS = ['header', 'height', 'txs', 'samples', 'shareBatch', 'aLeaves', 'bLeaves', 'rootA', 'rootB', 'weight'];

export const REGTEST_CHECKPOINT_FILE = path.join(HERE, '..', 'regtest_checkpoint.json');
export const REGTEST_CHECKPOINT_CHAIN_FILE = path.join(HERE, '..', 'fixtures', 'regtest_checkpoint_chain.json');

function stampOf(b) {
  return Number(decodeHeader(Buffer.from(b.header)).timestamp);
}

/** The first nonce whose ShearHash meets the template's bits. */
export function mineHeader(tpl) {
  const bits = decodeHeader(Buffer.from(tpl.header)).bits;
  if (bits !== FLOOR_BITS) throw new Error(`h=${tpl.height} bits ${bits}, not the 4-bit seed`);
  for (let nonce = 0; nonce < 1 << 20; nonce += 1) {
    const header = setNonce(tpl.header, BigInt(nonce));
    const hash = shearHash(header);
    if (meetsTarget(hash, bits)) return { header, hash };
  }
  throw new Error(`no nonce at h=${tpl.height}`);
}

/** Append a block with the node's own append. Shares are always checked. */
export async function appendMined(store, block, hash) {
  const row = Object.fromEntries(BLOCK_KEYS.map((k) => [k, block[k]]));
  row.shareBatch = row.shareBatch || [];
  if (block.miner != null) row.miner = block.miner;
  const got = await Promise.resolve(store.append(row, {
    trustedPowHash: hash,
    skipSharePow: !row.shareBatch.length,
  }));
  if (!got || got.ok !== true) throw new Error(`append h=${block.height} ${got?.reason || ''}`);
  return store.tip();
}

/** Mine the checkpoint chain into an empty regtest store (the generator). */
export async function mineCheckpointChain(store) {
  if (store.tip()) throw new Error('regtest checkpoint chain needs an empty store');
  for (let h = 1; h <= REGTEST_CHECKPOINT_HEIGHT; h += 1) {
    const now = REGTEST_CHECKPOINT_T0 + (h - 1) * 90_000;
    const { tpl } = store.template({ miner: MINER, now });
    const { header, hash } = mineHeader(tpl);
    await appendMined(store, { ...tpl, header }, hash);
  }
  return store.tip();
}

/**
 * The wallet checkpoint of [store]'s tip, in the wallet's CheckpointPin JSON
 * shape (wallet/lib/shear_checkpoint.dart). The wallet anchors ASERT at 17
 * bits; 30 h behind that schedule its quote is the 4-bit floor these headers
 * carry.
 */
export function checkpointOf(store) {
  const tip = store.tip();
  const times = store.blocks.map((b) => stampOf(b));
  return {
    network: REGTEST_CHECKPOINT_NETWORK,
    height: tip.height,
    hashHex: Buffer.from(tip.hash).toString('hex'),
    timeMs: times[tip.height - 1],
    bits: decodeHeader(Buffer.from(tip.header)).bits,
    anchorHeight: 1,
    anchorTimeMs: times[0] - 30 * 60 * 60 * 1000,
    anchorBits: 17 * 65536,
    priorTimesMs: times.slice(tip.height - 11, tip.height - 1),
  };
}

const toJson = (_k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data)
  ? { $hex: Buffer.from(v.data).toString('hex') }
  : v);
const fromJson = (_k, v) => (v && typeof v === 'object' && typeof v.$hex === 'string' && Object.keys(v).length === 1
  ? Buffer.from(v.$hex, 'hex')
  : v);

/** The blocks of [store], as the chain file keeps them. */
export function chainFileText(store) {
  const rows = store.blocks.map((b) => Object.fromEntries(BLOCK_KEYS.map((k) => [k, b[k]])));
  return `${JSON.stringify(rows, toJson)}\n`;
}

export function pinnedCheckpoint() {
  return JSON.parse(fs.readFileSync(REGTEST_CHECKPOINT_FILE, 'utf8'));
}

export function keptChain(text = fs.readFileSync(REGTEST_CHECKPOINT_CHAIN_FILE, 'utf8')) {
  return JSON.parse(text, fromJson);
}

/**
 * Replay the kept chain into an empty regtest store and refuse unless its tip
 * is [pin] (default: the pinned checkpoint). Each block's ShearHash is
 * recomputed from its header; the append checks it against the bits and the
 * parent link. Returns the pin.
 */
export async function replayToCheckpoint(store, { pin = pinnedCheckpoint(), blocks = keptChain() } = {}) {
  if (store.tip()) throw new Error('regtest checkpoint replay needs an empty store');
  for (const block of blocks) {
    const header = Buffer.from(block.header);
    const hash = shearHash(header);
    if (!meetsTarget(hash, decodeHeader(header).bits)) {
      throw new Error(`regtest checkpoint chain h=${block.height}: header misses its bits`);
    }
    await appendMined(store, block, hash);
  }
  const got = checkpointOf(store);
  if (JSON.stringify(got) !== JSON.stringify(pin)) {
    throw new Error(`regtest checkpoint mismatch: replayed ${got.hashHex}, pinned ${pin.hashHex}`);
  }
  return pin;
}
