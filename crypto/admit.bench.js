import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomScalar, commit, pointBytes } from './note.js';
import { admitPub, admitProve, admitVerify, jroot } from './admit.js';
import { nativeBench } from './native_admit.js';

function makeJ(n) {
  const xs = Array.from({ length: n }, () => randomScalar());
  const pubs = xs.map(admitPub);
  const commits = xs.map((_, i) => pointBytes(commit((i % 1000) + 1, xs[i])));
  return { xs, pubs, commits };
}

describe('ADMITv2 bench 1k/10k/100k', { timeout: 600_000 }, () => {
  it('1k JS prove/verify against jroot is milliseconds class; proof is few KB', () => {
    const n = 1024;
    const { xs, pubs, commits } = makeJ(n);
    const jr = jroot({ pubs, commits });
    const t0 = Date.now();
    const proof = admitProve({ x: xs[7], index: 7, pubs, commits, c: commits[7] });
    const proveMs = Date.now() - t0;
    assert.ok(proof);
    const t1 = Date.now();
    const ok = admitVerify(proof, { pubs: [], commits: [] }, { jroot: jr, cTilde: proof.cTilde, spendTag: proof.spendTag });
    const verifyMs = Date.now() - t1;
    assert.equal(ok, true);
    assert.ok(proof.blob.length <= 32768, `proof ${proof.blob.length}`);
    assert.ok(proveMs < 30_000, `prove ${proveMs}ms`);
    assert.ok(verifyMs < 1_000, `verify ${verifyMs}ms (must be log-time vs jroot)`);
  });

  for (const n of [1_000, 10_000, 100_000]) {
    it(`native |J|=${n} prove/verify; verify is log-time`, () => {
      const got = nativeBench(n);
      assert.ok(got, `native bench ${n} failed`);
      const proveMs = got.proveUs / 1000;
      const verifyMs = got.verifyUs / 1000;
      assert.ok(got.proofLen <= 32768, `proof ${got.proofLen}`);
      assert.ok(got.proofLen > 0);
      if (n <= 1_000) {
        assert.ok(proveMs < 5_000, `1k prove ${proveMs}ms`);
        assert.ok(verifyMs < 50, `1k verify ${verifyMs}ms`);
      } else if (n <= 10_000) {
        assert.ok(proveMs < 30_000, `10k prove ${proveMs}ms`);
        assert.ok(verifyMs < 200, `10k verify ${verifyMs}ms`);
      } else {
        assert.ok(proveMs < 90_000, `100k prove ${proveMs}ms`);
        assert.ok(verifyMs < 500, `100k verify ${verifyMs}ms`);
      }
    });
  }
});
