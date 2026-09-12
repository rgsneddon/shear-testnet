import { freshStealthDest, ed25519SeedOf } from '../crypto/address.js';
import { fluxsetFromBlocks, proveFlowSpend } from '../crypto/admit.js';

/** One-time mailbox + stealth spend key. destCommit(spendPub) is not money. */
export function spendBox(id) {
  const pay = freshStealthDest(id.paymentCode);
  return {
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
    spendSeed: id.spendSeed || ed25519SeedOf(id.privateKey),
  };
}

export function admitSend(tx, { id, spent, blocks }) {
  const spendSeed = id.spendSeed || ed25519SeedOf(id.privateKey);
  const pubs = fluxsetFromBlocks(blocks || []).pubs;
  return proveFlowSpend(tx, { spendSeed, spentNote: spent, pubs });
}
