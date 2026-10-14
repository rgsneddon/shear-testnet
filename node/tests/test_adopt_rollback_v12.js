/**
 * A throw after adopt publishes, a supply failure in the suffix, and a vault
 * apply failure leave the book, the markers' effects, and the snap bytes as
 * they were. The same candidate can still be adopted afterwards.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { createStore } from '../src/store.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { buildTemplate, retarget, shouldAdopt } from '../src/chain.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const STEP = 90_000;
const PUBLISH_STAGES = ['spent', 'blocks', 'chain', 'explorer', 'flux', 'vault', 'tail', 'snap', 'emit'];

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function easyPow(tag) {
  const h = Buffer.alloc(32);
  h.writeUInt32LE((tag >>> 0) || 1, 4);
  return h;
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function sealNext(store, dest, tag) {
  const tip = store.tip();
  const now = tip ? headerTime(tip) + STEP : T0;
  const { tpl } = store.template({ miner: dest, now });
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: easyPow(tag), skipSharePow: true });
}

function grow(store, dest, n, tagBase) {
  for (let i = 0; i < n; i += 1) {
    const got = sealNext(store, dest, tagBase + i + 1);
    if (!got.ok) return got;
  }
  return { ok: true, height: store.tip().height };
}

function heavierFork(store, dest, parentIndex, count, tagBase) {
  const prefix = store.blocks.slice(0, parentIndex + 1);
  const out = [];
  let prev = prefix[prefix.length - 1];
  let now = headerTime(prev) + STEP;
  for (let i = 0; i < count; i += 1) {
    const chain = prefix.concat(out);
    const bits = retarget(chain, now);
    const tpl = buildTemplate({
      prev: prev.hash,
      prevHeader: prev.header,
      prevBlock: prev,
      height: Number(prev.height) + 1,
      miner: dest,
      now,
      bits,
      parentBlocks: chain,
    });
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      hash: easyPow(tagBase + i),
      height: Number(prev.height) + 1,
      weight: tpl.weight,
      bSpendIds: [],
    };
    out.push(block);
    prev = block;
    now += STEP;
  }
  return out;
}

function fileBytes(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

function shot(store, dir) {
  const jroot = store.jroot();
  return {
    tip: Buffer.from(store.tip().hash).toString('hex'),
    length: store.blocks.length,
    hashes: store.blocks.map((b) => Buffer.from(b.hash).toString('hex')),
    spent: [...store.spentB].sort(),
    reorgs: store.getreorgs().length,
    side: store.sideHashes(),
    owed: store.owedView().series.length,
    bonus: String(store.reserveVault.liveHashBonusNanos),
    fee: String(store.reserveVault.feeBankNanos),
    jroot: jroot ? Buffer.from(jroot).toString('hex') : '',
    anchors: store.anchorView(),
    snap: fileBytes(path.join(dir, 'book.snap')),
    vault: fileBytes(path.join(dir, 'reserve.json')),
  };
}

function sameBytes(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Buffer.from(a).equals(Buffer.from(b));
}

describe('v12 adopt rolls back a throw after publish', () => {
  it('a suffix failure or a throw at any publish step leaves the book and the snap', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-adopt-rollback-'));
    try {
      const store = createStore(dir, { pruneAfter: 1_000_000 });
      const dest = minerDest();
      const built = grow(store, dest, 8, 4000);
      assert.equal(built.ok, true, built.reason);
      const before = shot(store, dir);
      assert.ok(before.snap, 'snap');
      const parent = store.blocks.length - 4;
      const fork = heavierFork(store, dest, parent, 5, 90_000);
      const candidate = store.blocks.slice(0, parent + 1).concat(fork);
      assert.equal(shouldAdopt(store.blocks, candidate), true);
      const suffix = fork.length;
      assert.ok(suffix > 2);

      const expectSame = (got, reason) => {
        assert.equal(got.ok, false);
        assert.equal(got.reason, reason);
        const after = shot(store, dir);
        assert.equal(after.tip, before.tip);
        assert.equal(after.length, before.length);
        assert.deepEqual(after.hashes, before.hashes);
        assert.deepEqual(after.spent, before.spent);
        assert.equal(after.reorgs, before.reorgs);
        assert.deepEqual(after.side, before.side);
        assert.equal(after.owed, before.owed);
        assert.equal(after.bonus, before.bonus);
        assert.equal(after.fee, before.fee);
        assert.equal(after.jroot, before.jroot);
        assert.deepEqual(after.anchors, before.anchors);
        assert.equal(sameBytes(after.snap, before.snap), true);
        assert.equal(sameBytes(after.vault, before.vault), true);
      };

      for (const stage of PUBLISH_STAGES) {
        const got = await Promise.resolve(store.ingest(fork, {
          trustBlockHash: true,
          throwAfterPublish: stage,
        }));
        expectSame(got, `adopt_throw_${stage}`);
      }

      for (const at of [0, Math.floor(suffix / 2), suffix - 1]) {
        const supply = await Promise.resolve(store.ingest(fork, {
          trustBlockHash: true,
          failSupplyAt: at,
        }));
        expectSame(supply, 'supply');
        const vault = await Promise.resolve(store.ingest(fork, {
          trustBlockHash: true,
          failVaultApplyAt: at,
        }));
        expectSame(vault, 'epoch_open');
      }

      const thrown = await Promise.resolve(store.ingest(fork, {
        trustBlockHash: true,
        throwSupply: true,
      }));
      expectSame(thrown, 'supply_throw');

      const adopted = await Promise.resolve(store.ingest(fork, { trustBlockHash: true }));
      assert.equal(adopted.ok, true, adopted.reason);
      assert.equal(store.blocks.length, parent + 1 + fork.length);
      assert.ok(store.blocks.length > before.length);
      assert.notEqual(Buffer.from(store.tip().hash).toString('hex'), before.tip);
      assert.equal(store.getreorgs().length, before.reorgs + 1);

      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-adopt-rollback-copy-'));
      fs.cpSync(dir, copy, { recursive: true });
      fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(copy));
      const reloaded = createStore(copy, { pruneAfter: 1_000_000 });
      assert.equal(reloaded.loadMode, 'snap');
      assert.equal(reloaded.blocks.length, store.blocks.length);
      assert.equal(Buffer.from(reloaded.tip().hash).toString('hex'), Buffer.from(store.tip().hash).toString('hex'));
      const liveRoot = store.jroot();
      const loadedRoot = reloaded.jroot();
      assert.equal(Buffer.from(loadedRoot).equals(Buffer.from(liveRoot)), true);
      fs.rmSync(copy, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
