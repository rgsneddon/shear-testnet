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
  const bookStart = src.indexOf('function noteHeaderAt');
  const bookEnd = src.indexOf('function loadFindLedger');
  const bookFns = bookStart > 0 && bookEnd > bookStart ? src.slice(bookStart, bookEnd) : '';
  const prelude = bookFns
    ? 'var headerAtBook = {}; var headerAtBusy = false; var headerAtTried = {};\n'
    : '';
  const names = ['poolTagSet', 'isPoolFoundBlock', 'notePoolFind', 'wallFoundMs', 'poolBlockRows', 'foundInMs', 'fmtFoundIn', 'stampOwner'];
  if (src.includes('function ledgerFindMs')) names.push('ledgerFindMs', 'chainAt');
  if (bookFns) names.push('noteHeaderAt', 'headerAtGaps', 'fillHeaderAt');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${prelude}${bookFns}${src.slice(start, end)}\n({ ${names.join(', ')} });`, sandbox);
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
      const now = stats({
        recentTxs: [
          { kind: 'block', height: 33, id: 'tip', at: 1_052_000, finder: TAG },
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
      if (rel.endsWith('public/explorer.html')) {
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

describe('explorer and pool index backfill Found in for every listed pool block', () => {
  for (const rel of ['../../explorer/explorer.html', '../public/index.html']) {
  const api = loadFindFns(rel);
  const label = rel;
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

  it(`${label} fills older rows from the next header stamp when the ledger has only the tip`, () => {
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

  it(`${label} keeps the 38s row on the previous listed pool find when an older stamp is closer in the ledger`, () => {
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

  it(`${label} keeps an observed lastFoundAt ahead of the next-header approximation`, () => {
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

  it(`${label} drops saved find times at or before the block header, or above the tip`, () => {
    const now = windowStats();
    const stale = { 33: at33, 99: lastFoundAt + 10_000 };
    assert.equal(api.ledgerFindMs(stale, 33, now), 0);
    assert.equal(api.ledgerFindMs(stale, 99, now), 0);
    const rows = api.poolBlockRows(now, stale);
    const row33 = rows.find((r) => r.height === 33);
    assert.equal(api.wallFoundMs(row33, now, stale), at34);
    assert.equal(api.foundInMs(row33, now, stale), at34 - at33);
    const kept = { 33: at33 + 1_000 };
    assert.equal(api.ledgerFindMs(kept, 33, now), at33 + 1_000);
    assert.equal(api.wallFoundMs(row33, now, kept), at33 + 1_000);
  });
  }
});

describe('explorer search rows carry their own header stamps', () => {
  function fresh() {
    return loadFindFns('../../explorer/explorer.html');
  }

  it('asks once for the missing next header on a single-height search', async () => {
    const api = fresh();
    const own = 5_000_000;
    const next = own + 91_000;
    const row = { kind: 'block', height: 4, id: 'old', at: own, finder: TAG, poolFound: true };
    const now = {
      height: 40,
      lastFoundAt: 9_000_000,
      workers: [{ miner: TAG }],
      recentTxs: [
        { kind: 'block', height: 40, id: 'tip', at: 8_000_000, finder: TAG },
        { kind: 'block', height: 39, id: 'prev', at: 7_900_000, finder: TAG },
      ],
    };
    api.noteHeaderAt([row]);
    const oneGap = api.headerAtGaps([row], now.height);
    assert.equal(oneGap && oneGap.from, 5);
    assert.equal(oneGap && oneGap.to, 5);
    api.noteHeaderAt(now.recentTxs);
    assert.equal(api.headerAtGaps(api.poolBlockRows(now, {}), now.height), null);

    const calls = [];
    api.fetchJson = (path) => {
      calls.push(path);
      return Promise.resolve({ headers: [{ height: 5, header: 'hh' }] });
    };
    api.headerTipMs = () => next;
    let painted = 0;
    api.fillHeaderAt([row], now.height, () => { painted += 1; });
    api.fillHeaderAt([row], now.height, () => { painted += 1; });
    assert.deepEqual(calls, ['/explorer/headers?from=5&to=5']);
    await Promise.resolve();
    assert.equal(painted, 1);
    assert.equal(api.chainAt(now, 5), next);
    assert.equal(api.wallFoundMs(row, now, {}), next);
    assert.equal(api.foundInMs(row, now, {}), next - own);
    assert.equal(api.fmtFoundIn(api.foundInMs(row, now, {})), '1m 31s');
    api.fillHeaderAt([row], now.height, () => { painted += 1; });
    assert.equal(calls.length, 1);
    assert.equal(painted, 1);
  });

  it('uses a search row timestamp for the next height and does not read headers', () => {
    const api = fresh();
    const low = { kind: 'block', height: 7, at: 700_000, finder: TAG, poolFound: true };
    const high = { kind: 'block', height: 8, at: 790_000, finder: TAG, poolFound: true };
    const now = { height: 40, lastFoundAt: 9_000_000, workers: [{ miner: TAG }], recentTxs: [] };
    api.noteHeaderAt([low, high]);
    assert.equal(api.headerAtGaps([low], now.height), null);
    const topGap = api.headerAtGaps([low, high], now.height);
    assert.equal(topGap && topGap.from, 9);
    assert.equal(topGap && topGap.to, 9);
    assert.equal(api.wallFoundMs(low, now, {}), 790_000);
    assert.equal(api.foundInMs(low, now, {}), 90_000);
    assert.equal(api.fmtFoundIn(90_000), '1m 30s');
  });
});
