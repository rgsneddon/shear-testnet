import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The public mainnet countdown on the live webroot is 21st December 2026 at
// 1400hrs UK time (data-until 2026-12-21T14:00:00+00:00). Every web page in the
// repo that shows the countdown must carry the live text and markup, read
// GET-only from shear.digital. site/admin/index.html is a redirect stub on live
// (301) and carries the same sentence as how-to.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const OLD = [/16th November 2026/, /2026-11-16T14:00/];
const SPAN = '<span id="mainnet-countdown" data-until="2026-12-21T14:00:00+00:00">countdown to 21st December 2026 at 1400hrs UK time</span>';
const SCRIPT_DONE = "el.textContent = '21st December 2026 at 1400hrs UK time';";
const SCRIPT_TICK = "el.textContent = 'countdown to 21st December 2026 at 1400hrs UK time · ' + days + 'd ' + pad(hours) + 'h ' + pad(mins) + 'm ' + pad(sec % 60) + 's';";

const EXPECT = {
  'site/index.html': [
    '<strong>Testnet only.</strong> Mainnet is not live · ' + SPAN,
    'Mainnet is not live and the public countdown is 21st December 2026 at 1400hrs UK time. Treat balances as disposable.</div>',
    SCRIPT_DONE,
    SCRIPT_TICK,
  ],
  'site/wallet/index.html': ['<strong>Testnet Continuum 0.71.</strong> Mainnet not live · ' + SPAN, SCRIPT_DONE, SCRIPT_TICK],
  'site/privacy.html': ['<strong>Testnet only.</strong> Mainnet is not live · countdown to 21st December 2026 at 1400hrs UK time'],
  'site/how-to/index.html': [
    '<div class="tn-launch">Testnet is the privacy-class book. Mainnet shear-v1 is not live. The public countdown is 21st December 2026 at 1400hrs UK time.</div>',
    'Mainnet <code>shear-v1</code> is not live. The public countdown is 21st December 2026 at 1400hrs UK time. Page map',
  ],
  'site/admin/index.html': ['The public countdown is 21st December 2026 at 1400hrs UK time.'],
  'site/docs/content.js': ['Mainnet <code>shear-v1</code> is not live. The public countdown is 21st December 2026 at 1400hrs UK time. Do not cut a mainnet genesis zip from these pages.'],
  'site/whitepaper/index.html': ['Mainnet is not live, and the public countdown is 21st December 2026 at 1400hrs UK time.</p>'],
};

describe('countdown: 21st December 2026 at 1400hrs UK time, matching live', () => {
  for (const [rel, wants] of Object.entries(EXPECT)) {
    it(`${rel} carries the live countdown and no older date`, () => {
      const src = read(rel);
      for (const re of OLD) assert.doesNotMatch(src, re, `${rel}: old countdown ${re}`);
      for (const w of wants) assert.ok(src.includes(w), `${rel}: missing live text: ${w}`);
    });
  }
});
