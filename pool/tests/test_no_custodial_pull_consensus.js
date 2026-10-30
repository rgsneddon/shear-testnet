/**
 * The node side of "no custodial pull on any book": crypto/levy.js carries
 * no magic switch and no pool-withdraw builder, and custodialPullRejected
 * refuses the kind outright. custodialPullRejected sits in node validation
 * (crypto/mempool.js, node/src/chain.js, node/src/store.js import it), so
 * the change waits for Russell's sign-off; this file is red until it lands.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as levy from '../../crypto/levy.js';
import { RESERVE_BOOKS, MAGIC_TESTNET, MAGIC_MAINNET } from '../../crypto/reserve_books.js';
import { MAGIC_REGTEST } from '../../crypto/regtest_bits.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAGICS = [...new Set([...RESERVE_BOOKS.map((b) => b.magic), MAGIC_TESTNET, MAGIC_MAINNET, MAGIC_REGTEST])];

describe('no custodial pull on any book: the node side', () => {
  it('crypto/levy.js has no custodialPullAllowed and no poolWithdrawTx', () => {
    assert.equal(levy.custodialPullAllowed, undefined);
    assert.equal(levy.poolWithdrawTx, undefined);
    const src = fs.readFileSync(path.join(ROOT, 'crypto/levy.js'), 'utf8');
    assert.doesNotMatch(src, /custodialPullAllowed|poolWithdrawTx/);
  });

  it('custodialPullRejected refuses a pool-withdraw on every book, top kind or vout kind', () => {
    assert.ok(MAGICS.length >= 3);
    for (const magic of MAGICS) {
      const top = { id: `top-${magic}`, kind: 'pool-withdraw', magic, vout: [{ kind: 'pool-withdraw', nanos: 1 }] };
      assert.deepEqual(levy.custodialPullRejected(top), { ok: false, reason: 'custodial_pull' }, magic);
      const vout = { id: `vout-${magic}`, kind: 'send', magic, vout: [{ kind: 'pool-withdraw', nanos: 1 }] };
      assert.deepEqual(levy.custodialPullRejected(vout), { ok: false, reason: 'custodial_pull' }, magic);
    }
    assert.equal(levy.custodialPullRejected({ kind: 'send', vout: [{ kind: 'send', nanos: 1 }] }), null);
    assert.equal(levy.custodialPullRejected({ coinbase: true, kind: 'pool-withdraw' }), null, 'a coinbase is not a pull');
  });
});
