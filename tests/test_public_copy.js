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
    assert.match(main, /not instant/);
    assert.match(main, /6\+ confs while the pool shows sent/);
    assert.match(main, /wallet\/sync bug/);
    assert.match(main, /https:\/\/shear\.digital\/docs\//);
    assert.match(main, /Never <code>npm run pool<\/code>/);

    const docs = read('site/docs/content.js');
    assert.match(docs, /https:\/\/shear\.digital\/whitepaper\//);
    assert.doesNotMatch(docs, /href="https:\/\/whitepaper\.shear\.digital"/);
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
    assert.match(readme, /Wallet pin: \*\*0\.44\*\*/);
    assert.doesNotMatch(readme, /Wallet pin: \*\*0\.41\*\*/);
    assert.doesNotMatch(readme, /Wallet pin: \*\*0\.40\*\*/);
    assert.doesNotMatch(readme, /Wallet pin: \*\*0\.39\*\*/);
    assert.doesNotMatch(readme, /Wallet pin: \*\*0\.38\*\*/);
    assert.doesNotMatch(readme, /Wallet \*\*0\.38\*\* syncs/);
    const walletReadme = read('wallet/README.md');
    assert.match(walletReadme, /releases\/tag\/0\.44/);
    assert.match(walletReadme, /shear-wallet-0\.44-windows\.zip/);
    assert.match(walletReadme, /shear-wallet-0\.44-linux\.zip/);
    assert.match(walletReadme, /shear-wallet-0\.44-archlinux\.zip/);
    assert.match(walletReadme, /shear-wallet-0\.44-android\.apk/);
    assert.doesNotMatch(walletReadme, /shear-wallet-0\.40-/);
    assert.doesNotMatch(walletReadme, /releases\/tag\/0\.39/);
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
    assert.match(main, /ShearK-Miner <strong>2\.5<\/strong>/);
    assert.match(main, /Continuum GUI <strong>0\.44<\/strong>/);
    assert.doesNotMatch(main, /Continuum GUI <strong>0\.40<\/strong>/);
    assert.doesNotMatch(main, /Continuum GUI 0\.40/);
    const help = read('node/src/help.js');
    assert.match(help, /Continuum 0\.44/);
    assert.doesNotMatch(help, /Continuum 0\.40/);
    assert.doesNotMatch(main, /shear-wallet-0\.38-macos\.dmg/);
    assert.match(main, /shear-wallet-0\.44-android\.apk/);
    assert.match(main, /id="solo-deps"/);
    assert.match(main, /apt-get install -y git curl build-essential cmake/);
    assert.match(main, /role="tablist"/);
    assert.match(main, /dnf groupinstall -y "Development Tools"/);
    assert.match(main, /pacman -Syu --needed base-devel/);
    assert.match(main, /zypper install -t pattern devel_C_C\+\+/);
    assert.match(main, /brew install git cmake python pkg-config openssl node rust/);
    assert.match(main, /wsl --install -d Ubuntu/);
    assert.match(main, /data-copy="solo-deps-fedora"/);
    assert.match(main, /data-copy="solo-deps-arch"/);
    assert.match(main, /data-copy="solo-deps-suse"/);
    assert.match(main, /data-copy="solo-deps-macos"/);
    assert.match(main, /data-copy="solo-deps-windows"/);
    assert.match(main, /Never copy a Darwin/);
    assert.match(main, /rustup\.rs/);
    assert.match(main, /crypto\/native/);
    assert.match(main, /NODE_INC|node_api\.h/);
    assert.match(main, /Headers check/);
    assert.match(main, /node_prefix/);
    assert.match(main, /data-copy="solo-headers-debian"/);
    assert.match(main, /data-copy="solo-nodeinc-debian"/);
    assert.match(main, /NODE_INC=\./);
    assert.match(main, /Missing node_api\.h/);
    assert.match(readme, /Headers check/);
    assert.match(readme, /node_prefix/);
    assert.match(readme, /NODE_INC=\./);
    assert.match(main, /p2p\.shear\.digital:30303,r2r\.shear\.digital:30303,b2b\.shear\.digital:30303/);
    assert.match(main, /same shell/);
    assert.match(main, /Stuck at height=0 \/ want=0 \/ ibd=false/);
    assert.match(main, /nc -vz p2p\.shear\.digital 30303/);
    assert.match(main, /want>0/);
    assert.match(main, /ibd=true/);
    assert.match(main, /live peer tip/);
    assert.doesNotMatch(main, /IBD is only true while/);
    assert.match(readme, /live peer/);
    assert.doesNotMatch(readme, /IBD is only `want>0`/);
    assert.match(main, /egress\/DNS/);
    assert.match(main, /data-copy="solo-sync-fix"/);
    assert.match(readme, /same shell.*npm run solo|npm run solo/);
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
    assert.match(ops, /Pins are \*\*0\.44\*\*/);
    assert.doesNotMatch(ops, /Pins are \*\*0\.42\*\*/);
    assert.doesNotMatch(ops, /Pins are \*\*0\.41\*\*/);
    assert.match(ops, /Pin \*\*0\.44\*\*/);
    assert.doesNotMatch(ops, /Pin \*\*0\.42\*\*/);
    assert.doesNotMatch(ops, /Pin \*\*0\.41\*\*/);
  });

  it('MacBook handoff is Apple-only 0.44 + ShearK 2.5 macOS; old handoff files are gone', () => {
    assert.equal(fs.existsSync(path.join(root, 'MACBOOK_HANDOFF.md')), false);
    assert.equal(fs.existsSync(path.join(root, 'WINDOWS_HANDOFF.md')), false);
    const md = read('CONTINUUM-0.44-MAC-HANDOFF.md');
    assert.match(md, /https:\/\/github\.com\/rgsneddon\/shear-testnet/);
    assert.match(md, /blob\/main\/CONTINUUM-0\.44-MAC-HANDOFF\.md/);
    assert.match(md, /releases\/tag\/0\.44/);
    assert.match(md, /pack_macos\.sh/);
    assert.match(md, /shear-wallet-0\.44-macos\.dmg/);
    assert.match(md, /shear-0\.44-macos/);
    assert.match(md, /ShearK-Miner-2\.5-macos\.zip/);
    assert.match(md, /rgsneddon\/ShearK/);
    assert.match(md, /MacBook only/);
    assert.doesNotMatch(md, /MACBOOK_HANDOFF\.md/);
    assert.doesNotMatch(md, /WINDOWS_HANDOFF\.md/);
  });
});
