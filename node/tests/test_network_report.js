import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { networkReport, freshMinerRounds } from '../src/network_report.js';
import { createRpc } from '../src/rpc.js';

describe('network report', () => {
  it('keeps proven rounds and drops a dest, a bad tag, and a claimed hash rate', () => {
    const dest = `ssa1q${'ab'.repeat(20)}`;
    const report = networkReport({
      height: 12,
      hash: 'ab'.repeat(32),
      nodesOnline: 3,
      peersLive: 4,
      rounds: [
        { tag: 'mdeadbeef', count: 256, hashrate: 99999, dest, ip: '77.42.91.84' },
        { tag: dest, count: 100 },
        { tag: 'not-a-tag', count: 50 },
        { miner: 'mabcdef01', count: 10, worker: 'alice' },
      ],
      mempool: [
        { kind: 'send', to: dest, nanos: 5 },
        { kind: 'ssa1qleak', from: dest },
        { kind: 'lock' },
      ],
    });
    const blob = JSON.stringify(report);
    assert.equal(report.ok, true);
    assert.equal(report.height, 12);
    assert.equal(report.hash, 'ab'.repeat(32));
    assert.equal(report.nodesOnline, 3);
    assert.equal(report.peersLive, 4);
    assert.equal(report.provenRoundHashes, 266);
    assert.equal(report.miners, 2);
    assert.deepEqual(report.rounds, [
      { tag: 'mdeadbeef', count: 256 },
      { tag: 'mabcdef01', count: 10 },
    ]);
    assert.equal(report.pending, 3);
    assert.equal(report.pendingKinds.send, 1);
    assert.equal(report.pendingKinds.lock, 1);
    assert.equal(report.pendingKinds.other, 1);
    assert.equal(Object.hasOwn(report, 'hashrate'), false);
    assert.doesNotMatch(blob, /ssa1|she1|shear1|77\.42\.91\.84|hashrate|alice|nanos|dest/);
  });

  it('relays only a strictly newer proven count', () => {
    const before = [{ tag: 'mdeadbeef', count: 10 }];
    assert.deepEqual(freshMinerRounds(before, [{ tag: 'mdeadbeef', count: 10 }]), []);
    assert.deepEqual(
      freshMinerRounds(before, [{ tag: 'mdeadbeef', count: 11 }]),
      [{ tag: 'mdeadbeef', count: 11 }],
    );
    assert.deepEqual(freshMinerRounds(before, [{ tag: 'ssa1qnope', count: 99 }]), []);
  });

  it('GET /api/network counts a lone node and does not echo a sealed dest', async () => {
    const dest = `ssa1q${'cd'.repeat(20)}`;
    const store = {
      tip: () => ({ height: 7, hash: Buffer.from('cd'.repeat(32), 'hex') }),
      openRoundRows: () => [
        { tag: 'mdeadbeef', count: 4 },
        { tag: dest, count: 9 },
      ],
      mempool: [{ kind: 'send', to: dest, nanos: 3 }],
    };
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    try {
      const heard = await rpc.listen();
      const body = await fetch(`http://127.0.0.1:${heard.port}/api/network`).then((r) => r.json());
      assert.equal(body.ok, true);
      assert.equal(body.nodesOnline, 1);
      assert.equal(body.height, 7);
      assert.equal(body.provenRoundHashes, 4);
      assert.equal(body.pending, 1);
      assert.equal(body.pendingKinds.send, 1);
      assert.doesNotMatch(JSON.stringify(body), /ssa1|nanos/);
      const via = await rpc.dispatch('getnetwork');
      assert.equal(via.nodesOnline, 1);
      assert.equal(via.provenRoundHashes, 4);
    } finally {
      await rpc.close();
    }
  });
});
