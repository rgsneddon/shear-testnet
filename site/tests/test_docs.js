import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

function utf16be(str) {
  const b = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    b[i * 2] = (c >> 8) & 0xff;
    b[i * 2 + 1] = c & 0xff;
  }
  return b;
}

function pdfHaystack(buf) {
  const parts = [buf];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const text = buf.toString('latin1');
  let m;
  while ((m = re.exec(text))) {
    const raw = Buffer.from(m[1], 'latin1');
    try { parts.push(zlib.inflateSync(raw)); } catch { /* not flate */ }
  }
  return Buffer.concat(parts);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = fs.readFileSync(path.join(here, '../docs/index.html'), 'utf8');
const content = fs.readFileSync(path.join(here, '../docs/content.js'), 'utf8');
const app = fs.readFileSync(path.join(here, '../docs/app.js'), 'utf8');
const paper = fs.readFileSync(path.join(here, '../whitepaper/index.html'), 'utf8');
const pdf = fs.readFileSync(path.join(here, '../whitepaper/shear-whitepaper.pdf'));

function chromeProductLabels() {
  const chrome = fs.readFileSync(path.join(here, '../shared/shear-chrome.js'), 'utf8');
  const block = chrome.match(/if \(local\) \{\s*return \[([\s\S]*?)\];/);
  assert.ok(block, 'shared chrome must list product links');
  return [...block[1].matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
}

function navLabels(html) {
  const nav = html.match(/id="shear-nav"[\s\S]*?<\/nav>/);
  if (nav) {
    return [...nav[0].matchAll(/class="nav-btn[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  }
  assert.match(html, /id="shear-chrome-root"/, 'missing shear-nav and shear-chrome-root');
  return chromeProductLabels();
}

const withDocs = ['MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'MINER', 'NODE', 'WALLET', 'DOCS'];

describe('shear.digital/docs', () => {
  it('is a file-tree browser with wallet, mining, vortex, vort1, reserve', () => {
    assert.match(docs, /id="docs-tree"/);
    assert.match(docs, /id="docs-read"/);
    assert.match(docs, /id="tree-search"/);
    assert.match(docs, /File tree/);
    assert.match(content, /id: 'wallet'/);
    assert.match(content, /id: 'mine'/);
    assert.match(content, /id: 'vort1'/);
    assert.match(content, /id: 'creators'/);
    assert.match(content, /id: 'reserve'/);
    assert.match(content, /vort1\./);
    assert.match(content, /ShearK-Miner 2\.6/);
    assert.match(content, /Copy dest/);
    assert.match(content, /hasher dest/);
    assert.match(content, /ShearHash-v3/);
    assert.match(content, /shewall\.bin/);
    assert.match(content, /Continuum/);
    assert.match(content, /0\.001 SHE/);
    assert.match(content, /split 50\/50/);
    assert.match(content, /finder-fee/);
    assert.match(content, /reserve-fee/);
    assert.match(content, /The Reserve vault fee bank/);
    assert.match(content, /not sent - try again/);
    assert.match(content, /https:\/\/shear\.digital\/whitepaper\//);
    assert.doesNotMatch(content, /href="https:\/\/whitepaper\.shear\.digital"/);
    assert.match(content, /not instant/);
    assert.match(content, /after 9 confirmations while the pool shows sent/);
    assert.match(content, /wallet\/sync bug/);
    assert.match(content, /Tx detail/);
    assert.match(content, /https:\/\/pool\.shear\.digital/);
    assert.match(content, /pool HUD is not spendable/);
    assert.match(content, /Your deposits/);
    assert.match(content, /two rows/);
    assert.doesNotMatch(content, /twenty rows/);
    assert.match(app, /hashchange/);
    assert.match(app, /SHEAR_DOCS/);
    assert.match(app, /tree-folder/);
    assert.match(app, /data-folder/);
    assert.match(app, /addEventListener\('toggle'/);
    assert.doesNotMatch(app, /<details open>/);
    assert.match(docs, /details\.tree-folder/);
    assert.match(docs, /summary::before/);
    const labels = navLabels(docs);
    assert.deepEqual(labels, chromeProductLabels());
    assert.equal(labels.includes('WHITEPAPER'), false);
    assert.equal(labels.includes('DAG'), true);
    assert.equal(labels.includes('VORTICES'), true);
    assert.match(docs, /id="shear-chrome-root" data-active="DOCS"/);
    assert.match(docs, /shared\/shear-chrome\.js/);
    assert.match(docs, /css\/saas-dark\.css/);
    assert.doesNotMatch(docs, /linear-gradient\(165deg, #ffffff 0%, #eef5fb 58%\)/);
    assert.match(docs, /content\.js\?v=30/);
    for (const pack of [
      'shear-wallet-0.66-windows.zip',
      'shear-wallet-0.66-android.apk',
      'shear-wallet-0.66-linux.zip',
      'shear-wallet-0.66-archlinux.zip',
      'shear-wallet-0.66-fedora.zip',
    ]) {
      const url = `releases/download/0.66/${pack}`;
      assert.match(docs, new RegExp(url.replace(/[.]/g, '\\.')));
      assert.match(content, new RegExp(url.replace(/[.]/g, '\\.')));
    }
    assert.doesNotMatch(docs, /0\.60\.1/);
    assert.doesNotMatch(docs, /0\.55\.1\.1/);
    assert.doesNotMatch(content, /0\.60\.1/);
    assert.doesNotMatch(content, /0\.55\.1\.1/);
    assert.match(content, /Remove vortice/);
    assert.match(content, /this wallet only/);
    assert.match(content, /vort1 origin/);
    assert.match(content, /Wallet pin<\/th><td>0\.66/);
    assert.doesNotMatch(content, /Wallet pin<\/th><td>0\.55</);
    assert.match(content, /Current pin is <strong>0\.66<\/strong>/);
    assert.doesNotMatch(content, /releases\/download\/0\.62\/shear-wallet-0\.62-macos\.dmg/);
    assert.doesNotMatch(docs, /releases\/download\/0\.62\/shear-wallet-0\.62-macos\.dmg/);
    assert.doesNotMatch(content, /shear-wallet-0\.55\.1-macos\.dmg/);
    assert.match(content, /https:\/\/shear\.digital\/wallet\//);
    assert.doesNotMatch(content, /releases\/tag\/0\.55(?!\.)/);
    assert.doesNotMatch(content, /Current pin is <strong>0\.33<\/strong>/);
    assert.doesNotMatch(content, /Wallet pin<\/th><td>0\.33/);
    const readme = fs.readFileSync(path.join(here, '../../README.md'), 'utf8');
    assert.match(readme, /releases\/tag\/0\.66/);
    assert.match(readme, /releases\/tag\/v16/);
    assert.doesNotMatch(readme, /releases\/tag\/0\.55(?!\.)/);
    assert.doesNotMatch(readme, /Wallet \*\*0\.33\*\*/);
    assert.match(content, /127\.0\.0\.1:18332/);
    assert.match(content, /node-sync/);
    assert.match(content, /com\.shear\.shear_wallet/);
    assert.match(content, /Stem then fluff/);
    assert.match(content, /ADMITv2/);
    assert.ok(content.indexOf("id: 'dins-dag'") > content.indexOf("id: 'admit'"));
    assert.match(content, /P\['dins-dag'\]/);
    assert.match(content, /blue set, sorted by identity/);
    assert.match(content, /not paid again from a second hash leg/);
    assert.match(content, /Connect bare/);
    assert.match(content, /0\.65 is the previous public pack pin\. 0\.66 is this Continuum wallet\./);
    assert.match(content, /node is the book/);
    assert.match(content, /password-sealed <code>shewall\.bin<\/code>/);
    assert.match(content, /shear-testnet-v10/);
    assert.doesNotMatch(content, /shear-testnet-v6/);
    assert.doesNotMatch(content, /testnet-v6/);
    assert.match(content, /127\.0\.0\.1:1111/);
    assert.match(content, /An empty book applies the snapshot once/);
    assert.match(content, /a recorded tip resumes and does not pull/);
    assert.doesNotMatch(content, /Startup does not pull a bootstrap/);
    assert.doesNotMatch(content, /Extract the wallet zip/);
    assert.match(content, /protocol-spendable after 9 confirmations. A low hash ratio does not hold pool credits/);
    assert.match(content, /4 days on this testnet \(400 days on mainnet\)/);
    assert.doesNotMatch(content, /explorer reports amounts, dests/);
    assert.match(content, /no dest, no amount/);
    assert.match(content, /boot\.shear\.digital/);
    assert.doesNotMatch(content, /Dandelion\+\+/);
    assert.doesNotMatch(content, /FCMP/);
    assert.doesNotMatch(content, /RING_SIZE/);
    assert.doesNotMatch(content, /Pedersen/);
    assert.doesNotMatch(content, /dag\.shear\.digital/);
    assert.doesNotMatch(content, /GHOSTDAG/);
  });

  it('nav/CTA hrefs are shear.digital/docs/, not docs.shear.digital', () => {
    const site = path.join(here, '..');
    const root = path.join(here, '../..');
    const navFiles = [
      path.join(site, 'index.html'),
      path.join(site, 'docs/index.html'),
      path.join(site, 'whitepaper/index.html'),
      path.join(root, 'pool/public/index.html'),
      path.join(root, 'pool/public/explorer.html'),
      path.join(root, 'pool/public/miner.html'),
      path.join(root, 'mempool/index.html'),
      path.join(root, 'pool/admin/index.html'),
    ];
    const chrome = fs.readFileSync(path.join(here, '../shared/shear-chrome.js'), 'utf8');
    assert.match(chrome, /https:\/\/shear\.digital\/docs\//);
    for (const f of navFiles) {
      const html = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(html, /href="https:\/\/docs\.shear\.digital/);
      const direct = /shear\.digital\/docs\/|href="\/docs\/"|href="\/"/.test(html);
      const mounted = /shear-chrome\.js/.test(html);
      assert.equal(direct || mounted, true, `${f} must link docs or mount shared chrome`);
    }
    assert.doesNotMatch(docs, /href="https:\/\/docs\.shear\.digital/);
    assert.doesNotMatch(paper, /href="https:\/\/docs\.shear\.digital/);
  });
});

describe('whitepaper.shear.digital', () => {
  it('presents a Zenodo-style record with a PDF, and has no WHITEPAPER nav button', () => {
    assert.match(paper, /id="zenodo-record"/);
    assert.match(paper, /shear-whitepaper\.pdf/);
    assert.match(paper, /<iframe[^>]+src="shear-whitepaper\.pdf#view=FitH"/);
    assert.match(paper, /min-width:0/);
    assert.match(paper, /\.banner-wordmark \{ height:36px; width:auto; max-width:none/);
    assert.match(paper, /Continuity-settled Proof of Work/);
    assert.match(paper, /HTML is canonical/);
    assert.match(paper, /id="pdf-stale"/);
    assert.match(paper, /wallet 0\.66/);
    assert.doesNotMatch(paper, /wallet 0\.55/);
    assert.match(paper, /ShearK 2\.6/);
    assert.doesNotMatch(paper, /The builder still carries older ADMITv1/);
    assert.match(paper, /href="https:\/\/shear\.digital\/wallet\/"/);
    assert.doesNotMatch(paper, /github\.com/);
    assert.doesNotMatch(paper, /releases\/tag\/0\.55(?!\.)/);
    assert.doesNotMatch(paper, /releases\/tag\/0\.33/);
    assert.match(paper, /Publication/);
    assert.match(paper, /Preprint/);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 50_000);
    const labels = navLabels(paper);
    assert.deepEqual(labels, ['MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'DAG', 'MINER', 'NODE', 'WALLET', 'VORTICES', 'DOCS']);
    assert.equal(labels.includes('WHITEPAPER'), false);
    assert.match(paper, /href="https:\/\/shear\.digital\/docs\/">DOCS</);
    assert.match(paper, /overflow-x:hidden/);
    assert.match(paper, /box-sizing: border-box/);
    assert.match(paper, /iframe \{\s*display:block; width:100%; max-width:100%/);
    assert.match(paper, /data-theme="dark"/);
    assert.match(paper, /Domain=\.shear\.digital/);
    assert.match(paper, /css\/saas-dark\.css/);
    assert.match(paper, /DINS-DAG/);
    assert.match(paper, /shear-testnet-v10/);
    assert.doesNotMatch(paper, /#eef3f8/);
    assert.doesNotMatch(paper, /linear-gradient\(165deg, #ffffff 0%, #eef5fb 58%\)/);
    assert.match(paper, /href="https:\/\/dag\.shear\.digital\/">DAG</);
    assert.doesNotMatch(paper, /width:min\(210mm/);
    assert.equal(labels[labels.length - 1], 'DOCS');
    assert.equal(labels[labels.length - 2], 'VORTICES');
    const src = fs.readFileSync(path.join(here, '../whitepaper/build_pdf.py'), 'utf8');
    assert.doesNotMatch(src, /The Join/);
    assert.doesNotMatch(src, /join1\./);
    assert.doesNotMatch(src, /ShearK-Miner 1\.6/);
    assert.doesNotMatch(src, /pin 0\.32/);
    assert.doesNotMatch(src, /pin 0\.37/);
    assert.match(src, /ShearK-Miner 2\.6/);
    assert.match(src, /pin 0\.66/);
    assert.doesNotMatch(src, /pin 0\.55/);
    assert.equal(pdf.includes(Buffer.from('The Join')), false);
    const hay = pdfHaystack(pdf);
    assert.equal(hay.includes(Buffer.from('shear-testnet-v3')), false);
    assert.equal(hay.includes(utf16be('shear-testnet-v3')), false);
    assert.equal(hay.includes(Buffer.from('ADMITV1')), false);
    assert.equal(hay.includes(utf16be('ADMITV1')), false);
    assert.equal(hay.includes(Buffer.from('ShearK-Miner 1.6')), false);
    assert.equal(hay.includes(utf16be('ShearK-Miner 1.6')), false);
    assert.equal(hay.includes(Buffer.from('wallet 0.32')) || hay.includes(utf16be('wallet 0.32')) || hay.includes(utf16be('pin 0.32')), false);
    assert.equal(pdf.includes(Buffer.from('shear-testnet-v10')), true);
    assert.equal(pdf.includes(Buffer.from('wallet-0.66')), true);
    assert.match(paper, /30th October 2026 at 1400hrs UK time/);
    assert.doesNotMatch(paper, /1st October 2026/);
    assert.equal(pdf.includes(Buffer.from('ShearK-2.6')), true);
    assert.doesNotMatch(content, /The Join/);
    assert.doesNotMatch(content, /join1\./);
  });
});

describe('deploy headers', () => {
  it('SSL vhosts send HSTS; stratum reload requires BIND+AUTH', () => {
    const root = path.join(here, '../..');
    const boot = fs.readFileSync(path.join(root, 'deploy/nginx-boot.shear.digital.conf'), 'utf8');
    const admin = fs.readFileSync(path.join(root, 'deploy/nginx-admin.shear.digital.conf'), 'utf8');
    assert.match(boot, /Strict-Transport-Security/);
    assert.match(admin, /Strict-Transport-Security/);
    const reload = fs.readFileSync(path.join(root, 'deploy/reload-stratum-units.sh'), 'utf8');
    assert.match(reload, /SHEAR_STRATUM_BIND=127\.0\.0\.1/);
    assert.match(reload, /SHEAR_STRATUM_AUTH=1/);
    const list = fs.readFileSync(path.join(root, 'deploy/STRATUM_CHECKLIST.md'), 'utf8');
    assert.match(list, /SHEAR_STRATUM_BIND=127\.0\.0\.1/);
    assert.match(list, /SHEAR_STRATUM_AUTH=1/);
    assert.match(list, /dest-ban without ownership/);
    assert.match(list, /reload-stratum-units\.sh/);
  });
});
