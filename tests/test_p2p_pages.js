import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// p2p.shear.digital and r2r.shear.digital are seed hosts for the upcoming v12
// testnet. While the chain is paused no node runs there, so the pages must not
// claim a validating peer, list seed ports, or name unverified versions.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['site/p2p/index.html', 'site/r2r/index.html'];
const BANNED = ['ADMITv2', 'shear-testnet-v11', ':30303', 'b2b.shear.digital', 'Continuum 0.71', 'Sentinel v18'];

function origins(html) {
  return [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
}

describe('p2p / r2r seed pages stay honest', () => {
  for (const rel of PAGES) {
    const html = fs.readFileSync(path.join(root, rel), 'utf8');

    for (const s of BANNED) {
      it(`${rel} does not say ${s}`, () => {
        assert.ok(!html.includes(s), `${rel} still contains ${s}`);
      });
    }

    it(`${rel} says v12 and paused`, () => {
      assert.match(html, /v12/);
      assert.match(html, /paused/);
    });

    it(`${rel} carries the maturity line`, () => {
      assert.match(html, /Experimental testnet software, coins have no value/);
    });

    it(`${rel} has no script and no off-site src/href`, () => {
      assert.doesNotMatch(html, /<script/i);
      for (const u of origins(html)) {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//')) continue; // relative
        const host = new URL(u, 'https://shear.digital/').hostname;
        assert.ok(host === 'shear.digital' || host.endsWith('.shear.digital'), `${rel}: off-site ${u}`);
      }
    });
  }
});

// b2b.shear.digital does not exist, so the repo carries no b2b page or reference.
describe('no b2b.shear.digital site', () => {
  it('site/b2b/ is gone', () => {
    assert.equal(fs.existsSync(path.join(root, 'site/b2b')), false);
  });

  it('template-lock.json has no b2b entry', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'site/template-lock.json'), 'utf8'));
    for (const group of Object.values(lock)) {
      for (const key of Object.keys(group)) assert.ok(!/b2b/i.test(key), `lock entry ${key}`);
    }
  });

  it('no file under site/ references b2b.shear.digital', () => {
    const hits = [];
    (function walk(rel) {
      for (const name of fs.readdirSync(path.join(root, rel))) {
        const child = path.posix.join(rel, name);
        if (name === 'node_modules') continue;
        if (fs.statSync(path.join(root, child)).isDirectory()) walk(child);
        else if (fs.readFileSync(path.join(root, child)).includes('b2b.shear.digital')) hits.push(child);
      }
    })('site');
    assert.deepEqual(hits, []);
  });
});
