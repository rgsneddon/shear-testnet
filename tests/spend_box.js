import { freshStealthDest, ed25519SeedOf } from '../crypto/address.js';

/** One-time mailbox + stealth spend key. destCommit(spendPub) is not money. */
export function spendBox(id) {
  const pay = freshStealthDest(id.paymentCode);
  return {
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
  };
}
