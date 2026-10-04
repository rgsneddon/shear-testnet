import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { encodeHeader } from '../../crypto/header.js';
import { intervalCertify } from '../src/posture.js';

function read(rel) {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
}

describe('website W-IMPL binds', () => {
  const explorer = read('../../explorer/explorer.html');
  const poolExplorer = read('../public/explorer.html');
  const pool = read('../public/index.html');
  const mempool = read('../../mempool/index.html');

  it('explorer labels ongoing hashbonus work as this-round hashes in nanos', () => {
    assert.match(explorer, /ONGOING HASHBONUS WORK/);
    assert.doesNotMatch(explorer, /All network hashrate/);
    assert.doesNotMatch(explorer, /Pool hashrate/);
    assert.match(explorer, /function ongoingHashbonusHashes\(stats\)/);
    assert.match(explorer, /function fmtHashNanos\(hashes, unitNanos\)/);
    assert.match(explorer, /networkRoundHashes/);
    assert.doesNotMatch(explorer, /stats\.workers/);
    assert.doesNotMatch(explorer, /stats\.avgBlockTimeMs/);
    assert.match(explorer, /1000000000/);
    assert.match(explorer, /setText\('ex-hashrate', fmtHashNanos\(ongoingHashbonusHashes\(stats\), stats && stats\.hashBonusNanos\) \+ ' SHE'\)/);
    assert.doesNotMatch(explorer, /fmtRate\(stats\.hashrate\)/);
    assert.doesNotMatch(explorer, /fmtRate\(allNetworkHashrate\(stats\)\)/);
    assert.match(explorer, /Nodes online/);
    assert.match(explorer, /id="ex-nodes-online"/);
    assert.match(explorer, /setText\('ex-nodes-online', String\(Math\.max\(0, Number\(stats\.nodesOnline\) \|\| 0\)\)\)/);
    assert.doesNotMatch(explorer, /id="ex-reserve-minted"/);
    assert.doesNotMatch(explorer, /Shear minted by Reserve/);
    assert.match(explorer, /id="ex-reserve-vault"/);
    assert.doesNotMatch(explorer, /fully synced/);
    const start = explorer.indexOf('function ongoingHashbonusHashes');
    const end = explorer.indexOf('function fmtHashNanos');
    const fn = explorer.slice(start, end);
    const withNetwork = vm.runInNewContext(`${fn}\nongoingHashbonusHashes({ networkRoundHashes: 12, workers: [{ roundHashes: 99 }] });`);
    const poolOnly = vm.runInNewContext(`${fn}\nongoingHashbonusHashes({ workers: [{ roundHashes: 99 }] });`);
    assert.equal(withNetwork, 12);
    assert.equal(poolOnly, 0);
    const poolSrc = read('../src/pool.js');
    assert.match(poolSrc, /networkAvgBlockTimeMs: avgBlockIntervalMs\(store\.blocks\)/);
    assert.doesNotMatch(poolSrc, /networkAvgBlockTimeMs: avgMs/);
    assert.match(poolSrc, /avgBlockTimeMs: avgMs/);
  });

  it('explorer last block is the network tip, not the pool find clock', () => {
    assert.match(explorer, /function headerTipMs\(hex\)/);
    assert.match(explorer, /function networkTipBlock\(stats, rows\)/);
    assert.match(explorer, /function paintLastBlock\(\)/);
    assert.match(explorer, /row\.kind !== 'block'/);
    assert.match(explorer, /Math\.max\(tipH, bestH\)/);
    assert.match(explorer, /headerTipMs\(stats && stats\.header\)/);
    assert.match(explorer, /'#' \+ lastBlockHeight/);
    assert.match(explorer, /network tip #/);
    assert.doesNotMatch(explorer, /lastFoundAt/);
    assert.doesNotMatch(explorer, /stats\.tipAt \|\| stats\.tipSealAt/);
    const start = explorer.indexOf('function headerTipMs');
    const end = explorer.indexOf('function paintLastBlock');
    assert.ok(start > 0 && end > start);
    const sandbox = {};
    vm.createContext(sandbox);
    const api = vm.runInContext(
      `${explorer.slice(start, end)}\n({ headerTipMs, networkTipBlock });`,
      sandbox,
    );
    const z = Buffer.alloc(32, 7);
    const tipMs = 1790425066464;
    const header = encodeHeader({
      prevBlockHash: z,
      merkleRoot: z,
      continuityRoot: z,
      timestamp: BigInt(tipMs),
      bits: 783090,
    }).toString('hex');
    assert.equal(api.headerTipMs(header), tipMs);
    assert.equal(api.headerTipMs('abcd'), 0);
    const poolFind = tipMs + 8000;
    const outOfOrder = api.networkTipBlock({
      height: 1213,
      header,
      lastFoundAt: poolFind,
    }, [
      { kind: 'lock', height: 0, at: poolFind, id: 'lock-old' },
      { kind: 'block', height: 10, at: tipMs - 500000, id: 'low' },
      { kind: 'block', height: 1213, at: tipMs - 1, id: 'tip-row' },
      { kind: 'block', height: 1212, at: tipMs - 90000, id: 'prev' },
    ]);
    assert.equal(outOfOrder.height, 1213);
    assert.equal(outOfOrder.at, tipMs);
    assert.equal(outOfOrder.id, 'tip-row');
    assert.notEqual(outOfOrder.at, poolFind);
    const headerOnly = api.networkTipBlock({
      height: 1213,
      header,
      lastFoundAt: poolFind,
    }, [
      { kind: 'block', height: 100, at: poolFind, id: 'slice' },
    ]);
    assert.equal(headerOnly.height, 1213);
    assert.equal(headerOnly.at, tipMs);
    assert.equal(headerOnly.id, '');
    const rowOnly = api.networkTipBlock({ height: 0, header: '' }, [
      { kind: 'block', height: 4, at: tipMs - 1000, id: 'a' },
      { kind: 'block', height: 9, at: tipMs, id: 'book-tip' },
    ]);
    assert.equal(rowOnly.height, 9);
    assert.equal(rowOnly.at, tipMs);
    assert.equal(rowOnly.id, 'book-tip');
  });

  it('explorer avg card is the sealed gross pot over height', () => {
    assert.match(explorer, /Average block reward since genesis/);
    assert.match(explorer, /id="ex-avg-reward"/);
    assert.match(explorer, /fmtShe\(\(avgPot \+ avgBonus\) \/ avgH \/ NANOS\)/);
    assert.doesNotMatch(explorer, /avgBlockReward/);
    assert.doesNotMatch(explorer, /fmtShe\([^)]*avgBlockTime/);
    assert.doesNotMatch(explorer, /POOL_FEE/);
    assert.doesNotMatch(explorer, /Math\.min\(\s*avg/);
  });

  it('pool avg card prefers sealed networkAvgBlockTimeMs, not EWMA paint', () => {
    assert.match(pool, /Average block time \(sealed, all blocks\)/);
    assert.match(pool, /networkAvgBlockTimeMs/);
    assert.match(pool, /Number\.isFinite\(net\) && net > 0\) \? net : \(s && s\.avgBlockTimeMs\)/);
    assert.doesNotMatch(pool, /chainAvgMs/);
    assert.doesNotMatch(pool, /\(chainAvgMs != null\) \? chainAvgMs : \(s && s\.avgBlockTimeMs\)/);
    assert.match(pool, /id="block-bits"/);
    assert.match(pool, /id="share-bits"/);
    assert.match(pool, /shareBits is not a retarget/);
  });

  it('tip page observed card shows soaking n and refuses ~90s certified below 288', () => {
    const site = read('../../site/js/site.js');
    const home = read('../../site/index.html');
    const network = read('../../site/network.html');
    assert.match(home, /id="nc-observed"/);
    assert.match(network, /id="nc-observed"/);
    assert.match(site, /soaking n=/);
    assert.match(site, /~90s not certified/);
    const soakAt = site.indexOf('gate.soaking');
    const certAt = site.indexOf('gate.certified90s');
    assert.ok(soakAt > 0 && certAt > soakAt);
    const start = site.indexOf('function setText');
    const end = site.indexOf('function paintFluxset');
    const src = site.slice(start, end);
    function paint(interval, observedMs) {
      return vm.runInNewContext(
        `const bag = {};
         function setText(id, text) { bag[id] = String(text); }
         ${src.replace('function setText(id, text) {', 'function setTextUnused(id, text) {')}
         var NANOS = 100000000000;
         paintContinuity({
           blockSubsidyNanos: 100000000000,
           targetBlockIntervalMs: 90000,
           networkAvgBlockTimeMs: ${observedMs},
           interval: ${JSON.stringify(interval)}
         });
         bag['nc-observed'];`,
      );
    }
    for (const n of [0, 12, 287]) {
      const gate = intervalCertify({ sealedSamples: n, ewmaMs: 90000, sealedMeanMs: 90000 });
      assert.equal(gate.soaking, true);
      assert.equal(gate.certified90s, false);
      assert.equal(gate.readyOnInterval, false);
      const thin = paint(gate, 90000);
      assert.match(thin, new RegExp(`soaking n=${n}`));
      assert.match(thin, /~90s not certified/);
      assert.equal(thin.includes('~90s certified'), false);
      const lied = paint({ ...gate, certified90s: true, readyOnInterval: true }, 90000);
      assert.match(lied, /~90s not certified/);
      assert.equal(lied.includes('~90s certified'), false);
    }
    const fullGate = intervalCertify({ sealedSamples: 288, ewmaMs: 90000, sealedMeanMs: 90000 });
    assert.equal(fullGate.soaking, false);
    assert.equal(fullGate.certified90s, true);
    assert.equal(fullGate.readyOnInterval, true);
    const full = paint(fullGate, 90000);
    assert.match(full, /n=288 ~90s certified/);
    assert.equal(full.includes('not certified'), false);
    const offGate = intervalCertify({ sealedSamples: 288, ewmaMs: 120000, sealedMeanMs: 120000 });
    assert.equal(offGate.soaking, false);
    assert.equal(offGate.certified90s, false);
    assert.equal(offGate.readyOnInterval, false);
    const off = paint(offGate, 120000);
    assert.match(off, /observational n=288/);
    assert.equal(off.includes('certified'), false);
    const bare = vm.runInNewContext(
      `const bag = {};
       function setText(id, text) { bag[id] = String(text); }
       ${src.replace('function setText(id, text) {', 'function setTextUnused(id, text) {')}
       var NANOS = 100000000000;
       paintContinuity({ blockSubsidyNanos: 100000000000, targetBlockIntervalMs: 90000, networkAvgBlockTimeMs: 90000 });
       bag['nc-observed'];`,
    );
    assert.match(bare, /~90s not certified/);
    assert.equal(bare.includes('~90s certified'), false);
  });

  it('explorer avg block time is sealed networkAvgBlockTimeMs, not EWMA paint', () => {
    assert.match(explorer, /id="ex-avg-block"/);
    assert.match(explorer, /Avg block time/);
    assert.match(explorer, /var avgBt = Number\(stats\.networkAvgBlockTimeMs\)/);
    assert.match(explorer, /~90s not certified/);
    assert.match(explorer, /soaking n=/);
    assert.match(explorer, /setText\('ex-avg-block', avgLabel\)/);
    assert.doesNotMatch(explorer, /stats\.avgBlockTimeMs/);
    assert.doesNotMatch(explorer, /chainAvgMs/);
    assert.doesNotMatch(explorer, /certified90s &&/);
    const card = explorer.slice(explorer.indexOf('id="ex-avg-block"') - 80, explorer.indexOf('id="ex-avg-block"') + 40);
    console.log('EXPLORER_PAGE ' + card.replace(/\s+/g, ' ').trim());
  });

  it('pool heading is pool-scoped and circulating subtitle does not say spendable people', () => {
    assert.match(pool, /Last Block \(pool\)/);
    assert.match(pool, /Pool hashrate/);
    assert.match(explorer, /Circulating supply\. Dest tags are not listed as people\./);
    assert.doesNotMatch(explorer, /Spendable SHE/);
  });

  it('mempool mobile navbar matches the shared gutter without a restyle', () => {
    assert.match(mempool, /@media \(max-width: 1024px\) \{[\s\S]*\.hud \{ grid-template-columns:1fr;/);
    assert.match(mempool, /header\.top-banner \{[\s\S]*grid-template-columns: 1fr auto 1fr;/);
    assert.match(mempool, /canvas id="lattice"/);
    assert.match(mempool, /--lattice-bg/);
    assert.doesNotMatch(mempool, /prettier/);
  });

  it('wallet pin 0.69 stays on explorer, pool, mempool, and the whitepaper PDF source', () => {
    const paper = read('../../site/whitepaper/index.html');
    const pdf = read('../../site/whitepaper/build_pdf.py');
    assert.match(explorer, /id="shear-chrome-root" data-active="EXPLORER"/);
    assert.doesNotMatch(explorer, /releases\/tag\/0\.55(?!\.)/);
    assert.doesNotMatch(explorer, /releases\/tag\/0\.52/);
    assert.match(poolExplorer, /href="https:\/\/shear\.digital\/wallet\/"/);
    assert.doesNotMatch(poolExplorer, /github\.com/);
    assert.doesNotMatch(poolExplorer, /releases\/tag\/0\.55(?!\.)/);
    assert.match(pool, /id="shear-chrome-root" data-active="POOL"/);
    assert.doesNotMatch(pool, /releases\/tag\/0\.55(?!\.)/);
    assert.doesNotMatch(pool, /releases\/tag\/0\.52/);
    assert.match(mempool, /id="shear-chrome-root" data-active="MEMPOOL"/);
    assert.doesNotMatch(mempool, /releases\/tag\/0\.55(?!\.)/);
    assert.doesNotMatch(mempool, /releases\/tag\/0\.52/);
    assert.match(pdf, /shear-testnet-v10/);
    assert.doesNotMatch(pdf, /shear-testnet-v6/);
    assert.match(pdf, /pin 0\.69/);
    assert.doesNotMatch(pdf, /pin 0\.66/);
    assert.doesNotMatch(pdf, /pin 0\.55(?!\.2)/);
    assert.match(pdf, /Wallet pin at publication: 0\.69/);
    assert.match(pdf, /wallet-0\.69/);
    assert.doesNotMatch(pdf, /wallet-0\.66/);
    assert.doesNotMatch(pdf, /ShearK-2\.6/);
    assert.doesNotMatch(pdf, /pool\.shear\.digital:1111/);
    assert.doesNotMatch(pdf, /wallet-0\.55(?!\.2)/);
    assert.match(paper, /a class="nav-btn"/);
    assert.match(paper, /href="https:\/\/shear\.digital\/"/);
    assert.doesNotMatch(paper, /prettier/);
    assert.match(read('../../explorer/shared/shear-chrome.js'), /id="shear-wordmark"/);
    assert.match(explorer, /shear-chrome\.js/);
    assert.match(poolExplorer, /id="shear-wordmark"/);
    assert.match(poolExplorer, /class="top-banner"/);
    assert.match(pool, /\.top-banner \{/);
    assert.match(pool, /shear-chrome\.js/);
  });

  it('v10 docs name the fingerprint, the seed, and the quarantine', () => {
    const consensus = read('../../specs/consensus.md');
    const ops = read('../../docs/OPS-testnet-v10-90s.md');
    for (const doc of [consensus, ops]) {
      assert.match(doc, /shear-testnet-v10/);
      assert.match(doc, /median11/);
      assert.match(doc, /fluctuat/);
      assert.match(doc, /seed/);
      assert.match(doc, /τ=32T/);
      assert.match(doc, /288/);
      assert.match(doc, /invent-must-not-return/);
      assert.match(doc, /6054186/);
      assert.match(doc, /v8/);
      assert.match(doc, /v9/);
    }
    assert.match(ops, /last resort/);
    assert.match(pool, /id="block-bits"/);
    assert.match(pool, /id="share-bits"/);
    assert.match(pool, /shareBits is not a retarget/);
    assert.match(explorer, /id="ex-avg-block"/);
    assert.match(explorer, /networkAvgBlockTimeMs/);
    assert.match(ops, /shareBits`\) is not a retarget/);
    const ready = pool.match(/Ready to copy[^'\n]*/);
    assert.ok(ready);
    assert.doesNotMatch(ready[0], /avgBlockTimeMs/);
  });
});
