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
