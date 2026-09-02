import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../dag/index.html'),
  'utf8',
);
const theme = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../brand/theme.css'),
  'utf8',
);

describe('hash DAG GUI', () => {
  it('draws a KGI-style timeline with 100-hash miner points that commit live', () => {
    assert.match(html, /id="shear-nav"/);
    assert.match(html, /id="nav-toggle"/);
    assert.match(html, /onclick="toggleShearNav\(\)"/);
    assert.match(html, /position:fixed; top:0; left:0; right:0/);
    assert.match(html, /width:auto; max-width:100%; min-width:0/);
    assert.match(html, /min-width:0 !important; min-height:0 !important/);
    assert.match(html, /overflow:hidden; box-sizing:border-box/);
    assert.match(html, /c\.style\.minWidth = '0'/);
    assert.match(html, /Math\.min\(Math\.floor\(box\.width\)/);
    assert.doesNotMatch(html, /max-width:none/);
    assert.doesNotMatch(html, /--shear-vp-w/);
    assert.doesNotMatch(html, /visualViewport/);
    assert.doesNotMatch(html, /height=device-height/);
    assert.doesNotMatch(html, /stage\.style\.top/);
    assert.match(html, /theme\.css\?v=25/);
    assert.match(html, /theme\.js\?v=12/);
    assert.match(theme, /position: absolute; top: 100%; right: 0; left: auto/);
    assert.match(theme, /display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr/);
    assert.match(theme, /grid-auto-columns: 1fr/);
    assert.match(theme, /width: max-content; min-width: 0; max-width: 100%/);
    assert.match(theme, /height: 36px; justify-content: center; padding: 0 10px/);
    assert.match(theme, /display: none !important/);
    assert.doesNotMatch(theme, /grid-template-areas/);
    assert.doesNotMatch(theme, /shear-nav-open/);
    assert.doesNotMatch(theme, /min-width: 12\.5rem/);
    assert.doesNotMatch(theme, /position: fixed; top: var\(--shear-banner-h/);
    assert.match(theme, /html, body \{ max-width: 100%; \}/);
    assert.match(theme, /max-width: 1024px/);
    assert.doesNotMatch(theme, /100vw/);
    assert.doesNotMatch(html, /100vw/);
    const themeJs = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../brand/theme.js'),
      'utf8',
    );
    assert.match(themeJs, /--shear-banner-h/);
    assert.doesNotMatch(themeJs, /visualViewport/);
    assert.doesNotMatch(themeJs, /appendChild\(nav\)/);
    assert.doesNotMatch(themeJs, /shear-nav-open/);
    assert.match(html, /5581AA/);
    assert.match(html, /B34D50/);
    assert.match(html, /roundRect/);
    assert.match(html, /HASH_BUNDLE = 50/);
    assert.match(html, /addBundles/);
    assert.match(html, /function jitter/);
    assert.match(html, /DOT_R/);
    assert.match(html, /ctx\.arc\(0, 0, r/);
    assert.match(html, /sealedStem/);
    assert.match(html, /SEALED_MAX = 50/);
    assert.match(html, /H \* 0\.46/);
    assert.match(html, /n\.kind !== 'live'/);
    assert.match(html, /LIVE_MAX = 2500/);
    assert.match(html, /Math\.sqrt\(n\.bundle \+ 1\)/);
    assert.match(html, /n\.r = 1\.55/);
    assert.match(html, /kind: 'miner'/);
    assert.match(html, /n\.r = 3\.35/);
    assert.match(html, /n\.r = 1\.55/);
    assert.match(html, /stem from that miner/);
    assert.match(html, /spy glass/);
    assert.match(html, /id="dag-key"/);
    assert.match(html, /Live hashes/);
    assert.match(html, /Sealed hashes/);
    assert.match(html, /function orbit/);
    assert.match(html, /drawLoupe/);
    assert.match(html, /glass ×2\.8/);
    assert.match(html, /empty neighbourhood/);
    assert.match(html, /Inspector/);
    assert.match(html, /'live'/);
    assert.match(html, /'hash'/);
    assert.match(html, /HEAD_RIGHT/);
    assert.match(html, /Inspector/);
    assert.match(html, /\/api\/explorer\/dag/);
    assert.doesNotMatch(html, /HASH_BUNDLE = 1000/);
    assert.doesNotMatch(html, /burstFireworks/);
    assert.equal(/h\.a \+ t \//.test(html), false);
    assert.doesNotMatch(html, /kyrusfables/);
  });
});
