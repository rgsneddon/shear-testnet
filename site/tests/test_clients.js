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
  it('home stays on the SaaS dark theme and pins Continuum 0.53', () => {
    assert.match(html, /data-theme="dark"/);
    assert.match(html, /css\/saas-dark\.css/);
    assert.match(html, /shared\/shear-chrome\.js/);
    assert.match(html, /data-active="MAIN"/);
    assert.match(html, /She Is Private/);
    assert.match(html, /ADMITv2/);
    assert.match(html, /Continuum 0\.53/);
    assert.match(html, /ShearK 2\.6/);
    assert.match(html, /releases\/tag\/0\.53/);
    assert.match(html, /releases\/tag\/2\.6/);
    assert.doesNotMatch(html, /--bg: #eef3f8/);
    assert.doesNotMatch(html, /Owed toward/);
    assert.doesNotMatch(html, /dag\.shear\.digital/);
    assert.doesNotMatch(html, />DAG</);
    assert.match(html, /SmartScreen/);
    assert.match(html, /Authenticode/);
    assert.match(html, /Run anyway/);
    assert.match(html, /Unblock/);
    assert.doesNotMatch(html, /releases\/tag\/0\.48/);
    assert.doesNotMatch(html, /releases\/download\/0\.48/);
    assert.doesNotMatch(html, /releases\/tag\/0\.51/);
    assert.doesNotMatch(html, /Continuum 0\.51/);
    const wallet = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../wallet/index.html'), 'utf8');
    assert.match(wallet, /css\/saas-dark\.css/);
    assert.match(wallet, /shear-wallet-0\.53-windows\.zip/);
    assert.match(wallet, /shear-wallet-0\.53-linux\.zip/);
    assert.match(wallet, /shear-wallet-0\.53-archlinux\.zip/);
    assert.match(wallet, /shear-wallet-0\.53-fedora\.zip/);
    assert.match(wallet, /shear-wallet-0\.53-android\.apk/);
    assert.doesNotMatch(wallet, /shear-wallet-0\.51-/);
    assert.doesNotMatch(wallet, /shear-wallet-0\.48-/);
    assert.match(wallet, /releases\/download\/0\.53\/shear-wallet-0\.53-windows\.zip/);
    assert.match(wallet, /releases\/download\/0\.53\/shear-wallet-0\.53-linux\.zip/);
    assert.match(wallet, /releases\/download\/0\.53\/shear-wallet-0\.53-archlinux\.zip/);
    assert.match(wallet, /releases\/download\/0\.53\/shear-wallet-0\.53-fedora\.zip/);
    assert.match(wallet, /releases\/download\/0\.53\/shear-wallet-0\.53-android\.apk/);
    assert.match(wallet, /data-theme="dark"/);
    assert.doesNotMatch(wallet, /--bg: #eef3f8/);
    assert.doesNotMatch(wallet, /shear-wallet-0\.52-/);
    assert.doesNotMatch(wallet, /releases\/download\/0\.52/);
    assert.doesNotMatch(wallet, /releases\/tag\/0\.52/);
    assert.doesNotMatch(html, /Continuum 0\.52/);
    assert.doesNotMatch(html, /releases\/tag\/0\.52/);
    assert.doesNotMatch(html, /releases\/download\/0\.52/);
    assert.doesNotMatch(html, /data-wallet-fallback="0\.52"/);
  });

  it('WALLET nav on MAIN MEMPOOL POOL EXPLORER pins 0.53 and refuses older tags', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pages = {
      main: html,
      mempool: fs.readFileSync(path.join(here, '../../mempool/index.html'), 'utf8'),
      pool: fs.readFileSync(path.join(here, '../../pool/public/index.html'), 'utf8'),
      explorer: fs.readFileSync(path.join(here, '../../pool/public/explorer.html'), 'utf8'),
      miner: fs.readFileSync(path.join(here, '../../pool/public/miner.html'), 'utf8'),
      poolAdmin: fs.readFileSync(path.join(here, '../../pool/admin/index.html'), 'utf8'),
      docs: fs.readFileSync(path.join(here, '../docs/index.html'), 'utf8'),
      admin: fs.readFileSync(path.join(here, '../admin/index.html'), 'utf8'),
      whitepaper: fs.readFileSync(path.join(here, '../whitepaper/index.html'), 'utf8'),
    };
    for (const [name, page] of Object.entries(pages)) {
      assert.match(page, /releases\/tag\/0\.53/, `${name} WALLET must pin 0.53`);
      assert.doesNotMatch(page, /releases\/tag\/0\.52/, `${name} must not pin 0.52 as current`);
      assert.doesNotMatch(page, /releases\/download\/0\.52/, `${name} must not download 0.52`);
      assert.doesNotMatch(page, /shear-wallet-0\.52-/, `${name} must not offer 0.52 packs`);
      assert.doesNotMatch(page, /releases\/tag\/0\.51/, `${name} must not pin 0.51 as current`);
      assert.doesNotMatch(page, /releases\/tag\/0\.48/, `${name} must not pin 0.48 as current`);
      assert.doesNotMatch(page, /releases\/tag\/0\.41/, `${name} must not pin 0.41 as current`);
      assert.doesNotMatch(page, /releases\/download\/0\.41/, `${name} must not download from tag 0.41`);
      assert.doesNotMatch(page, /releases\/tag\/0\.40/, `${name} must not pin 0.40 as current`);
      assert.doesNotMatch(page, /releases\/tag\/0\.39/, `${name} must not pin 0.39 as current`);
      assert.doesNotMatch(page, /shear-wallet-0\.39-/, `${name} must not offer 0.39 packs`);
      assert.doesNotMatch(page, /releases\/tag\/0\.38/, `${name} must not pin 0.38 as current`);
      assert.doesNotMatch(page, /shear-wallet-0\.38-/, `${name} must not offer 0.38 packs`);
      assert.doesNotMatch(page, /releases\/download\/0\.38/, `${name} must not download from tag 0.38`);
      assert.doesNotMatch(page, /releases\/download\/0\.37/, `${name} must not download from tag 0.37`);
      assert.doesNotMatch(page, /releases\/tag\/0\.37/, `${name} must not pin 0.37 as current`);
      assert.doesNotMatch(page, /releases\/tag\/0\.36/, `${name} must not pin 0.36 as current`);
      assert.doesNotMatch(page, /releases\/download\/0\.36/, `${name} must not download from tag 0.36`);
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
      assert.match(page, /ShearK\/releases\/tag\/2\.6/, `${name} MINER must pin 2.6`);
      assert.doesNotMatch(page, /ShearK\/releases\/tag\/1\.1/, `${name} must not offer miner 1.1`);
      assert.doesNotMatch(page, /ShearK\/releases\/tag\/1\.4/, `${name} must not offer miner 1.4`);
    }
  });

  it('home bento keeps issuance, governance, and vortex on the SaaS page', () => {
    assert.match(html, /How SHE is created/);
    assert.match(html, /No premine/);
    assert.match(html, /No ICO/);
    assert.match(html, /Governance/);
    assert.match(html, /Vortex/);
    assert.match(html, /Copy dest/);
    assert.match(html, /css\/saas-dark\.css/);
    assert.doesNotMatch(html, /class="guide-grid"/);
    assert.doesNotMatch(html, /id="wallet-start"/);
    assert.doesNotMatch(html, /1:1 claim of coins GNFP to SHEAR/);
    assert.doesNotMatch(html, /The Join/);
    assert.doesNotMatch(html, /join1\./);
    assert.doesNotMatch(html, /shewall\.json/);
    assert.doesNotMatch(html, /Private by default/);
    assert.doesNotMatch(html, /Proof of work only/);
    assert.doesNotMatch(html, /Owed toward/);
    assert.doesNotMatch(html, /guide-grid/);
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
    assert.match(admin, /ShearK-Miner 2\.6/);
    assert.match(admin, /A typed suffix is optional/);
    assert.doesNotMatch(admin, /YOUR_SSA1\.solo/);
    assert.match(admin, /shear-wallet-0\.53-/);
    assert.match(admin, /shear-wallet-0\.53-windows\.zip/);
    assert.match(admin, /shear-wallet-0\.53-android\.apk/);
    assert.match(admin, /Mainnet shear-v1 is not live/);
    assert.match(admin, /A launch date is not decided/);
    assert.doesNotMatch(admin, /MAINNET LAUNCH at 9pm UK time on 11th September 2026/);
    assert.doesNotMatch(admin, /2026-09-18T21:00:00\+01:00/);
    assert.doesNotMatch(admin, /11th September 2026/);
    assert.doesNotMatch(admin, /9pm UK/);
    assert.match(admin, /ADMITv2 membership/);
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
