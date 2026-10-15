import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeProveRange, nativeLoaded } from './native_admit.js';
import { provePackedRange, scalarBytes, randomScalar } from './note.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function runPolicy(env, script) {
  const childEnv = { ...process.env, ...env };
  if (!Object.prototype.hasOwnProperty.call(env, 'SHEAR_RANGE_JS')) delete childEnv.SHEAR_RANGE_JS;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
  });
}

describe('range JS is opt-in and hidden amounts fail closed', () => {
  it('pool and node hidden-amount creation names the native requirement', () => {
    const pool = readFileSync(path.join(root, 'pool/src/wallet_api.js'), 'utf8');
    const node = readFileSync(path.join(root, 'node/mine_loop.js'), 'utf8');
    const dummy = readFileSync(path.join(root, 'crypto/dummy.js'), 'utf8');
    const note = readFileSync(path.join(root, 'crypto/note.js'), 'utf8');
    assert.match(pool, /hiddenAmountRangeReady\(\)/);
    assert.match(pool, /range_native_required/);
    assert.match(node, /hiddenAmountRangeReady\(\)/);
    assert.match(dummy, /hiddenAmountRangeReady\(\)/);
    assert.match(note, /if \(rangeJsOptIn\(\)\)/);
    assert.match(note, /return false/);
    assert.match(note, /opts\.hidden === true && !rangeJsOptIn\(\)/);
  });

  it('missing native fails verify closed, warns on public prove, and refuses hidden notes', () => {
    assert.equal(nativeLoaded(), true, 'parent comparison host must have shearadmit.node');
    const r = scalarBytes(randomScalar());
    const proof = provePackedRange(100_000_000_000n, r);
    const native = nativeProveRange('100000000000', r);
    assert.ok(proof && native && proof.equals(Buffer.from(native)));
    const closed = runPolicy({ SHEAR_ADMIT_DISABLE: '1' }, `
      import { verifyRange, proveRange, sealNote, commit, pointBytes, scalarFrom } from './crypto/note.js';
      import { nativeLoaded, nativeLoadErrorText } from './crypto/native_admit.js';
      if (nativeLoaded()) throw new Error('native still loaded');
      if (!nativeLoadErrorText().includes('SHEAR_ADMIT_DISABLE=1')) throw new Error('load reason missing');
      const r = Buffer.from('${r.toString('hex')}', 'hex');
      const proof = Buffer.from('${proof.toString('hex')}', 'hex');
      const s = scalarFrom(r);
      const c = pointBytes(commit(100000000000n, s));
      if (verifyRange(c, proof) !== false) throw new Error('verify did not fail closed');
      const pub = proveRange(100000000000n, r);
      if (!pub || pub.length !== 14433) throw new Error('public prove fallback missing');
      const hidden = sealNote(7, { dest20: Buffer.alloc(20, 3), kind: 'send' });
      if (hidden.rangeProof.length !== 0) throw new Error('hidden note was proved');
      console.log('CLOSED_OK');
    `);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    assert.match(closed.stdout, /CLOSED_OK/);
    assert.match(closed.stderr, /shearadmit\.node failed to load: SHEAR_ADMIT_DISABLE=1/);
    assert.match(closed.stderr, /SHEAR RANGE WARNING: proving a range in JavaScript/);
    assert.match(closed.stderr, /SHEAR RANGE WARNING: refusing a hidden-amount range proof/);
    assert.equal(closed.stderr.includes('verifying range proofs in JavaScript'), false);

    const opted = runPolicy({ SHEAR_ADMIT_DISABLE: '1', SHEAR_RANGE_JS: '1' }, `
      import { verifyRange, sealNote, commit, pointBytes, scalarFrom } from './crypto/note.js';
      const r = Buffer.from('${r.toString('hex')}', 'hex');
      const proof = Buffer.from('${proof.toString('hex')}', 'hex');
      const c = pointBytes(commit(100000000000n, scalarFrom(r)));
      if (verifyRange(c, proof) !== true) throw new Error('opt-in verify rejected a native proof');
      const hidden = sealNote(7, { dest20: Buffer.alloc(20, 4), kind: 'send' });
      if (!hidden.rangeProof || hidden.rangeProof.length !== 14433) throw new Error('opt-in hidden prove missing');
      console.log('OPT_IN_OK');
    `);
    assert.equal(opted.status, 0, opted.stderr || opted.stdout);
    assert.match(opted.stdout, /OPT_IN_OK/);
    assert.match(opted.stderr, /SHEAR RANGE WARNING: SHEAR_RANGE_JS=1 is verifying range proofs in JavaScript/);
    assert.match(opted.stderr, /SHEAR RANGE WARNING: proving a range in JavaScript/);
  });
});
