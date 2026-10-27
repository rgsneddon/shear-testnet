// R28 test support: mine real BluNotes shares and find a wallet's paid
// notes, the way a rig and a wallet do. Shares are ground with real
// ShearHash-v3; nothing here skips a check. Use it where a test used to
// fund a wallet by solo mining, which R28 retired: a wallet is paid
// through its own shares in the next block's draw.
import { randomBytes } from 'node:crypto';
import { setNonce } from '../../../crypto/header.js';
import { shearHash, meetsTarget, leadingZeroBits } from '../../../crypto/shear_hash.js';
import { SHARE_FLOOR_BITS } from '../../../crypto/asert.js';
import { pointBytes } from '../../../crypto/note.js';
import { admitBasePub, admitBaseScalar } from '../../../crypto/admit.js';
import {
  bindNonce,
  blunoteRho,
  decodeRecord,
  notesFromRecord,
  oneTimeKey,
  oneTimeSpendScalar,
  recogniseOneTime,
  scanPub,
  scanScalar,
} from '../../../crypto/blunote.js';

/** A miner wallet: its spend seed, base key, scan key and mining address. */
export function bluWallet(seed = randomBytes(32)) {
  return {
    seed,
    xBase: admitBaseScalar(seed),
    B: pointBytes(admitBasePub(seed)),
    y: scanScalar(seed),
    Y: scanPub(seed),
  };
}

/**
 * One real share for `owner` on `header`: a fresh key, then the 256 nonces
 * its binding allows, then a new key. kin marks a sibling-template share.
 */
export function mineBluShare(owner, header, { slot = 0, kin = false, bits = SHARE_FLOOR_BITS } = {}) {
  for (let keys = 0; keys < 4096; keys += 1) {
    const k = oneTimeKey({ B: owner.B, Y: owner.Y });
    for (let c = 0; c < 256; c += 1) {
      const nonce = bindNonce(header, k.R, k.P, c, bits);
      const rx = shearHash(setNonce(Buffer.from(header), nonce));
      if (!meetsTarget(rx, bits)) continue;
      return {
        shareR: k.R,
        shareP: k.P,
        viewTag: k.tag,
        nonce,
        lz: leadingZeroBits(rx),
        shareBits: bits,
        proofSlot: slot,
        verifiedHeader: Buffer.from(header),
        ...(kin ? { kinHeader: true } : {}),
      };
    }
  }
  throw new Error('no share found');
}

/** `n` real shares for `owner` on `header`. */
export function mineBluShares(owner, header, n, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(mineBluShare(owner, header, opts));
  return out;
}

/**
 * The notes `owner` was paid by a block, from its record alone, with what a
 * wallet needs to spend each: the spend scalar x (x·G = admitPub), the
 * public blinding rho, and the value.
 */
export function ownBluNotes(owner, blunoteRecord) {
  const bytes = Buffer.isBuffer(blunoteRecord) ? blunoteRecord : Buffer.from(String(blunoteRecord), 'hex');
  if (!decodeRecord(bytes)) throw new Error('blunote_record');
  const out = [];
  for (const note of notesFromRecord(bytes)) {
    const delta = recogniseOneTime({ y: owner.y, B: owner.B }, note.R, note.admitPub);
    if (delta == null) continue;
    out.push({
      kind: note.kind,
      admitPub: note.admitPub,
      commit: note.commit,
      v: note.v,
      rho: blunoteRho(note.admitPub),
      x: oneTimeSpendScalar(owner.xBase, delta),
      leaf: note.leaf,
    });
  }
  return out;
}
