import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../mempool/index.html'),
  'utf8',
);

describe('mempool lattice honesty', () => {
  it('does not paint bonus seats from clientHashes', () => {
    assert.doesNotMatch(html, /clientHashes/);
    assert.match(html, /roundHashes/);
    assert.match(html, /valid-hash bonus|Valid hashes/);
    assert.match(html, /releases\/tag\/0\.18/);
    assert.doesNotMatch(html, /releases\/tag\/0\.17/);
    assert.doesNotMatch(html, /GNFP/);
    assert.doesNotMatch(html, /50 hashes each/);
    assert.match(html, /Gold hoop — user Flow sends/);
  });
});
