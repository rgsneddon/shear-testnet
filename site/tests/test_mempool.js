import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { newIdentity, freshStealthDest } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import { PI_SHE_NANOS } from '../../crypto/asert.js';
import { explorerRecentTxs, orderExplorerRecent, publicPayloadLeaksIdentity, publicSurfaceRow } from '../../pool/src/wallet_api.js';
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
    assert.match(html, /function isHashBonus/);
    assert.match(html, /function latticeTxs/);
    assert.match(html, /function txWeightLevel/);
    assert.match(html, /one seat per miner on the network/);
    assert.match(html, /Filaments link those gold seats to the cyan miners/);
    assert.match(html, /Weight sets the level/);
    assert.match(html, /Open in full screen/);
    assert.match(html, /lattice-full/);
    assert.match(html, /function spawnCommitBursts/);
    assert.match(html, /function spawnCascade/);
    assert.match(html, /txCount \+ ' txs'/);
    assert.doesNotMatch(html, /hash bonuses, pot, and every other tx/);
    assert.doesNotMatch(html, /valid-hash bonus/);
    assert.match(html, /releases\/tag\/0\.35/);
    assert.doesNotMatch(html, /releases\/tag\/0\.34/);
    assert.doesNotMatch(html, /releases\/tag\/0\.32/);
    assert.doesNotMatch(html, /releases\/tag\/0\.31/);
    assert.doesNotMatch(html, /releases\/tag\/0\.30/);
    assert.doesNotMatch(html, /releases\/tag\/0\.29/);
    assert.doesNotMatch(html, /GNFP/);
    assert.doesNotMatch(html, /50 hashes each/);
    assert.match(html, /Gold hoop — pending Flow sends/);
  });

  it('latticeTxs drops hash bonuses; tx weight lifts pending sends; miners stay cyan seats', () => {
    const start = html.indexOf('function isHashBonus(');
    const end = html.indexOf('function layout(');
    assert.ok(start >= 0 && end > start, 'shipped lattice helpers');
    const fns = new Function(`${html.slice(start, end)}\nreturn { isHashBonus, latticeTxs, formingHashSeats, massOf, txWeightLevel, bandSends };`)();
    assert.equal(fns.isHashBonus({ kind: 'hash' }), true);
    assert.equal(fns.isHashBonus({ kind: 'send' }), false);
    const kept = fns.latticeTxs([
      { id: 'a', kind: 'send' },
      { id: 'b', kind: 'hash' },
      { id: 'c', kind: 'lock' },
      { id: 'd', kind: 'dummy' },
      { id: 'e', kind: 'b-spend' },
      { id: 'f', kind: 'coinbase' },
    ]);
    assert.deepEqual(kept.map((t) => t.id), ['a', 'c', 'e', 'f']);
    const miners = fns.formingHashSeats({
      txs: [
        { id: 'hash-m1', kind: 'hash', count: 40 },
        { id: 'send-1', kind: 'send', weight: 2, fee: 8 },
        { id: 'hash-zero', kind: 'hash', count: 0 },
      ],
    });
    assert.deepEqual(miners.map((t) => t.id), ['hash-m1']);
    const heavy = { id: 'hi', kind: 'send', weight: 8, fee: 12, included: true };
    const light = { id: 'lo', kind: 'send', weight: 1, fee: 0, included: false };
    assert.ok(fns.txWeightLevel(heavy) > fns.txWeightLevel(light));
    const bands = fns.bandSends([light, heavy]);
    assert.equal(bands[0][0].id, 'hi');
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
    assert.match(explorer, /reserve-chip/);
    assert.match(explorer, /Reserve lock and vote/);
    assert.doesNotMatch(explorer, /memoPlain|memo-plain/);
  });

  it('30 sealed blocks plus a mempool lock still paint (pending) first after the page transform', () => {
    const alice = newIdentity();
    const from = freshStealthDest(alice).dest;
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
    const api = [
      { id: 'lock-live', kind: 'lock', pending: true, status: 'pending', height: 0, from, to, amount: 1 },
      { id: 'vote-live', kind: 'vote', pending: true, status: 'pending', height: 0, from, to, amount: 0 },
    ];
    assert.ok(String(from).startsWith('ssa1'));
    assert.equal(/she1|shear1/i.test(JSON.stringify(api[0])), false);

    const start = explorer.indexOf('function isPendingRow(');
    const end = explorer.indexOf('function paintTxs(');
    assert.ok(start >= 0 && end > start, 'shipped orderRecentTxs');
    const page = new Function(`${explorer.slice(start, end)}\nreturn orderRecentTxs;`)();
    const heightSorted = api.slice().sort((a, b) => Number(b.height) - Number(a.height)).concat(
      Array.from({ length: 28 }, (_, i) => ({
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
      assert.equal(publicPayloadLeaksIdentity(stats.recentTxs), false);
      const row = publicSurfaceRow(stats.recentTxs[0]);
      assert.equal(row.to, '');
      assert.equal(row.kind, 'lock');
      assert.equal(row.amountHidden, true);
      assert.equal(row.amount, undefined);
      assert.equal(row.memoPlain, undefined);
    } finally {
      pool.close();
    }
  });
});
