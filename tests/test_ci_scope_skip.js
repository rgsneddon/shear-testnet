/**
 * Vortice scope (Russell 26 Oct): only the Vault/Reserve vortice is in scope.
 * The third-party deploy-key catalog is held out of the full suite by name,
 * as SCOPE, and --check prints it as skipped. The two files that keep other
 * vortices off the chain and away from the Reserve's program id still run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPending, planShards, readPending } from './ci_shard.js';

const shardJs = fileURLToPath(new URL('./ci_shard.js', import.meta.url));

describe('ci scope skip', () => {
  it('holds test_vortice.js out as SCOPE and keeps the Reserve guards in a shard', () => {
    const rows = readPending();
    const scope = rows.filter((r) => r.pr === 'SCOPE');
    assert.deepEqual(scope.map((r) => r.file), ['node/tests/test_vortice.js']);
    const run = planShards(16).flatMap((s) => s.files);
    assert.equal(run.includes('node/tests/test_vortice.js'), false);
    for (const kept of ['node/tests/test_vort1_register.js', 'crypto/vortex.test.js']) {
      assert.equal(run.filter((f) => f === kept).length, 1, kept);
    }
    const out = spawnSync(process.execPath, [shardJs, '--check'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^skipped SCOPE node\/tests\/test_vortice\.js: /m);
  });

  it('refuses a SCOPE row with no dated ruling, or one that is tracked', () => {
    const files = ['node/tests/test_vortice.js'];
    const base = { line: 1, file: files[0], pr: 'SCOPE', track: false };
    assert.deepEqual(checkPending(files, [{ ...base, reason: 'Vortice scope, Russell 26 Oct: paused' }]), []);
    assert.match(checkPending(files, [{ ...base, reason: 'out of scope' }]).join('\n'), /needs the dated ruling/);
    assert.match(checkPending(files, [{ ...base, track: true, reason: 'Russell 26 Oct' }]).join('\n'), /cannot be tracked/);
  });
});
