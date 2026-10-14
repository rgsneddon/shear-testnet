import { freshStealthDest, ed25519SeedOf } from '../crypto/address.js';
import { attachStubAdmitV2 } from '../node/tests/stub_admit_v2.js';

/** One-time mailbox + stealth spend key. destCommit(spendPub) is not money. */
export function spendBox(id) {
  const pay = freshStealthDest(id);
  return {
    dest: pay.dest,
    key: { type: 'ed25519-stealth', seed: ed25519SeedOf(id.privateKey), shared: pay.shared },
    spendSeed: id.spendSeed || ed25519SeedOf(id.privateKey),
  };
}

/** Byte-2 stub. The v2 prover is gone, and consensus rejects the byte. */
export function admitSend(tx) {
  return attachStubAdmitV2(tx);
}
