import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function bytes(rel) {
  return fs.readFileSync(path.join(root, rel));
}

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function bannerBlock(html) {
  const m = html.match(/\.top-banner\s*\{[^}]+\}/);
  assert.ok(m, 'missing .top-banner rule');
  return m[0];
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
      assert.match(p, /she is quiet/);
      assert.equal(/--user she1/.test(p), false);
      assert.equal(/--user shear1/.test(p), false);
      const banner = bannerBlock(p);
      assert.match(banner, /background:\s*var\(--banner\)/);
      assert.equal(/background:\s*#f7fbff/.test(banner), false);
      assert.equal(/input[^{]*\{[^}]*background:\s*#fff/.test(p), false);
      assert.equal(/button[^{]*\{[^}]*background:\s*#fff/.test(p), false);
    }
    const theme = read('pool/public/brand/theme.js');
    assert.match(theme, /prefers-color-scheme: dark/);
    assert.match(theme, /data-theme/);
    assert.match(theme, /data-dark/);
    const css = read('pool/public/brand/theme.css');
    assert.match(css, /html\[data-theme="dark"\]/);
    assert.match(css, /--banner:\s*#06141f/);
    assert.match(css, /\.top-banner\s*\{\s*background:\s*var\(--banner\)/);
    assert.match(css, /input,\s*select,\s*button\s*\{\s*background:\s*var\(--input\)/);
    assert.equal(fs.existsSync(path.join(root, 'pool/public/brand/05c-wordmark-nevia-light-transparent.png')), true);
    assert.equal(fs.existsSync(path.join(root, 'pool/public/brand/favicon-32.png')), true);
    assert.equal(fs.existsSync(path.join(root, 'brand/fonts/nevia/woff2/Nevia-Regular.woff2')), true);
  });

  it('Urema is body text, Nevia is larger headings only, body is at least 16px', () => {
    const pages = [
      read('site/index.html'),
      read('pool/public/index.html'),
      read('pool/public/explorer.html'),
    ];
    for (const p of pages) {
      assert.match(p, /href="\/brand\/urema\.css"/);
      const body = p.match(/body\s*\{[^}]+\}/);
      assert.ok(body, 'missing body rule');
      assert.match(body[0], /"Urema"/);
      assert.equal(/"Nevia"/.test(body[0]), false, 'body must not list Nevia');
      assert.match(body[0], /16px/);
      assert.equal(/font:\s*13px/.test(body[0]), false);
      assert.match(p, /h1,\s*h2,\s*\.label\s*\{[^}]*font-family:\s*"Nevia"/);
      assert.match(p, /h1\s*\{[^}]*font-size:\s*1\.75rem/);
      assert.match(p, /h2\s*\{[^}]*font-size:\s*1\.35rem/);
      assert.equal(/font-size:\s*\.62rem/.test(p), false);
      assert.equal(/font:\s*13px/.test(p), false);
    }
    const urema = read('pool/public/brand/urema.css');
    assert.match(urema, /font-family:\s*"Urema"/);
    assert.match(urema, /format\("woff2"\)/);
    assert.match(urema, /font-weight:\s*100 900/);
    assert.match(urema, /fonts\/urema\/woff2\/Urema-Variable\.woff2/);
    const woff = bytes('pool/public/brand/fonts/urema/woff2/Urema-Variable.woff2');
    assert.equal(woff.subarray(0, 4).toString(), 'wOF2');
    assert.ok(woff.length > 10000, 'Urema WOFF2 too small to be the variable face');
    const shipped = bytes('brand/fonts/urema/woff2/Urema-Variable.woff2');
    assert.deepEqual(woff, shipped);
    const css = read('pool/public/brand/theme.css');
    assert.match(css, /font-family:\s*"Urema"/);
    assert.match(css, /h1,\s*h2,\s*\.label/);
  });

  it('Windows ICO and web icons are the pack mark, not Flutter defaults', () => {
    const flutter = {
      'wallet/web/icons/Icon-192.png': '3dce99077602f704',
      'wallet/web/icons/Icon-512.png': 'baccb205ae45f0b4',
      'wallet/web/icons/Icon-maskable-192.png': 'd2c842e22a9f4ec9',
      'wallet/web/icons/Icon-maskable-512.png': '6aee06cdcab6b2ae',
      'wallet/web/favicon.png': '7ab2525f4b86b65d',
      'wallet/windows/runner/resources/app_icon.ico': 'c098d3fc85cacff9',
    };
    for (const [rel, bad] of Object.entries(flutter)) {
      const buf = bytes(rel);
      const got = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
      assert.notEqual(got, bad, `${rel} still Flutter default`);
    }
    const i192 = pngSize(bytes('wallet/web/icons/Icon-192.png'));
    const i512 = pngSize(bytes('wallet/web/icons/Icon-512.png'));
    const m192 = pngSize(bytes('wallet/web/icons/Icon-maskable-192.png'));
    const m512 = pngSize(bytes('wallet/web/icons/Icon-maskable-512.png'));
    const fav = pngSize(bytes('wallet/web/favicon.png'));
    assert.deepEqual(i192, { w: 192, h: 192 });
    assert.deepEqual(i512, { w: 512, h: 512 });
    assert.deepEqual(m192, { w: 192, h: 192 });
    assert.deepEqual(m512, { w: 512, h: 512 });
    assert.ok(fav.w >= 16 && fav.h >= 16);
    assert.ok(bytes('wallet/web/icons/Icon-192.png').length > 15000);
    assert.ok(bytes('wallet/web/icons/Icon-512.png').length > 40000);
    const ico = bytes('wallet/windows/runner/resources/app_icon.ico');
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.ok(ico.readUInt16LE(4) >= 1);
    assert.ok(ico.length > 20000);
    const png = bytes('wallet/windows/runner/resources/app_icon.png');
    assert.deepEqual(pngSize(png), { w: 256, h: 256 });
    const webIndex = read('wallet/web/index.html');
    assert.match(webIndex, /Shear wallet/);
    assert.equal(/A new Flutter project/.test(webIndex), false);
    const manifest = read('wallet/web/manifest.json');
    assert.match(manifest, /"name": "Shear"/);
    assert.equal(/A new Flutter project/.test(manifest), false);
  });
});
