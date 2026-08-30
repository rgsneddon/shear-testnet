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
  it('pool and explorer fmtRate step 1000 MH/s to GH/s', () => {
    for (const rel of ['pool/public/index.html', 'pool/public/explorer.html']) {
      const page = read(rel);
      const fn = page.match(/function fmtRate\(n\) \{[\s\S]*?\n    \}/);
      assert.ok(fn, `${rel} must ship fmtRate`);
      const fmtRate = new Function(`${fn[0]}; return fmtRate;`)();
      assert.equal(fmtRate(1000e6), '1.00 GH/s');
      assert.equal(fmtRate(1.2e9), '1.20 GH/s');
      assert.equal(fmtRate(1e12), '1.00 TH/s');
      assert.equal(fmtRate(1e15), '1.00 PH/s');
    }
  });

  it('site, pool, explorer, and mempool have pack wordmark, favicon, and dark/light swap', () => {
    const pages = [
      read('site/index.html'),
      read('pool/public/index.html'),
      read('pool/public/explorer.html'),
      read('mempool/index.html'),
    ];
    for (const p of pages) {
      assert.match(p, /<head>[\s\S]*theme\.js[\s\S]*<\/head>/);
      assert.match(p, /theme-img-light/);
      assert.match(p, /theme-img-dark/);
      assert.match(p, /shear-wordmark/);
      assert.match(p, /05c-wordmark-nevia-light-transparent\.png/);
      assert.match(p, /05d-wordmark-nevia-dark-transparent\.png/);
      assert.match(p, /data-light=/);
      assert.match(p, /data-dark=/);
      assert.match(p, /favicon/);
      assert.match(p, /theme\.js/);
      assert.match(p, /toggleShearTheme/);
      assert.match(p, /theme-toggle/);
      assert.match(p, /toggleShearNav/);
      assert.match(p, /nav-toggle/);
      assert.match(p, /id="shear-nav"/);
      assert.match(p, /grid-template-columns:\s*1fr auto 1fr/);
      assert.match(p, /icon-moon/);
      assert.match(p, /icon-sun/);
      assert.equal(/OFFICIAL POOL/.test(p), false);
      assert.equal(/>SITE</.test(p), false);
      const nav = p.match(/id="shear-nav"[\s\S]*?<\/nav>/);
      assert.ok(nav, 'missing shear-nav');
      const labels = [...nav[0].matchAll(/class="nav-btn[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
      assert.deepEqual(labels, ['MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'MINER', 'NODE', 'WALLET']);
      assert.equal(/GNFP|gnfp|feeless/i.test(p), false);
      assert.match(p, /she is private/);
      assert.equal(/she is quiet/.test(p), false);
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
    assert.match(theme, /img\[data-light\]\[data-dark\]/);
    assert.match(theme, /DOMContentLoaded/);
    assert.match(theme, /addEventListener\('change'/);
    assert.match(theme, /toggleShearNav/);
    assert.match(theme, /nav-open/);
    assert.match(theme, /CustomEvent\('shear-theme'/);
    const pool = read('pool/public/index.html');
    assert.match(pool, /table-wrap/);
    assert.match(pool, /overflow-wrap:\s*anywhere/);
    assert.match(pool, /table-layout:\s*fixed/);
    const site = read('site/index.html');
    assert.match(site, /max-width:\s*72rem/);
    assert.match(site, />MAIN</);
    assert.match(site, /id="shear-hero"/);
    assert.match(site, /SHEAR_light\.png/);
    assert.match(site, /SHEAR_dark\.png/);
    assert.equal(fs.existsSync(path.join(root, 'site/brand/SHEAR_light.png')), true);
    assert.equal(fs.existsSync(path.join(root, 'site/brand/SHEAR_dark.png')), true);
    const light = pngSize(bytes('site/brand/SHEAR_light.png'));
    const dark = pngSize(bytes('site/brand/SHEAR_dark.png'));
    assert.deepEqual(light, { w: 1500, h: 500 });
    assert.deepEqual(dark, { w: 1500, h: 500 });
    const css = read('pool/public/brand/theme.css');
    assert.match(css, /html\[data-theme="dark"\]/);
    assert.match(css, /--banner:\s*#06141f/);
    assert.match(css, /--gold:\s*#c48a00/);
    assert.match(css, /--gold:\s*#ffd24a/);
    assert.match(css, /html,\s*body\s*\{/);
    assert.match(css, /font-size:\s*15px/);
    assert.match(css, /a\.nav-btn\.is-on\s*\{\s*color:\s*var\(--gold\)/);
    const siteHtml = read('site/index.html');
    const poolHtml = read('pool/public/index.html');
    const explorerHtml = read('pool/public/explorer.html');
    const mempoolHtml = read('mempool/index.html');
    assert.match(siteHtml, /class="nav-btn is-on"[^>]*>MAIN</);
    assert.match(poolHtml, /class="nav-btn is-on"[^>]*>POOL</);
    assert.match(explorerHtml, /class="nav-btn is-on"[^>]*>EXPLORER</);
    assert.match(mempoolHtml, /class="nav-btn is-on"[^>]*>MEMPOOL</);
    for (const page of [siteHtml, poolHtml, explorerHtml, mempoolHtml]) {
      assert.match(page, /rgsneddon\/shear-testnet/);
      assert.equal(/href="https:\/\/github\.com\/rgsneddon\/shear"/.test(page), false);
      assert.match(page, /releases\/tag\/0\.4|shear-wallet-0\.4/);
      assert.match(page, /rgsneddon\/ShearK/);
    }
    assert.match(css, /\.top-banner\s*\{[\s\S]*?background:\s*var\(--banner\)/);
    assert.match(css, /grid-template-columns:\s*1fr auto 1fr/);
    assert.match(css, /header\.top-banner\s*\{\s*grid-template-columns:\s*1fr auto/);
    assert.match(css, /input,\s*select,\s*button\s*\{\s*background:\s*var\(--input\)/);
    assert.match(css, /img\.theme-img-dark/);
    assert.match(css, /html:not\(\[data-theme="light"\]\) img\.theme-img-dark/);
    assert.match(css, /button\.nav-toggle/);
    assert.match(css, /@media \(max-width: 1024px\)/);
    assert.match(css, /icon-moon/);
    assert.match(css, /icon-sun/);
    assert.match(css, /justify-self:\s*end/);
    assert.match(css, /position:\s*absolute/);
    assert.match(css, /z-index:\s*30/);
    assert.match(theme, /aria-label/);
    assert.equal(fs.existsSync(path.join(root, 'pool/public/brand/05c-wordmark-nevia-light-transparent.png')), true);
    assert.equal(fs.existsSync(path.join(root, 'pool/public/brand/favicon-32.png')), true);
    const mempool = read('mempool/index.html');
    assert.match(mempool, /--lattice-bg:\s*#dce6f0/);
    assert.match(mempool, /html\[data-theme="dark"\]\s*\{[\s\S]*--lattice-bg:\s*#050b18/);
    assert.match(mempool, /function isDark\(/);
    assert.match(mempool, /function palette\(/);
    assert.match(mempool, /cssVar\('--lattice-bg'/);
    assert.match(mempool, /--pick-bg/);
    assert.match(mempool, /color:var\(--pick\)/);
    assert.match(mempool, /background:var\(--pick-bg\)/);
    assert.match(mempool, /addEventListener\('shear-theme'/);
    assert.equal(/canvas\s*\{[^}]*background:#050b18/.test(mempool), false);
    assert.equal(/\.eq\s*\{[^}]*color:#f0d27a/.test(mempool), false);
    assert.equal(/#pick\s*\{[^}]*color:#4fd8e8/.test(mempool), false);
  });

  it('pages use Segoe UI like the GNFP sites, not Nevia or Urema', () => {
    const pages = [
      read('site/index.html'),
      read('pool/public/index.html'),
      read('pool/public/explorer.html'),
    ];
    for (const p of pages) {
      assert.equal(/href="\/brand\/urema\.css"/.test(p), false);
      assert.equal(/href="\/brand\/nevia\.css"/.test(p), false);
      const body = p.match(/body\s*\{[^}]+\}/);
      assert.ok(body, 'missing body rule');
      assert.match(body[0], /"Segoe UI"/);
      assert.equal(/"Urema"/.test(body[0]), false);
      assert.equal(/"Nevia"/.test(body[0]), false);
      assert.match(body[0], /15px/);
      assert.match(p, /h1,\s*h2,\s*\.label\s*\{[^}]*font-family:\s*"Segoe UI"/);
    }
    const css = read('pool/public/brand/theme.css');
    assert.match(css, /font-family:\s*"Segoe UI"/);
    assert.equal(/"Urema"/.test(css), false);
    assert.equal(/"Nevia"/.test(css), false);
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

describe('explorer pulse', () => {
  it('paints live pulse from /api/stats first; offline retrying is catch-only', () => {
    const page = read('pool/public/explorer.html');
    assert.match(page, /id="live-pulse"/);
    assert.match(page, /const stats = await fetchJson\('\/stats'\);/);
    assert.match(page, /pulse\.textContent = 'live · ' \+ \(stats\.magic/);
    assert.equal(/Promise\.all\(\[\s*fetchJson\('\/stats'\)/.test(page), false);
    const catchOffline = page.match(/loadRecent\(\)\.catch\(function \(\) \{[\s\S]*?offline · retrying[\s\S]*?\}\);/);
    assert.ok(catchOffline, 'offline · retrying must live only in loadRecent catch');
    assert.match(page, /if \(!r\.ok\) throw new Error\('http ' \+ r\.status\)/);
  });
});

describe('mempool pulse', () => {
  it('uses API spendableConfirmations, not a hard-coded 6', () => {
    const page = read('mempool/index.html');
    assert.match(page, /data\.spendableConfirmations/);
    assert.equal(/6 conf spendable/.test(page), false);
    assert.match(page, /isDark/);
    assert.match(page, /palette/);
    assert.match(page, /--pick-bg/);
  });
});
