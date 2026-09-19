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
  'site/p2p/index.html',
  'site/r2r/index.html',
  'site/b2b/index.html',
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
    assert.match(main, /ADMITv2 membership/);
    assert.match(main, /10,000 notes/);
    assert.match(main, /ssa1\.worker|miner <code>ssa1<\/code>/);
    assert.match(main, /π SHE/);
    assert.match(main, /never 0/);

    const docs = read('site/docs/content.js');
    assert.match(docs, /next sealed payout|next sealed block/);
    assert.match(docs, /Copy dest as <code>ssa1\.worker<\/code>/);

    const pool = read('pool/public/index.html');
    assert.match(pool, /Copy dest/);
    assert.match(pool, /Hash bonus \(no pool fee\)/);
    assert.match(pool, /π SHE/);
    assert.doesNotMatch(pool, /<th>From<\/th>/);
    assert.doesNotMatch(pool, /<th>To<\/th>/);
    assert.doesNotMatch(pool, /<th>Amount<\/th>/);
    assert.match(pool, /<th>Type<\/th>/);
    assert.doesNotMatch(pool, /stem:true/);
    assert.doesNotMatch(joined, /RING_SIZE/);

    const expl = read('pool/public/explorer.html');
    assert.doesNotMatch(expl, /<th>From<\/th>/);
    assert.doesNotMatch(expl, /<th>Amount<\/th>/);
    assert.match(expl, /<th>Type<\/th>/);
    assert.doesNotMatch(expl, /<th>To<\/th>/);
    assert.doesNotMatch(expl, /<th>Kind<\/th>/);

    const paper = read('site/whitepaper/index.html');
    assert.match(paper, /ShearHash-v3/);
    assert.match(paper, /hasher dest that produced proven work/);

    const readme = read('README.md');
    assert.match(readme, /Wallet pin: \*\*0\.38\*\*/);
    assert.doesNotMatch(readme, /Wallet pin: \*\*0\.37\*\*/);
    assert.doesNotMatch(readme, /Wallet \*\*0\.37\*\* syncs/);
    assert.match(readme, /Copy dest/);
    assert.match(readme, /own hash bonus on the next sealed block/);
    assert.match(readme, /shear-testnet-v4/);
    assert.doesNotMatch(readme, /Chain: `shear-testnet-v2`/);
    assert.match(readme, /p2p\.shear\.digital:30303/);
    assert.match(readme, /r2r\.shear\.digital:30303/);
    assert.match(readme, /b2b\.shear\.digital:30303/);
    assert.match(joined, /p2p\.shear\.digital/);
    assert.match(joined, /r2r\.shear\.digital/);
    assert.match(joined, /b2b\.shear\.digital/);
    assert.doesNotMatch(joined, /46\.224\.132\.83/);
    assert.doesNotMatch(joined, /77\.42\.91\.84/);
    assert.doesNotMatch(joined, /157\.180\.70\.110/);
    assert.doesNotMatch(joined, /157\.180\.70\.100/);
    assert.doesNotMatch(joined, /2\.28\.8\.89/);
    assert.doesNotMatch(joined, /178\.105\.187\.178/);
    assert.doesNotMatch(joined, /178\.156\.222\.223/);
    const sheark = read('sheark-miner/README.md');
    assert.match(sheark, /magic `shear-testnet-v4`/);
    assert.doesNotMatch(sheark, /magic `shear-testnet-v2`/);

    assert.doesNotMatch(joined, /Private dests, public amounts/);
    assert.doesNotMatch(joined, /amounts stay public/);
    assert.doesNotMatch(docs, /explorer reports amounts, dests/);
    assert.match(docs, /no dest, no amount/);
    assert.match(joined, /confidential amounts/);
    assert.match(joined, /ADMITv2/);
    assert.match(joined, /https:\/\/shear\.digital\/docs\//);
    assert.match(joined, /cleartext TCP/);
    assert.match(main, /ShearK-Miner <strong>2\.4<\/strong>/);
    assert.doesNotMatch(main, /shear-wallet-0\.38-macos\.dmg/);
    assert.match(main, /shear-wallet-0\.38-android\.apk/);
    assert.match(main, /id="solo-deps"/);
    assert.match(main, /apt-get install -y git curl build-essential cmake/);
    assert.match(main, /rustup\.rs/);
    assert.match(main, /crypto\/native/);
    assert.match(main, /NODE_INC|node_api\.h/);
    assert.match(main, /Darwin/);
    assert.match(main, /Wrong dest/);
    assert.match(main, /cleartext TCP/);
    assert.match(main, /live epoch pot/);
    assert.doesNotMatch(pool, /shear-testnet-v3/);
    assert.match(main, /A launch date is not decided/);
    assert.doesNotMatch(main, /2026-09-18T21:00:00/);
    assert.doesNotMatch(docs, /2026-09-18T21:00:00/);
    assert.doesNotMatch(read('site/admin/index.html'), /2026-09-18T21:00:00/);
    assert.doesNotMatch(readme, /2026-09-18T21:00:00/);
    assert.match(readme, /not yet scheduled/);
  });

  it('clone and operator handoff stay on merged main, not feat/admit-v2', () => {
    const readme = read('README.md');
    const ops = read('HANDOFF_OPS.md');
    assert.match(readme, /git checkout main/);
    assert.doesNotMatch(readme, /git checkout feat\/admit-v2/);
    assert.match(ops, /\*\*Working branch:\*\* `main`/);
    assert.doesNotMatch(ops, /\*\*Working branch:\*\* `feat\/admit-v2`/);
    assert.match(ops, /git checkout main/);
    assert.doesNotMatch(ops, /git checkout feat\/admit-v2/);
    assert.match(ops, /Pins are \*\*0\.38\*\*/);
    assert.doesNotMatch(ops, /Pins are \*\*0\.37\*\*/);
    assert.match(ops, /Pin \*\*0\.38\*\*/);
    assert.doesNotMatch(ops, /Pin \*\*0\.37\*\*/);
  });

  it('MacBook handoff points at merged GitHub main, 0.38 tag, and pack_macos.sh', () => {
    const md = read('MACBOOK_HANDOFF.md');
    assert.match(md, /https:\/\/github\.com\/rgsneddon\/shear-testnet/);
    assert.match(md, /blob\/main\/MACBOOK_HANDOFF\.md/);
    assert.match(md, /releases\/tag\/0\.38/);
    assert.match(md, /pack_macos\.sh/);
    assert.match(md, /shear-wallet-0\.38-macos\.dmg/);
  });
});
