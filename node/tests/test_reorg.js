import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest, newIdentity, destOpeningFromView } from '../../crypto/address.js';
import { spendBox, admitSend } from '../../tests/spend_box.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { GENESIS_BITS_PACKED, MAGIC_MAINNET, MAGIC_TESTNET, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNanos, bindWeightFee } from '../../crypto/levy.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { createStore } from '../src/store.js';
import { createRegtestStore } from './regtest_store.js';
import { shouldAdopt, digestTx } from '../src/chain.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const threads = os.cpus().length;
// Was 3_000_000 at the three search sites. Four-bit regtest work is ~16 hashes.
const MAX_TRIES = 8_192;
const T0 = 1_700_000_000_000;
let genesisStamp = T0;
const LONG_MS = 300_000;
const CASE_MS = 120_000;

after(() => closeMineWorkers());

function destMiner() {
  return encodeDest(Buffer.alloc(20, 9));
}

function tmpStore(regtest = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-reorg-'));
  return regtest ? createRegtestStore(dir, { bits: 4 }) : createStore(dir);
}

async function mineOne(store, dest) {
  const parent = store.tip();
  // Each empty chain gets its own past stamp. One shared stamp makes every
  // genesis header identical, so the equal-work case never stages a side tip.
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : genesisStamp;
  if (!parent) genesisStamp += 7_000;
  const want = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now });
  assert.equal(tpl.bits, want, 'template must seal the regtest bits');
  assert.equal(decodeHeader(tpl.header).bits, want);
  const found = await mineHeaderParallel(tpl.header, tpl.bits, MAX_TRIES, threads);
  assert.ok(found && found.block, 'need pow');
  return store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  });
}

describe('most-work adopt', () => {
  it('heavier valid fork replaces the local tip; equal work follows the lower tip hash; invalid rest-frame is refused', { timeout: LONG_MS }, async () => {
    assert.equal(regtestBitsOverride(MAGIC_REGTEST), null);
    assert.equal(regtestBitsOverride(MAGIC_TESTNET), null);
    assert.equal(regtestBitsOverride(MAGIC_MAINNET), null);
    assert.equal(regtestBitsOverride('shear-testnet-v11'), null);
    const plain = tmpStore(false);
    const probed = plain.template({ miner: destMiner(), bits: 1, now: T0 });
    assert.equal(probed.tpl.bits, GENESIS_BITS_PACKED);
    console.log(`reorg harness threads=${threads} regtestBits=4`);

    const id = newIdentity();
    const box = spendBox(id);
    const dest = box.dest;
    const local = tmpStore();
    const first = await Promise.resolve(mineOne(local, dest));
    assert.equal(first.ok, true, first.reason);
    const firstHash = Buffer.from(local.tip().hash);

    const equalPeer = tmpStore();
    assert.equal((await Promise.resolve(mineOne(equalPeer, dest))).ok, true);
    const preferPeer = shouldAdopt(local.blocks, equalPeer.blocks);
    const equal = local.ingest(equalPeer.blocks);
    if (preferPeer) {
      assert.equal(equal.ok, true, equal.reason);
      assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(equalPeer.tip().hash)), true);
    } else {
      assert.equal(equal.ok, false);
      assert.equal(equal.reason, 'side_hold');
      assert.equal(Buffer.from(local.tip().hash).equals(firstHash), true);
      assert.equal(local.sideTipHash(), Buffer.from(equalPeer.tip().hash).toString('hex'));
    }

    const events = [];
    local.on('reorg', (e) => events.push(e));
    for (let i = 0; i < SPENDABLE_CONFIRMATIONS; i += 1) {
      const extended = await mineOne(local, dest);
      assert.equal(extended.ok, true, `${extended.reason || 'extend'} at=${extended.at} i=${i}`);
    }
    const tip = local.tip();
    const spent = (tip.txs[0].vout || []).find((o) => o.kind === 'pot');
    const bounce = attachDummyOuts({
      id: 'bounce-1',
      kind: 'send',
      from: dest,
      to: dest,
      nanos: 1,
      fee: levyNanos(1),
      open: destOpeningFromView(id.viewKey, id.spendPub, 0),
      vin: [{
        commit: spent.commit,
        address: dest,
      }],
      vout: [{ address: dest, nanos: 1 }],
    }, { spent });
    admitSend(bounce, { id, spent, blocks: local.blocks });
    bindWeightFee(bounce);
    signSpendTx(bounce, box.key);
    // admitSend is a byte-2 stub. Stage 0 refuses it, so it never sits in
    // the mempool for the reorg to bounce. The fork checks below still run.
    const queued = local.queueTx(bounce);
    assert.equal(queued.ok, false);
    assert.equal(queued.reason, 'admit_version');
    const heavier = tmpStore();
    const heavierNeed = local.tip().height + 1;
    for (let i = 0; i < heavierNeed; i += 1) {
      assert.equal((await Promise.resolve(mineOne(heavier, dest))).ok, true);
    }
    assert.equal(heavier.tip().height, heavierNeed);
    assert.equal(shouldAdopt(local.blocks, heavier.blocks), true);
    const got = await Promise.resolve(local.ingest(heavier.blocks));
    assert.equal(got.ok, true, `${got.reason || 'ingest'} at=${got.at}`);
    assert.equal(got.reorg, true, `${got.reason || 'expected reorg'} at=${got.at}`);
    assert.equal(local.tip().height, heavierNeed);
    assert.equal(Buffer.from(local.tip().hash).equals(Buffer.from(heavier.tip().hash)), true);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'reorg');
    assert.ok(events[0].from_hash);
    assert.ok(events[0].to_hash);
    assert.ok(events[0].depth >= 1);
    assert.equal(Array.isArray(events[0].orphaned_txids), true);
    const tips = local.getchaintips();
    assert.equal(tips.some((t) => t.status === 'active'), true);
    assert.equal(tips.some((t) => t.status === 'valid-fork'), true);
    assert.equal(local.getpolicy().consensus_min, 9);
    assert.equal(local.getpolicy().bands.pool_merchant, 12);
    assert.equal(local.mempool.some((t) => t.id === 'bounce-1'), false, 'refused send stays out of the mempool');
  });

  it('ingest of an invalid child of the tip fails verifyBlock and keeps the tip', { timeout: CASE_MS }, async () => {
    const dest = destMiner();
    const store = tmpStore();
    assert.equal((await mineOne(store, dest)).ok, true);
    const parent = store.tip();
    const now = Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000;
    const want = regtestBitsOverride(MAGIC_REGTEST);
    const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now });
    const found = await mineHeaderParallel(tpl.header, tpl.bits, MAX_TRIES, threads);
    assert.ok(found && found.block, 'need child pow');
    const id = newIdentity();
    const poisoned = {
      header: found.header,
      txs: [{
        ...tpl.txs[0],
        vout: tpl.txs[0].vout.map((o) => ({ ...o, address: id.address })),
      }],
      samples: tpl.samples,
      miner: dest,
    };
    const before = Buffer.from(store.tip().hash);
    const height = store.tip().height;
    const refused = store.ingest([poisoned]);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'rest_frame_on_chain');
    assert.equal(store.tip().height, height);
    assert.equal(Buffer.from(store.tip().hash).equals(before), true);
  });

  it('heavier rest-frame fork is refused with rest_frame_on_chain and the old tip remains', { timeout: CASE_MS }, async () => {
    const dest = destMiner();
    const local = tmpStore();
    assert.equal((await mineOne(local, dest)).ok, true);
    const fork = tmpStore();
    assert.equal((await mineOne(fork, dest)).ok, true);
    assert.equal((await mineOne(fork, dest)).ok, true);
    const id = newIdentity();
    const last = fork.blocks[1];
    const txs = [{
      ...last.txs[0],
      vout: last.txs[0].vout.map((o) => ({ ...o, address: id.address })),
    }];
    const decoded = decodeHeader(last.header);
    assert.equal(decoded.bits, regtestBitsOverride(MAGIC_REGTEST));
    const merkle = merkleRoot(txs.map(digestTx));
    const header = encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: merkle,
      continuityRoot: decoded.continuityRoot,
      timestamp: decoded.timestamp,
      bits: decoded.bits,
      nonce: 0n,
    });
    const found = await mineHeaderParallel(header, decoded.bits, MAX_TRIES, threads);
    assert.ok(found && found.block, 'need pow on rest-frame body');
    const poisoned = fork.blocks.map((b, i) => (i !== 1 ? b : { ...b, header: found.header, txs }));
    const before = Buffer.from(local.tip().hash);
    const refused = local.ingest(poisoned);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'rest_frame_on_chain');
    assert.equal(local.tip().height, 1);
    assert.equal(Buffer.from(local.tip().hash).equals(before), true);
  });

  it('rebuildSpentB awaits a real promise when share prehash is cold', { timeout: CASE_MS }, async () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const body = src.split('function rebuildSpentB()')[1].split('function bounceMempool')[0];
    assert.equal(/Promise\.resolve\(spentCheck\)\.catch\(\(\) => \{\}\)/.test(src), false);
    assert.match(body, /\.then\(/);
    assert.doesNotMatch(body, /return step\(\)/);
    assert.doesNotMatch(body, /spentB\.clear\(\)/);
    assert.match(body, /skipSharePow:\s*false/);
    assert.doesNotMatch(body, /skipSharePow:\s*true/);
    assert.match(body, /trustedPowHash/);
    assert.match(src, /spendableOf:/);
    const dest = destMiner();
    const local = tmpStore();
    const peer = tmpStore();
    assert.equal((await mineOne(peer, dest)).ok, true);
    const got = await Promise.resolve(local.adopt(peer.blocks));
    assert.equal(got.ok, true, got.reason);
    assert.equal(local.tip().height, 1);
  });

  it('adopt from empty rebuilds without a snapshot vault helper', { timeout: CASE_MS }, async () => {
    const dest = destMiner();
    const local = tmpStore();
    const peer = tmpStore();
    const mined = await mineOne(peer, dest);
    assert.equal(mined.ok, true, mined.reason);
    const got = local.adopt(peer.blocks);
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.reorg, true);
    assert.equal(local.tip().height, 1);
  });

  it('append still extends a child of the current tip', { timeout: CASE_MS }, async () => {
    const dest = destMiner();
    const store = tmpStore();
    const a = await mineOne(store, dest);
    assert.equal(a.ok, true);
    const h1 = store.tip().height;
    const b = await mineOne(store, dest);
    assert.equal(b.ok, true);
    assert.equal(store.tip().height, h1 + 1);
  });
});
