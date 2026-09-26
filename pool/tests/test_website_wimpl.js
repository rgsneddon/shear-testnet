import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(rel) {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
}

describe('website W-IMPL binds', () => {
  const explorer = read('../public/explorer.html');
  const pool = read('../public/index.html');
  const mempool = read('../../mempool/index.html');

  it('explorer labels pool hashrate and nodes online without inventing network fields', () => {
    assert.match(explorer, /Pool hashrate/);
    assert.doesNotMatch(explorer, /Network hashrate/);
    assert.match(explorer, /setText\('ex-hashrate', fmtRate\(stats\.hashrate\)\)/);
    assert.doesNotMatch(explorer, /networkHashrate/);
    assert.match(explorer, /Nodes online/);
    assert.match(explorer, /id="ex-nodes-online"/);
    assert.match(explorer, /setText\('ex-nodes-online', String\(Math\.max\(0, Number\(stats\.nodesOnline\) \|\| 0\)\)\)/);
    assert.doesNotMatch(explorer, /id="ex-reserve-minted"/);
    assert.doesNotMatch(explorer, /Shear minted by Reserve/);
    assert.match(explorer, /id="ex-reserve-vault"/);
    assert.doesNotMatch(explorer, /fully synced/);
  });

  it('explorer age follows tipAt or a recent block .at, not lastFoundAt', () => {
    assert.match(explorer, /stats\.tipAt \|\| stats\.tipSealAt/);
    assert.match(explorer, /rows\[bi\]\.kind === 'block'/);
    assert.match(explorer, /rows\[bi\]\.at/);
    assert.doesNotMatch(explorer, /lastFoundAt/);
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

  it('wallet pin 0.53 stays on explorer, pool, mempool, and the whitepaper PDF source', () => {
    const paper = read('../../site/whitepaper/index.html');
    const pdf = read('../../site/whitepaper/build_pdf.py');
    assert.match(explorer, /releases\/tag\/0\.53/);
    assert.match(pool, /releases\/tag\/0\.53/);
    assert.match(mempool, /releases\/tag\/0\.53/);
    assert.match(pdf, /pin 0\.53/);
    assert.match(pdf, /Wallet pin at publication: 0\.53/);
    assert.match(pdf, /wallet-0\.53/);
    assert.match(paper, /a class="nav-btn"/);
    assert.match(paper, /href="https:\/\/shear\.digital"/);
    assert.doesNotMatch(paper, /prettier/);
    assert.match(explorer, /id="shear-wordmark"/);
    assert.match(explorer, /class="top-banner"/);
    assert.match(pool, /class="top-banner"/);
  });
});
