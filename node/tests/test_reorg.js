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
import { readChainSegments } from '../../crypto/chainbin.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import { bluWallet, soloCoin, soloPay } from './support/blunote_mine.js';

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

async function mineOne(store, dest, extra = {}) {
  const parent = store.tip();
  // Each empty chain gets its own past stamp. One shared stamp makes every
  // genesis header identical, so the equal-work case never stages a side tip.
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : genesisStamp;
  if (!parent) genesisStamp += 7_000;
  const want = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now, ...extra });
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
    // R28: the extension is mined solo with option (b); the tip's pot is a
    // record coin of the miner's wallet, found with its scan key.
    const blu = bluWallet(id.spendSeed);
    for (let i = 0; i < SPENDABLE_CONFIRMATIONS; i += 1) {
      const extended = await mineOne(local, dest, soloPay(blu));
      assert.equal(extended.ok, true, `${extended.reason || 'extend'} at=${extended.at} i=${i}`);
    }
    const tip = local.tip();
    const spent = soloCoin(blu, tip);
    assert.ok(spent, 'the tip paid its pot to the miner');
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
    // State and disk agree after the adopt: the chain read back from the
    // segments (what a restart reads) is the live chain block for block,
    // every stored body rebuilds its sealed merkle root, and the supply audit
    // of the disk chain is the live one.
    const onDisk = readChainSegments(path.join(local.dir, 'segments'));
    assert.ok(Array.isArray(onDisk), 'segments on disk');
    assert.equal(onDisk.length, local.blocks.length, 'disk height');
    for (let i = 0; i < onDisk.length; i += 1) {
      assert.equal(Buffer.from(onDisk[i].header).equals(Buffer.from(local.blocks[i].header)), true, `header ${i}`);
      const sealed = Buffer.from(decodeHeader(Buffer.from(onDisk[i].header)).merkleRoot);
      assert.equal(merkleRoot(onDisk[i].txs.map(digestTx)).equals(sealed), true, `disk body ${i} rebuilds its merkle root`);
      assert.deepEqual(onDisk[i].txs.map((t) => digestTx(t).toString('hex')), local.blocks[i].txs.map((t) => digestTx(t).toString('hex')), `body ${i}`);
    }
    assert.deepEqual(auditCirculatingSupply(onDisk), auditCirculatingSupply(local.blocks), 'disk supply is live supply');
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

  it('ingest of an invalid child of the tip fails verifyBlock and keeps the tip; a rest-frame address never reaches the chain', { timeout: CASE_MS }, async () => {
    const dest = destMiner();
    const store = tmpStore();
    assert.equal((await mineOne(store, dest)).ok, true);
    const parent = store.tip();
    const now = Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000;
    const want = regtestBitsOverride(MAGIC_REGTEST);
    const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now });
    const before = Buffer.from(store.tip().hash);
    const height = store.tip().height;
    // A field validators read (the coinbase jroot) is wrong: sealed under its
    // own merkle root and proven, the child is still refused, and the tip stays.
    const badRoot = Buffer.alloc(32, 0x5a);
    const badTxs = [{ ...tpl.txs[0], jroot: badRoot }, ...tpl.txs.slice(1)];
    const tplHeader = decodeHeader(Buffer.from(tpl.header));
    const badHeader = encodeHeader({ ...tplHeader, merkleRoot: merkleRoot(badTxs.map(digestTx)), nonce: 0n });
    const badFound = await mineHeaderParallel(badHeader, tpl.bits, MAX_TRIES, threads);
    assert.ok(badFound && badFound.block, 'need pow on the bad child');
    const refused = store.ingest([{ header: badFound.header, txs: badTxs, samples: tpl.samples, miner: dest }]);
    assert.equal(refused.ok, false, 'a wrong jroot is refused');
    assert.equal(refused.reason, 'admit_membership');
    assert.equal(store.tip().height, height);
    assert.equal(Buffer.from(store.tip().hash).equals(before), true);
    // A rest-frame (shear1) or payment-code (she1) address on a coinbase
    // output names its owner. Compaction would drop it and leave the clean
    // child's leaf, so the arrival gate refuses it on the row as it arrived
    // (Russell 26 Oct, ruling A; it superseded the 25 Oct 14:20 strip): the
    // same header and proof of work, refused, the tip kept. The clean child
    // under that header then appends.
    const found = await mineHeaderParallel(tpl.header, tpl.bits, MAX_TRIES, threads);
    assert.ok(found && found.block, 'need child pow');
    const id = newIdentity();
    for (const [addr, reason] of [[id.address, 'rest_frame_on_chain'], [id.paymentCode, 'silent_id_on_chain']]) {
      const addressed = [{
        ...tpl.txs[0],
        vout: tpl.txs[0].vout.map((o) => ({ ...o, address: addr })),
      }, ...tpl.txs.slice(1)];
      assert.deepEqual(addressed.map((t) => digestTx(t).toString('hex')), tpl.txs.map((t) => digestTx(t).toString('hex')), 'the address is in no leaf');
      const framed = store.ingest([{ header: found.header, txs: addressed, samples: tpl.samples, miner: dest }]);
      assert.equal(framed.ok, false, `${reason}: refused, not stripped`);
      assert.equal(framed.reason, reason);
      assert.equal(store.tip().height, height);
      assert.equal(store.blocks.some((b) => JSON.stringify(b.txs).includes(addr)), false, `${reason}: never on chain`);
    }
    const got = store.ingest([{ header: found.header, txs: tpl.txs, samples: tpl.samples, miner: dest }]);
    assert.equal(got.ok, true, `the clean child ${got.reason || ''}`);
    assert.equal(store.tip().height, height + 1);
  });

  it('a heavier fork with an invalid block is refused and the old tip remains; its rest-frame address never reaches the chain', { timeout: CASE_MS }, async () => {
    const dest = destMiner();
    const local = tmpStore();
    assert.equal((await mineOne(local, dest)).ok, true);
    const fork = tmpStore();
    assert.equal((await mineOne(fork, dest)).ok, true);
    assert.equal((await mineOne(fork, dest)).ok, true);
    const id = newIdentity();
    const last = fork.blocks[1];
    // The heavier fork's second block names a wrong jroot, a field
    // validators read, and a rest-frame address. The arrival refusal waits
    // for the compact body to verify, so the block keeps its consensus
    // reason (admit_membership); either way the fork is refused.
    const txs = [{
      ...last.txs[0],
      jroot: Buffer.alloc(32, 0x5a),
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
    assert.equal(refused.reason, 'admit_membership');
    assert.equal(local.tip().height, 1);
    assert.equal(Buffer.from(local.tip().hash).equals(before), true);
    assert.equal(local.blocks.some((b) => JSON.stringify(b.txs).includes(id.address)), false, 'no rest-frame address on chain');
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
