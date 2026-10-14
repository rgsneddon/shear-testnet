import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshStealthDest, hash20FromAddress, newIdentity } from '../../crypto/address.js';
import {
  BLOCK_SUBSIDY_NANOS,
  GENESIS_BITS_PACKED,
  HASH_BONUS_NANOS,
  MAGIC_TESTNET,
  POOL_FEE_BPS,
  POOL_FEE_MAX_BPS,
  SHARE_FLOOR_BITS,
  TARGET_BLOCK_INTERVAL_MS,
  asertNextBits,
} from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { excessOf, noteCommitOfDest20, openedCoinbaseNanos, sealCoinbaseNote } from '../../crypto/note.js';
import { epochMs, potSubsidyAt, potSubsidyNanos } from '../../crypto/pot_sched.js';
import {
  aLeavesFromShares,
  clearLiveSharePow,
  dest20OfShare,
  nonceWithShareTarget,
  noteCommitOfShare,
  rememberLiveSharePow,
  shareWorkBits,
} from '../../crypto/share_batch.js';
import {
  GENESIS_PREV,
  buildTemplate,
  canonicalCarry,
  custodyPotShares,
  digestTx,
  potSharesFromBatch,
  verifyBlock,
} from '../src/chain.js';
import { encodeWireBlock } from '../src/p2p.js';
import { applyVerifiedIpcBlock } from '../src/p2p_ipc.js';
import { createRpc } from '../src/rpc.js';
import { createStore } from '../src/store.js';

const genesisMs = 1_700_000_000_000;
const feeTo = freshStealthDest(newIdentity()).dest;
const stranger = freshStealthDest(newIdentity()).dest;

function minerDest() {
  return freshStealthDest(newIdentity()).dest;
}

function tplOf(args) {
  // A warm share cache must not drop a later batch that reuses a nonce.
  clearLiveSharePow();
  return buildTemplate(args);
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[20] = powTag & 0xff;
  h[21] = (powTag >> 8) & 0xff;
  powTag += 1;
  return h;
}

function shareRow(dest, nonce, bits, header) {
  const width = Math.floor(Number(bits));
  return {
    dest,
    dest20: dest20OfShare({ dest }),
    nonce: nonceWithShareTarget(BigInt(nonce), width),
    lz: width,
    shareBits: width,
    creditedShareBits: width,
    verifiedHeader: header,
  };
}

function seed(header, rows) {
  clearLiveSharePow();
  if (!header) return;
  for (const row of rows || []) {
    const bits = shareWorkBits(row);
    rememberLiveSharePow(header, row.nonce, {
      noteCommit: noteCommitOfShare(row),
      shareBits: bits,
      lz: row.lz,
    });
  }
}

function asView(parent) {
  if (!parent) return null;
  return {
    hash: parent.res.hash,
    header: parent.block.header,
    height: parent.block.height,
    weight: parent.block.weight,
    txs: parent.block.txs,
    bLeaves: parent.block.bLeaves,
  };
}

function linkedBlock(sealed) {
  if (!sealed?.res?.hash) return null;
  return {
    ...sealed.block,
    hash: sealed.res.hash,
    height: sealed.block.height,
  };
}

function supplyPrefix(prev) {
  if (!prev) return [];
  const self = linkedBlock(prev);
  const prior = Array.isArray(prev.ancestors) ? prev.ancestors : [];
  return self ? [...prior, self] : prior.slice();
}

function check(block, prev, now, supplyParents) {
  seed(prev?.header, block.shareBatch || []);
  return verifyBlock(block, prev, {
    trustedPowHash: easyPowHash(),
    skipSharePow: true,
    nowMs: now + 1_000,
    genesisMs,
    mtpTimestamps: [now - 1_000],
    poolDest: feeTo,
    magic: MAGIC_TESTNET,
    ...(Array.isArray(supplyParents) && supplyParents.length ? { supplyParents } : {}),
  });
}

function seal(tpl, prev, now) {
  const block = {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    poolDest: tpl.poolDest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height: tpl.height,
  };
  const supplyParents = supplyPrefix(prev);
  return {
    block,
    res: check(block, asView(prev), now, supplyParents),
    ancestors: supplyParents,
  };
}

function bitsAfter(parent, childNow, childHeight) {
  const ph = decodeHeader(parent.block.header);
  const quote = asertNextBits({
    anchorBits: GENESIS_BITS_PACKED,
    anchorTimeMs: genesisMs,
    anchorHeight: 1,
    blockTimeMs: childNow,
    blockHeight: childHeight,
    parentTimeMs: Number(ph.timestamp),
  });
  assert.equal(quote.ok, true, `asert h=${childHeight}`);
  return quote.packed;
}

function blockFrom(tpl, txs) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  return {
    header: encodeHeader({
      version: decoded.version,
      prevBlockHash: decoded.prevBlockHash,
      merkleRoot: merkleRoot(txs.map(digestTx)),
      continuityRoot: decoded.continuityRoot,
      timestamp: decoded.timestamp,
      bits: decoded.bits,
      nonce: decoded.nonce,
      baseFee: decoded.baseFee,
    }),
    txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    poolDest: tpl.poolDest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    height: tpl.height,
  };
}

function retargetHash(tpl, dest, nanos) {
  const cb = {
    ...tpl.txs[0],
    vout: (tpl.txs[0].vout || []).filter((o) => o.kind !== 'hash'),
  };
  cb.vout.push(sealCoinbaseNote(nanos, {
    dest20: hash20FromAddress(dest),
    kind: 'hash',
  }));
  cb.excess = excessOf(cb.vout);
  delete cb.jroot;
  return blockFrom(tpl, [cb, ...tpl.txs.slice(1)]);
}

function paintV(block, mode) {
  const txs = block.txs.map((tx, i) => {
    if (i !== 0) return tx;
    return {
      ...tx,
      vout: (tx.vout || []).map((o) => {
        if (!o?.valueProof) return o;
        const valueProof = { ...o.valueProof };
        if (mode === 'strip') delete valueProof.v;
        else if (mode === 'one') valueProof.v = 1;
        else valueProof.v = (Number(valueProof.v) || 0) + 1_000_000_003;
        return { ...o, valueProof };
      }),
    };
  });
  return { ...block, txs };
}

function withEnv(on, fn) {
  const prev = process.env.SHEAR_ALLOW_HASHBONUS_CUSTODY;
  if (on) process.env.SHEAR_ALLOW_HASHBONUS_CUSTODY = '1';
  else delete process.env.SHEAR_ALLOW_HASHBONUS_CUSTODY;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SHEAR_ALLOW_HASHBONUS_CUSTODY;
    else process.env.SHEAR_ALLOW_HASHBONUS_CUSTODY = prev;
  }
}

function sameVerdict(block, prev, now, supplyParents) {
  const off = withEnv(false, () => check(block, prev, now, supplyParents));
  const on = withEnv(true, () => check(block, prev, now, supplyParents));
  assert.equal(on.ok, off.ok);
  assert.equal(on.reason, off.reason);
  return off;
}

function openedPot(vouts) {
  const by = new Map();
  let sum = 0;
  for (const o of vouts || []) {
    if (o.kind === 'hash' || o.kind === 'finder-fee' || o.kind === 'reserve-fee') continue;
    const v = openedCoinbaseNanos(o);
    assert.equal(typeof v, 'number');
    sum += v;
    const key = Buffer.from(o.dest20).toString('hex');
    by.set(key, (by.get(key) || 0) + v);
  }
  return { sum, by };
}

function onSubsidyScale(subsidy, nanos) {
  for (let bps = 0; bps <= POOL_FEE_MAX_BPS; bps += 1) {
    if (Math.floor(subsidy * bps / 10000) === nanos) return true;
  }
  return false;
}

function batchOf(dests, header, bitsFor) {
  return dests.map((dest, i) => shareRow(dest, i + 1, bitsFor(i), header));
}

describe('v12 consensus rejects a custodial coinbase', () => {
  it('pays proven work only, at any miner count, carry, subsidy, and published v', { timeout: 180_000 }, async () => {
    const chainSrc = fs.readFileSync(new URL('../src/chain.js', import.meta.url), 'utf8');
    const verifySrc = chainSrc.slice(chainSrc.indexOf('function verifyBlockConsensus'));
    assert.doesNotMatch(verifySrc, /matchCustodyCoinbase\(/);
    assert.doesNotMatch(verifySrc, /matchDestBoundHashCustodyPot\(/);
    assert.doesNotMatch(verifySrc, /process\.env\.SHEAR_ALLOW_HASHBONUS_CUSTODY/);

    const solo = minerDest();
    const paid = seal(tplOf({
      prev: GENESIS_PREV,
      height: 1,
      miner: solo,
      bits: GENESIS_BITS_PACKED,
      now: genesisMs,
      potShares: [{ address: solo, nanos: potSubsidyNanos(0), kind: 'pot' }],
    }), null, genesisMs);
    assert.equal(paid.res.ok, true, paid.res.reason);
    assert.equal(canonicalCarry(paid.block.txs[0]), 0);

    const empties = [];
    {
      let parent = paid;
      let now = genesisMs;
      for (let i = 0; i < 4; i += 1) {
        now += TARGET_BLOCK_INTERVAL_MS;
        const height = parent.block.height + 1;
        const subsidy = potSubsidyAt({ nowMs: now, genesisMs, magic: MAGIC_TESTNET });
        const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
        const tpl = tplOf({
          prev: parent.res.hash,
          prevHeader: parent.block.header,
          prevBlock: parent.block,
          height,
          miner: feeTo,
          bits: bitsAfter(parent, now, height),
          now,
          potShares: [{ address: feeTo, nanos: fee, kind: 'pool-fee' }],
          poolDest: feeTo,
        });
        const got = seal(tpl, parent, now);
        assert.equal(got.res.ok, true, `empty h=${height} ${got.res.reason}`);
        assert.ok(canonicalCarry(got.block.txs[0]) > 0);
        empties.push({ parent: got, now });
        parent = got;
      }
    }

    const streaks = [
      { name: 'none', parent: paid, now: genesisMs + TARGET_BLOCK_INTERVAL_MS },
      { name: 'one', parent: empties[0].parent, now: empties[0].now + TARGET_BLOCK_INTERVAL_MS },
      { name: 'several', parent: empties[3].parent, now: empties[3].now + TARGET_BLOCK_INTERVAL_MS },
    ];
    const counts = [1, 3, 8];
    const painted = [];

    function consider(parent, now, dests, bitsFor, label) {
      const height = parent.block.height + 1;
      const subsidy = potSubsidyAt({ nowMs: now, genesisMs, magic: MAGIC_TESTNET });
      const carry = canonicalCarry(parent.block.txs[0]) || 0;
      const payable = subsidy + carry;
      const header = parent.block.header;
      const batch = batchOf(dests, header, bitsFor);
      const honestRows = potSharesFromBatch(batch, feeTo, subsidy, carry);
      const miner = dests[0];
      const tpl = tplOf({
        prev: parent.res.hash,
        prevHeader: header,
        prevBlock: parent.block,
        parentWeight: parent.block.weight,
        height,
        miner,
        bits: bitsAfter(parent, now, height),
        now,
        shareBatch: batch,
        potShares: honestRows,
        poolDest: feeTo,
      });
      const honest = seal(tpl, parent, now);
      assert.equal(honest.res.ok, true, `${label} honest ${honest.res.reason}`);
      const opened = openedPot(honest.block.txs[0].vout);
      const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
      const feeKey = hash20FromAddress(feeTo).toString('hex');
      const strangerKey = hash20FromAddress(stranger).toString('hex');
      assert.equal(opened.sum, payable, label);
      assert.equal(opened.by.get(feeKey) || 0, fee, label);
      assert.equal(opened.by.get(strangerKey) || 0, 0, label);
      for (const dest of dests) {
        const key = hash20FromAddress(dest).toString('hex');
        if (key === feeKey) continue;
        assert.ok((opened.by.get(key) || 0) > 0, `${label} hasher pot`);
      }
      const hashes = (honest.block.txs[0].vout || []).filter((o) => o.kind === 'hash');
      assert.equal(hashes.length, dests.length, label);
      for (const h of hashes) {
        assert.notEqual(Buffer.from(h.noteCommit).equals(noteCommitOfDest20(hash20FromAddress(stranger))), true);
      }

      const prev = asView(parent);
      const whole = seal(tplOf({
        prev: parent.res.hash,
        prevHeader: header,
        prevBlock: parent.block,
        parentWeight: parent.block.weight,
        height,
        miner,
        bits: bitsAfter(parent, now, height),
        now,
        shareBatch: batch,
        potShares: [{ address: stranger, nanos: payable, kind: 'pot' }],
        poolDest: feeTo,
      }), parent, now);
      assert.equal(whole.res.ok, false, label);
      assert.equal(whole.res.reason, 'pot_prop', label);

      const maxFee = Math.floor(subsidy * POOL_FEE_MAX_BPS / 10000);
      const overFee = maxFee + 1;
      const rest = payable - overFee;
      const overRows = [
        ...potSharesFromBatch(batch, null, rest, 0),
        { address: stranger, nanos: overFee, kind: 'pool-fee' },
      ];
      const over = seal(tplOf({
        prev: parent.res.hash,
        prevHeader: header,
        prevBlock: parent.block,
        parentWeight: parent.block.weight,
        height,
        miner,
        bits: bitsAfter(parent, now, height),
        now,
        shareBatch: batch,
        potShares: overRows,
        poolDest: feeTo,
      }), parent, now);
      assert.equal(over.res.ok, false, `${label} over-cap`);
      assert.equal(over.res.reason, 'pot_prop', label);

      if (carry > 0) {
        const carryFee = Math.floor(payable * POOL_FEE_BPS / 10000);
        if (!onSubsidyScale(subsidy, carryFee) && carryFee < payable) {
          const carryRows = [
            ...potSharesFromBatch(batch, null, payable - carryFee, 0),
            { address: stranger, nanos: carryFee, kind: 'pool-fee' },
          ];
          const skim = seal(tplOf({
            prev: parent.res.hash,
            prevHeader: header,
            prevBlock: parent.block,
            parentWeight: parent.block.weight,
            height,
            miner,
            bits: bitsAfter(parent, now, height),
            now,
            shareBatch: batch,
            potShares: carryRows,
            poolDest: feeTo,
          }), parent, now);
          assert.equal(skim.res.ok, false, `${label} carry fee`);
          assert.equal(skim.res.reason, 'pot_prop', label);
        }
      }

      const leaves = aLeavesFromShares(batch);
      const bonus = leaves.reduce((a, l) => a + l.count * HASH_BONUS_NANOS, 0);
      const moved = retargetHash(tpl, stranger, bonus);
      const parents = supplyPrefix(parent);
      const movedRes = sameVerdict(moved, prev, now, parents);
      assert.equal(movedRes.ok, false, `${label} hash`);
      assert.equal(movedRes.reason, 'hash_owed', label);
      const both = retargetHash(whole.block, stranger, bonus);
      const bothRes = sameVerdict(both, prev, now, parents);
      assert.equal(bothRes.ok, false, `${label} both`);
      assert.equal(bothRes.reason, 'hash_owed', `${label} both ${bothRes.reason}`);

      painted.push({ block: honest.block, prev, now, attack: whole.block, supplyParents: parents });
      return honest;
    }

    for (const streak of streaks) {
      for (const n of counts) {
        const dests = Array.from({ length: n }, () => minerDest());
        const bitsFor = n === 1
          ? () => SHARE_FLOOR_BITS + 12
          : (i) => SHARE_FLOOR_BITS + (n === 3 ? i * 5 : 0);
        consider(streak.parent, streak.now, dests, bitsFor, `${streak.name}/${n}`);
      }
    }

    const epochs = [1, 7];
    for (const epoch of epochs) {
      const now = genesisMs + epoch * epochMs(MAGIC_TESTNET) + TARGET_BLOCK_INTERVAL_MS;
      for (const n of [1, 3]) {
        const dests = Array.from({ length: n }, () => minerDest());
        const bitsFor = (i) => SHARE_FLOOR_BITS + i * 4;
        consider(paid, now, dests, bitsFor, `epoch${epoch}/${n}`);
      }
    }

    const sample = painted[1];
    for (const mode of ['strip', 'one', 'huge']) {
      const honestV = sameVerdict(paintV(sample.block, mode), sample.prev, sample.now, sample.supplyParents);
      assert.equal(honestV.ok, true, `honest ${mode} ${honestV.reason}`);
      const attackV = sameVerdict(paintV(sample.attack, mode), sample.prev, sample.now, sample.supplyParents);
      assert.equal(attackV.ok, false, `attack ${mode}`);
      assert.equal(attackV.reason, 'pot_prop', mode);
    }

    const shuffleParent = streaks[1].parent;
    const shuffleNow = streaks[1].now + TARGET_BLOCK_INTERVAL_MS;
    const shuffleDests = [minerDest(), minerDest(), minerDest()];
    const shuffleBits = (i) => SHARE_FLOOR_BITS + (i + 1) * 3;
    const forward = batchOf(shuffleDests, shuffleParent.block.header, shuffleBits);
    const backward = [...forward].reverse();
    const subsidy = potSubsidyAt({ nowMs: shuffleNow, genesisMs, magic: MAGIC_TESTNET });
    const carry = canonicalCarry(shuffleParent.block.txs[0]) || 0;
    const rows = potSharesFromBatch(forward, feeTo, subsidy, carry);
    function shuffled(batch) {
      const height = shuffleParent.block.height + 1;
      return seal(tplOf({
        prev: shuffleParent.res.hash,
        prevHeader: shuffleParent.block.header,
        prevBlock: shuffleParent.block,
        height,
        miner: shuffleDests[0],
        bits: bitsAfter(shuffleParent, shuffleNow, height),
        now: shuffleNow,
        shareBatch: batch,
        potShares: rows,
        poolDest: feeTo,
      }), shuffleParent, shuffleNow);
    }
    const left = shuffled(forward);
    const right = shuffled(backward);
    assert.equal(left.res.ok, true, left.res.reason);
    assert.equal(right.res.ok, true, right.res.reason);
    const a = openedPot(left.block.txs[0].vout);
    const b = openedPot(right.block.txs[0].vout);
    assert.equal(a.sum, b.sum);
    for (const [key, nanos] of a.by) assert.equal(b.by.get(key) || 0, nanos);

    const capParent = paid;
    const capNow = genesisMs + TARGET_BLOCK_INTERVAL_MS;
    const capDests = [minerDest(), minerDest()];
    const capBatch = batchOf(capDests, capParent.block.header, () => SHARE_FLOOR_BITS);
    const capSubsidy = potSubsidyAt({ nowMs: capNow, genesisMs, magic: MAGIC_TESTNET });
    for (const bps of [0, POOL_FEE_MAX_BPS]) {
      const fee = Math.floor(capSubsidy * bps / 10000);
      const capRows = fee > 0
        ? [...potSharesFromBatch(capBatch, null, capSubsidy - fee, 0), { address: feeTo, nanos: fee, kind: 'pool-fee' }]
        : potSharesFromBatch(capBatch, null, capSubsidy, 0);
      const height = capParent.block.height + 1;
      const got = seal(tplOf({
        prev: capParent.res.hash,
        prevHeader: capParent.block.header,
        prevBlock: capParent.block,
        height,
        miner: capDests[0],
        bits: bitsAfter(capParent, capNow, height),
        now: capNow,
        shareBatch: capBatch,
        potShares: capRows,
        poolDest: feeTo,
      }), capParent, capNow);
      assert.equal(got.res.ok, true, `bps ${bps} ${got.res.reason}`);
      const opened = openedPot(got.block.txs[0].vout);
      assert.equal(opened.by.get(hash20FromAddress(feeTo).toString('hex')) || 0, fee);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-custody-v12-'));
    const store = createStore(dir);
    const hasher = minerDest();
    const pool = minerDest();
    const boot = store.template({
      miner: hasher,
      poolDest: pool,
      potShares: custodyPotShares(pool, BLOCK_SUBSIDY_NANOS),
    });
    const booted = store.submitHeader({
      jobId: boot.job.jobId,
      nonce: 0n,
      miner: hasher,
      powHash: '00'.repeat(32),
    }, { trusted: true });
    assert.equal(booted.ok, true, booted.reason);
    const parentTip = store.tip();
    const shareNonce = nonceWithShareTarget(1n, SHARE_FLOOR_BITS);
    const share = {
      dest: hasher,
      dest20: dest20OfShare({ dest: hasher }),
      nonce: shareNonce,
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      creditedShareBits: SHARE_FLOOR_BITS,
      verifiedHeader: Buffer.from(parentTip.header).toString('hex'),
    };
    assert.equal(rememberLiveSharePow(parentTip.header, shareNonce, {
      noteCommit: noteCommitOfShare(share),
      shareBits: SHARE_FLOOR_BITS,
      lz: SHARE_FLOOR_BITS,
    }), true);
    const badJob = store.template({
      miner: hasher,
      poolDest: pool,
      shareBatch: [share],
      potShares: custodyPotShares(pool, BLOCK_SUBSIDY_NANOS),
    });
    const minedPow = easyPowHash();
    const mined = store.submitHeader({
      jobId: badJob.job.jobId,
      nonce: 0n,
      miner: hasher,
      powHash: minedPow.toString('hex'),
    }, { trusted: true });
    assert.equal(mined.ok, false);
    assert.equal(mined.reason, 'pot_prop');
    const badBlock = {
      header: badJob.tpl.header,
      txs: badJob.tpl.txs,
      shareBatch: badJob.tpl.shareBatch,
      miner: hasher,
      poolDest: pool,
      aLeaves: badJob.tpl.aLeaves,
      bLeaves: badJob.tpl.bLeaves,
      weight: badJob.tpl.weight,
      height: badJob.tpl.height,
      samples: badJob.tpl.samples,
    };
    const trustedIngest = await Promise.resolve(store.ingest([badBlock], {
      trustedPowHash: easyPowHash(),
      skipSharePow: true,
    }));
    assert.equal(trustedIngest.ok, false);
    assert.equal(trustedIngest.reason, 'pot_prop');
    const p2p = await Promise.resolve(store.ingest([badBlock], { offLoopPow: true }));
    assert.equal(p2p.ok, false);

    const rpcStore = createStore(path.join(dir, 'rpc'));
    const rpcBoot = rpcStore.template({
      miner: hasher,
      poolDest: pool,
      potShares: custodyPotShares(pool, BLOCK_SUBSIDY_NANOS),
      now: genesisMs,
    });
    assert.equal(rpcStore.submitHeader({
      jobId: rpcBoot.job.jobId,
      nonce: 0n,
      miner: hasher,
      powHash: '00'.repeat(32),
    }, { trusted: true }).ok, true);
    const rpcParent = rpcStore.tip();
    const rpcNonce = nonceWithShareTarget(2n, SHARE_FLOOR_BITS);
    const rpcShare = {
      dest: hasher,
      dest20: dest20OfShare({ dest: hasher }),
      nonce: rpcNonce,
      lz: SHARE_FLOOR_BITS,
      shareBits: SHARE_FLOOR_BITS,
      creditedShareBits: SHARE_FLOOR_BITS,
      verifiedHeader: Buffer.from(rpcParent.header).toString('hex'),
    };
    assert.equal(rememberLiveSharePow(rpcParent.header, rpcNonce, {
      noteCommit: noteCommitOfShare(rpcShare),
      shareBits: SHARE_FLOOR_BITS,
      lz: SHARE_FLOOR_BITS,
    }), true);
    const rpcJob = rpcStore.template({
      miner: hasher,
      poolDest: pool,
      shareBatch: [rpcShare],
      potShares: custodyPotShares(pool, BLOCK_SUBSIDY_NANOS),
      now: genesisMs + TARGET_BLOCK_INTERVAL_MS,
    });
    const rpc = createRpc({ store: rpcStore, port: 0, host: '127.0.0.1' });
    try {
      const got = await Promise.resolve(rpc.dispatch('submitHeader', {
        jobId: rpcJob.job.jobId,
        nonce: '0',
        miner: hasher,
        powHash: '11'.repeat(32),
        trustedPowHash: '11'.repeat(32),
        skipSharePow: true,
      }));
      assert.equal(got.ok, false);
      assert.equal(rpcStore.tip().height, rpcParent.height);
    } finally {
      await rpc.close();
    }

    const ipcBlock = {
      ...badBlock,
      hash: easyPowHash(),
    };
    const ipc = await Promise.resolve(applyVerifiedIpcBlock(store, {
      type: 'ipc_block',
      magic: MAGIC_TESTNET,
      block: encodeWireBlock(ipcBlock),
      powHash: Buffer.from(ipcBlock.hash).toString('hex'),
    }));
    assert.equal(ipc.ok, false);
    assert.equal(store.tip().height, parentTip.height);
  });
});
