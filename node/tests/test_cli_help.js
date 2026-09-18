import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printHelp, helpTopics } from '../src/help.js';
import { nodeStatus } from '../src/status.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(args) {
  return spawnSync(process.execPath, ['node/src/node.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
  });
}

describe('shear-node CLI help', () => {
  it('prints full help on --help, -h, and help; topics exist; unknown flag exits 2', () => {
    const topics = helpTopics();
    assert.deepEqual(topics.sort(), ['bootstrap', 'env', 'p2p', 'rpc', 'run', 'solo', 'status'].sort());
    const full = printHelp();
    assert.match(full, /SHEAR_DATA/);
    assert.match(full, /clock_wait/);
    assert.match(full, /p2p\.shear\.digital:30303/);
    assert.match(full, /make -C crypto\/native/);
    assert.match(full, /--status/);
    assert.match(full, /GET \/stats/);
    assert.doesNotMatch(full, /77\.42\.91\.84/);
    for (const flag of ['--help', '-h', 'help']) {
      const r = run([flag]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /SHEAR_DATA/);
      assert.match(r.stdout, /clock_wait/);
      assert.match(r.stdout, /p2p\.shear\.digital:30303/);
    }
    const rpc = run(['help', 'rpc']);
    assert.equal(rpc.status, 0, rpc.stderr);
    assert.match(rpc.stdout, /GET \/stats/);
    const solo = run(['--help', 'solo']);
    assert.equal(solo.status, 0, solo.stderr);
    assert.match(solo.stdout, /YOUR_SSA1\.solo/);
    const bad = run(['--not-a-flag']);
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /SHEAR_DATA/);
    const badTopic = run(['help', 'nope']);
    assert.equal(badTopic.status, 2);
  });

  it('nodeStatus reports height 0 and missing backend without a store tip', () => {
    const row = nodeStatus({ store: { tip: () => null } });
    assert.equal(row.event, 'status');
    assert.equal(row.height, 0);
    assert.equal(row.ibd, false);
    assert.equal(row.want, 0);
    assert.match(row.hashBackend, /native|miner|missing/);
  });
});
