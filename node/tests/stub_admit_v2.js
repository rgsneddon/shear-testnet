/**
 * A flow blob whose first byte is 2. It is not a proof.
 * Rejection tests post this when they only assert admit_version.
 */
export function stubAdmitV2({ cTilde = null, tagFill = 2 } = {}) {
  const tag = Buffer.alloc(32, tagFill & 0xff);
  const blob = Buffer.alloc(33, 0);
  blob[0] = 2;
  tag.copy(blob, 1);
  let ct = Buffer.alloc(32, (tagFill + 3) & 0xff);
  if (cTilde != null) {
    try {
      const got = Buffer.from(cTilde);
      if (got.length) ct = got;
    } catch { /* keep the fill */ }
  }
  return {
    admit_proof: true,
    v: 2,
    blob,
    spendTag: Buffer.from(tag),
    cTilde: ct,
  };
}

/** Puts a byte-2 stub on the tx. The vin commit is the proof cTilde. */
export function attachStubAdmitV2(tx, { cTilde = null, tagFill = 2 } = {}) {
  const ct = cTilde != null ? cTilde : tx?.vin?.[0]?.commit;
  const proof = stubAdmitV2({ cTilde: ct, tagFill });
  tx.admit_proof = proof;
  tx.spendTag = proof.spendTag;
  return tx;
}
