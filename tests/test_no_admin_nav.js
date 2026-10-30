import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Russell: the admin link comes out of the product navbar. No navbar link (static
// HTML, shared chrome link lists, or the theme.js OSAdmin injection) may point at
// /admin on any host. The admin page itself is not touched here.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_HREF = /^(https?:\/\/[^/"']+)?\/admin(\/|$|[?#])/i;
const SKIP = new Set(['node_modules', 'tests', 'vendor', '.git']);

function walk(rel, pred, out = []) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return out;
  for (const name of fs.readdirSync(abs)) {
    if (SKIP.has(name)) continue;
    const child = path.posix.join(rel, name);
    const st = fs.statSync(path.join(root, child));
    if (st.isDirectory()) walk(child, pred, out);
    else if (pred(name)) out.push(child);
  }
  return out;
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ROOTS = ['site', 'pool', 'explorer', 'mempool', 'dag', 'team', 'vortices', 'docs', 'brand'];

describe('navbar: no admin link', () => {
  it('no static navbar links to /admin or shows an ADMIN label', () => {
    const bad = [];
    for (const r of ROOTS) {
      for (const rel of walk(r, (n) => n.endsWith('.html'))) {
        const nav = read(rel).match(/<nav\b[^>]*id="shear-nav"[^>]*>([\s\S]*?)<\/nav>/);
        if (!nav) continue;
        for (const m of nav[1].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)) {
          if (ADMIN_HREF.test(m[1]) || /admin/i.test(m[2])) bad.push(`${rel}: ${m[1]} ${m[2].trim()}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  it('no shared chrome link list has an admin entry', () => {
    const bad = [];
    for (const r of ROOTS) {
      for (const rel of walk(r, (n) => n === 'shear-chrome.js')) {
        for (const m of read(rel).matchAll(/\{ id: '([^']+)', label: '([^']+)', href: '([^']+)'/g)) {
          if (ADMIN_HREF.test(m[3]) || /admin/i.test(m[1] + m[2])) bad.push(`${rel}: ${m[0]}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  it('no theme.js injects an OSAdmin / admin nav link', () => {
    const files = ROOTS.flatMap((r) => walk(r, (n) => n === 'theme.js'));
    assert.ok(files.length >= 7, `theme.js copies: ${files.length}`);
    const bad = [];
    for (const rel of files) {
      const src = read(rel);
      if (/textContent\s*=\s*'OSAdmin'/i.test(src)) bad.push(`${rel}: builds an OSAdmin link`);
      if (/nav\.appendChild\(/.test(src)) bad.push(`${rel}: appends a link to #shear-nav`);
    }
    assert.deepEqual(bad, []);
  });
});
