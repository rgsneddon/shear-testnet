/**
 * An old pull-book.json on disk carries credits, pulled rows and a last-pull
 * clock from the custodial book. None of it is money the pool holds: miners
 * are paid from the coinbase (R14a). The pull book must not load those rows,
 * must not write them back, and /api/stats must not paint balances or a
 * reconcile from them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { createPullBook } from '../src/pull_book.js';
import { configuredFeeIdentity, createPool, publicMinerTag } from '../src/pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FEE = configuredFeeIdentity().feeDest;
const BALANCE_KEYS = /potCreditsNanos|hashCreditsNanos|attributedFeeNanos|expectedNetPotNanos|driftNanos|"reconcile"/;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

/** A pull-book.json as the custodial book wrote it: three pot credits, a hash credit, one pull. */
function writeOldBook(dir, tag, dest) {
  fs.mkdirSync(dir, { recursive: true });
  const dest20 = Buffer.from(hash20FromAddress(dest)).toString('hex');
  const credits = [7, 8, 9].map((height) => ({ tag, nanos: 99_000_000_000, height, ms: height, kind: 'pot', dest20 }));
  credits.push({ tag, nanos: 5_000_000, height: 9, ms: 9, kind: 'hash', dest20 });
  const disk = {
    credits,
    pulled: [{ tag, nanos: 50_000_000_000, height: 40, ms: 40, dest20 }],
    lastPullMs: { [tag]: 40 },
    found: { [tag]: 3 },
    finders: { 7: { tag, worker: 'rig' } },
    dests: { [tag]: dest20 },
    sealsLifetime: 3,
  };
  fs.writeFileSync(path.join(dir, 'pull-book.json'), `${JSON.stringify(disk)}\n`);
}

describe('an old pull-book.json is not a balance', () => {
  it('createPullBook loads no credits, pulls or pull clock, and writes none back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stale-book-'));
    const dest = minerDest();
    const tag = publicMinerTag(dest);
    writeOldBook(dir, tag, dest);
    const book = createPullBook(dir);
    const v = book.view(tag, { tipHeight: 80, need: 1 });
    assert.equal(v.pendingNanos, 0);
    assert.equal(v.confirmedNanos, 0);
    assert.equal(v.unconfirmedNanos, 0);
    assert.equal(v.confirmedPotNanos, 0);
    assert.equal(v.confirmedHashNanos, 0);
    assert.equal(v.sentNanos, 0);
    assert.equal(v.lastPullMs, 0);
    assert.equal(v.foundBlocks, undefined, 'no lifetime count is painted from the book');
    assert.equal(book.ledger(tag).length, 0);
    assert.equal(book.unpaidPotNanos({ tipHeight: 80, need: 1 }), 0);
    assert.equal(book.reconcile, undefined, 'nothing to reconcile');
    assert.equal(book.takeConfirmed, undefined, 'nothing to take');
    assert.equal(book.finderOf, undefined, 'no finder record');
    assert.equal(book.sealsLifetime, undefined, 'no seal count from credits');
    // The tag and its dest stay known: the miner page still answers for it.
    assert.equal(book.hasTag(tag), true);
    assert.equal(book.destOf(tag), dest.split('.')[0]);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'pull-book.json'), 'utf8'));
    for (const key of ['credits', 'pulled', 'lastPullMs', 'finders', 'sealsLifetime']) {
      assert.equal(Object.hasOwn(written, key), false, `${key} written back`);
    }
    assert.doesNotMatch(JSON.stringify(written), /ssa1/);
  });

  it('/api/stats on a datadir with an old pull-book.json paints zero balances and no reconcile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stale-stats-'));
    const dest = minerDest();
    const tag = publicMinerTag(dest);
    writeOldBook(dir, tag, dest);
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: FEE });
    try {
      const stats = pool.publicStats();
      assert.equal(stats.reconcile, undefined);
      assert.equal(stats.blocksLifetime, 0);
      assert.equal(stats.sealsLifetime, 0);
      assert.doesNotMatch(JSON.stringify(stats), BALANCE_KEYS);
      await new Promise((resolve, reject) => {
        pool.httpServer.listen(0, '127.0.0.1', resolve);
        pool.httpServer.on('error', reject);
      });
      const port = pool.httpServer.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/miners/${encodeURIComponent(tag)}`);
      const miner = await res.json();
      assert.equal(res.status, 200, JSON.stringify(miner));
      assert.equal(miner.ok, true, miner.reason);
      assert.equal(miner.pendingShe, 0);
      assert.equal(miner.confirmedShe, 0);
      assert.equal(miner.unconfirmedShe, 0);
      assert.equal(miner.blocksLifetime, 0);
      assert.doesNotMatch(JSON.stringify(miner), BALANCE_KEYS);
    } finally {
      pool.close();
    }
  });

  it('the pull book source reads no credits, pulled rows or pull clock from disk', () => {
    const src = fs.readFileSync(path.join(ROOT, 'pool/src/pull_book.js'), 'utf8');
    assert.doesNotMatch(src, /raw\?\.credits|raw\?\.pulled|raw\?\.lastPullMs|state\.credits|state\.pulled|takeConfirmed|reconcile|finderOf/);
    const poolSrc = fs.readFileSync(path.join(ROOT, 'pool/src/pool.js'), 'utf8');
    assert.doesNotMatch(poolSrc, /pullBook\.reconcile|pullBook\.finderOf|pullBook\.sealsLifetime|foundBlocks/);
  });
});
