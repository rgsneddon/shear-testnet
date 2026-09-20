import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeStatus, printNodeStatus } from '../src/status.js';

function tipStore(height, hashByte = 1) {
  const hash = Buffer.alloc(32, hashByte);
  return { tip: () => ({ height, hash }) };
}

function p2pWith(recs, live = recs.length + 1) {
  const peers = new Map();
  recs.forEach((rec, i) => peers.set(i + 1, rec));
  return { peers, liveOnline: () => live };
}

function idleRec(height) {
  return {
    height,
    want: [],
    pending: new Set(),
    retryPrev: [],
    syncing: false,
  };
}

describe('status IBD catch-up', () => {
  it('stays ibd=true at local height 71 with a live peer tip 95 and empty getblock queues', () => {
    const row = nodeStatus({
      store: tipStore(71),
      p2p: p2pWith([idleRec(95)]),
    });
    assert.equal(row.height, 71);
    assert.equal(row.want, 0);
    assert.equal(row.ibd, true);
  });

  it('printNodeStatus stderr matches the shipped ibd=true false-exit pattern', () => {
    const logs = [];
    const errs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (s) => { logs.push(String(s)); };
    console.error = (s) => { errs.push(String(s)); };
    try {
      const row = printNodeStatus({
        store: tipStore(71),
        p2p: p2pWith([idleRec(95)]),
      });
      assert.equal(row.ibd, true);
      assert.equal(row.want, 0);
      assert.equal(row.height, 71);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.ibd, true);
    assert.equal(parsed.want, 0);
    assert.match(errs[0], /height=71/);
    assert.match(errs[0], /want=0/);
    assert.match(errs[0], /ibd=true/);
  });

  it('stays ibd=true while syncing even when want/pending/retryPrev are empty', () => {
    const rec = idleRec(71);
    rec.syncing = true;
    const row = nodeStatus({
      store: tipStore(71),
      p2p: p2pWith([rec]),
    });
    assert.equal(row.want, 0);
    assert.equal(row.ibd, true);
  });

  it('stays ibd=true for pending, want, or retryPrev even when peer height is not ahead', () => {
    const pending = idleRec(71);
    pending.pending = new Set(['abc']);
    assert.equal(nodeStatus({ store: tipStore(71), p2p: p2pWith([pending]) }).ibd, true);

    const want = idleRec(71);
    want.want = ['abc'];
    assert.equal(nodeStatus({ store: tipStore(71), p2p: p2pWith([want]) }).ibd, true);

    const retry = idleRec(71);
    retry.retryPrev = ['abc'];
    assert.equal(nodeStatus({ store: tipStore(71), p2p: p2pWith([retry]) }).ibd, true);
  });

  it('sets ibd=false when local height >= max live peer height and queues are idle', () => {
    const row = nodeStatus({
      store: tipStore(95),
      p2p: p2pWith([idleRec(95), idleRec(90)]),
    });
    assert.equal(row.height, 95);
    assert.equal(row.want, 0);
    assert.equal(row.ibd, false);
  });

  it('keeps empty-tip height=0 want=0 ibd=false when no live peer is ahead', () => {
    const none = nodeStatus({ store: { tip: () => null } });
    assert.equal(none.height, 0);
    assert.equal(none.want, 0);
    assert.equal(none.ibd, false);

    const genesisPeer = nodeStatus({
      store: { tip: () => null },
      p2p: p2pWith([idleRec(0)]),
    });
    assert.equal(genesisPeer.height, 0);
    assert.equal(genesisPeer.want, 0);
    assert.equal(genesisPeer.ibd, false);
  });
});
