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
  const slice = src.slice(start, end);
  const names = ['poolTagSet', 'isPoolFoundBlock', 'notePoolFind', 'wallFoundMs', 'poolBlockRows', 'foundInMs', 'fmtFoundIn', 'stampOwner'];
  if (slice.includes('function chainAt')) names.push('chainAt', 'ledgerFindMs');
  const sandbox = {};
  vm.createContext(sandbox);
  // headerAtBook is the explorer header fetch. Pages that read it close over this object.
  vm.runInContext(`var headerAtBook = {};\n${slice}\n({ ${names.join(', ')}, headerAtBook });`, sandbox);
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
      // The header still in view is the one from the find, before the ledger stamp.
      const now = stats({
        recentTxs: [
          { kind: 'block', height: 33, id: 'tip', at: 1_000_000, finder: TAG },
          { kind: 'block', height: 32, id: 'prev', at: 948_000, finder: TAG },
        ],
      });
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
        recentTxs: [{ kind: 'block', height: 32, id: 'prev', at: 948_000, finder: TAG }],
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

    it(`${rel} uses foundAt, never the header timestamp, as this block's find`, () => {
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
      if (rel.includes('public/explorer.html')) {
        assert.equal(api.foundInMs(rows[0], now, ledger), 0);
        assert.equal(api.fmtFoundIn(api.foundInMs(rows[0], now, ledger)), '—');
      } else {
        // Previous find is this header stamp. Tip find stays foundAt.
        assert.equal(api.foundInMs(rows[0], now, ledger), 88_000);
        assert.equal(api.fmtFoundIn(88_000), '1m 28s');
      }
    });
  }
});

describe('explorer backfills Found in for every listed pool block', () => {
  const api = loadFindFns('../../explorer/explorer.html');
  // Header gaps: 33 vs 32 is the 52s bug; 34 vs 33 is the wall gap that was watched.
  const at32 = 1_000_000;
  const at33 = at32 + 52_445;
  const at34 = at33 + 146_336;
  const lastFoundAt = at34 + 140_000;

  function windowStats(over) {
    return {
      height: 34,
      lastFoundAt,
      workers: [{ miner: TAG }],
      recentTxs: [
        { kind: 'block', height: 34, id: 'h34', at: at34, finder: TAG },
        { kind: 'block', height: 33, id: 'h33', at: at33, finder: TAG },
        { kind: 'block', height: 32, id: 'h32', at: at32, finder: TAG },
      ],
      ...over,
    };
  }

  it('fills older rows from the next header stamp when the ledger has only the tip', () => {
    const now = windowStats();
    const ledger = {};
    const rows = api.poolBlockRows(now, ledger);
    assert.equal(rows.map((r) => r.height).join(','), '34,33,32');
    assert.equal(api.wallFoundMs(rows[0], now, ledger), lastFoundAt);
    assert.notEqual(api.wallFoundMs(rows[0], now, ledger), at34);
    assert.equal(api.foundInMs(rows[0], now, ledger), 140_000);
    assert.equal(api.fmtFoundIn(api.foundInMs(rows[0], now, ledger)), '2m 20s');
    // Row 33 is at(34)-at(33), not the 52s header delta against 32.
    assert.equal(api.foundInMs(rows[1], now, ledger), 146_336);
    assert.equal(api.fmtFoundIn(api.foundInMs(rows[1], now, ledger)), '2m 26s');
    assert.notEqual(api.fmtFoundIn(api.foundInMs(rows[1], now, ledger)), '52s');
    assert.equal(api.foundInMs(rows[2], now, ledger), 52_445);
    assert.equal(api.fmtFoundIn(api.foundInMs(rows[2], now, ledger)), '52s');
    for (const row of rows) {
      assert.notEqual(api.fmtFoundIn(api.foundInMs(row, now, ledger)), '—');
    }
  });

  it('keeps the 38s row on the previous listed pool find when an older stamp is closer in the ledger', () => {
    // Live shape: pool shows ~38s for height 40, a skipped ledger stamp is >5 min.
    const at39 = 1_000_000;
    const at40 = at39 + 300_000;
    const at41 = at40 + 38_000;
    const at42 = at41 + 331_000;
    const tipFound = at42 + 50_000;
    const now = {
      height: 42,
      lastFoundAt: tipFound,
      workers: [{ miner: TAG }],
      recentTxs: [
        { kind: 'block', height: 42, id: 'h42', at: at42, finder: TAG },
        { kind: 'block', height: 41, id: 'h41', at: at41, finder: TAG },
        { kind: 'block', height: 40, id: 'h40', at: at40, finder: TAG },
        { kind: 'block', height: 39, id: 'h39', at: at39, finder: TAG },
      ],
    };
    // Saw 39, missed 40, and the tip stamp was pinned onto 40 before height advanced.
    const ledger = { 39: at40, 40: tipFound };
    const rows = api.poolBlockRows(now, ledger);
    const row40 = rows.find((r) => r.height === 40);
    const row41 = rows.find((r) => r.height === 41);
    assert.equal(api.foundInMs(row40, now, ledger), 38_000);
    assert.equal(api.fmtFoundIn(api.foundInMs(row40, now, ledger)), '38s');
    assert.notEqual(api.fmtFoundIn(api.foundInMs(row40, now, ledger)), '5m 38s');
    assert.equal(api.foundInMs(row41, now, ledger), 331_000);
    assert.equal(api.fmtFoundIn(331_000), '5m 31s');
    assert.equal(ledger[42], tipFound);
    assert.notEqual(ledger[40], tipFound);
  });

  it('keeps an observed lastFoundAt ahead of the next-header approximation', () => {
    const now = windowStats();
    const observed33 = at34 - 5_000;
    const ledger = { 33: observed33, 32: at33 };
    api.notePoolFind(now, ledger);
    const rows = api.poolBlockRows(now, ledger);
    assert.equal(api.wallFoundMs(rows.find((r) => r.height === 33), now, ledger), observed33);
    assert.equal(api.foundInMs(rows[0], now, ledger), lastFoundAt - observed33);
    assert.notEqual(api.foundInMs(rows[0], now, ledger), 140_000);
    assert.equal(api.foundInMs(rows.find((r) => r.height === 33), now, ledger), observed33 - at33);
  });
});

describe('found in uses the ledger first, then the header timestamp', () => {
  for (const rel of ['../../explorer/explorer.html', '../public/index.html']) {
    const api = loadFindFns(rel);

    it(`${rel} keeps a ledger stamp that is later than the header`, () => {
      const header32 = 948_000;
      const find32 = 1_000_000;
      const find33 = 1_140_000;
      const now = stats({
        height: 33,
        lastFoundAt: find33,
        recentTxs: [
          { kind: 'block', height: 33, id: 'tip', at: 1_052_000, finder: TAG },
          { kind: 'block', height: 32, id: 'prev', at: header32, finder: TAG },
        ],
      });
      const ledger = { 32: find32, 33: find33 };
      assert.equal(api.wallFoundMs(now.recentTxs[1], now, ledger), find32);
      assert.notEqual(api.wallFoundMs(now.recentTxs[1], now, ledger), header32);
      assert.equal(api.foundInMs(now.recentTxs[0], now, ledger), find33 - find32);
      assert.equal(api.fmtFoundIn(find33 - find32), '2m 20s');
      assert.notEqual(api.foundInMs(now.recentTxs[0], now, ledger), 52_000);
    });

    it(`${rel} falls back to the header timestamp when the height is outside the ledger`, () => {
      const header20 = 500_000;
      const header21 = 588_000;
      const now = stats({
        height: 33,
        lastFoundAt: 1_140_000,
        recentTxs: [
          { kind: 'block', height: 21, id: 'h21', at: header21, finder: TAG, poolFound: true },
          { kind: 'block', height: 20, id: 'h20', at: header20, finder: TAG, poolFound: true },
        ],
      });
      const ledger = { 33: 1_140_000 };
      const row20 = now.recentTxs.find((r) => r.height === 20);
      assert.equal(api.wallFoundMs(row20, now, ledger), header21);
      assert.notEqual(api.wallFoundMs(row20, now, ledger), header20);
      assert.equal(api.foundInMs(row20, now, ledger), header21 - header20);
      assert.equal(api.fmtFoundIn(api.foundInMs(row20, now, ledger)), '1m 28s');
    });
  }

  it('explorer header fetch fills a row that is outside the ledger and outside recentTxs', () => {
    const api = loadFindFns('../../explorer/explorer.html');
    const now = stats({
      height: 33,
      lastFoundAt: 1_140_000,
      recentTxs: [
        { kind: 'block', height: 33, id: 'tip', at: 1_052_000, finder: TAG },
      ],
    });
    api.headerAtBook[12] = 200_000;
    api.headerAtBook[13] = 288_000;
    const row = { kind: 'block', height: 12, id: 'old', at: 0, finder: TAG, poolFound: true };
    const outside = { 33: 1_140_000 };
    assert.equal(api.chainAt(now, 12), 200_000);
    assert.equal(api.wallFoundMs(row, now, outside), 288_000);
    assert.equal(api.foundInMs(row, now, outside), 88_000);
    const inLedger = { 12: 250_000, 33: 1_140_000 };
    assert.equal(api.wallFoundMs(row, now, inLedger), 250_000);
    assert.notEqual(api.wallFoundMs(row, now, inLedger), 288_000);
    assert.equal(api.foundInMs(row, now, inLedger), 50_000);
  });
});
