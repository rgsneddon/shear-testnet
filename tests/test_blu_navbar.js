import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The DAG nav item was renamed to BLU (BluNotes, blunote.shear.digital) on the
// live webroot. Every static navbar and both link lists in every shared-chrome
// copy must match live: no nav item labelled DAG or linking to dag.shear.digital,
// and one BLU -> https://blunote.shear.digital/ just after MEMPOOL, before MINER.
// Live markup (shear.digital, pool.shear.digital):
//   <a class="nav-btn" href="https://blunote.shear.digital/">BLU</a>
// Live shear-chrome.js keeps the item id 'DAG' (data-active="DAG" on blunote):
//   { id: 'DAG', label: 'BLU', href: 'https://blunote.shear.digital/' }

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLU = 'https://blunote.shear.digital/';
const WEBROOTS = ['site', 'pool/public', 'pool/admin', 'explorer', 'mempool', 'dag', 'team', 'vortices', 'docs/site-unmapped'];
const CHROME = [
  'site/shared/shear-chrome.js',
  'pool/public/shared/shear-chrome.js',
  'explorer/shared/shear-chrome.js',
  'mempool/shared/shear-chrome.js',
  'team/shared/shear-chrome.js',
];

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

function assertBlu(rel, links) {
  assert.equal(links.filter((l) => l.label === 'DAG').length, 0, `${rel}: nav item labelled DAG`);
  assert.equal(links.filter((l) => /dag\.shear\.digital/.test(l.href)).length, 0, `${rel}: nav item links dag.shear.digital`);
  const blu = links.filter((l) => l.label === 'BLU');
  assert.equal(blu.length, 1, `${rel}: one BLU nav item`);
  const i = links.indexOf(blu[0]);
  assert.equal(blu[0].href, BLU, `${rel}: BLU href`);
  assert.equal(links[i - 1] && links[i - 1].label, 'MEMPOOL', `${rel}: BLU sits just after MEMPOOL`);
  assert.equal(links[i + 1] && links[i + 1].label, 'MINER', `${rel}: BLU sits just before MINER`);
}

describe('navbar: BLU (blunote.shear.digital) replaces DAG, matching live', () => {
  const pages = htmlPages().filter((rel) => staticNav(read(rel)));

  it('finds the static navbar pages', () => {
    assert.ok(pages.length >= 20, `only ${pages.length} static navbars`);
  });

  for (const rel of pages) {
    it(`${rel} static navbar has BLU -> ${BLU} and no DAG`, () => {
      assertBlu(rel, navLinks(staticNav(read(rel))));
    });
  }

  for (const rel of CHROME) {
    it(`${rel} lists BLU -> ${BLU} and no DAG (live and preview)`, () => {
      const lists = chromeLists(read(rel));
      assert.equal(lists.length, 2, `${rel}: expected preview and live link lists`);
      for (const list of lists) {
        assertBlu(rel, list);
        assert.equal(list.find((l) => l.label === 'BLU').id, 'DAG', `${rel}: BLU keeps the live item id DAG`);
      }
    });
  }
});
