import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../public/explorer.html', import.meta.url), 'utf8');

function loadFmtCircShe() {
  const fn = page.match(/function fmtCircShe\(nanos\) \{[\s\S]*?\n    \}/);
  assert.ok(fn, 'fmtCircShe missing from shipped explorer.html');
  return new Function(`${fn[0]}; return fmtCircShe;`)();
}

describe('Circulating Shear card on the shipped explorer page', () => {
  it('162100004829440 nanos renders as 1621.00004829440 SHE', () => {
    const fmtCircShe = loadFmtCircShe();
    assert.equal(fmtCircShe(162100004829440), '1621.00004829440 SHE');
    assert.equal(fmtCircShe(1), '0.00000000001 SHE');
  });

  it('wallet href is releases/tag/0.55.2, ONGOING HASHBONUS WORK stays, light --bg is not restored', () => {
    assert.match(page, /releases\/tag\/0\.55\.2/);
    assert.doesNotMatch(page, /releases\/tag\/0\.55(?!\.)/);
    assert.equal(page.includes('releases/tag/0.56'), false);
    assert.equal(page.includes('0.56'), false);
    assert.match(page, /ONGOING HASHBONUS WORK/);
    assert.match(page, /id="ex-hashrate"/);
    assert.match(page, /\/brand\/theme\.css/);
    assert.doesNotMatch(page, /<html[^>]*data-theme="light"/);
    assert.match(page, /html:not\(\[data-theme="light"\]\)/);
    assert.doesNotMatch(page, /--bg:\s*#fff\b/);
    assert.doesNotMatch(page, /--bg:\s*white/);
    assert.match(page, /fmtCircShe\(stats\.circulatingNanos\)/);
  });
});
