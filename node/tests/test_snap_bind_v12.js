/**
 * A lagged snap is accepted only when vault.snap matches and every packed
 * field of the prefix is still the one the snap sealed. Samples are the
 * exception: burial may drop them. A torn snap, a vault written out of
 * step with book.snap, and a reorg below the snap height all replay.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import {
  packEpochBlock,
  segmentFileName,
  segmentRecordBodies,
  unpackEpochBlock,
  CHAIN_SEGMENT_BLOCKS,
} from '../../crypto/chainbin.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { packSpillBytes } from '../../crypto/hash_owed.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { decodeBookSnap } from '../src/book_snap.js';
import { buildTemplate, retarget, shouldAdopt } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { auditCirculatingSupply } from '../src/supply.js';

const T0 = 1_700_000_000_000;
const STEP = 90_000;

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

function freshDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

function cloneDir(src) {
  const dest = freshDir('shear-snap-bind-copy-');
  fs.cpSync(src, dest, { recursive: true });
  fs.mkdirSync(path.dirname(bookSealKeyPath(dest)), { recursive: true });
  fs.copyFileSync(bookSealKeyPath(src), bookSealKeyPath(dest));
  return dest;
}

function viewOf(store) {
  const supply = auditCirculatingSupply(store.blocks);
  assert.equal(supply.status, 'verified', supply.reason || 'supply');
  const owed = store.owedView();
  return {
    height: store.tip().height,
    tip: Buffer.from(store.tip().hash).toString('hex'),
    supply: String(supply.circulatingNanos),
    series: owed.series.map((n) => String(n)).join(','),
    rows: owed.rows.map((r) => `${Buffer.from(r.noteCommit).toString('hex')}:${String(r.nanos)}`).sort().join('|'),
  };
}

function readSnap(dir) {
  return decodeBookSnap(fs.readFileSync(path.join(dir, 'book.snap')), fs.readFileSync(bookSealKeyPath(dir)));
}

const CHAIN_MAGIC = Buffer.from('shear-chn-v1\0\0\0');

function writeBodies(file, bodies) {
  const magic = fs.readFileSync(file).subarray(0, CHAIN_MAGIC.length);
  assert.ok(magic.equals(CHAIN_MAGIC), 'segment magic');
  const chunks = [magic];
  for (const body of bodies) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length, 0);
    chunks.push(len, body);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

function patchPrefix(dir, index, patch) {
  const seg = Math.floor(index / CHAIN_SEGMENT_BLOCKS);
  const local = index % CHAIN_SEGMENT_BLOCKS;
  const file = path.join(dir, 'segments', segmentFileName(seg));
  const bodies = segmentRecordBodies(file);
  assert.ok(bodies && bodies[local], 'prefix record');
  const before = Buffer.from(bodies[local]);
  const next = patch(before);
  assert.ok(!next.equals(before), 'patch changed the packed record');
  bodies[local] = next;
  writeBodies(file, bodies);
  return unpackEpochBlock(next);
}

function patchBLeaves(rec) {
  const aLen = rec.readUInt32LE(240);
  const bLen = rec.readUInt32LE(244);
  const bAt = 252 + aLen;
  const json = rec.subarray(bAt, bAt + bLen).toString('utf8');
  assert.ok(json.endsWith(']'), json);
  const next = Buffer.from(`${json.slice(0, -1)} ]`);
  const out = Buffer.concat([rec.subarray(0, bAt), next, rec.subarray(bAt + bLen)]);
  out.writeUInt32LE(next.length, 244);
  return out;
}

function patchShareBatch(rec) {
  const aLen = rec.readUInt32LE(240);
  const bLen = rec.readUInt32LE(244);
  const tLen = rec.readUInt32LE(248);
  const sLenAt = 252 + aLen + bLen + tLen;
  const sLen = rec.readUInt32LE(sLenAt);
  const sEnd = sLenAt + 4 + sLen;
  const out = Buffer.concat([rec.subarray(0, sEnd), Buffer.from([0x00]), rec.subarray(sEnd)]);
  out.writeUInt32LE(sLen + 1, sLenAt);
  return out;
}

function patchHashSpill(rec) {
  const body = packSpillBytes([]);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(body.length, 0);
  return Buffer.concat([rec, n, body]);
}

function patchBLeavesPruned(rec) {
  const out = Buffer.from(rec);
  const flags = out.readUInt32LE(228);
  assert.equal(flags & 2, 0, 'prefix leaf flag starts clear');
  out.writeUInt32LE(flags | 2, 228);
  return out;
}

function patchSpendIds(rec) {
  const block = unpackEpochBlock(rec);
  assert.ok(Array.isArray(block.bSpendIds));
  assert.equal(block.bSpendIds.length, 0);
  delete block.bSpendIds;
  return packEpochBlock(block);
}

describe('v12 snap binds every packed prefix field', () => {
  it('a torn snap, a mismatched vault, and a crash between the two files replay', () => {
    const dir = freshDir('shear-snap-bind-');
    const dest = minerDest();
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    assert.equal(grow(store, dest, 2, 10).ok, true);
    const snap2 = fs.readFileSync(path.join(dir, 'book.snap'));
    const vaultSnap2 = fs.readFileSync(path.join(dir, 'vault.snap'));
    const reserve2 = fs.readFileSync(path.join(dir, 'reserve.json'));
    const decoded2 = readSnap(dir);
    assert.equal(decoded2.height, 2);
    assert.equal(grow(store, dest, 2, 30).ok, true);
    const honest = viewOf(store);
    assert.equal(store.tip().height, 4);

    const lagged = cloneDir(dir);
    fs.writeFileSync(path.join(lagged, 'book.snap'), snap2);
    fs.writeFileSync(path.join(lagged, 'vault.snap'), vaultSnap2);
    const suffix = createStore(lagged, { pruneAfter: 1_000_000 });
    assert.equal(suffix.loadMode, 'suffix', suffix.loadMode);
    assert.deepEqual(viewOf(suffix), honest);

    const tornDir = cloneDir(dir);
    const tornPath = path.join(tornDir, 'book.snap');
    const tornRaw = fs.readFileSync(tornPath);
    tornRaw[tornRaw.length - 1] ^= 0xff;
    fs.writeFileSync(tornPath, tornRaw);
    const torn = createStore(tornDir, { pruneAfter: 1_000_000 });
    assert.equal(torn.loadMode, 'full');
    assert.deepEqual(viewOf(torn), honest);

    const lagDir = cloneDir(dir);
    fs.writeFileSync(path.join(lagDir, 'book.snap'), snap2);
    fs.writeFileSync(path.join(lagDir, 'reserve.json'), reserve2);
    const laggedBad = createStore(lagDir, { pruneAfter: 1_000_000 });
    assert.equal(laggedBad.loadMode, 'full', laggedBad.loadMode);
    assert.deepEqual(viewOf(laggedBad), honest);

    const crashDir = cloneDir(dir);
    fs.writeFileSync(path.join(crashDir, 'vault.snap'), vaultSnap2);
    const crashed = createStore(crashDir, { pruneAfter: 1_000_000 });
    assert.equal(crashed.loadMode, 'full', crashed.loadMode);
    assert.deepEqual(viewOf(crashed), honest);
  });

  it('a change to each prefix field that the stable tag used to skip forces a full load', () => {
    const dir = freshDir('shear-snap-field-');
    const dest = minerDest();
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    assert.equal(grow(store, dest, 2, 50).ok, true);
    const snap2 = fs.readFileSync(path.join(dir, 'book.snap'));
    const vaultSnap2 = fs.readFileSync(path.join(dir, 'vault.snap'));
    assert.equal(grow(store, dest, 2, 70).ok, true);
    const honest = viewOf(store);
    const cases = [
      ['bLeaves', patchBLeaves, (block) => assert.ok(Array.isArray(block.bLeaves))],
      ['bLeavesPruned', patchBLeavesPruned, (block) => assert.equal(block.bLeavesPruned, true)],
      ['bSpendIds', patchSpendIds, (block) => assert.equal(Object.prototype.hasOwnProperty.call(block, 'bSpendIds'), false)],
      ['hashSpill', patchHashSpill, (block) => assert.deepEqual(block.hashSpill, [])],
      ['shareBatch', patchShareBatch, (block) => assert.ok(Array.isArray(block.shareBatch))],
    ];
    for (const [name, patch, check] of cases) {
      const copy = cloneDir(dir);
      fs.writeFileSync(path.join(copy, 'book.snap'), snap2);
      fs.writeFileSync(path.join(copy, 'vault.snap'), vaultSnap2);
      const unpacked = patchPrefix(copy, 0, patch);
      check(unpacked);
      const loaded = createStore(copy, { pruneAfter: 1_000_000 });
      assert.equal(loaded.loadMode, 'full', name);
      assert.deepEqual(viewOf(loaded), honest, name);
    }
  });

  it('a reorg below the snap height does not keep the old prefix snap', async () => {
    const dir = freshDir('shear-snap-reorg-');
    const dest = minerDest();
    const store = createStore(dir, { pruneAfter: 1_000_000 });
    const built = grow(store, dest, 36, 100);
    assert.equal(built.ok, true, built.reason);
    const sealed = readSnap(dir);
    assert.equal(sealed.height, 32);
    assert.ok(sealed.height < store.tip().height);
    const oldSnap = fs.readFileSync(path.join(dir, 'book.snap'));
    const oldVaultSnap = fs.readFileSync(path.join(dir, 'vault.snap'));
    const parent = 20;
    assert.ok(parent < sealed.height - 1);
    const fork = heavierFork(store, dest, parent, 18, 9_000);
    const candidate = store.blocks.slice(0, parent + 1).concat(fork);
    assert.equal(shouldAdopt(store.blocks, candidate), true);
    const got = await Promise.resolve(store.ingest(fork, { trustBlockHash: true }));
    assert.equal(got.ok, true, got.reason);
    assert.equal(store.tip().height, parent + 1 + fork.length);
    const after = viewOf(store);
    assert.notEqual(after.tip, Buffer.from(candidate[parent].hash).toString('hex'));

    const reloaded = createStore(cloneDir(dir), { pruneAfter: 1_000_000 });
    assert.notEqual(reloaded.loadMode, 'full', reloaded.loadMode);
    assert.deepEqual(viewOf(reloaded), after);

    const staleDir = cloneDir(dir);
    fs.writeFileSync(path.join(staleDir, 'book.snap'), oldSnap);
    fs.writeFileSync(path.join(staleDir, 'vault.snap'), oldVaultSnap);
    const stale = createStore(staleDir, { pruneAfter: 1_000_000 });
    assert.equal(stale.loadMode, 'full', stale.loadMode);
    assert.deepEqual(viewOf(stale), after);
  });
});
