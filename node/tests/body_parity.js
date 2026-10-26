/**
 * Body parity: per block, whether the merkle root rebuilt from the stored
 * bodies is the root the header seals, plus the tip, the supply, the vault
 * root and the spent tags. A writing process and a restarted one print the
 * same line for the same book (body_parity_open.js is the restarted one).
 */
import { createHash } from 'node:crypto';
import { digestTx } from '../src/chain.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { decodeHeader } from '../../crypto/header.js';
import { supplyIdentity } from '../../crypto/reserve_vault.js';
import { auditCirculatingSupply } from '../src/supply.js';

/** One line a parent and a child both print for the same store. */
export function bodyParityLine(store) {
  const blocks = store.blocks || [];
  const mismatched = [];
  for (const b of blocks) {
    const sealed = Buffer.from(decodeHeader(Buffer.from(b.header)).merkleRoot).toString('hex');
    const rebuilt = merkleRoot((b.txs || []).map(digestTx)).toString('hex');
    if (sealed !== rebuilt) {
      mismatched.push({
        height: Number(b.height),
        kinds: (b.txs || []).map((tx) => (tx?.coinbase ? 'coinbase' : String(tx?.kind || ''))),
      });
    }
  }
  const tip = store.tip();
  const tags = [...(store.fluxset()?.spendTags || [])].map(String).sort();
  const identity = supplyIdentity(store.reserveVault);
  const audit = auditCirculatingSupply(blocks);
  return {
    height: tip ? Number(tip.height) : 0,
    hash: tip ? Buffer.from(tip.hash).toString('hex') : '',
    mismatched,
    circulating: audit.circulatingNanos,
    supplyStatus: audit.status,
    principal: identity.principalNanos,
    vaultRoot: String(store.reserveVault?.vaultLockRoot || ''),
    spendTags: createHash('sha256').update(tags.join(',')).digest('hex'),
  };
}
