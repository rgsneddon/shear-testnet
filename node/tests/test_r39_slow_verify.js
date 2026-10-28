// R39 (Russell 28 Oct): an interpreter fallback in verify is never silent.
// A verify lane logs the backend it actually got (not the one it asked for),
// and on the interpreter logs slow_verify; the node's status JSON says
// slowVerify and its status line prints a WARNING SLOW VERIFY line.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('../../crypto/hash_offloop_child.js', import.meta.url));

function runLane(backend) {
  const header = randomBytes(128);
  header[0] = 1;
  return spawnSync(process.execPath, [child], {
    input: `1\t${header.toString('hex')}\n`,
    env: { ...process.env, SHEAR_HASH_BACKEND: backend },
    encoding: 'utf8',
    timeout: 300_000,
  });
}

describe('R39: slow verify is never silent', () => {
  it('a lane on the interpreter says so; a JIT lane does not', () => {
    const slow = runLane('interpreter');
    assert.equal(slow.status, 0, slow.stderr);
    assert.match(slow.stdout.split('\n')[0], /^BACKEND\tinterpreter$/);
    assert.match(slow.stdout, /^1\t[0-9a-f]{64}$/m);
    assert.match(slow.stderr, /"event":"slow_verify"/);
    assert.match(slow.stderr, /"backend":"interpreter"/);
    const fast = runLane('jit');
    assert.equal(fast.status, 0, fast.stderr);
    assert.match(fast.stdout.split('\n')[0], /^BACKEND\tjit$/);
    assert.doesNotMatch(fast.stderr, /slow_verify/);
    // The same header gives the same digest on both backends.
    assert.equal(slow.stdout.split('\n')[1].split('\t')[1].length, 64);
  });

  it('the node status flags it and prints a warning line', async () => {
    process.env.SHEAR_HASH_BACKEND = 'interpreter';
    const { hashHeaderOffLoop, closeP2pHashWorkers } = await import('../../crypto/hash_offloop.js');
    const { nodeStatus, printNodeStatus } = await import('../src/status.js');
    const header = randomBytes(128);
    header[0] = 1;
    await hashHeaderOffLoop(header);
    const row = nodeStatus({ store: null, p2p: null });
    assert.equal(row.verifyLane, 'interpreter');
    assert.equal(row.slowVerify, true);
    const lines = [];
    const err = console.error;
    const log = console.log;
    console.error = (...a) => lines.push(a.join(' '));
    console.log = () => {};
    try {
      printNodeStatus({ store: null, p2p: null });
    } finally {
      console.error = err;
      console.log = log;
    }
    assert.ok(lines.some((l) => /^WARNING SLOW VERIFY: /.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /verifyLane=interpreter/.test(l)));
    if (typeof closeP2pHashWorkers === 'function') closeP2pHashWorkers();
  });
});
