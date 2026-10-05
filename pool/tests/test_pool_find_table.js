import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadFindFns(rel) {
  const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const start = src.indexOf('function poolTagSet');
  const marks = ['function paintTxs', 'function prevSealedPoolBlock']
    .map((mark) => src.indexOf(mark))
    .filter((n) => n > start);
  const end = Math.min(...marks);
  assert.ok(start > 0 && end > start, rel);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${src.slice(start, end)}\n({ poolTagSet, isPoolFoundBlock, notePoolFind, wallFoundMs, poolBlockRows, foundInMs, fmtFoundIn, stampOwner });`, sandbox);
  return sandbox;
}

const TAG = 'm3a63ed50';
const OTHER = 'mdeadbeef';

function stats(over) {
  return {
    height: 33,
    lastFoundAt: 1_140_000,
    workers: [{ miner: TAG }],
    recentTxs: [
      { kind: 'block', height: 33, id: 'tip', at: 1_052_000, finder: TAG },
      { kind: 'block', height: 32, id: 'prev', at: 1_000_000, finder: TAG },
    ],
    ...over,
  };
}

describe('explorer pool-found table uses wall-clock finds', () => {
  for (const rel of ['../../explorer/explorer.html', '../public/explorer.html', '../public/index.html']) {
    const api = loadFindFns(rel);

    it(`${rel} ignores a 52s header gap and shows the 2m 20s wall find`, () => {
      const ledger = {};
      api.notePoolFind(stats({
        height: 32,
        lastFoundAt: 1_000_000,
        recentTxs: [{ kind: 'block', height: 32, id: 'prev', at: 948_000, finder: TAG }],
      }), ledger);
      const now = stats();
      const rows = api.poolBlockRows(now, ledger);
      assert.equal(rows[0].height, 33);
      assert.equal(rows[0].height, now.height);
      assert.equal(api.foundInMs(rows[0], now, ledger), 140_000);
      assert.equal(api.fmtFoundIn(api.foundInMs(rows[0], now, ledger)), '2m 20s');
      assert.equal(api.fmtFoundIn(52_000), '52s');
      assert.notEqual(api.fmtFoundIn(api.foundInMs(rows[0], now, ledger)), '52s');
    });

    it(`${rel} puts the live tip on top when recentTxs is one block behind`, () => {
      const ledger = {};
      api.notePoolFind(stats({
        height: 32,
        lastFoundAt: 1_000_000,
        recentTxs: [{ kind: 'block', height: 32, id: 'prev', at: 1_000_000, finder: TAG }],
      }), ledger);
      const now = stats({
        height: 33,
        lastFoundAt: 1_140_000,
        recentTxs: [{ kind: 'block', height: 32, id: 'prev', at: 1_052_000, finder: TAG }],
      });
      const rows = api.poolBlockRows(now, ledger);
      assert.equal(rows[0].height, 33);
      assert.equal(rows[0].foundAt, 1_140_000);
      assert.equal(api.foundInMs(rows[0], now, ledger), 140_000);
    });

    it(`${rel} drops blocks this pool did not find`, () => {
      const now = stats({
        height: 34,
        lastFoundAt: 1_140_000,
        recentTxs: [
          { kind: 'block', height: 34, id: 'foreign', at: 1_200_000, finder: OTHER, poolFound: false },
          { kind: 'block', height: 33, id: 'tip', at: 1_052_000, finder: TAG, poolFound: true, foundAt: 1_140_000 },
          { kind: 'lock', height: 0, id: 'lock' },
        ],
      });
      const ledger = {};
      const rows = api.poolBlockRows(now, ledger);
      assert.equal(rows.some((r) => r.height === 34), false);
      assert.equal(rows[0].height, 33);
      assert.equal(api.wallFoundMs(rows[0], now, ledger), 1_140_000);
      assert.notEqual(api.wallFoundMs(rows[0], now, ledger), 1_052_000);
    });

    it(`${rel} uses foundAt, never the header timestamp`, () => {
      const now = stats({
        height: 33,
        lastFoundAt: 140_000,
        recentTxs: [
          { kind: 'block', height: 33, id: 'tip', at: 52_000, finder: TAG, poolFound: true, foundAt: 140_000 },
          { kind: 'block', height: 32, id: 'prev', at: 0, finder: TAG, poolFound: true, foundAt: 0 },
        ],
      });
      const ledger = {};
      const rows = api.poolBlockRows(now, ledger);
      assert.equal(rows[0].height, 33);
      assert.equal(api.wallFoundMs(rows[0], now, ledger), 140_000);
      assert.notEqual(api.wallFoundMs(rows[0], now, ledger), 52_000);
      assert.equal(api.foundInMs(rows[0], now, ledger), 0);
      assert.equal(api.fmtFoundIn(api.foundInMs(rows[0], now, ledger)), '—');
    });
  }
});
