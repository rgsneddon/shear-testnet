import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { encodeHeader } from '../../crypto/header.js';

function read(rel) {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
}

describe('website W-IMPL binds', () => {
  const explorer = read('../public/explorer.html');
  const pool = read('../public/index.html');
  const mempool = read('../../mempool/index.html');

  it('explorer labels ongoing hashbonus work as this-round hashes in nanos', () => {
    assert.match(explorer, /ONGOING HASHBONUS WORK/);
    assert.doesNotMatch(explorer, /All network hashrate/);
    assert.doesNotMatch(explorer, /Pool hashrate/);
    assert.match(explorer, /function ongoingHashbonusHashes\(stats\)/);
    assert.match(explorer, /function fmtHashNanos\(hashes\)/);
    assert.match(explorer, /networkRoundHashes/);
    assert.match(explorer, /roundHashes/);
    assert.match(explorer, /1000000000/);
    assert.match(explorer, /setText\('ex-hashrate', fmtHashNanos\(ongoingHashbonusHashes\(stats\)\)\)/);
    assert.doesNotMatch(explorer, /fmtRate\(stats\.hashrate\)/);
    assert.doesNotMatch(explorer, /fmtRate\(allNetworkHashrate\(stats\)\)/);
    assert.match(explorer, /Nodes online/);
    assert.match(explorer, /id="ex-nodes-online"/);
    assert.match(explorer, /setText\('ex-nodes-online', String\(Math\.max\(0, Number\(stats\.nodesOnline\) \|\| 0\)\)\)/);
    assert.doesNotMatch(explorer, /id="ex-reserve-minted"/);
    assert.doesNotMatch(explorer, /Shear minted by Reserve/);
    assert.match(explorer, /id="ex-reserve-vault"/);
    assert.doesNotMatch(explorer, /fully synced/);
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
    assert.match(explorer, /\(avgPot \+ avgBonus\) \/ avgH/);
    assert.doesNotMatch(explorer, /avgBlockReward/);
    assert.doesNotMatch(explorer, /avgBlockTime/);
    assert.doesNotMatch(explorer, /POOL_FEE/);
    assert.doesNotMatch(explorer, /Math\.min\(\s*avg/);
  });

  it('pool heading is pool-scoped and circulating subtitle does not say spendable people', () => {
    assert.match(pool, /Last Block \(pool\)/);
    assert.match(pool, /Pool hashrate/);
    assert.match(explorer, /Circulating supply\. Dest tags are not listed as people\./);
    assert.doesNotMatch(explorer, /Spendable SHE/);
  });

  it('mempool mobile navbar matches the shared gutter without a restyle', () => {
    assert.match(mempool, /@media \(max-width: 1024px\) \{[\s\S]*header\.top-banner \{[\s\S]*grid-template-columns: 1fr auto;/);
    assert.match(mempool, /header\.top-banner \{[\s\S]*grid-template-columns: 1fr auto 1fr;/);
    assert.match(mempool, /canvas id="lattice"/);
    assert.match(mempool, /--lattice-bg/);
    assert.doesNotMatch(mempool, /prettier/);
  });

  it('wallet pin 0.54 stays on explorer, pool, mempool, and the whitepaper PDF source', () => {
    const paper = read('../../site/whitepaper/index.html');
    const pdf = read('../../site/whitepaper/build_pdf.py');
    assert.match(explorer, /releases\/tag\/0\.54/);
    assert.match(pool, /releases\/tag\/0\.54/);
    assert.match(mempool, /releases\/tag\/0\.54/);
    assert.match(pdf, /pin 0\.54/);
    assert.match(pdf, /Wallet pin at publication: 0\.54/);
    assert.match(pdf, /wallet-0\.54/);
    assert.match(paper, /a class="nav-btn"/);
    assert.match(paper, /href="https:\/\/shear\.digital"/);
    assert.doesNotMatch(paper, /prettier/);
    assert.match(explorer, /id="shear-wordmark"/);
    assert.match(explorer, /class="top-banner"/);
    assert.match(pool, /class="top-banner"/);
  });
});
