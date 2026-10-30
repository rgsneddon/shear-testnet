/**
 * Ruling 6 (Russell, 28 Oct): a wallet on its own node reads its Reserve pane
 * from GET /reserve?address=, as an own node has no pool /api/vault/reserve.
 * With an address the answer adds the public vault view the pool route
 * spreads; without one it is unchanged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from '../src/rpc.js';
import { encodeDest } from '../../crypto/address.js';
import { emptyVault, publicVaultView } from '../../crypto/reserve_vault.js';
import { loadOracleSnapshot } from '../src/oracle_feed.js';

describe('own-node Reserve read (ruling 6)', () => {
  it('reserve?address= carries the portal and the public vault view', async () => {
    const vault = emptyVault();
    const dest = encodeDest(Buffer.alloc(20, 4));
    const rpc = createRpc({
      store: { reserveVault: vault, oracleSnapshot: loadOracleSnapshot(), tip: () => null, mempool: [] },
      port: 0,
      host: '127.0.0.1',
    });
    try {
      const info = await rpc.listen();
      const res = await fetch(`http://127.0.0.1:${info.port}/reserve?address=${encodeURIComponent(dest)}`);
      assert.equal(res.status, 200);
      const one = await res.json();
      assert.equal(one.ok, true, one.reason);
      assert.equal(one.portal.staked, 0);
      const want = publicVaultView(vault, Date.now());
      assert.deepEqual(Object.keys(one.vault).sort(), Object.keys(want).sort());
      for (const k of ['totalLockedNanos', 'mintBankNanos', 'feeBankNanos', 'epochBps', 'epochStartMs']) {
        assert.equal(one.vault[k], want[k], k);
      }
      const bare = rpc.dispatch('getreserve');
      assert.equal(bare.vault, undefined, 'no address: the answer is unchanged');
      assert.equal(bare.address, undefined);
    } finally {
      await rpc.close();
    }
  });
});
