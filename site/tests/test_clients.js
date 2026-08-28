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
    assert.match(html, /shear-wallet-0\.2-macos\.dmg/);
    assert.match(html, /id="pack-advisory"/);
    assert.match(html, /wallet <strong>0\.2<\/strong>/);
    assert.match(html, /miner <strong>1\.1<\/strong>/);
    assert.match(html, /sha256/);
    assert.match(html, /Shear-Miner-1\.1-macos\.zip/);
    assert.match(html, /navigator\.userAgent/);
    assert.match(html, /client-dd:hover \.client-menu/);
    assert.match(html, /id="menu-wallet"/);
    assert.match(html, /id="menu-miner"/);
    assert.match(html, /id="menu-node"/);
    assert.match(html, /data-pack="wallet-macos"/);
    assert.match(html, /data-pack="miner-windows"/);
  });
});
