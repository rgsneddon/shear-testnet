// R28 attack 8 on the load paths (CA review of #145, finding A-1). A share
// whose one-time key P is already an admit-set note is refused
// (`share_key`), because two notes on one P share a key image. The key
// index behind that rule must be complete however the node booted: a full
// load, an own-install book.snap boot, or a snap-plus-suffix boot. If a
// snap boot left the index empty, that node would accept a block every
// fully loaded node refuses: a chain split. This is a regression test for
// the refusal; the share it builds names the genesis fee note's public key.
// Share PoW is real ShearHash-v3. Block headers use trustedPowHash, as the
// other store tests do; block PoW is not under test.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setHashBackend, shearHash, meetsTarget, leadingZeroBits } from '../../crypto/shear_hash.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import { HASH_BONUS_NANOS, POOL_FEE_BPS, SHARE_FLOOR_BITS } from '../../crypto/asert.js';
import { pointBytes } from '../../crypto/note.js';
import { admitBasePub, admitPubIndex, emptyFluxset, fluxWithLeaves } from '../../crypto/admit.js';
import { bindNonce, decodeRecord, oneTimeKey, scanPub } from '../../crypto/blunote.js';
import { GENESIS_PREV, buildTemplate } from '../src/chain.js';
import { createStore } from '../src/store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-keyidx-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

const MINER = 'ssa1qfqhuqrvxe63785jttt6t35fjs8r7heus2zweyv22twndy8mkcyjqs6c03jaql5q64ragqs6hx6drwr4ddddqwre9sv';
const T0 = 1_700_000_000_000;
const STEP = 90_000;
const BITS = SHARE_FLOOR_BITS;

function wallet() {
  const seed = randomBytes(32);
  return { B: pointBytes(admitBasePub(seed)), Y: scanPub(seed) };
}
const POOL = wallet();
function feeKey() {
  const k = oneTimeKey(POOL);
  return { R: k.R, P: k.P, viewTag: k.tag };
}

function asBlock(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

let powTag = 1;
function pow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag++, 4);
  return h;
}

/** A real floor share on `header` that pays `P` (any R; the binding names both). */
function shareFor(header, P) {
  for (let keys = 0; keys < 4096; keys += 1) {
    const R = oneTimeKey(wallet()).R;
    for (let c = 0; c < 256; c += 1) {
      const nonce = bindNonce(header, R, P, c, BITS);
      const rx = shearHash(setNonce(Buffer.from(header), nonce));
      if (!meetsTarget(rx, BITS)) continue;
      return {
        shareR: R, shareP: Buffer.from(P), viewTag: 0, nonce, lz: leadingZeroBits(rx),
        shareBits: BITS, proofSlot: 0, verifiedHeader: Buffer.from(header),
      };
    }
  }
  throw new Error('no share found');
}

/** The accepted-units series a store keeps, read from the records. */
function seriesOf(blocks) {
  return blocks.map((b) => {
    const rec = decodeRecord(Buffer.from(String(b.blunoteRecord), 'hex'));
    return rec && rec.n > 0 ? rec.W : 0n;
  });
}

/**
 * A block on `store`'s tip that seats `share`, built the way the store's
 * template builds it. By default the parent fluxset is empty, so the
 * template does not leave a reused key out and each node's verify must
 * decide; pass the real fluxset for a block that should be accepted.
 */
function forcedBlock(store, share, now, parentFluxset = emptyFluxset()) {
  const tip = store.tip();
  const plain = store.template({ miner: MINER, now, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
  const bits = decodeHeader(Buffer.from(plain.tpl.header)).bits;
  const tpl = buildTemplate({
    prev: tip ? tip.hash : GENESIS_PREV,
    prevHeader: tip.header,
    prevBlock: tip,
    parentWeight: tip.weight ?? undefined,
    height: tip.height + 1,
    miner: MINER,
    now,
    bits,
    hashBonusNanos: HASH_BONUS_NANOS,
    shareBatch: [share],
    parentBlocks: store.blocks,
    parentFluxset,
    hashAcceptedSeries: seriesOf(store.blocks),
    feeKey: feeKey(),
    feeBps: POOL_FEE_BPS,
  });
  assert.equal(tpl.shareBatch.length, 1, 'the forced template seats the share');
  return asBlock(tpl);
}

describe('R28 attack 8: the share-key index survives every load path (A-1)', () => {
  const dirs = [];
  const mk = (tag) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
    dirs.push(d);
    return d;
  };
  let bookDir;
  let live;
  let feeP;
  let tipHeight;

  before(async () => {
    // `live` verifies every block as it arrives and never reloads. `bookDir`
    // receives the same blocks; its book.snap is then rolled back one block,
    // so its next boot replays a suffix, and the boot after that is a snap.
    bookDir = mk('shear-r28-keyidx-book-');
    live = createStore(mk('shear-r28-keyidx-live-'));
    const book = createStore(bookDir);
    const blocks = [];
    for (let i = 0; i < 3; i += 1) {
      const t = book.template({ miner: MINER, now: T0 + i * STEP, feeKey: feeKey(), feeBps: POOL_FEE_BPS });
      const b = asBlock(t.tpl);
      const tag = pow();
      let got = await Promise.resolve(book.append(b, { trustedPowHash: tag }));
      assert.equal(got.ok, true, got.reason);
      got = await Promise.resolve(live.append(b, { trustedPowHash: tag }));
      assert.equal(got.ok, true, got.reason);
      blocks.push(b);
      if (i === 1) {
        for (const f of ['book.snap', 'reserve.json', 'vault.snap']) {
          fs.copyFileSync(path.join(bookDir, f), path.join(bookDir, `${f}.h2`));
        }
      }
    }
    feeP = decodeRecord(Buffer.from(book.blocks[0].blunoteRecord, 'hex')).feeP;
    assert.ok(!feeP.equals(Buffer.alloc(32)), 'genesis paid a fee note');
    tipHeight = book.tip().height;
    if (typeof book.close === 'function') book.close();
    for (const f of ['book.snap', 'reserve.json', 'vault.snap']) {
      fs.copyFileSync(path.join(bookDir, `${f}.h2`), path.join(bookDir, f));
    }
  });

  after(() => {
    if (live && typeof live.close === 'function') live.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a snapshot-index fluxset knows every key it was built from', () => {
    const flux = live.fluxset();
    const rebuilt = fluxWithLeaves(flux.pubs, flux.commits, [...flux.spendTags], { trust: true });
    const want = admitPubIndex({ pubs: flux.pubs });
    assert.ok(want.size > 0);
    const got = admitPubIndex(rebuilt);
    assert.equal(got.size, want.size, 'fluxWithLeaves keeps the key index');
    for (const k of want) assert.ok(got.has(k));
  });

  async function refusesReusedKey(node, label) {
    assert.equal(node.tip().height, tipHeight);
    const hex = Buffer.from(feeP).toString('hex');
    assert.ok(admitPubIndex(node.fluxset()).has(hex), `${label} knows the note key`);
    const header = node.tip().header;
    const reused = shareFor(header, feeP);
    const now = T0 + 3 * STEP;
    const t = node.template({ miner: MINER, now, shareBatch: [reused], feeKey: feeKey(), feeBps: POOL_FEE_BPS });
    assert.equal(t.tpl.shareBatch.length, 0, `${label} template seats no share on a note key`);
    const forced = forcedBlock(live, reused, now);
    const got = await Promise.resolve(node.append(forced, { trustedPowHash: pow() }));
    assert.equal(got.ok, false, `${label} refuses the block`);
    assert.equal(got.reason, 'share_key', `${label} refuses it as share_key`);
    assert.equal(node.tip().height, tipHeight);
  }

  it('suffix-booted, snap-booted and live nodes all refuse a share on an existing note key', async () => {
    const suffixNode = createStore(bookDir);
    assert.equal(suffixNode.loadMode, 'suffix', 'a rolled-back snap replays the suffix');
    await refusesReusedKey(suffixNode, 'suffix-booted node');
    if (typeof suffixNode.close === 'function') suffixNode.close();

    const snapNode = createStore(bookDir);
    assert.equal(snapNode.loadMode, 'snap', 'own-install restart boots from book.snap');
    await refusesReusedKey(snapNode, 'snap-booted node');
    await refusesReusedKey(live, 'live node');

    // Control: a fresh key, on the real parent fluxset, is accepted by both.
    const fresh = shareFor(live.tip().header, oneTimeKey(wallet()).P);
    const ok = forcedBlock(live, fresh, T0 + 3 * STEP, live.fluxset());
    const tag = pow();
    for (const [node, label] of [[snapNode, 'snap-booted node'], [live, 'live node']]) {
      const got = await Promise.resolve(node.append(ok, { trustedPowHash: tag }));
      assert.equal(got.ok, true, `${label}: ${got.reason}`);
    }
    if (typeof snapNode.close === 'function') snapNode.close();
  });
});
