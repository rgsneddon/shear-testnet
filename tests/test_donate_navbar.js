import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every Shear web page that carries the product navbar must link to Donate.
// The canonical donate URL is the donate.shear.digital page (claude/donate-site);
// Donate sits immediately before DOCS, matching that page's own navbar.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DONATE = 'https://donate.shear.digital/';
const WEBROOTS = ['site', 'pool/public', 'pool/admin', 'explorer', 'mempool', 'dag', 'team', 'vortices', 'docs/site-unmapped'];
const CHROME = [
  'site/shared/shear-chrome.js',
  'pool/public/shared/shear-chrome.js',
  'explorer/shared/shear-chrome.js',
  'mempool/shared/shear-chrome.js',
  'team/shared/shear-chrome.js',
];
// Pages with neither a static navbar nor a shared-chrome mount. Listed so a new page cannot skip the check silently.
const NO_NAVBAR = new Set([
  'site/admin/index.html',
  'site/b2b/index.html',
  'site/how-to/index.html',
  'site/p2p/index.html',
  'site/r2r/index.html',
]);

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function htmlPages() {
  const out = [];
  function walk(rel) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs)) {
      const child = path.posix.join(rel, name);
      if (['tests', 'node_modules', 'vendor'].includes(name)) continue;
      if (fs.statSync(path.join(root, child)).isDirectory()) walk(child);
      else if (name.endsWith('.html')) out.push(child);
    }
  }
  for (const r of WEBROOTS) walk(r);
  return out.sort();
}

function staticNav(html) {
  const m = html.match(/<nav\b[^>]*id="shear-nav"[^>]*>([\s\S]*?)<\/nav>/);
  return m ? m[1] : null;
}

function navLinks(nav) {
  return [...nav.matchAll(/<a class="nav-btn[^"]*" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => ({ href: m[1], label: m[2].trim() }));
}

function chromeLists(src) {
  return [...src.matchAll(/\[\s*(\{ id: 'MAIN'[\s\S]*?)\]/g)].map((m) =>
    [...m[1].matchAll(/\{ id: '([^']+)', label: '([^']+)', href: '([^']+)'/g)].map((x) => ({ id: x[1], label: x[2], href: x[3] })),
  );
}

describe('navbar: Donate link on every Shear page', () => {
  const pages = htmlPages();

  it('finds the navbar pages', () => {
    assert.ok(pages.length >= 40, `only ${pages.length} pages`);
  });

  for (const rel of pages) {
    it(`${rel} navbar has DONATE -> ${DONATE} just before DOCS`, () => {
      const html = read(rel);
      const nav = staticNav(html);
      if (nav) {
        const links = navLinks(nav);
        const i = links.findIndex((l) => l.label === 'DONATE');
        assert.ok(i >= 0, `${rel}: static navbar has no DONATE`);
        assert.equal(links[i].href, DONATE, `${rel}: DONATE href`);
        assert.equal(links.filter((l) => l.label === 'DONATE').length, 1, `${rel}: one DONATE`);
        assert.equal(links[i + 1] && links[i + 1].label, 'DOCS', `${rel}: DONATE sits just before DOCS`);
        return;
      }
      if (/id="shear-chrome-root"/.test(html)) {
        assert.match(html, /shared\/shear-chrome\.js/, `${rel}: chrome mount without shear-chrome.js`);
        return; // covered by the shared chrome check below
      }
      assert.ok(NO_NAVBAR.has(rel), `${rel}: no navbar and not listed in NO_NAVBAR`);
    });
  }

  for (const rel of CHROME) {
    it(`${rel} lists DONATE -> ${DONATE} just before DOCS (live and preview)`, () => {
      const lists = chromeLists(read(rel));
      assert.equal(lists.length, 2, `${rel}: expected preview and live link lists`);
      for (const list of lists) {
        const i = list.findIndex((l) => l.id === 'DONATE');
        assert.ok(i >= 0, `${rel}: no DONATE link`);
        assert.equal(list[i].label, 'DONATE');
        assert.equal(list[i].href, DONATE);
        assert.equal(list[i + 1] && list[i + 1].id, 'DOCS', `${rel}: DONATE sits just before DOCS`);
      }
    });
  }

  it('the five shared chrome copies stay identical', () => {
    const first = read(CHROME[0]);
    for (const rel of CHROME.slice(1)) assert.equal(read(rel), first, rel);
  });
});
