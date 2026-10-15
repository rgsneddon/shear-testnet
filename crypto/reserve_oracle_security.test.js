import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeHeader, decodeHeader } from './header.js';
import { merkleRoot } from './merkle.js';
import {
  GENESIS_BITS_PACKED,
  GENESIS_BPS,
  MAGIC_TESTNET,
  NANOS_PER_SHE,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
} from './asert.js';
import { MAGIC_MAINNET } from './pot_sched.js';
import {
  BUNDLED_POLICY_TENTHS,
  ORACLE_MIN_SOURCES,
  ORACLE_STALE_MS,
  POLICY_BANK_IDS,
  SOURCE_TENTHS_MAX,
  adoptObservedBps,
  bundleObservationRoot,
  bundledComponents,
  classifySource,
  epochRateBps,
  freezeEpochBps,
  halfUpDiv,
  interestNanos,
  makeFreezeRecord,
  observeVerdict,
  rateCommitFor,
  recomputeEpochBps,
  sourceFreshness,
  trimmedMeanBps,
  verifyFreezeRecord,
  verifyRateCommit,
} from './reserve_oracle.js';
import {
  cloneVault,
  deposit,
  emptyVault,
  enact,
  observeRate,
  verifyReservePayout,
  withdraw,
  withdrawTx,
} from './reserve_vault.js';
import { newIdentity } from './address.js';
import { vaultDest } from './flow_sheet.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../node/src/chain.js';
import { oracleView } from '../node/src/oracle_feed.js';
import {
  bootReserveEvm,
  callReserve,
  encodeCommitRate,
  encodeObserveRate,
  encodeRewardNanos,
  encodeTrimmedMean,
} from './reserve_evm.js';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;
const END = T0 + RESERVE_EPOCH_MS;
const PREV = [0, 1, 99, 264];

function destOf(id) {
  return vaultDest(id.address, { viewKey: id.viewKey });
}

function bundleSources(asOfMs = T0, deltaTenths = 0, ids = POLICY_BANK_IDS) {
  return ids.map((id) => ({
    id,
    tenths: BUNDLED_POLICY_TENTHS[id] + deltaTenths,
    asOfMs,
  }));
}

function flatSources(tenths, asOfMs = T0) {
  return POLICY_BANK_IDS.map((id) => ({ id, tenths, asOfMs }));
}

function pythonTrimmed(vectors) {
  const script = `
import json, sys
from reserve.normalise import trimmed_mean_bps
out = []
for vec in json.load(sys.stdin):
    got = trimmed_mean_bps(vec)
    out.append(None if got is None else int(got))
json.dump(out, sys.stdout)
`;
  const res = spawnSync('python3', ['-c', script], {
    input: JSON.stringify(vectors),
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(res.status, 0, res.stderr || 'python trimmed_mean_bps failed');
  return JSON.parse(res.stdout);
}

function readWord(buf, word) {
  let n = 0n;
  const b = Buffer.from(buf);
  for (let i = 0; i < 32; i += 1) n = (n << 8n) + BigInt(b[word * 32 + i] || 0);
  return n;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('oracle security pack (attester keys held)', () => {
  it('O0-a floors an in-range negative aggregate and keeps the last rate when sources are implausible', () => {
    const cases = [
      { name: 'all -1.00%', tenths: flatSources(-1000), expect: 0 },
      { name: 'all -0.10%', tenths: flatSources(-100), expect: 0 },
      { name: 'all -0.01%', tenths: flatSources(-1), expect: 0 },
      { name: 'all zero', tenths: flatSources(0), expect: 0 },
      {
        name: 'cancelling pairs',
        tenths: POLICY_BANK_IDS.map((id, i) => ({ id, tenths: i < 7 ? -100 : 100, asOfMs: T0 })),
        expect: 0,
      },
      { name: 'half-up tenth rounds to 0 bps', tenths: flatSources(1), expect: 0 },
      { name: '+1 bp', tenths: flatSources(10), expect: 1 },
    ];
    const vectors = cases.map((c) => c.tenths.map((s) => s.tenths));
    const py = pythonTrimmed(vectors);
    cases.forEach((c, i) => {
      assert.equal(trimmedMeanBps(vectors[i]), c.expect, c.name);
      assert.equal(py[i], c.expect, `python ${c.name}`);
      for (const prev of PREV) {
        assert.equal(recomputeEpochBps(prev, c.tenths, T0), c.expect, `${c.name} prev ${prev}`);
        assert.equal(adoptObservedBps(prev, c.expect), c.expect);
      }
    });
    for (const prev of PREV) {
      assert.equal(recomputeEpochBps(prev, flatSources(-5000), T0), prev, `implausible -500 bps keeps ${prev}`);
      assert.equal(adoptObservedBps(prev, -500), 0, `floor of a negative aggregate from ${prev}`);
    }
    assert.equal(halfUpDiv(-15, 10), -2);
    assert.equal(halfUpDiv(15, 10), 2);
  });

  it('O0-b pays principal exactly at 0% and rejects a short or fat release', () => {
    const stakes = [PI_SHE_NANOS, PI_SHE_NANOS * 3, 2 ** 40];
    for (const stake of stakes) {
      const who = newIdentity();
      const dest = destOf(who);
      const state = emptyVault();
      state.genesisMs = T0;
      assert.equal(deposit({ state, dest, nanos: stake, nowMs: T0 }).ok, true);
      state.epochBps = 0;
      const paid = withdraw({ state, dest, nowMs: END });
      assert.equal(paid.ok, true, paid.reason);
      assert.equal(paid.reward, 0);
      assert.equal(paid.payout, paid.principal);
      assert.equal(paid.principal, stake);
      for (const short of [1, Math.min(NANOS_PER_SHE, stake), stake]) {
        const again = emptyVault();
        again.genesisMs = T0;
        assert.equal(deposit({ state: again, dest, nanos: stake, nowMs: T0 }).ok, true);
        again.epochBps = 0;
        const tx = withdrawTx({ from: dest, to: dest, nanos: stake - short, id: `short-${short}` });
        const got = verifyReservePayout(again, tx, END);
        assert.equal(got.ok, false, String(short));
        assert.equal(got.reason, 'principal_short');
      }
      const fat = emptyVault();
      fat.genesisMs = T0;
      assert.equal(deposit({ state: fat, dest, nanos: stake, nowMs: T0 }).ok, true);
      fat.epochBps = 0;
      const over = verifyReservePayout(fat, withdrawTx({
        from: dest, to: dest, nanos: stake + 1, id: 'fat',
      }), END);
      assert.equal(over.reason, 'over_mint');
    }
  });

  it('O0-c rejects a negative mint and a negative observe', async () => {
    const who = destOf(newIdentity());
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      finderDest: '',
      txs: [],
      bits: GENESIS_BITS_PACKED,
      now: T0,
    });
    const decoded = decodeHeader(Buffer.from(tpl.header));
    function blockFor(txPatch) {
      const cb = { ...tpl.txs[0], ...txPatch };
      const header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: merkleRoot([digestTx(cb)]),
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      return { ...tpl, header, txs: [cb] };
    }
    function blockRaw(txPatch) {
      return { ...tpl, txs: [{ ...tpl.txs[0], ...txPatch }] };
    }
    const negative = await verifyBlock(blockRaw({
      vout: [{ address: who, nanos: -1 }],
    }), null, { probeBody: true });
    assert.equal(negative.ok, false);
    assert.equal(negative.reason, 'negative_mint');
    const wrapped = await verifyBlock(blockRaw({
      vout: [{ address: who, nanos: 0, valueProof: { v: -1n } }],
    }), null, { probeBody: true });
    assert.equal(wrapped.reason, 'negative_mint');
    const txNeg = await verifyBlock(blockRaw({ nanos: -1n }), null, { probeBody: true });
    assert.equal(txNeg.reason, 'negative_mint');
    for (const annualBps of [-1, -264]) {
      const got = await verifyBlock(blockFor({
        observe: { annualBps, observedAtMs: T0 },
      }), null, { probeBody: true });
      assert.equal(got.reason, 'observe_unattested');
    }
  });

  it('O0-d EVM reward matches JS and is never a principal haircut', async () => {
    const session = await bootReserveEvm();
    const stakes = [PI_SHE_NANOS, PI_SHE_NANOS * 3, 2 ** 40];
    for (const stake of stakes) {
      for (const bps of [0, 1, GENESIS_BPS, 10001]) {
        const call = await callReserve(session, encodeRewardNanos(stake, bps), { staticCall: true });
        assert.equal(call.ok, true, call.reason);
        const reward = Number(readWord(call.returnValue, 0));
        assert.equal(reward, interestNanos(stake, bps));
        assert.ok(stake + reward >= stake);
      }
    }
    const refused = await callReserve(session, encodeObserveRate(0, T0));
    assert.equal(refused.ok, false);
    const recomputed = await callReserve(session, encodeCommitRate(0, 9999, T0, T0));
    assert.equal(recomputed.ok, true, recomputed.reason);
    const bad = await callReserve(session, encodeCommitRate(0, 10001, T0, T0));
    assert.equal(bad.ok, false);
    const repeated = await callReserve(session, encodeCommitRate(0, GENESIS_BPS, T0, T0));
    assert.equal(repeated.ok, false);
  });

  it('Oa-1 JS, Python, and the EVM agree on seeded tenths vectors', async () => {
    const rng = mulberry32(20261014);
    const vectors = [
      bundledComponents().map((c) => c.tenths),
      Array(14).fill(0),
      Array(14).fill(-1000),
      Array(14).fill(10000),
      Array(14).fill(5),
      [10001, ...Array(13).fill(1000)],
      Array(9).fill(1000),
    ];
    while (vectors.length < 10_000) {
      const row = [];
      for (let i = 0; i < 14; i += 1) row.push(Math.floor(rng() * 11001) - 1000);
      vectors.push(row);
    }
    const py = pythonTrimmed(vectors);
    const session = await bootReserveEvm();
    for (let i = 0; i < vectors.length; i += 1) {
      const js = trimmedMeanBps(vectors[i]);
      assert.equal(py[i], js, `python ${i}`);
      if (i < 64 || i % 200 === 0) {
        const call = await callReserve(session, encodeTrimmedMean(vectors[i]), { staticCall: true });
        assert.equal(call.ok, true, call.reason);
        const ok = readWord(call.returnValue, 0) !== 0n;
        const bps = Number(readWord(call.returnValue, 1));
        if (js == null) assert.equal(ok, false, `evm quorum ${i}`);
        else {
          assert.equal(ok, true, `evm ok ${i}`);
          assert.equal(bps, js, `evm ${i}`);
        }
      }
    }
  });

  it('Oa-2 a boundary reorg keeps only the winning fork rate', () => {
    const shift = bundleSources(END, 2500);
    const plain = bundleSources(END, 0);
    const rateA = recomputeEpochBps(GENESIS_BPS, shift, END);
    const rateB = recomputeEpochBps(GENESIS_BPS, plain, END);
    assert.notEqual(rateA, rateB);
    const commitA = rateCommitFor({
      prevEpochBps: GENESIS_BPS,
      sources: shift,
      blockTimeMs: END,
      epochIndex: 1,
      magic: MAGIC_TESTNET,
    });
    assert.equal(verifyRateCommit(commitA, {
      sources: plain,
      blockTimeMs: END,
      epochIndex: 1,
      magic: MAGIC_TESTNET,
    }).reason, 'rate_commit');
    assert.equal(verifyRateCommit(commitA, {
      sources: shift,
      blockTimeMs: END,
      epochIndex: 1,
      magic: MAGIC_TESTNET,
    }).epochBps, rateA);
    const alice = destOf(newIdentity());
    const chain = emptyVault();
    chain.genesisMs = T0;
    assert.equal(deposit({ state: chain, dest: alice, nanos: PI_SHE_NANOS, nowMs: T0 }).ok, true);
    assert.equal(enact({ state: chain, nowMs: END }).ok, true);
    const snap = JSON.parse(JSON.stringify(chain.freezes));
    const loser = cloneVault(chain);
    assert.equal(observeRate({ state: loser, annualBps: 9000, nowMs: END + 1 }).reason, 'rate_bundled');
    loser.epochBps = 9000;
    const restored = cloneVault(chain);
    assert.equal(restored.epochBps, GENESIS_BPS);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.freezes)), snap);
    assert.equal(chain.epochBps, GENESIS_BPS);
  });

  it('Oa-3 the first lock after the boundary does not change the rate', () => {
    for (const at of [END, END + 90_000, END + DAY, END + 3 * DAY]) {
      const state = emptyVault();
      state.genesisMs = T0;
      const first = destOf(newIdentity());
      const next = destOf(newIdentity());
      assert.equal(deposit({ state, dest: first, nanos: PI_SHE_NANOS, nowMs: T0 }).ok, true);
      assert.equal(enact({ state, nowMs: END }).ok, true);
      assert.equal(deposit({ state, dest: next, nanos: PI_SHE_NANOS, nowMs: at }).ok, true);
      assert.equal(state.epochBps, GENESIS_BPS, String(at - END));
      assert.equal(state.freeze.epochBps, GENESIS_BPS);
    }
  });

  it('Ob-1 two in-range outliers on one side do not move the trimmed mean', () => {
    const base = bundleSources();
    const baseline = recomputeEpochBps(264, base, T0);
    assert.equal(baseline, 291);
    const high = ['RBA', 'NORGES'];
    const low = ['SNB', 'BOJ'];
    for (const n of [1, 2]) {
      const bumped = base.map((s) => (high.slice(0, n).includes(s.id) ? { ...s, tenths: 10000 } : s));
      assert.equal(recomputeEpochBps(264, bumped, T0), baseline, `${n} high`);
      const cut = base.map((s) => (low.slice(0, n).includes(s.id) ? { ...s, tenths: -1000 } : s));
      assert.equal(recomputeEpochBps(264, cut, T0), baseline, `${n} low`);
    }
    const threeIds = ['BOE', 'NORGES', 'BOI'];
    const three = base.map((s) => (threeIds.includes(s.id) ? { ...s, tenths: 9000 } : s));
    const moved = recomputeEpochBps(264, three, T0);
    assert.ok(moved !== baseline);
    assert.ok(Math.abs(moved - baseline) <= (9000 - 2875) / 10);
    const spike = base.map((s) => ({ ...s }));
    spike[0] = { ...spike[0], tenths: BUNDLED_POLICY_TENTHS[spike[0].id] + 9999 * 10 };
    assert.equal(classifySource(spike[0], T0), 'bad_rate');
    assert.equal(
      recomputeEpochBps(264, spike, T0),
      trimmedMeanBps(base.slice(1).map((s) => s.tenths)),
    );
  });

  it('Ob-2 ten fresh sources compute a rate and nine keep the last rate', () => {
    const prev = 99;
    const full = bundleSources();
    assert.equal(recomputeEpochBps(prev, full, T0), 291);
    const ten = bundleSources(T0, 0, POLICY_BANK_IDS.slice(0, ORACLE_MIN_SOURCES));
    const computed = recomputeEpochBps(prev, ten, T0);
    assert.equal(computed, trimmedMeanBps(ten.map((s) => s.tenths)));
    assert.notEqual(computed, prev);
    const nine = bundleSources(T0, 0, POLICY_BANK_IDS.slice(0, ORACLE_MIN_SOURCES - 1));
    assert.equal(recomputeEpochBps(prev, nine, T0), prev);
    assert.equal(recomputeEpochBps(prev, [], T0), prev);
    assert.equal(observeVerdict({
      sources: nine.map((s) => ({ id: s.id, annualBps: GENESIS_BPS, observedAtMs: T0 })),
    }).reason, 'observe_unattested');
  });

  it('Ob-3 staleness follows the boundary block time', () => {
    const boundary = END;
    const ages = [
      { delta: -1 * DAY, counts: true },
      { delta: -29 * DAY, counts: true },
      { delta: -30 * DAY, counts: true },
      { delta: -31 * DAY, counts: false },
      { delta: 1000, counts: false, reason: 'oracle_future' },
    ];
    assert.equal(ORACLE_STALE_MS, 30 * DAY);
    for (const age of ages) {
      const asOf = boundary + age.delta;
      const reason = sourceFreshness(asOf, boundary);
      const sources = bundleSources(boundary);
      sources[5] = { ...sources[5], asOfMs: asOf };
      if (age.counts) {
        assert.equal(reason, 'fresh');
        assert.equal(recomputeEpochBps(50, sources, boundary), 291);
      } else {
        assert.equal(reason, age.reason || 'stale');
        assert.notEqual(classifySource(sources[5], boundary), 'fresh');
        const rest = sources.filter((_, i) => i !== 5).map((s) => s.tenths);
        assert.equal(recomputeEpochBps(50, sources, boundary), trimmedMeanBps(rest));
      }
    }
  });

  it('Od-1 a raw producer observe cannot set the rate', async () => {
    assert.equal(observeVerdict({ annualBps: 9000, observedAtMs: T0 }).reason, 'observe_unattested');
    const who = destOf(newIdentity());
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      finderDest: '',
      txs: [],
      bits: GENESIS_BITS_PACKED,
      now: T0,
    });
    const decoded = decodeHeader(Buffer.from(tpl.header));
    function blockFor(rateCommit) {
      const cb = { ...tpl.txs[0], rateCommit };
      const header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: merkleRoot([digestTx(cb)]),
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      return { ...tpl, header, txs: [cb] };
    }
    const forged = await verifyBlock(blockFor({
      epochIndex: 0,
      epochBps: 9000,
      magic: MAGIC_TESTNET,
      attRoot: bundleObservationRoot(),
      sources: bundleSources(T0, 2500),
    }), null, { probeBody: true, genesisMs: T0, magic: MAGIC_TESTNET });
    assert.equal(forged.reason, 'rate_commit');
    const bound = await verifyBlock(blockFor({
      epochIndex: 0,
      epochBps: GENESIS_BPS,
      magic: MAGIC_TESTNET,
      attRoot: bundleObservationRoot(),
    }), null, { probeBody: true, genesisMs: T0, magic: MAGIC_TESTNET });
    assert.notEqual(bound.reason, 'rate_commit');
  });

  it('Oe large in-range moves are adopted in full and spikes are excluded', () => {
    const prevs = [0, 264, 525];
    for (const prev of prevs) {
      for (const deltaBps of [250, 500]) {
        const sources = bundleSources(T0, deltaBps * 10);
        const want = trimmedMeanBps(sources.map((s) => s.tenths));
        assert.equal(recomputeEpochBps(prev, sources, T0), want);
        assert.equal(want, 291 + deltaBps);
        assert.equal(interestNanos(PI_SHE_NANOS, want), Number((BigInt(PI_SHE_NANOS) * BigInt(want)) / 10000n));
      }
      assert.equal(recomputeEpochBps(prev, flatSources(-1000), T0), 0);
    }
    const staggered = POLICY_BANK_IDS.map((id, i) => ({
      id,
      tenths: Math.min(SOURCE_TENTHS_MAX, Math.max(-1000, BUNDLED_POLICY_TENTHS[id] + (100 + i * 50) * 10)),
      asOfMs: T0,
    }));
    const stag = recomputeEpochBps(264, staggered, T0);
    assert.equal(stag, trimmedMeanBps(staggered.map((s) => s.tenths)));
    assert.ok(stag > 291);
    for (const bad of [100001, -1001, 999999]) {
      const sources = bundleSources();
      sources[12] = { ...sources[12], tenths: bad };
      assert.equal(classifySource(sources[12], T0), 'bad_rate');
      const rest = sources.filter((s) => s.tenths !== bad).map((s) => s.tenths);
      assert.equal(recomputeEpochBps(264, sources, T0), trimmedMeanBps(rest));
    }
    for (const edge of [{ id: 'RBA', tenths: 9000 }, { id: 'SNB', tenths: -900 }]) {
      const sources = bundleSources().map((s) => (s.id === edge.id ? { ...s, tenths: edge.tenths } : s));
      assert.equal(recomputeEpochBps(264, sources, T0), 291, edge.id);
    }
    const eras = {
      '2008-Q4': [125, 2000, 2500, 100, 1500, 4250, 5000, 500, 2000, 3000, 3750, 3000, 2500, 2250],
      '2020-Q1': [125, 100, -500, -100, 250, 250, 250, -750, 0, 250, -600, 750, 100, 1000],
      '2022-H2': [4375, 3500, 2000, -100, 4250, 3100, 4250, 1000, 2500, 2750, 1750, 3250, 2750, 7000],
    };
    for (const [name, tenths] of Object.entries(eras)) {
      const sources = POLICY_BANK_IDS.map((id, i) => ({ id, tenths: tenths[i], asOfMs: T0 }));
      assert.equal(recomputeEpochBps(264, sources, T0), trimmedMeanBps(tenths), name);
    }
  });

  it('Oe-6 a large freeze delta is accepted and a mismatched commit is rate_commit', () => {
    const rec = makeFreezeRecord({
      epochIndex: 1,
      prevEpochBps: 0,
      nowMs: END,
      magic: MAGIC_TESTNET,
    });
    assert.equal(rec.epochBps, GENESIS_BPS);
    assert.ok(Math.abs(rec.epochBps - rec.prevEpochBps) > 100);
    const ok = verifyFreezeRecord(rec, { epochIndex: 1, magic: MAGIC_TESTNET });
    assert.equal(ok.ok, true, ok.reason);
    assert.notEqual(ok.reason, 'freeze_step');
    const mismatch = verifyFreezeRecord({ ...rec, epochBps: 900 }, { epochIndex: 1, magic: MAGIC_TESTNET });
    assert.equal(mismatch.reason, 'rate_commit');
    const negative = verifyFreezeRecord({ ...rec, epochBps: -1 }, { epochIndex: 1, magic: MAGIC_TESTNET });
    assert.equal(negative.reason, 'freeze_bps');
  });

  it('Of keeps the last rate when a window misses quorum', () => {
    let prev = 99;
    const steps = [
      { sources: bundleSources(), want: 291 },
      { sources: bundleSources(T0, 0, POLICY_BANK_IDS.slice(0, 9)), want: null },
      { sources: [], want: null },
      { sources: bundleSources(T0, 2500), want: 541 },
      { sources: bundleSources(T0, 0, POLICY_BANK_IDS.slice(0, 9)), want: null },
      { sources: bundleSources(), want: 291 },
    ];
    const seen = [];
    for (const step of steps) {
      prev = recomputeEpochBps(prev, step.sources, T0);
      seen.push(prev);
      if (step.want == null) assert.equal(prev, seen.length === 1 ? 99 : seen[seen.length - 2]);
    }
    assert.deepEqual(seen, [291, 291, 291, 541, 541, 291]);
    assert.equal(epochRateBps(0), GENESIS_BPS);
  });

  it('Og no env var or snapshot selects the consensus rate', () => {
    const oracleSrc = readFileSync(fileURLToPath(new URL('./reserve_oracle.js', import.meta.url)), 'utf8');
    const vaultSrc = readFileSync(fileURLToPath(new URL('./reserve_vault.js', import.meta.url)), 'utf8');
    assert.equal(oracleSrc.includes('process.env'), false);
    assert.equal(vaultSrc.includes('process.env'), false);
    assert.equal(oracleSrc.includes('SHEAR_ORACLE_BPS'), false);
    assert.equal(vaultSrc.includes('SHEAR_ORACLE_BPS'), false);
    const view = oracleView({ epochBps: GENESIS_BPS }, {
      annualBps: 9999,
      averagePercent: 99.99,
      observedAt: '2026-08-01T00:00:00Z',
      components: [{ id: 'FED', tenths: 9999 }],
    }, T0);
    assert.equal(view.displayOnly, true);
    assert.equal(view.snapshotIgnored, true);
    assert.equal(view.wouldFreezeBps, GENESIS_BPS);
    assert.equal(view.annualBps, GENESIS_BPS);
    assert.equal(freezeEpochBps({ prevEpochBps: 0, annualBps: 9999, observedAtMs: T0, nowMs: T0 }), GENESIS_BPS);
  });

  it('Oh binds MAGIC and epoch, and a duplicate bank counts once', () => {
    const good = rateCommitFor({
      prevEpochBps: GENESIS_BPS,
      epochIndex: 1,
      magic: MAGIC_TESTNET,
      blockTimeMs: END,
    });
    assert.equal(verifyRateCommit({ ...good, epochIndex: 0 }, {
      epochIndex: 1,
      magic: MAGIC_TESTNET,
    }).reason, 'att_epoch');
    assert.equal(verifyRateCommit({ ...good, epochIndex: 2 }, {
      epochIndex: 1,
      magic: MAGIC_TESTNET,
    }).reason, 'att_epoch');
    assert.equal(verifyRateCommit({ ...good, magic: 'shear-testnet-v11' }, {
      epochIndex: 1,
      magic: MAGIC_TESTNET,
    }).reason, 'att_magic');
    assert.equal(verifyRateCommit({ ...good, magic: MAGIC_MAINNET }, {
      epochIndex: 1,
      magic: MAGIC_TESTNET,
    }).reason, 'att_magic');
    const rec = makeFreezeRecord({ epochIndex: 1, prevEpochBps: GENESIS_BPS, magic: MAGIC_TESTNET });
    assert.equal(verifyFreezeRecord({ ...rec, magic: 'shear-testnet-v11' }, {
      epochIndex: 1,
      magic: MAGIC_TESTNET,
    }).reason, 'att_magic');
    const dup = bundleSources();
    for (let i = 0; i < 5; i += 1) dup.push({ id: 'FED', tenths: 10000, asOfMs: T0 });
    assert.equal(classifySource(dup[dup.length - 1], T0, new Set(['FED'])), 'att_dup');
    assert.equal(recomputeEpochBps(50, dup, T0), 291);
  });
});
