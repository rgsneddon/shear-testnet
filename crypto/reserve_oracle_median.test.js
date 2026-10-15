import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHeader, decodeHeader } from './header.js';
import { merkleRoot } from './merkle.js';
import {
  GENESIS_BITS_PACKED,
  GENESIS_BPS,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  RESERVE_EPOCH_MS,
} from './asert.js';
import {
  BUNDLED_POLICY_TENTHS,
  ORACLE_ACTIVATION_HEIGHT,
  ORACLE_WINDOW_MAINNET,
  ORACLE_WINDOW_MS,
  ORACLE_WINDOW_TESTNET,
  POLICY_BANK_IDS,
  boundaryEpochBps,
  bundleObservationRoot,
  epochBpsFromReports,
  medianBankTenths,
  observeVerdict,
  oracleRuleAt,
  producerShareAlert,
  selectReportWindow,
  trimmedMeanBps,
  verifyMinerReport,
  windowBlocksFor,
} from './reserve_oracle.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../node/src/chain.js';
import { newIdentity } from './address.js';
import { vaultDest } from './flow_sheet.js';

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const PREV = 50;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reportsAt(tenths) {
  if (typeof tenths === 'number') {
    return POLICY_BANK_IDS.map((id) => ({ id, tenths }));
  }
  return POLICY_BANK_IDS.map((id) => ({ id, tenths: tenths[id] }));
}

function blocksOf(kind, n, tenths) {
  return Array.from({ length: n }, () => ({
    miner: kind,
    reports: reportsAt(tenths),
  }));
}

function mix(honestN, attackN, attackTenths) {
  return [
    ...blocksOf('honest', honestN, BUNDLED_POLICY_TENTHS),
    ...blocksOf('attacker', attackN, attackTenths),
  ];
}

describe('hardened miner median (3b)', () => {
  it('ships fixed at the genesis rate until the activation height', () => {
    assert.equal(ORACLE_ACTIVATION_HEIGHT, null);
    assert.equal(oracleRuleAt(1), 'fixed');
    assert.equal(oracleRuleAt(10_000, { activationHeight: null }), 'fixed');
    assert.equal(oracleRuleAt(99, { activationHeight: 100 }), 'fixed');
    assert.equal(oracleRuleAt(100, { activationHeight: 100 }), 'median3b');
    assert.equal(windowBlocksFor(MAGIC_TESTNET), ORACLE_WINDOW_TESTNET);
    assert.equal(windowBlocksFor(MAGIC_MAINNET), ORACLE_WINDOW_MAINNET);
    assert.equal(ORACLE_WINDOW_MS, 7 * DAY);
    const shifted = blocksOf('honest', 144, 15000);
    assert.equal(boundaryEpochBps({
      prevEpochBps: PREV,
      height: 50,
      activationHeight: 100,
      windowBlocks: shifted,
      windowSize: 144,
    }), GENESIS_BPS);
    assert.equal(boundaryEpochBps({
      prevEpochBps: PREV,
      height: 100,
      activationHeight: 100,
      windowBlocks: shifted,
      windowSize: 144,
    }), 1500);
  });

  it('K-1 steering cannot set the rate below a 2/3 share', () => {
    const alphas = [0.2, 0.34, 0.45, 0.5, 0.67];
    const widths = [144, 1008];
    const attacks = [800, -500, 10000];
    const rng = mulberry32(20261014);
    for (const tenths of attacks) {
      const attackerBps = trimmedMeanBps(Array(14).fill(tenths));
      for (const W of widths) {
        for (const alpha of alphas) {
          const attackN = Math.floor(alpha * W);
          const honestN = W - attackN;
          const fixed = epochBpsFromReports(PREV, mix(honestN, attackN, tenths), { windowSize: W });
          if (alpha < 1 / 3) assert.equal(fixed, GENESIS_BPS, `fixed ${alpha} ${W} ${tenths}`);
          else if (alpha < 2 / 3) {
            assert.notEqual(fixed, attackerBps, `fixed steal ${alpha} ${W} ${tenths}`);
            assert.ok(fixed === GENESIS_BPS || fixed === PREV);
          } else assert.equal(fixed, attackerBps, `fixed attacker ${alpha} ${W} ${tenths}`);

          let stolen = 0;
          let other = 0;
          for (let run = 0; run < 1000; run += 1) {
            const blocks = [];
            for (let i = 0; i < W; i += 1) {
              const attack = rng() < alpha;
              blocks.push({
                miner: attack ? 'attacker' : 'honest',
                reports: reportsAt(attack ? tenths : BUNDLED_POLICY_TENTHS),
              });
            }
            const got = epochBpsFromReports(PREV, blocks, { windowSize: W });
            if (got === attackerBps) stolen += 1;
            else if (got !== GENESIS_BPS && got !== PREV) other += 1;
          }
          assert.equal(other, 0, `other ${alpha} ${W} ${tenths}`);
          if (alpha < 2 / 3) assert.equal(stolen, 0, `stolen ${alpha} ${W} ${tenths}`);
          else assert.ok(stolen > 0, `attacker can win ${alpha} ${W} ${tenths}`);
        }
      }
    }
  });

  it('K-2 honest moves are adopted in full', () => {
    for (const bps of [250, 500, 1500]) {
      const blocks = blocksOf('honest', 144, bps * 10);
      const got = epochBpsFromReports(0, blocks, { windowSize: 144 });
      assert.equal(got, bps);
      assert.notEqual(got, 100);
    }
    assert.equal(medianBankTenths([1, 1, 9], 3), 1);
    assert.equal(medianBankTenths([1, 9, 9], 3), 9);
    assert.equal(medianBankTenths([1, 1, 9, 9], 4), null);
  });

  it('counts 2/3 over reporting blocks, and half the window must report', () => {
    const W = 144;
    const quiet = (n) => Array.from({ length: n }, () => ({ miner: 'quiet' }));
    const speak = (n, tenths) => blocksOf('honest', n, tenths);
    const adopted = trimmedMeanBps(Array(14).fill(15000));
    assert.equal(adopted, 1500);
    // 80/144 is 55.6%: at least half the window, and under 60%.
    const reporting = 80;
    assert.ok(reporting / W > 0.5 && reporting / W < 0.6);
    assert.ok(reporting * 2 >= W);
    assert.equal(
      epochBpsFromReports(PREV, [...speak(reporting, 15000), ...quiet(W - reporting)], { windowSize: W }),
      adopted,
      'a 50-60% reporting window adopts the new rate',
    );
    assert.equal(medianBankTenths(Array(reporting).fill(15000), W), 15000);
    const tooQuiet = Math.floor(W / 3) + 1;
    assert.ok(tooQuiet / W > 1 / 3);
    assert.ok((W - tooQuiet) * 2 >= W);
    assert.equal(
      epochBpsFromReports(PREV, [...speak(W - tooQuiet, 15000), ...quiet(tooQuiet)], { windowSize: W }),
      adopted,
      'silence above 1/3 still adopts when half the window reports',
    );
    const underHalf = Math.floor((W - 1) / 2);
    assert.ok(underHalf * 2 < W);
    assert.equal(
      epochBpsFromReports(PREV, [...speak(underHalf, 15000), ...quiet(W - underHalf)], { windowSize: W }),
      PREV,
      'under half reporting keeps the last rate',
    );
    assert.equal(medianBankTenths(Array(underHalf).fill(15000), W), null);
    const attackN = Math.floor(W / 3) - 1;
    assert.ok(attackN / W < 1 / 3);
    assert.equal(
      epochBpsFromReports(PREV, mix(W - attackN, attackN, 10000), { windowSize: W }),
      GENESIS_BPS,
      'steering under 1/3 stays on the bundle',
    );
    const belowTwoThirds = Math.floor((2 * W) / 3) - 1;
    const attackerBps = trimmedMeanBps(Array(14).fill(10000));
    assert.notEqual(
      epochBpsFromReports(PREV, mix(W - belowTwoThirds, belowTwoThirds, 10000), { windowSize: W }),
      attackerBps,
      'steering under 2/3 cannot install the attack',
    );
    const atTwoThirds = Math.ceil((2 * W) / 3);
    assert.equal(
      epochBpsFromReports(PREV, mix(W - atTwoThirds, atTwoThirds, 10000), { windowSize: W }),
      attackerBps,
      'a 2/3 reporting share can steer',
    );
    // Silence of exactly 1/3 leaves a reporting set. 2/3 of that set is
    // under 2/3 of the window, and it still freezes.
    const values = [1, 1, 1, 1, 9, 9];
    assert.equal(medianBankTenths(values, 9), 1);
    assert.ok(values.filter((v) => v === 1).length * 3 < 9 * 2);
  });

  it('K-3 the template carries no report and a 40% producer is an alert', () => {
    const who = vaultDest(newIdentity().address, { viewKey: newIdentity().viewKey });
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: who,
      finderDest: '',
      txs: [],
      bits: GENESIS_BITS_PACKED,
      now: T0,
    });
    assert.equal(tpl.txs[0].reports, undefined);
    assert.equal(tpl.txs[0].observe, undefined);
    assert.equal(observeVerdict(undefined).present, false);
    const heavy = [];
    for (let i = 0; i < 100; i += 1) heavy.push({ miner: i < 41 ? 'pool' : `h${i}` });
    const alert = producerShareAlert(heavy);
    assert.equal(alert.alert, true);
    assert.equal(alert.producer, 'pool');
    const even = [];
    for (let i = 0; i < 100; i += 1) even.push({ miner: i < 40 ? 'pool' : `h${i}` });
    assert.equal(producerShareAlert(even).alert, false);
    const boundary = 6720;
    const old = { miner: 'a', height: boundary - ORACLE_WINDOW_MAINNET - 1, reports: reportsAt(0) };
    const fresh = { miner: 'b', height: boundary - 1, reports: reportsAt(0) };
    const future = { miner: 'c', height: boundary, reports: reportsAt(0) };
    const week = selectReportWindow(
      [old, fresh, future],
      boundary,
      { magic: MAGIC_MAINNET },
    );
    assert.deepEqual(week.map((b) => b.miner), ['b']);
    assert.equal(ORACLE_WINDOW_MAINNET, 6720);
    assert.equal(ORACLE_WINDOW_TESTNET, 67);
  });

  it('K-4 a boundary reorg keeps only the winning window', () => {
    const W = 144;
    for (const k of [1, 10, 100]) {
      const forkA = blocksOf('honest', W, BUNDLED_POLICY_TENTHS);
      const forkB = blocksOf('honest', W, BUNDLED_POLICY_TENTHS);
      for (let i = 0; i < k; i += 1) forkB[i] = { miner: 'attacker', reports: reportsAt(10000) };
      const rateA = epochBpsFromReports(PREV, forkA, { windowSize: W });
      const rateB = epochBpsFromReports(PREV, forkB, { windowSize: W });
      let live = { epochBps: rateA, window: forkA.map((b) => b.miner) };
      const snap = JSON.parse(JSON.stringify(live));
      live = { epochBps: rateB, window: forkB.map((b) => b.miner) };
      assert.equal(live.epochBps, rateB);
      live = JSON.parse(JSON.stringify(snap));
      assert.equal(live.epochBps, rateA);
      assert.equal(epochBpsFromReports(PREV, forkA, { windowSize: W }), rateA);
      if (k === 100) assert.notEqual(rateA, rateB);
    }
  });

  it('K-5 a bad report rejects the block', async () => {
    const who = vaultDest(newIdentity().address, { viewKey: newIdentity().viewKey });
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
    function blockFor(reports, { digest = true, rateCommit = null } = {}) {
      const cb = { ...tpl.txs[0] };
      if (reports) cb.reports = reports;
      if (rateCommit) cb.rateCommit = rateCommit;
      const header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: digest ? merkleRoot([digestTx(cb)]) : decoded.merkleRoot,
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      return { ...tpl, header, txs: [cb] };
    }
    const good = reportsAt(BUNDLED_POLICY_TENTHS);
    assert.equal(verifyMinerReport(good).ok, true);
    const dup = good.map((row, i) => (i === good.length - 1 ? { id: 'FED', tenths: 1000 } : row));
    assert.equal(verifyMinerReport(dup).reason, 'report_dup');
    assert.equal((await verifyBlock(blockFor(dup), null, { probeBody: true })).reason, 'report_dup');
    const tooMany = good.concat([{ id: 'FED', tenths: 1 }]);
    assert.equal(tooMany.length, 15);
    assert.equal(verifyMinerReport(tooMany).reason, 'report_count');
    for (const tenths of [100001, -1001, 1.5, Number.NaN]) {
      const bad = reportsAt(BUNDLED_POLICY_TENTHS).map((row, i) => (i === 0 ? { ...row, tenths } : row));
      assert.equal(verifyMinerReport(bad).reason, 'bad_rate', String(tenths));
      const got = await verifyBlock(blockFor(bad), null, { probeBody: true });
      assert.equal(got.reason, 'bad_rate', String(tenths));
    }
    assert.equal(verifyMinerReport([{ id: 'SOFR', tenths: 100 }]).reason, 'bad_rate');
    const window = blocksOf('honest', 144, 2500);
    const commit = {
      epochIndex: 0,
      epochBps: 250,
      magic: MAGIC_TESTNET,
      attRoot: bundleObservationRoot(),
    };
    const fixed = await verifyBlock(blockFor(good, {
      rateCommit: commit,
    }), null, { probeBody: true, genesisMs: T0, magic: MAGIC_TESTNET });
    assert.equal(fixed.reason, 'rate_commit');
    const opened = await verifyBlock(blockFor(reportsAt(2500), {
      rateCommit: commit,
    }), null, {
      probeBody: true,
      genesisMs: T0,
      magic: MAGIC_TESTNET,
      oracleActivationHeight: 0,
      oracleWindow: window,
      oracleWindowSize: 144,
    });
    assert.equal(opened.reason, 'rate_commit');
  });
});
