import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../../explorer/explorer.html', import.meta.url), 'utf8');

function loadFmtShe() {
  const fn = page.match(/function fmtShe\(n\) \{[\s\S]*?\n    \}/);
  assert.ok(fn, 'fmtShe missing from shipped explorer.html');
  return new Function(`${fn[0]}; return fmtShe;`)();
}

describe('Circulating Shear card on the shipped explorer page', () => {
  it('162100004829440 nanos renders through the shipped eight-decimal fmtShe', () => {
    const fmtShe = loadFmtShe();
    const nanos = 162100004829440;
    assert.equal(fmtShe(nanos / 100000000000), '1621.00004829');
    assert.equal(fmtShe(1 / 100000000000), '0.00000000');
  });

  it('ONGOING HASHBONUS WORK stays on the dark explorer, and light --bg is not restored', () => {
    assert.match(page, /id="shear-chrome-root" data-active="EXPLORER"/);
    assert.doesNotMatch(page, /releases\/tag\/0\.55(?!\.)/);
    assert.doesNotMatch(page, /releases\/tag\/0\.52/);
    assert.match(page, /ONGOING HASHBONUS WORK/);
    assert.match(page, /id="ex-hashrate"/);
    assert.match(page, /shared\/shear-chrome\.css/);
    assert.doesNotMatch(page, /<html[^>]*data-theme="light"/);
    assert.match(page, /html:not\(\[data-theme="light"\]\)/);
    assert.doesNotMatch(page, /--bg:\s*#fff\b/);
    assert.doesNotMatch(page, /--bg:\s*white/);
    assert.match(page, /fmtShe\(Number\(stats\.circulatingNanos \|\| 0\) \/ NANOS\)/);
  });
});
