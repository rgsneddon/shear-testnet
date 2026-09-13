import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const PUBLIC = [
  'site/index.html',
  'site/docs/content.js',
  'site/docs/index.html',
  'site/admin/index.html',
  'site/whitepaper/index.html',
  'site/whitepaper/build_pdf.py',
  'pool/public/index.html',
  'pool/public/explorer.html',
  'pool/public/miner.html',
  'mempool/index.html',
  'README.md',
  'wallet/README.md',
  'sheark-miner/README.md',
];

describe('public copy: dest privacy and per-hasher hash bonus', () => {
  it('states dest privacy, Copy dest mining, per-hasher bonus; keeps She is Private; omits this is not and worthy coin', () => {
    const joined = PUBLIC.map((rel) => read(rel)).join('\n');
    assert.match(joined, /She is Private/);
    assert.match(joined, /she1/);
    assert.match(joined, /ssa1/);
    assert.match(joined, /Copy dest/);
    assert.match(joined, /ssa1\.worker/);
    assert.match(joined, /hasher dest/);
    assert.match(joined, /1 SHE/);
    assert.match(joined, /ShearHash-v3/);
    assert.doesNotMatch(joined, /this is not/i);
    assert.doesNotMatch(joined, /worthy[ -]?coin/i);
    assert.doesNotMatch(joined, /ShearHash-v2/);

    const main = read('site/index.html');
    assert.match(main, /revolving dest/);
    assert.match(main, /ADMITV1 membership/);
    assert.match(main, /10,000 notes/);
    assert.match(main, /Copy dest \(<code>ssa1\.worker<\/code>\)/);
    assert.match(main, /own <code>kind:hash<\/code> payout/);

    const docs = read('site/docs/content.js');
    assert.match(docs, /next sealed block/);
    assert.match(docs, /Copy dest as <code>ssa1\.worker<\/code>/);

    const pool = read('pool/public/index.html');
    assert.match(pool, /Copy dest/);
    assert.match(pool, /Hash bonuses pay in full to each hasher dest/);
    assert.doesNotMatch(pool, /<th>From<\/th>/);
    assert.doesNotMatch(pool, /<th>Amount<\/th>/);
    assert.doesNotMatch(pool, /stem:true/);
    assert.doesNotMatch(joined, /RING_SIZE/);

    const expl = read('pool/public/explorer.html');
    assert.doesNotMatch(expl, /<th>From<\/th>/);
    assert.doesNotMatch(expl, /<th>Amount<\/th>/);
    assert.match(expl, /<th>Kind<\/th>/);

    const paper = read('site/whitepaper/index.html');
    assert.match(paper, /ShearHash-v3/);
    assert.match(paper, /hasher dest that produced proven work/);

    const readme = read('README.md');
    assert.match(readme, /Copy dest/);
    assert.match(readme, /own hash bonus on the next sealed block/);
    assert.match(readme, /shear-testnet-v3/);
    assert.doesNotMatch(readme, /Chain: `shear-testnet-v2`/);

    assert.doesNotMatch(joined, /Private dests, public amounts/);
    assert.doesNotMatch(joined, /amounts stay public/);
    assert.match(joined, /confidential amounts/);
    assert.match(joined, /ADMITV1/);
  });
});
