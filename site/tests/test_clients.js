import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../index.html'),
  'utf8',
);

describe('shear.digital client buttons', () => {
  it('places BIG WALLET / MINER / NODE buttons between the hero banner and the Shear box', () => {
    const hero = html.indexOf('class="hero"');
    const clients = html.indexOf('id="client-downloads"');
    const testnet = html.indexOf('id="testnet-banner"');
    const shear = html.indexOf('<h1>Shear</h1>');
    const continuity = html.indexOf('id="network-continuity"');
    assert.ok(hero >= 0 && clients > hero && testnet > clients && shear > testnet);
    assert.ok(continuity > shear);
    assert.match(html, /id="intro-split"/);
    assert.match(html, /Network continuity/);
    assert.match(html, /Closure quantum/);
    assert.match(html, /Each found block closes exactly one coin, forever\./);
    assert.match(html, /Integral Q/);
    assert.match(html, /Emissions and circulation stats of the Shear network/);
    assert.match(html, /Total circulation of Shear coins/);
    assert.match(html, /circulatingNanos/);
    assert.match(html, /function fmtCirc/);
    assert.doesNotMatch(html, /whole chain/);
    assert.doesNotMatch(html, /Hash bonuses sit on top/);
    assert.doesNotMatch(html, /id="nc-height"/);
    assert.doesNotMatch(html, /id="nc-nodes"/);
    assert.doesNotMatch(html, /intro-live/);
    assert.doesNotMatch(html, /Pool hashrate|Workers online|Last block/);
    const left = html.slice(html.indexOf('<h1>Shear</h1>'), html.indexOf('id="network-continuity"'));
    assert.match(left, /class="she-private"/);
    assert.match(left, /She is Private/);
    assert.match(left, /Private dests, public amounts/);
    assert.match(left, /PoW elects the tip/);
    assert.doesNotMatch(left, /Private by default/);
    assert.doesNotMatch(left, /Proof of work only/);
    assert.doesNotMatch(left, /She is<br/);
    assert.match(html, /Great Vibes/);
    const dag = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../dag/index.html'),
      'utf8',
    );
    assert.match(dag, /\/api\/explorer\/dag/);
    assert.match(dag, /spy glass/);
    assert.match(dag, /liveFromBook/);
    assert.doesNotMatch(dag, /HASH_BUNDLE/);
    assert.match(dag, /releases\/tag\/0\.31/);
    assert.doesNotMatch(dag, /releases\/tag\/0\.15/);
    assert.doesNotMatch(dag, /releases\/tag\/0\.13/);
    assert.doesNotMatch(dag, /releases\/tag\/0\.12/);
    assert.match(html, /white-space: nowrap/);
    assert.match(html, /text-align: left/);
    assert.match(html, /color: #0d2b55/);
    assert.match(html, /color: #c9d3de/);
    assert.doesNotMatch(html, /she-glitter|she-sparkle|d4af37|#c9a227/);
    assert.doesNotMatch(left, />Height</);
    assert.doesNotMatch(left, /Nodes online/);
    assert.match(html, /\/api\/stats/);
    assert.doesNotMatch(html, /Spendable|Copy ID|paymentCode/);
    assert.match(html, /TESTNET/);
    assert.match(html, /Mainnet shear-v1 starts 18 Sep 2026 21:00 UK/);
    assert.match(html, /Testnet is the privacy-class book/);
    assert.match(html, /id="mainnet-countdown"/);
    assert.doesNotMatch(html, /MAINNET LAUNCH at 9pm UK time on 11th September 2026/);
    assert.doesNotMatch(html, /2026-09-11T21:00:00\+01:00/);
    assert.doesNotMatch(html, /21:00 BST 11 Sep/);
    assert.match(html, />WALLET</);
    assert.match(html, />MINER</);
    assert.match(html, />NODE</);
    assert.match(html, /height:72px/);
    assert.match(html, /justify-content:center/);
    assert.match(html, /text-indent:\.12em/);
    assert.match(html, /shear-wallet-0\.31-macos\.dmg/);
    assert.doesNotMatch(html, /shear-wallet-0\.31-windows\.zip/);
    assert.match(html, /shear-wallet-0\.31-android\.apk/);
    assert.match(html, /shear-wallet-0\.31-linux\.zip/);
    assert.match(html, /shear-wallet-0\.31-archlinux\.zip/);
    assert.doesNotMatch(html, /shear-wallet-0\.26-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.26/);
    assert.doesNotMatch(html, /shear-wallet-0\.24-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.24/);
    assert.doesNotMatch(html, /shear-wallet-0\.23-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.23/);
    assert.doesNotMatch(html, /shear-wallet-0\.20-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.20/);
    assert.doesNotMatch(html, /shear-wallet-0\.19-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.19/);
    assert.doesNotMatch(html, /shear-wallet-0\.18-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.18/);
    assert.doesNotMatch(html, /shear-wallet-0\.17-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.17/);
    assert.doesNotMatch(html, /shear-wallet-0\.15-/);
    assert.doesNotMatch(html, /shear-wallet-0\.14-/);
    assert.doesNotMatch(html, /shear-wallet-0\.13-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.15/);
    assert.doesNotMatch(html, /releases\/tag\/0\.13/);
    assert.doesNotMatch(html, /shear-wallet-0\.12-/);
    assert.doesNotMatch(html, /releases\/tag\/0\.12/);
    assert.doesNotMatch(html, /shear-wallet-0\.11-/);
    assert.doesNotMatch(html, /shear-wallet-0\.9-/);
    assert.match(html, /data-pack="wallet-macos"/);
    assert.doesNotMatch(html, /data-pack="wallet-windows"/);
    assert.match(html, /data-pack="wallet-android"/);
    assert.match(html, /data-pack="wallet-linux"/);
    assert.match(html, /data-pack="wallet-archlinux"/);
    assert.match(html, /id="pack-advisory"/);
    assert.match(html, /wallet <strong>0\.31<\/strong>/);
    assert.doesNotMatch(html, /shear-wallet-0\.8-/);
    assert.match(html, /rgsneddon\/shear-testnet/);
    assert.doesNotMatch(html, /github\.com\/rgsneddon\/shear"/);
    assert.match(html, /miner <strong>1\.6<\/strong>/);
    assert.doesNotMatch(html, /sha256/);
    assert.match(html, /rgsneddon\/ShearK/);
    assert.doesNotMatch(html, /ShearK-Miner-1\.6-macos\.zip/);
    assert.match(html, /ShearK-Miner-1\.6-windows\.zip/);
    assert.match(html, /ShearK-Miner-1\.6-linux\.zip/);
    assert.match(html, /SmartScreen/);
    assert.match(html, /Authenticode/);
    assert.match(html, /Run anyway/);
    assert.match(html, /Unblock/);
    assert.doesNotMatch(html, /Windows leftover/);
    assert.doesNotMatch(html, /Linux leftover/);
    assert.match(html, /navigator\.userAgent/);
    assert.match(html, /client-dd:hover \.client-menu/);
    assert.match(html, /html\[data-theme="dark"\] \.client-menu \{/);
    assert.match(html, /\.client-menu \{[\s\S]*?background: linear-gradient\(165deg, var\(--card\) 0%, var\(--bg\) 58%\)/);
    assert.doesNotMatch(html, /dag\.shear\.digital/);
    assert.doesNotMatch(html, />DAG</);
    const nav = html.match(/id="shear-nav"[\s\S]*?<\/nav>/);
    assert.ok(nav);
    const labels = [...nav[0].matchAll(/class="nav-btn[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    assert.deepEqual(labels, ['MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'MINER', 'NODE', 'WALLET', 'DOCS']);
    assert.equal(labels.includes('WHITEPAPER'), false);
    assert.match(html, /id="menu-wallet"/);
    assert.match(html, /id="menu-miner"/);
    assert.match(html, /id="menu-node"/);
    assert.match(html, /data-pack="wallet-macos"/);
    assert.match(html, /data-pack="miner-windows"/);
  });

  it('WALLET nav on MAIN DAG MEMPOOL POOL EXPLORER pins 0.31 and refuses older tags', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pages = {
      main: html,
      dag: fs.readFileSync(path.join(here, '../dag/index.html'), 'utf8'),
      mempool: fs.readFileSync(path.join(here, '../../mempool/index.html'), 'utf8'),
      pool: fs.readFileSync(path.join(here, '../../pool/public/index.html'), 'utf8'),
      explorer: fs.readFileSync(path.join(here, '../../pool/public/explorer.html'), 'utf8'),
      miner: fs.readFileSync(path.join(here, '../../pool/public/miner.html'), 'utf8'),
      poolAdmin: fs.readFileSync(path.join(here, '../../pool/admin/index.html'), 'utf8'),
    };
    for (const [name, page] of Object.entries(pages)) {
      assert.match(page, /releases\/tag\/0\.31/, `${name} WALLET must pin 0.31`);
      assert.doesNotMatch(page, /releases\/tag\/0\.29/, `${name} must not offer 0.29`);
      assert.doesNotMatch(page, /releases\/tag\/0\.26/, `${name} must not offer 0.26`);
      assert.doesNotMatch(page, /shear-wallet-0\.26-/);
      assert.doesNotMatch(page, /releases\/tag\/0\.24/, `${name} must not offer 0.24`);
      assert.doesNotMatch(page, /shear-wallet-0\.24-/);
      assert.doesNotMatch(page, /releases\/tag\/0\.23/, `${name} must not offer 0.23`);
      assert.doesNotMatch(page, /shear-wallet-0\.23-/);
      assert.doesNotMatch(page, /releases\/tag\/0\.22/, `${name} must not offer 0.22`);
      assert.doesNotMatch(page, /shear-wallet-0\.22-/);
      assert.doesNotMatch(page, /releases\/tag\/0\.21/, `${name} must not offer 0.21`);
      assert.doesNotMatch(page, /shear-wallet-0\.21-/);
      assert.doesNotMatch(page, /releases\/tag\/0\.20/, `${name} must not offer 0.20`);
      assert.doesNotMatch(page, /shear-wallet-0\.20-/);
      assert.doesNotMatch(page, /releases\/tag\/0\.19/, `${name} must not offer 0.19`);
      assert.doesNotMatch(page, /shear-wallet-0\.19-/);
      assert.doesNotMatch(page, /releases\/tag\/0\.18/, `${name} must not offer 0.18`);
      assert.doesNotMatch(page, /releases\/tag\/0\.17/, `${name} must not offer 0.17`);
      assert.doesNotMatch(page, /shear-wallet-0\.17-/);
      assert.doesNotMatch(page, /releases\/tag\/0\.16/, `${name} must not offer 0.16`);
      assert.doesNotMatch(page, /releases\/tag\/0\.15/, `${name} must not offer 0.15`);
      assert.doesNotMatch(page, /releases\/tag\/0\.13/, `${name} must not offer 0.13`);
      assert.doesNotMatch(page, /releases\/tag\/0\.12/, `${name} must not offer 0.12`);
      assert.doesNotMatch(page, /releases\/tag\/0\.11/, `${name} must not offer 0.11`);
      assert.doesNotMatch(page, /releases\/tag\/0\.9[^\d]/, `${name} must not offer 0.9`);
      assert.doesNotMatch(page, /shear-wallet-0\.13-/);
      assert.doesNotMatch(page, /shear-wallet-0\.12-/);
      assert.doesNotMatch(page, /shear-wallet-0\.11-/);
      assert.match(page, /ShearK\/releases\/tag\/1\.6/, `${name} MINER must pin 1.6`);
      assert.doesNotMatch(page, /ShearK\/releases\/tag\/1\.1/, `${name} must not offer miner 1.1`);
      assert.doesNotMatch(page, /ShearK\/releases\/tag\/1\.4/, `${name} must not offer miner 1.4`);
    }
  });

  it('puts emissions, governance, vortex columns and a full-width wallet box', () => {
    const shear = html.indexOf('<h1>Shear</h1>');
    const emission = html.indexOf('id="emission"');
    const governance = html.indexOf('id="governance"');
    const vortex = html.indexOf('id="vortex"');
    const gridEnd = html.indexOf('</div>', html.indexOf('class="guide-grid"'));
    const wallet = html.indexOf('id="wallet-start"');
    assert.ok(shear >= 0 && emission > shear && governance > emission && vortex > governance && wallet > vortex);
    assert.ok(wallet > gridEnd);
    assert.match(html, /How SHE is created/);
    assert.match(html, /No premine, no ICO/);
    assert.doesNotMatch(html, /1:1 claim of coins GNFP to SHEAR/);
    assert.doesNotMatch(html, /The Join/);
    assert.doesNotMatch(html, /join1\./);
    assert.match(html, /CPU-only proof-of-work/);
    assert.match(html, /Algo: ShearHash-v3 · Coin: SHE · Network: shear-testnet-v3/);
    assert.match(html, /ShearHash-v3 \(a variant of RandomX\)/);
    assert.doesNotMatch(html, /using the ShearK algorithm/);
    assert.match(html, /Exactly 1 SHE, every found block/);
    const potChunk = html.slice(html.indexOf('<h3>The pot</h3>'), html.indexOf('<h3>Each hash</h3>'));
    assert.match(potChunk, /split proportionally to each miner's proven work in that round/);
    assert.match(potChunk, /PROP, minus any pool fee/);
    assert.match(potChunk, /Solo miners receive that full pot plus their own hash bonuses/);
    assert.match(potChunk, /not PROP-split/);
    assert.doesNotMatch(potChunk, /it is split between miners who hashed during the round/);
    assert.match(html, /Hash bonuses are always paid in full to the miner who produced them/);
    assert.match(html, /Each hasher dest that hashed that round receives its own/);
    assert.match(html, /Copy dest/);
    assert.match(html, /Staked SHE/);
    assert.match(html, /Staking may occur in The Reserve vortice at a variable rate to reward participants in Shear's community governance model/);
    assert.match(html, /0\.00000000001 SHE for each accepted hash/);
    assert.match(html, /Community Governance/);
    assert.match(html, /Who may take part/);
    assert.match(html, /What a vote may move/);
    assert.match(html, /The Reserve Oracle/);
    assert.match(html, /id="oracle-rate"/);
    assert.doesNotMatch(html, /median of first-world/);
    assert.doesNotMatch(html, /central banks/);
    assert.match(html, /\/reserve\/latest\.json/);
    assert.doesNotMatch(html, /starts at 4\.25%/);
    const emissionChunk = html.slice(emission, governance);
    assert.equal(/Reserve interest/.test(emissionChunk), false);
    assert.equal(/The Reserve Oracle/.test(emissionChunk), false);
    const latest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../reserve/latest.json'),
      'utf8',
    ));
    assert.equal(latest.version, 'shear-reserve-oracle-v1');
    assert.equal(typeof latest.medianBps, 'number');
    assert.equal(latest.averagePercent, undefined);
    assert.equal(latest.aprDays, 400);
    assert.match(html, /Vortex and Vortices/);
    assert.match(html, /vort1\./);
    assert.match(html, /add new vortice/);
    assert.match(html, /Start a wallet from scratch/);
    assert.match(html, /Set password/);
    assert.match(html, /Export shewall\.bin/);
    assert.doesNotMatch(html, /shewall\.json/);
    assert.match(html, /still lock and can vote/);
    assert.doesNotMatch(html, /cannot vote/);
    assert.doesNotMatch(html, /Private by default/);
    assert.doesNotMatch(html, /Proof of work only/);
    assert.match(html, /id="solo-mine"/);
    assert.match(html, /Solo mine/);
    assert.match(html, /127\.0\.0\.1:1111/);
    assert.match(html, /npm run pool/);
    assert.match(html, /YOUR_SSA1\.solo/);
    assert.match(html, /data-copy="solo-unix"/);
    assert.match(html, /guide-grid/);
    assert.match(html, /guide-wide/);
    assert.doesNotMatch(html, /Bitcoin|Ethereum|feeless/);
    assert.doesNotMatch(html, /GNFP/);
  });

  it('admin how-to is Shear-only: wallet, mine, Reserve; no claim copy', () => {
    const admin = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../admin/index.html'),
      'utf8',
    );
    assert.match(admin, /Install the wallet/);
    assert.match(admin, /How to mine/);
    assert.match(admin, /The Reserve/);
    assert.match(admin, /pool\.shear\.digital:1111/);
    assert.match(admin, /ShearK-Miner 1\.6/);
    assert.match(admin, /shear-wallet-0\.31-/);
    assert.doesNotMatch(admin, /shear-wallet-0\.31-windows\.zip/);
    assert.match(admin, /Mainnet shear-v1 starts 18 Sep 2026 21:00 UK/);
    assert.doesNotMatch(admin, /MAINNET LAUNCH at 9pm UK time on 11th September 2026/);
    assert.doesNotMatch(admin, /11th September 2026/);
    assert.doesNotMatch(admin, /9pm UK/);
    assert.match(admin, /Private dests, public amounts/);
    assert.match(admin, /PoW elects the tip/);
    assert.match(admin, /can still vote/);
    assert.match(admin, /Export shewall\.bin/);
    assert.doesNotMatch(admin, /Private by default/);
    assert.doesNotMatch(admin, /Proof of work only/);
    assert.doesNotMatch(admin, /cannot vote/);
    assert.doesNotMatch(admin, /shewall\.json/);
    assert.doesNotMatch(admin, /The Join/);
    assert.doesNotMatch(admin, /join1\./);
    assert.doesNotMatch(admin, /GNFP/);
    assert.doesNotMatch(admin, /1:1/);
    assert.doesNotMatch(admin, /migrat/i);
  });
});
