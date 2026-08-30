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
    const shear = html.indexOf('<h1>Shear</h1>');
    assert.ok(hero >= 0 && clients > hero && shear > clients);
    assert.match(html, />WALLET</);
    assert.match(html, />MINER</);
    assert.match(html, />NODE</);
    assert.match(html, /height:72px/);
    assert.match(html, /justify-content:center/);
    assert.match(html, /text-indent:\.12em/);
    assert.match(html, /shear-wallet-0\.4-macos\.dmg/);
    assert.match(html, /shear-wallet-0\.4-windows\.zip/);
    assert.match(html, /shear-wallet-0\.4-linux\.zip/);
    assert.match(html, /shear-wallet-0\.4-archlinux\.zip/);
    assert.match(html, /id="pack-advisory"/);
    assert.match(html, /wallet <strong>0\.4<\/strong>/);
    assert.match(html, /rgsneddon\/shear-testnet/);
    assert.doesNotMatch(html, /github\.com\/rgsneddon\/shear"/);
    assert.match(html, /miner <strong>1\.1<\/strong>/);
    assert.doesNotMatch(html, /sha256/);
    assert.match(html, /rgsneddon\/ShearK/);
    assert.match(html, /ShearK-Miner-1\.1-macos\.zip/);
    assert.match(html, /ShearK-Miner-1\.1-windows\.zip/);
    assert.match(html, /ShearK-Miner-1\.1-linux\.zip/);
    assert.doesNotMatch(html, /Windows leftover/);
    assert.doesNotMatch(html, /Linux leftover/);
    assert.match(html, /navigator\.userAgent/);
    assert.match(html, /client-dd:hover \.client-menu/);
    assert.match(html, /id="menu-wallet"/);
    assert.match(html, /id="menu-miner"/);
    assert.match(html, /id="menu-node"/);
    assert.match(html, /data-pack="wallet-macos"/);
    assert.match(html, /data-pack="miner-windows"/);
  });

  it('puts emissions, vortex, and wallet-start boxes on the main page', () => {
    const shear = html.indexOf('<h1>Shear</h1>');
    const emission = html.indexOf('id="emission"');
    const vortex = html.indexOf('id="vortex"');
    const wallet = html.indexOf('id="wallet-start"');
    assert.ok(shear >= 0 && emission > shear && vortex > emission && wallet > vortex);
    assert.match(html, /How SHE is created/);
    assert.match(html, /No premine, no ICO/);
    assert.match(html, /1:1 claim of coins GNFP to SHEAR/);
    assert.match(html, /CPU-only proof-of-work/);
    assert.match(html, /ShearK algorithm \(a variant of RandomX\)/);
    assert.match(html, /Exactly 1 SHE, every found block/);
    assert.match(html, /0\.00000000001 SHE for each accepted hash/);
    assert.match(html, /Vortex, and the vortices inside it/);
    assert.match(html, /vort1\./);
    assert.match(html, /Add new vortice/);
    assert.match(html, /Start a wallet from scratch/);
    assert.match(html, /Set password/);
    assert.match(html, /Export shewall\.bin/);
    assert.match(html, /guide-grid/);
    assert.doesNotMatch(html, /Bitcoin|Ethereum|feeless/);
  });
});
