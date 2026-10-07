import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import { GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { writeChainBin, readChainBin } from '../../crypto/chainbin.js';
import { setHashBackend, shearHash, meetsTarget } from '../../crypto/shear_hash.js';
import { createStore } from '../src/store.js';
import {
  buildTemplate,
  retarget,
  GENESIS_PREV,
  verifyLoadedChain,
  pruneSamples,
} from '../src/chain.js';
import { writeLatestBootstrap, applyLatestBootstrap, latestPaths } from '../src/bootstrap.js';
import { auditCirculatingSupply } from '../src/supply.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

function tipHex(store) {
  return Buffer.from(store.tip().hash).toString('hex');
}

function cloneBlocks(blocks) {
  return blocks.map((b) => ({
    ...b,
    header: Buffer.from(b.header),
    hash: Buffer.from(b.hash),
    txs: (b.txs || []).map((tx) => ({
      ...tx,
      vin: (tx.vin || []).map((v) => ({ ...v })),
      vout: (tx.vout || []).map((o) => ({ ...o })),
    })),
    bSpendIds: Array.isArray(b.bSpendIds) ? b.bSpendIds.slice() : b.bSpendIds,
  }));
}

function loadForeign(blocks) {
  const dir = tmp('shear-loadv-');
  writeChainBin(path.join(dir, 'chain.bin'), blocks);
  return { dir, store: createStore(dir) };
}

const progressPath = path.join(os.tmpdir(), 'shear-load-verify-progress.txt');
const powChild = path.join(path.dirname(fileURLToPath(import.meta.url)), 'load_verify_pow_child.js');

function mineHeader(tpl) {
  const t0 = Date.now();
  fs.appendFileSync(progressPath, `mine height ${tpl.height} bits ${tpl.bits}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      powChild,
      Buffer.from(tpl.header).toString('hex'),
      String(tpl.bits),
      '4000000',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      fs.appendFileSync(progressPath, `height ${tpl.height} ${chunk.toString()}`);
    });
    child.on('error', reject);
    child.on('exit', () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
      let parsed = null;
      try { parsed = JSON.parse(line || ''); } catch { parsed = null; }
      if (!parsed?.ok) {
        resolve(null);
        return;
      }
      const header = setNonce(tpl.header, BigInt(parsed.nonce));
      const hash = shearHash(header);
      const hex = Buffer.from(hash).toString('hex');
      if (!meetsTarget(hash, tpl.bits) || hex !== parsed.hash) {
        reject(new Error(`height ${tpl.height} jit-full hit failed the light ShearHash check`));
        return;
      }
      fs.appendFileSync(
        progressPath,
        `height ${tpl.height} nonce ${parsed.nonce} ms ${Date.now() - t0}\n`,
      );
      resolve({ header, hash, nonce: BigInt(parsed.nonce), block: true });
    });
  });
}

function expectForeign(blocks, re) {
  const dir = tmp('shear-loadv-bad-');
  writeChainBin(path.join(dir, 'chain.bin'), blocks);
  assert.throws(() => createStore(dir), re);
  assert.equal(fs.existsSync(path.join(dir, 'reserve.json')), false);
  return dir;
}

describe('foreign chain load names a reason before the vault boots', () => {
  it('an empty book loads, and a header this node did not seal fails closed', () => {
    const empty = createStore(tmp('shear-loadv-empty-'));
    assert.equal(empty.tip(), null);
    assert.equal(verifyLoadedChain([]).ok, true);
    assert.equal(verifyLoadedChain([{}]).reason, 'no_header');
    assert.equal(verifyLoadedChain([{ header: Buffer.alloc(10) }]).reason, 'bad_header');

    const dir = tmp('shear-loadv-fake-');
    writeChainBin(path.join(dir, 'chain.bin'), [{
      height: 1,
      hash: Buffer.alloc(32, 1),
      header: Buffer.alloc(128, 1),
      txs: [{ coinbase: true, vout: [{ kind: 'pot' }] }],
    }]);
    assert.throws(() => createStore(dir), /prev/);
    assert.equal(fs.existsSync(path.join(dir, 'reserve.json')), false);
  });
});

describe('a real ShearHash chain is the only foreign book that loads', () => {
  it('checks merkle, prev, and header work before spend restore', { timeout: 3_600_000 }, async () => {
    fs.writeFileSync(progressPath, `start ${Date.now()}\n`);
    const dest = minerDest();
    const dir = tmp('shear-loadv-mine-');
    const store = createStore(dir);
    const mined = [];
    for (let n = 0; n < 3; n += 1) {
      const tip = store.tip();
      const now = tip
        ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) + TARGET_BLOCK_INTERVAL_MS
        : 1_700_000_000_000;
      const bits = retarget(store.blocks, now);
      const tpl = buildTemplate({
        prev: tip ? tip.hash : GENESIS_PREV,
        prevHeader: tip ? tip.header : null,
        prevBlock: tip,
        parentWeight: tip ? tip.weight : 1,
        height: tip ? tip.height + 1 : 1,
        miner: dest,
        now,
        bits,
        parentBlocks: store.blocks,
      });
      const hit = await mineHeader(tpl);
      assert.ok(hit?.block, `height ${tpl.height} had no ShearHash under the cap`);
      const got = store.append({
        header: hit.header,
        txs: tpl.txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        weight: tpl.weight,
      }, { trustedPowHash: hit.hash, skipSharePow: true });
      assert.equal(got.ok, true, got.reason);
      assert.ok(shearHash(got.block.header).equals(Buffer.from(got.block.hash)));
      mined.push(got.block);
    }
    assert.equal(store.tip().height, 3);
    const honestTip = tipHex(store);

    const sealed = createStore(dir);
    assert.equal(tipHex(sealed), honestTip);

    fs.rmSync(path.join(dir, 'book.seal'));
    const resealed = createStore(dir);
    assert.equal(tipHex(resealed), honestTip);

    const lengths = [1, 2, 3];
    for (const n of lengths) {
      const prefix = loadForeign(mined.slice(0, n));
      assert.equal(prefix.store.tip().height, n);
      assert.equal(tipHex(prefix.store), Buffer.from(mined[n - 1].hash).toString('hex'));
    }

    const foreign = loadForeign(mined);
    assert.equal(tipHex(foreign.store), honestTip);
    const supplyMine = auditCirculatingSupply(store.blocks);
    const supplyForeign = auditCirculatingSupply(foreign.store.blocks);
    assert.equal(supplyMine.status, 'verified', supplyMine.reason);
    assert.equal(supplyForeign.status, 'verified', supplyForeign.reason);
    assert.equal(supplyForeign.circulatingNanos, supplyMine.circulatingNanos);
    assert.equal(foreign.store.spentB.size, 0);

    const bare = cloneBlocks(mined);
    for (const b of bare) delete b.bSpendIds;
    const bareStore = loadForeign(bare).store;
    assert.equal(tipHex(bareStore), honestTip);
    assert.equal(bareStore.spentB.size, 0);

    const oneId = cloneBlocks(mined);
    oneId[0].bSpendIds = ['aa'.repeat(32)];
    expectForeign(oneId, /spent_checkpoint_mismatch/);
    const several = cloneBlocks(mined);
    several[1].bSpendIds = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
    expectForeign(several, /spent_checkpoint_mismatch/);

    const amount = cloneBlocks(mined);
    amount[0].txs[0].vout[0].kind = `${amount[0].txs[0].vout[0].kind || 'pot'}-tamper`;
    expectForeign(amount, /merkle/);
    const swapped = cloneBlocks(mined);
    const marked = swapped[1].txs[0];
    marked.vout = (marked.vout || []).map((o, i) => (
      i === 0 ? { ...o, kind: `${o.kind || 'pot'}-swap` } : o
    ));
    const txs0 = swapped[0].txs;
    swapped[0].txs = swapped[1].txs;
    swapped[1].txs = txs0;
    expectForeign(swapped, /merkle/);
    const added = cloneBlocks(mined);
    added[2].txs = added[2].txs.concat([{ coinbase: false, kind: 'flow', vout: [] }]);
    expectForeign(added, /merkle/);

    const prev = cloneBlocks(mined);
    prev[1].header[4] ^= 0xff;
    expectForeign(prev, /prev/);
    const unlinked = [mined[0], mined[2]];
    expectForeign(unlinked, /prev/);

    const stamped = cloneBlocks(mined);
    stamped[2].header.set(stamped[1].header.subarray(100, 108), 100);
    expectForeign(stamped, /timestamp/);

    const noCoinbase = cloneBlocks(mined);
    noCoinbase[0].txs = [{ kind: 'flow', vout: [{ kind: 'pot' }] }];
    expectForeign(noCoinbase, /coinbase/);

    const parent = mined[0];
    const early = Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 1;
    const badTpl = buildTemplate({
      prev: parent.hash,
      prevHeader: parent.header,
      prevBlock: parent,
      height: 2,
      miner: dest,
      now: early,
      bits: GENESIS_BITS_PACKED,
      parentBlocks: [parent],
    });
    const badHit = await mineHeader(badTpl);
    assert.ok(badHit?.block, 'easy-bits header had no ShearHash under the cap');
    expectForeign([
      parent,
      {
        header: badHit.header,
        hash: badHit.hash,
        height: 2,
        txs: badTpl.txs,
        rootA: badTpl.rootA,
        rootB: badTpl.rootB,
        aLeaves: badTpl.aLeaves,
        bLeaves: badTpl.bLeaves,
        weight: badTpl.weight,
      },
    ], /bits/);

    const pruned = mined.map((b) => pruneSamples(b));
    const src = tmp('shear-loadv-boot-');
    const manifest = writeLatestBootstrap(src, pruned, { pruneDepth: 0 });
    assert.ok(manifest);
    assert.equal(manifest.height, 3);
    const appliedDir = tmp('shear-loadv-applied-');
    const applied = applyLatestBootstrap(appliedDir, src);
    assert.equal(applied.height, 3);
    const installed = createStore(appliedDir);
    assert.equal(tipHex(installed), honestTip);
    assert.equal(auditCirculatingSupply(installed.blocks).status, 'verified');

    const tamperDir = tmp('shear-loadv-tamper-boot-');
    const paths = latestPaths(src);
    fs.cpSync(paths.dir, latestPaths(tamperDir).dir, { recursive: true });
    const body = readChainBin(latestPaths(tamperDir).bin);
    body[0].txs[0].vout[0].kind = `${body[0].txs[0].vout[0].kind || 'pot'}-tamper`;
    writeChainBin(latestPaths(tamperDir).bin, body);
    const refused = tmp('shear-loadv-refused-');
    assert.throws(() => applyLatestBootstrap(refused, tamperDir), /merkle/);
    assert.equal(fs.existsSync(path.join(refused, 'chain.bin')), false);
    assert.equal(fs.existsSync(path.join(refused, 'reserve.json')), false);
  });
});
