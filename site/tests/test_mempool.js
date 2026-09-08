import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import { PI_SHE_NANOS } from '../../crypto/asert.js';
import { explorerRecentTxs, orderExplorerRecent } from '../../pool/src/wallet_api.js';
import { createStore } from '../../node/src/store.js';
import { createPool } from '../../pool/src/pool.js';

const html = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../mempool/index.html'),
  'utf8',
);

describe('mempool lattice honesty', () => {
  it('does not paint bonus seats from clientHashes', () => {
    assert.doesNotMatch(html, /clientHashes/);
    assert.match(html, /roundHashes/);
    assert.match(html, /valid-hash bonus|Valid hashes/);
    assert.match(html, /releases\/tag\/0\.27/);
    assert.doesNotMatch(html, /releases\/tag\/0\.26/);
    assert.doesNotMatch(html, /GNFP/);
    assert.doesNotMatch(html, /50 hashes each/);
    assert.match(html, /Gold hoop — user Flow sends/);
  });
});

describe('explorer pending paint', () => {
  const explorer = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../pool/public/explorer.html'),
    'utf8',
  );
  it('paints kind and (pending) for mempool lock/vote; never she1', () => {
    assert.match(explorer, /\(pending\)/);
    assert.match(explorer, /t\.kind/);
    assert.match(explorer, /Reserve lock and vote appear from mempool/);
    assert.match(explorer, /shortDest/);
    assert.doesNotMatch(explorer, /portal id|viewKey|memoPlain/);
    assert.match(explorer, /orderRecentTxs\(hist\.txs/);
    assert.doesNotMatch(explorer, /hist\.txs \|\| \[\]\)\.slice\(\)\.sort/);
  });

  it('30 sealed blocks plus a mempool lock still paint (pending) first after the page transform', () => {
    const alice = newIdentity();
    const from = destForLogin(alice.address, { viewKey: alice.viewKey, height: 1 });
    const to = vaultDest(alice.address, { viewKey: alice.viewKey });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pending-30-'));
    const store = createStore(dir);
    for (let i = 1; i <= 32; i += 1) {
      store.blocks.push({
        height: i,
        hash: Buffer.alloc(32, i),
        txs: [{ id: `block-${i}`, coinbase: true }],
      });
    }
    store.mempool.push({
      id: 'lock-live',
      kind: 'lock',
      from,
      to,
      nanos: PI_SHE_NANOS,
    });
    store.mempool.push({
      id: 'vote-live',
      kind: 'vote',
      from,
      to,
      nanos: 0,
    });
    const api = explorerRecentTxs(store, 30);
    assert.equal(api[0].id, 'lock-live');
    assert.equal(api[0].kind, 'lock');
    assert.equal(api[0].pending, true);
    assert.equal(api[0].status, 'pending');
    assert.equal(api[1].id, 'vote-live');
    assert.equal(api[1].kind, 'vote');
    assert.equal(api[1].pending, true);
    assert.ok(String(api[0].to).startsWith('ssa1'));
    assert.equal(/she1|shear1/i.test(JSON.stringify(api[0])), false);
    assert.equal(api.length, 30);

    const start = explorer.indexOf('function isPendingRow(');
    const end = explorer.indexOf('function paintTxs(');
    assert.ok(start >= 0 && end > start, 'shipped orderRecentTxs');
    const page = new Function(`${explorer.slice(start, end)}\nreturn orderRecentTxs;`)();
    const heightSorted = api.slice().sort((a, b) => Number(b.height) - Number(a.height)).concat(
      Array.from({ length: 5 }, (_, i) => ({
        id: `extra-block-${i}`,
        kind: 'block',
        height: 40 + i,
        from: 'coinbase',
        to: from,
        amount: 1,
      })),
    );
    const painted = page(heightSorted, 30);
    assert.equal(painted[0].id, 'lock-live');
    assert.equal(painted[0].kind, 'lock');
    assert.equal(painted[1].id, 'vote-live');
    const html = painted.map((t) => {
      const st = t.status || (t.pending ? 'pending' : 'confirmed');
      const pendingLabel = st === 'pending' || st === '(pending)' ? '(pending)' : 'confirmed';
      return `${t.kind} ${pendingLabel}`;
    }).join('\n');
    assert.match(html, /^lock \(pending\)/);
    assert.match(html, /vote \(pending\)/);
    assert.equal(painted.length, 30);
    assert.equal(orderExplorerRecent(heightSorted, 30)[0].id, 'lock-live');

    const pool = createPool({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pending-pool-')),
      stratumPort: 0,
      httpPort: 0,
      miner: from,
    });
    try {
      for (const b of store.blocks) pool.store.blocks.push(b);
      for (const m of store.mempool) pool.store.mempool.push(m);
      const stats = pool.publicStats();
      assert.equal(stats.recentTxs[0].id, 'lock-live');
      assert.equal(stats.recentTxs[0].pending, true);
      assert.ok(stats.recentTxs.length <= 10);
    } finally {
      pool.close();
    }
  });
});
