/**
 * Own-install restart uses book.snap. A foreign book and a bad snap do not.
 * Times below are whatever this machine measured. A length that is not
 * built is not claimed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash20FromAddress, newIdentity } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
} from '../../crypto/asert.js';
import { applyBlockToFluxset, emptyFluxset } from '../../crypto/admit.js';
import { writeChainBin, readChainBin } from '../../crypto/chainbin.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { potSubsidyAt } from '../../crypto/pot_sched.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import {
  aLeavesFromShares,
  nonceWithShareTarget,
  noteCommitOfShare,
} from '../../crypto/share_batch.js';
import { potPaysFromLeaves } from '../src/chain.js';
import { decodeBookSnap, frameDigest } from '../src/book_snap.js';
import { bookSealKeyFor, bookSealKeyPath } from '../src/book_seal_key.js';
import {
  GENESIS_PREV,
  buildTemplate,
  canonicalCarry,
  chainLoadSeal,
  digestTx,
  verifyLoadedChainAsync,
} from '../src/chain.js';
import { createStore } from '../src/store.js';
import { auditCirculatingSupply } from '../src/supply.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-snap-keys-'));
process.env.SHEAR_SEAL_KEY_DIR = keyDir;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

let tagN = 1;
function tagHash() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(tagN, 4);
  tagN += 1;
  assert.equal(meetsTarget(h, GENESIS_BITS_PACKED), true);
  return h;
}

function restamp(block) {
  const decoded = decodeHeader(Buffer.from(block.header));
  const txs = block.txs || [];
  return {
    ...block,
    header: encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: merkleRoot(txs.map(digestTx)),
      continuityRoot: decoded.continuityRoot,
      timestamp: Number(decoded.timestamp),
      bits: decoded.bits,
      nonce: decoded.nonce,
      baseFee: decoded.baseFee,
    }),
  };
}

function sealBook(dir, blocks) {
  const bin = path.join(dir, 'chain.bin');
  writeChainBin(bin, blocks);
  const stamped = readChainBin(bin).map(restamp);
  writeChainBin(bin, stamped);
  const key = bookSealKeyFor(dir);
  fs.writeFileSync(path.join(dir, 'book.seal'), `${chainLoadSeal(stamped, key)}\n`);
  return stamped;
}

function potCount(block) {
  return (block?.txs?.[0]?.vout || []).filter((o) => o && o.kind === 'pot').length;
}

function supplyOf(blocks) {
  const got = auditCirculatingSupply(blocks);
  assert.equal(got.status, 'verified', got.reason || 'supply');
  return got.circulatingNanos;
}

function buildCoinbaseBook(n, noteCount, t0) {
  const dests = Array.from({ length: Math.max(1, noteCount) }, () => minerDest());
  const chain = [];
  let prevHash = GENESIS_PREV;
  let prevHeader = null;
  let flux = emptyFluxset();
  for (let h = 1; h <= n; h += 1) {
    const now = t0 + (h - 1) * TARGET_BLOCK_INTERVAL_MS;
    const genesisMs = h === 1 ? now : Number(decodeHeader(Buffer.from(chain[0].header)).timestamp);
    const subsidy = potSubsidyAt({ nowMs: now, genesisMs, magic: MAGIC_TESTNET });
    const potShares = [];
    let used = 0;
    const count = Math.max(1, noteCount);
    const base = Math.floor(subsidy / count);
    for (let i = 0; i < count; i += 1) {
      const nanos = i === count - 1 ? subsidy - used : base;
      used += nanos;
      potShares.push({ address: dests[i % dests.length], nanos, kind: 'pot' });
    }
    assert.equal(used, subsidy);
    const tpl = buildTemplate({
      prev: prevHash,
      prevHeader,
      prevBlock: chain[chain.length - 1] || null,
      height: h,
      miner: dests[0],
      now,
      bits: GENESIS_BITS_PACKED,
      potShares,
      parentFluxset: flux.pubs,
      parentBlocks: chain.length ? [chain[0]] : null,
    });
    const block = {
      header: tpl.header,
      txs: tpl.txs,
      shareBatch: tpl.shareBatch || [],
      hashCredits: tpl.hashCredits,
      miner: dests[0],
      height: h,
      hash: tagHash(),
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
      samples: tpl.samples,
    };
    assert.equal(potCount(block), count);
    chain.push(block);
    flux = applyBlockToFluxset(flux, block);
    prevHash = block.hash;
    prevHeader = tpl.header;
  }
  return chain;
}

function loadPair(blocks) {
  const dir = tmp('shear-snap-len-');
  sealBook(dir, blocks);
  const fullT = performance.now();
  const first = createStore(dir);
  const fullMs = performance.now() - fullT;
  assert.equal(first.loadMode, 'full');
  assert.equal(first.tip().height, blocks.length);
  const before = supplyOf(first.blocks);
  const snapT = performance.now();
  const second = createStore(dir);
  const snapMs = performance.now() - snapT;
  assert.equal(second.loadMode, 'snap', `reload ${blocks.length} was ${second.loadMode}`);
  assert.equal(second.tip().height, blocks.length);
  assert.equal(Buffer.from(second.tip().hash).toString('hex'), Buffer.from(first.tip().hash).toString('hex'));
  assert.equal(supplyOf(second.blocks), before);
  assert.ok(snapMs < TARGET_BLOCK_INTERVAL_MS, `snap ${snapMs}ms`);
  return { dir, first, second, fullMs, snapMs };
}

function shareRow(dest, low, bits, slot = 0) {
  const row = {
    dest,
    nonce: nonceWithShareTarget(BigInt(low), bits),
    lz: bits,
    shareBits: bits,
    creditedShareBits: bits,
    proofSlot: slot,
  };
  row.noteCommit = Buffer.from(noteCommitOfShare(row));
  return row;
}

function legacySeal(blocks, key) {
  const h = createHash('sha256');
  h.update(key);
  for (const b of blocks) {
    const header = Buffer.from(b.header);
    const hash = Buffer.from(b.hash);
    const n = Buffer.alloc(8);
    n.writeUInt32LE(header.length >>> 0, 0);
    n.writeUInt32LE(hash.length >>> 0, 4);
    h.update(n);
    h.update(header);
    h.update(hash);
  }
  return h.digest('hex');
}

describe('v12 own-install snapshot', () => {
  it('reloads an own book from the snap and extends it', () => {
    const dest = minerDest();
    const dir = tmp('shear-snap-own-');
    const live = createStore(dir);
    const t0 = 1_700_000_000_000;
    const { tpl } = live.template({ miner: dest, now: t0 });
    const got = live.append({
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
      hashCredits: tpl.hashCredits,
    }, { trustedPowHash: tagHash(), skipSharePow: true });
    assert.equal(got.ok, true, got.reason || 'append');
    assert.equal(fs.existsSync(path.join(dir, 'book.snap')), true);
    const tip = Buffer.from(live.tip().hash).toString('hex');
    const before = supplyOf(live.blocks);
    const again = createStore(dir);
    assert.equal(again.loadMode, 'snap');
    assert.equal(Buffer.from(again.tip().hash).toString('hex'), tip);
    assert.equal(supplyOf(again.blocks), before);
    const built = again.template({ miner: dest, now: t0 + TARGET_BLOCK_INTERVAL_MS });
    const next = again.append({
      header: built.tpl.header,
      txs: built.tpl.txs,
      samples: built.tpl.samples,
      shareBatch: built.tpl.shareBatch || [],
      miner: dest,
      aLeaves: built.tpl.aLeaves,
      bLeaves: built.tpl.bLeaves,
      rootA: built.tpl.rootA,
      rootB: built.tpl.rootB,
      weight: built.tpl.weight,
      hashCredits: built.tpl.hashCredits,
    }, { trustedPowHash: tagHash(), skipSharePow: true });
    assert.equal(next.ok, true, next.reason || 'extend');
    const third = createStore(dir);
    assert.equal(third.loadMode, 'snap');
    assert.equal(third.tip().height, 2);
    assert.equal(supplyOf(third.blocks), supplyOf(again.blocks));
  });

  it('replays only the suffix when the snap is an earlier height of this book', () => {
    const dest = minerDest();
    const dir = tmp('shear-snap-suffix-');
    const live = createStore(dir);
    const t0 = 1_700_000_000_000;
    const sealAt = (when) => {
      const { tpl } = live.template({ miner: dest, now: when });
      const got = live.append({
        header: tpl.header,
        txs: tpl.txs,
        samples: tpl.samples,
        shareBatch: [],
        miner: dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        weight: tpl.weight,
        hashCredits: tpl.hashCredits,
      }, { trustedPowHash: tagHash(), skipSharePow: true });
      assert.equal(got.ok, true, got.reason || 'append');
    };
    sealAt(t0);
    sealAt(t0 + TARGET_BLOCK_INTERVAL_MS);
    const snap2 = fs.readFileSync(path.join(dir, 'book.snap'));
    const vault2 = fs.readFileSync(path.join(dir, 'reserve.json'));
    const key = bookSealKeyFor(dir);
    const decoded = decodeBookSnap(snap2, key);
    assert.ok(decoded);
    assert.equal(decoded.height, 2);
    assert.equal(decoded.frameDigest, frameDigest(live.blocks.slice(0, 2)));
    sealAt(t0 + 2 * TARGET_BLOCK_INTERVAL_MS);
    assert.equal(frameDigest(live.blocks.slice(0, 2)), decoded.frameDigest);
    const tip = Buffer.from(live.tip().hash).toString('hex');
    const before = supplyOf(live.blocks);
    assert.equal(live.tip().height, 3);
    fs.writeFileSync(path.join(dir, 'book.snap'), snap2);
    fs.writeFileSync(path.join(dir, 'reserve.json'), vault2);
    const loaded = createStore(dir);
    assert.equal(loaded.loadMode, 'suffix', loaded.loadMode);
    assert.equal(loaded.tip().height, 3);
    assert.equal(Buffer.from(loaded.tip().hash).toString('hex'), tip);
    assert.equal(supplyOf(loaded.blocks), before);
  });

  it('does not trust a tampered snap, another install, or a pre-domain seal', () => {
    const blocks = buildCoinbaseBook(1, 1, 1_700_000_000_000);
    const { dir, first } = loadPair(blocks);
    const tip = Buffer.from(first.tip().hash).toString('hex');
    const before = supplyOf(first.blocks);
    const snapPath = path.join(dir, 'book.snap');
    const good = fs.readFileSync(snapPath);
    const torn = Buffer.from(good);
    torn[torn.length - 1] ^= 0xff;
    fs.writeFileSync(snapPath, torn);
    const repaired = createStore(dir);
    assert.equal(repaired.loadMode, 'full');
    assert.equal(Buffer.from(repaired.tip().hash).toString('hex'), tip);
    assert.equal(supplyOf(repaired.blocks), before);
    const after = createStore(dir);
    assert.equal(after.loadMode, 'snap');

    const foreign = tmp('shear-snap-foreign-');
    fs.copyFileSync(path.join(dir, 'chain.bin'), path.join(foreign, 'chain.bin'));
    fs.copyFileSync(path.join(dir, 'book.seal'), path.join(foreign, 'book.seal'));
    fs.copyFileSync(path.join(dir, 'book.snap'), path.join(foreign, 'book.snap'));
    assert.throws(() => createStore(foreign), /pow/);

    const moved = tmp('shear-snap-moved-');
    fs.copyFileSync(path.join(dir, 'chain.bin'), path.join(moved, 'chain.bin'));
    fs.copyFileSync(path.join(dir, 'book.seal'), path.join(moved, 'book.seal'));
    fs.copyFileSync(path.join(dir, 'book.snap'), path.join(moved, 'book.snap'));
    fs.copyFileSync(path.join(dir, 'reserve.json'), path.join(moved, 'reserve.json'));
    fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(moved));
    const sameKey = createStore(moved);
    assert.equal(sameKey.loadMode, 'snap');
    assert.equal(Buffer.from(sameKey.tip().hash).toString('hex'), tip);
    assert.equal(supplyOf(sameKey.blocks), before);

    const staleDir = tmp('shear-snap-stale-');
    const other = buildCoinbaseBook(1, 1, 1_700_000_000_000 + 50_000);
    sealBook(staleDir, other);
    createStore(staleDir);
    const staleTip = Buffer.from(createStore(staleDir).tip().hash).toString('hex');
    fs.copyFileSync(path.join(dir, 'book.snap'), path.join(staleDir, 'book.snap'));
    const refused = createStore(staleDir);
    assert.equal(refused.loadMode, 'full');
    assert.equal(Buffer.from(refused.tip().hash).toString('hex'), staleTip);
    assert.notEqual(staleTip, tip);

    const legacyDir = tmp('shear-snap-legacy-');
    const stamped = sealBook(legacyDir, buildCoinbaseBook(1, 1, 1_700_000_000_000 + 90_000));
    const key = bookSealKeyFor(legacyDir);
    const modern = chainLoadSeal(stamped, key);
    const old = legacySeal(stamped, key);
    assert.notEqual(old, modern);
    const sealPath = path.join(legacyDir, 'book.seal');
    fs.writeFileSync(sealPath, `${old}\n`);
    const beforeBytes = fs.readFileSync(sealPath);
    assert.throws(() => createStore(legacyDir), /pow/);
    assert.equal(fs.existsSync(path.join(legacyDir, 'reserve.json')), false);
    assert.deepEqual(fs.readFileSync(sealPath), beforeBytes);
  });

  it('keeps 1, 3, and 17 pot notes, and 1, 3, and 17 hash notes, on a snap reload', () => {
    const t0 = 1_700_000_000_000;
    for (const count of [1, 3, 17]) {
      const blocks = buildCoinbaseBook(1, count, t0 + count * 1000);
      const loaded = loadPair(blocks);
      assert.equal(potCount(loaded.second.tip()), count);
    }
    for (const count of [1, 3, 17]) {
      const genesisWhen = 1_700_000_000_000 - 400_000;
      const genesis = buildCoinbaseBook(1, 1, genesisWhen)[0];
      const rows = Array.from({ length: count }, (_, i) => shareRow(minerDest(), i + 1, SHARE_FLOOR_BITS, 0));
      const when = genesisWhen + TARGET_BLOCK_INTERVAL_MS;
      const genesisDecoded = decodeHeader(Buffer.from(genesis.header));
      const subsidy = potSubsidyAt({
        nowMs: when,
        genesisMs: Number(genesisDecoded.timestamp),
        magic: MAGIC_TESTNET,
      });
      const carry = canonicalCarry(genesis.txs[0]) || 0;
      const leaves = aLeavesFromShares(rows);
      const rawPays = potPaysFromLeaves(leaves, null, 0, subsidy, carry);
      const destByNc = new Map();
      for (const row of rows) destByNc.set(Buffer.from(row.noteCommit).toString('hex'), row.dest);
      const pays = rawPays.map((p) => ({
        ...p,
        address: destByNc.get(Buffer.from(p.noteCommit).toString('hex')) || '',
      })).filter((p) => p.nanos > 0 && p.address);
      const quote = asertNextBits({
        anchorBits: genesisDecoded.bits,
        anchorTimeMs: Number(genesisDecoded.timestamp),
        anchorHeight: 1,
        blockTimeMs: when,
        blockHeight: 2,
        parentTimeMs: Number(genesisDecoded.timestamp),
      });
      assert.equal(quote.ok, true, quote.reason || 'asert');
      const tpl = buildTemplate({
        prev: genesis.hash,
        prevHeader: genesis.header,
        prevBlock: genesis,
        height: 2,
        miner: rows[0].dest,
        bits: quote.packed,
        now: when,
        potShares: pays,
        shareBatch: rows,
        parentBlocks: [genesis],
      });
      const child = {
        header: Buffer.from(tpl.header),
        txs: tpl.txs,
        shareBatch: (tpl.shareBatch || []).map((s) => ({ ...s })),
        miner: rows[0].dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        weight: tpl.weight,
        hashCredits: tpl.hashCredits,
        hash: tagHash(),
        height: 2,
      };
      assert.equal((child.shareBatch || []).length, count);
      const loaded = loadPair([genesis, child]);
      assert.equal((loaded.second.blocks[1].shareBatch || []).length, count);
      const hashNotes = (loaded.second.blocks[1].txs[0].vout || []).filter((o) => o && o.kind === 'hash');
      assert.equal(hashNotes.length, count);
    }
  });

  it('yields during a foreign body replay', async () => {
    const built = buildCoinbaseBook(4, 1, 1_700_000_000_000);
    const diskDir = tmp('shear-snap-yield-');
    sealBook(diskDir, built);
    const blocks = readChainBin(path.join(diskDir, 'chain.bin'));
    const heights = [];
    let turns = 0;
    let stop = false;
    const spin = () => {
      if (stop) return;
      turns += 1;
      setImmediate(spin);
    };
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, enc, cb) => {
      lines.push(String(chunk));
      return orig(chunk, enc, cb);
    };
    setImmediate(spin);
    try {
      const got = await verifyLoadedChainAsync(blocks, {
        trustStoredHash: true,
        onProgress: (p) => heights.push(p.height),
      });
      assert.equal(got.ok, true, got.reason || 'replay');
    } finally {
      stop = true;
      process.stderr.write = orig;
    }
    assert.ok(turns >= 2, `turns ${turns}`);
    assert.deepEqual(heights, [1, 2, 3, 4]);
    assert.ok(lines.some((l) => l.includes('book-replay 1/4')));
    assert.ok(lines.some((l) => l.includes('book-replay 4/4')));
  });

  it('snap reload stays under one target interval at every length this host finished', () => {
    const t0 = 1_700_000_000_000;
    const measured = [];
    const budgetMs = 180_000;
    const started = performance.now();
    const wanted = [1, 16, 64, 256, 1000, 2880, 8640];
    for (const n of wanted) {
      if (measured.length) {
        const prev = measured[measured.length - 1];
        const rate = prev.fullMs / prev.n;
        const projected = rate * n;
        const left = budgetMs - (performance.now() - started);
        if (projected > left) {
          console.log(`snap-open length ${n} projected ${Math.round(projected)}ms rate ${rate.toFixed(1)} ms/block`);
          break;
        }
      }
      const built = buildCoinbaseBook(n, 1, t0 + n);
      const row = loadPair(built);
      measured.push({ n, fullMs: Math.round(row.fullMs), snapMs: Math.round(row.snapMs) });
      console.log(`snap-time ${JSON.stringify(measured[measured.length - 1])}`);
    }
    assert.ok(measured.length >= 2, JSON.stringify(measured));
    for (let i = 1; i < measured.length; i += 1) {
      const a = measured[i - 1];
      const b = measured[i];
      assert.ok(b.snapMs < TARGET_BLOCK_INTERVAL_MS);
      assert.ok(
        b.snapMs < a.snapMs * (b.n / a.n) * 4,
        `snap grew faster than the chain ${JSON.stringify(measured)}`,
      );
    }
    console.log(`snap-measured ${JSON.stringify(measured)}`);
  });
});
