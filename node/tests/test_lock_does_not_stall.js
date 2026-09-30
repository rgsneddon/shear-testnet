import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import { retarget, buildTemplate, GENESIS_PREV } from '../src/chain.js';
import {
  GENESIS_BITS_PACKED,
  SPENDABLE_CONFIRMATIONS,
  NANOS_PER_SHE,
  TARGET_BLOCK_INTERVAL_MS,
  nextBits,
  medianIntervalMs,
} from '../../crypto/asert.js';
import { lockTx } from '../../crypto/reserve_vault.js';
import { newIdentity, destOpeningFromView, ed25519SeedOf, freshStealthDest } from '../../crypto/address.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { matureSpendableNanos, signSpendTx } from '../../crypto/spend.js';
import { bindWeightFee } from '../../crypto/levy.js';
import { meetsTarget, shearHash } from '../../crypto/shear_hash.js';

const workerPath = fileURLToPath(new URL('./lock_mine_worker.js', import.meta.url));
const LIVE_SEALED_BITS = 1_242_688;
const LIVE_PRIOR_JOB_BITS = 1_598_531;
const LIVE_TIP_HEIGHT = 20;
const LIVE_LAST_GAP_MS = 2_088;
const UNDER_20_MIN_MS = 20 * 60 * 1000;

function spendBox(id) {
  const pay = freshStealthDest(id);
  return {
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
  };
}

function tipHeight(store) {
  return Number(store.tip()?.height || 0);
}

function spendableOf(store, dest) {
  const tipH = tipHeight(store);
  return matureSpendableNanos(store.historyFor(dest), dest, tipH);
}

function mempoolHas(store, id) {
  return store.mempool.some((m) => String(m.id) === id);
}

function chainHas(store, id) {
  return store.blocks.some((b) => Array.isArray(b.txs) && b.txs.some((t) => t && String(t.id) === id));
}

function mineHeader(header, bits, { timeoutMs = 8 * 60 * 1000 } = {}) {
  const hex = Buffer.from(header).toString('hex');
  // jit-full loads a 2 GiB dataset per process. Two copies stay in RAM on this host.
  const workers = 2;
  return new Promise((resolve, reject) => {
    const kids = [];
    let settled = false;
    let misses = 0;
    const finish = (err, found) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const kid of kids) {
        try { kid.kill(); } catch { /* gone */ }
      }
      if (err) reject(err);
      else resolve(found);
    };
    const timer = setTimeout(() => finish(new Error('pow_timeout')), timeoutMs);
    for (let w = 0; w < workers; w += 1) {
      const kid = spawn(process.execPath, [workerPath, hex, String(bits), String(w), String(workers)], {
        stdio: ['ignore', 'pipe', 'inherit'],
        windowsHide: true,
      });
      kids.push(kid);
      const rl = createInterface({ input: kid.stdout });
      rl.on('line', (line) => {
        const m = /^FOUND (\d+) ([0-9a-f]{64})/.exec(line.trim());
        if (m) finish(null, { nonce: BigInt(m[1]), hashHex: m[2] });
        else if (line.trim() === 'MISS') {
          misses += 1;
          if (misses >= workers) finish(new Error('pow_exhausted'));
        }
      });
      kid.on('exit', (code) => {
        if (settled) return;
        if (code && code !== 0 && code !== 2) {
          misses += 1;
          if (misses >= workers) finish(new Error('miner_exit'));
        }
      });
    }
  });
}

function installStuckTip(store, miner) {
  const times = new Array(LIVE_TIP_HEIGHT);
  times[LIVE_TIP_HEIGHT - 1] = Date.now() - 5_000;
  for (let i = LIVE_TIP_HEIGHT - 2; i >= 0; i -= 1) {
    const gap = i === LIVE_TIP_HEIGHT - 2 ? LIVE_LAST_GAP_MS : TARGET_BLOCK_INTERVAL_MS;
    times[i] = times[i + 1] - gap;
  }
  let prev = null;
  for (let height = 1; height <= LIVE_TIP_HEIGHT; height += 1) {
    const tpl = buildTemplate({
      prev: prev ? prev.hash : GENESIS_PREV,
      prevHeader: prev ? prev.header : null,
      prevBlock: prev,
      parentWeight: prev ? prev.weight : undefined,
      height,
      miner,
      bits: LIVE_SEALED_BITS,
      now: times[height - 1],
      txs: [],
      parentBlocks: store.blocks,
    });
    const header = Buffer.from(tpl.header);
    const block = {
      header,
      hash: shearHash(header),
      height,
      txs: [],
      weight: tpl.weight,
      miner,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
    };
    store.blocks.push(block);
    prev = block;
  }
  return prev;
}

async function sealTemplate(store, tpl, mineOpts = {}) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  const bits = Number(decoded.bits);
  const network = retarget(store.blocks);
  assert.equal(bits, network, 'header bits are the network curve');
  assert.notEqual(bits, 1, 'caller bits must not undercut the header');
  const t0 = Date.now();
  const found = await mineHeader(tpl.header, bits, mineOpts);
  const header = setNonce(Buffer.from(tpl.header), found.nonce);
  const hash = shearHash(header);
  assert.equal(hash.toString('hex'), found.hashHex);
  assert.equal(meetsTarget(hash, bits), true);
  const got = await store.append({
    header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  });
  assert.equal(got.ok, true, `${got.reason || ''} ${got.error || ''}`);
  console.log(`BLOCK height=${tipHeight(store)} bits=${bits} ms=${Date.now() - t0} hash=${hash.toString('hex')}`);
  return got;
}

async function mineOne(store, dest, { now } = {}) {
  const parent = store.tip();
  const stamp = now != null
    ? now
    : (parent
      ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + TARGET_BLOCK_INTERVAL_MS
      : Date.now());
  const { tpl } = store.template({ miner: dest, bits: 1, shareBits: 8, now: stamp });
  return sealTemplate(store, { ...tpl, miner: dest });
}

describe('reserve lock does not stall the next block', () => {
  it('refuses an unfunded lock, mines past an unmined lock, then includes a funded one', { timeout: 45 * 60 * 1000 }, async () => {
    const oneFast = nextBits(LIVE_SEALED_BITS, 2_000);
    const oneSlow = nextBits(LIVE_SEALED_BITS, 68 * 60 * 1000);
    const held = nextBits(LIVE_SEALED_BITS, medianIntervalMs([2_000]));
    assert.equal(medianIntervalMs([2_000]), TARGET_BLOCK_INTERVAL_MS);
    assert.equal(medianIntervalMs([68 * 60 * 1000]), TARGET_BLOCK_INTERVAL_MS);
    assert.equal(held, nextBits(LIVE_SEALED_BITS, TARGET_BLOCK_INTERVAL_MS));
    assert.equal(nextBits(LIVE_SEALED_BITS, medianIntervalMs([68 * 60 * 1000])), held);
    assert.ok(oneFast > held, `one fast gap jumped to ${oneFast}`);
    const priorJob = nextBits(LIVE_SEALED_BITS, LIVE_LAST_GAP_MS);
    assert.equal(priorJob, LIVE_PRIOR_JOB_BITS);
    assert.equal(held, LIVE_SEALED_BITS);
    console.log(`CURVE sealed=${LIVE_SEALED_BITS} oneFastGap=${oneFast} oneSlowGap=${oneSlow} priorJob=${priorJob} median11=${held}`);

    const alice = newIdentity();
    const aliceBox = spendBox(alice);
    const continuum = aliceBox.dest;
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const stuckDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-stuck-'));
    const stuck = createStore(stuckDir);
    try {
      installStuckTip(stuck, continuum);
      const parent = stuck.tip();
      const parentBits = Number(decodeHeader(Buffer.from(parent.header)).bits);
      assert.equal(tipHeight(stuck), LIVE_TIP_HEIGHT);
      assert.equal(parentBits, LIVE_SEALED_BITS);
      assert.equal(retarget(stuck.blocks), LIVE_SEALED_BITS);
      const bareStuck = lockTx({ from: continuum, to: vault, nanos: NANOS_PER_SHE, id: 'lock-unfunded-stuck' });
      bareStuck.open = open;
      bindWeightFee(bareStuck);
      bareStuck.maxLevy = bareStuck.fee;
      signSpendTx(bareStuck, aliceBox.key);
      const refusedStuck = stuck.queueTx(bareStuck);
      assert.equal(refusedStuck.ok, false);
      assert.equal(refusedStuck.reason, 'insufficient');
      assert.equal(mempoolHas(stuck, 'lock-unfunded-stuck'), false);
      assert.equal(tipHeight(stuck), LIVE_TIP_HEIGHT);
      const { tpl: stuckTpl } = stuck.template({
        miner: continuum,
        bits: 1,
        shareBits: 8,
        now: Date.now(),
      });
      const shippedBits = Number(decodeHeader(Buffer.from(stuckTpl.header)).bits);
      assert.equal(shippedBits, LIVE_SEALED_BITS);
      assert.notEqual(shippedBits, LIVE_PRIOR_JOB_BITS);
      console.log(`STUCK_TIP height=${LIVE_TIP_HEIGHT} sealed=${LIVE_SEALED_BITS} priorJob=${LIVE_PRIOR_JOB_BITS} shippedBits=${shippedBits} workers=2`);
      const minedAt = Date.now();
      await sealTemplate(stuck, { ...stuckTpl, miner: continuum }, { timeoutMs: 19 * 60 * 1000 + 30 * 1000 });
      const advancedMs = Date.now() - minedAt;
      assert.equal(tipHeight(stuck), LIVE_TIP_HEIGHT + 1);
      assert.ok(advancedMs < UNDER_20_MIN_MS, `later block took ${advancedMs}ms`);
      const advanced = decodeHeader(Buffer.from(stuck.tip().header));
      console.log(`TIP_ADVANCED height=${tipHeight(stuck)} bits=${advanced.bits} ms=${advancedMs} hash=${stuck.tip().hash.toString('hex')}`);
    } finally {
      /* the stuck-tip miner is killed when the header is found */
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lock-stall-'));
    const store = createStore(dir);
    const t0 = 1_700_000_000_000;
    try {
      const bare = lockTx({ from: continuum, to: vault, nanos: NANOS_PER_SHE, id: 'lock-unfunded' });
      bare.open = open;
      bindWeightFee(bare);
      bare.maxLevy = bare.fee;
      signSpendTx(bare, aliceBox.key);
      const unfunded = store.queueTx(bare);
      assert.equal(unfunded.ok, false);
      assert.equal(unfunded.reason, 'insufficient');
      assert.equal(mempoolHas(store, 'lock-unfunded'), false);
      const heightAtRefuse = tipHeight(store);
      await mineOne(store, continuum, { now: t0 });
      assert.ok(tipHeight(store) > heightAtRefuse, 'refused lock must not freeze the tip');
      console.log(`TIP_AFTER_REFUSE height=${tipHeight(store)}`);

      let guard = 0;
      while (spendableOf(store, continuum) < NANOS_PER_SHE * 2 && guard < 16) {
        guard += 1;
        await mineOne(store, continuum, { now: t0 + guard * TARGET_BLOCK_INTERVAL_MS });
      }
      const before = spendableOf(store, continuum);
      assert.ok(before >= NANOS_PER_SHE, `spendable ${before}`);
      assert.ok(tipHeight(store) >= SPENDABLE_CONFIRMATIONS, 'funding must clear the confirmation floor');
      const fundedTip = tipHeight(store);

      const unsigned = lockTx({ from: continuum, to: vault, nanos: NANOS_PER_SHE, id: 'lock-unsigned' });
      bindWeightFee(unsigned);
      unsigned.maxLevy = unsigned.fee;
      const unsignedGot = store.queueTx(unsigned);
      assert.equal(unsignedGot.ok, false);
      assert.equal(unsignedGot.reason, 'unsigned');
      assert.equal(tipHeight(store), fundedTip);

      const tooMuch = lockTx({
        from: continuum,
        to: vault,
        nanos: before + NANOS_PER_SHE,
        id: 'lock-too-much',
      });
      tooMuch.open = open;
      bindWeightFee(tooMuch);
      tooMuch.maxLevy = tooMuch.fee;
      signSpendTx(tooMuch, aliceBox.key);
      const refused = store.queueTx(tooMuch);
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'insufficient');
      assert.equal(mempoolHas(store, 'lock-too-much'), false);
      assert.equal(tipHeight(store), fundedTip);
      assert.equal(Number(store.reserveVault.totalLockedNanos), 0);

      const parent = store.tip();
      const stamp = Number(decodeHeader(Buffer.from(parent.header)).timestamp) + TARGET_BLOCK_INTERVAL_MS;
      const pre = store.template({ miner: continuum, bits: 1, shareBits: 8, now: stamp });
      assert.equal(pre.tpl.txs.some((t) => t && t.id === 'lock-funded'), false);

      const lock = lockTx({ from: continuum, to: vault, nanos: NANOS_PER_SHE, id: 'lock-funded' });
      lock.open = open;
      bindWeightFee(lock);
      lock.maxLevy = lock.fee;
      signSpendTx(lock, aliceBox.key);
      const queued = store.queueTx(lock);
      assert.equal(queued.ok, true, queued.reason);
      assert.equal(mempoolHas(store, 'lock-funded'), true);

      await sealTemplate(store, { ...pre.tpl, miner: continuum });
      assert.equal(tipHeight(store), fundedTip + 1);
      assert.equal(chainHas(store, 'lock-funded'), false);
      assert.equal(mempoolHas(store, 'lock-funded'), true, 'unmined lock stays queued');
      assert.equal(Number(store.reserveVault.totalLockedNanos), 0);
      console.log(`TIP_UNMINED_LOCK height=${tipHeight(store)}`);

      await mineOne(store, continuum, { now: stamp + TARGET_BLOCK_INTERVAL_MS });
      assert.ok(tipHeight(store) > fundedTip + 1);
      assert.equal(chainHas(store, 'lock-funded'), true);
      assert.equal(mempoolHas(store, 'lock-funded'), false);
      assert.equal(Number(store.reserveVault.totalLockedNanos), NANOS_PER_SHE);
      console.log(`TIP_LOCK_INCLUDED height=${tipHeight(store)} reserve=${store.reserveVault.totalLockedNanos}`);
    } finally {
      /* miners are killed when each header is found */
    }
  });
});
