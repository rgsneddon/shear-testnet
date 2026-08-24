import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('brand pages', () => {
  it('site, pool, and explorer have pack wordmark, favicon, and dark/light swap', () => {
    const pages = [
      read('site/index.html'),
      read('pool/public/index.html'),
      read('pool/public/explorer.html'),
    ];
    for (const p of pages) {
      assert.match(p, /shear-wordmark/);
      assert.match(p, /05c-wordmark-nevia-light-transparent\.png/);
      assert.match(p, /05d-wordmark-nevia-dark-transparent\.png/);
      assert.match(p, /data-light=/);
      assert.match(p, /data-dark=/);
      assert.match(p, /favicon/);
      assert.match(p, /theme\.js/);
      assert.match(p, /toggleShearTheme/);
      assert.match(p, /theme-toggle/);
      assert.equal(/GNFP|gnfp|feeless/i.test(p), false);
    }
    const theme = read('pool/public/brand/theme.js');
    assert.match(theme, /prefers-color-scheme: dark/);
    assert.match(theme, /data-theme/);
    assert.match(theme, /data-dark/);
    const css = read('pool/public/brand/theme.css');
    assert.match(css, /html\[data-theme="dark"\]/);
    assert.equal(fs.existsSync(path.join(root, 'pool/public/brand/05c-wordmark-nevia-light-transparent.png')), true);
    assert.equal(fs.existsSync(path.join(root, 'pool/public/brand/favicon-32.png')), true);
    assert.equal(fs.existsSync(path.join(root, 'brand/fonts/nevia/woff2/Nevia-Regular.woff2')), true);
  });
});
