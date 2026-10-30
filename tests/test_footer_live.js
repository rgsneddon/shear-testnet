import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Main and pool carry the live 5-link footer (read GET-only from shear.digital
// and pool.shear.digital) with no shear-legal disclaimer, and the repo carries
// the live legal page at site/legal.html (served as https://shear.digital/legal.html).
// legal.html is the live bytes plus the one DONATE navbar line this PR adds to
// every static navbar; with that line removed it must hash to the live sha256.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const LIVE_FOOTER = [
  '  <footer class="footer">',
  '    <div class="wrap footer-inner">',
  '      <div data-shear-foot data-wallet-fallback="0.71" data-network-fallback="shear-testnet-v11">Shear · … · Continuum … · …</div>',
  '      <nav>',
  '        <a href="https://shear.digital/">Home</a>',
  '        <a href="https://shear.digital/network.html">Network</a>',
  '        <a href="https://shear.digital/docs/index.html">Docs</a>',
  '        <a href="https://shear.digital/privacy.html">Privacy</a>',
  '        <a href="https://shear.digital/legal.html">Legal &amp; licences</a>',
  '      </nav>',
  '    </div>',
  '  </footer>',
].join('\n');

const LIVE_LEGAL_SHA256 = '8daf9f0cf4b1a7d1225bf4236b154545a5b470ceee5945a9c535d5fa7a5e0065';
const DONATE_LINE = '      <a class="nav-btn" href="https://donate.shear.digital/">DONATE</a>\n';

describe('footer: live 5-link footer and legal page', () => {
  for (const rel of ['site/index.html', 'pool/public/index.html']) {
    it(`${rel} has exactly the live footer and no shear-legal disclaimer`, () => {
      const html = read(rel);
      const footers = html.match(/^ {2}<footer\b[\s\S]*?<\/footer>/gm) || [];
      assert.equal(footers.length, 1, `${rel}: one footer`);
      assert.equal(footers[0], LIVE_FOOTER, `${rel}: footer markup differs from live`);
      assert.doesNotMatch(html, /class="shear-legal"/, `${rel}: shear-legal disclaimer`);
    });
  }

  it('site/legal.html is the live page (plus the PR 155 DONATE nav line)', () => {
    const rel = 'site/legal.html';
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} missing`);
    const bytes = fs.readFileSync(path.join(root, rel));
    const text = bytes.toString('utf8');
    assert.equal(text.split(DONATE_LINE).length - 1, 1, `${rel}: one DONATE nav line`);
    const live = Buffer.from(text.replace(DONATE_LINE, ''), 'utf8');
    assert.equal(crypto.createHash('sha256').update(live).digest('hex'), LIVE_LEGAL_SHA256, `${rel}: bytes differ from live`);
    assert.ok(text.includes(LIVE_FOOTER), `${rel}: live footer`);
  });
});
