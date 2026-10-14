/**
 * T21 share labels on the stratum side.
 *
 * A miner that logs in with a voucher { B, Y, lambda } is given a pool-issued
 * label for every job header it is sent: E = λG + βH from the pool's label
 * book (node/src/t21_template.js), and the job carries shareBind 'note' with
 * noteCommit = t21ShareNc(magic, E). The miner binds the share PoW to that
 * note commit instead of a dest, so a share names a label and nothing else.
 * The accepted share record keeps the note commit and no dest field; the
 * cb-v3 template resolves the label through the same book.
 *
 * One label per header: re-sending the same header to a connection reuses its
 * label, a restamp or a new template gets a fresh one. A connection keeps its
 * last T21_LABELS_PER_CONN headers, so a share on a recently replaced header
 * still finds its label.
 */
import { t21LabelBook } from '../../node/src/t21_template.js';
import { voucherKeysOk } from '../../crypto/t21_voucher.js';
import { encodeDest, hash20FromAddress, isDestAddress } from '../../crypto/address.js';
import { scalarBytes } from '../../crypto/note.js';
import { FEE_BPS_MAX } from '../../crypto/t21_params.js';

export const T21_LABELS_PER_CONN = 64;

const HEX32 = /^[0-9a-f]{64}$/;

function hex32(v) {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return HEX32.test(s) ? Buffer.from(s, 'hex') : null;
}

function headerKey(header) {
  if (Buffer.isBuffer(header) || header instanceof Uint8Array) return Buffer.from(header).toString('hex');
  return String(header || '').toLowerCase();
}

/** The voucher a stratum login carries as `voucher: { B, Y, lambda }` (hex), or null when absent or not acceptable. */
export function loginVoucher(params) {
  const v = params?.voucher;
  if (!v || typeof v !== 'object') return null;
  const out = { B: hex32(v.B), Y: hex32(v.Y), lambda: hex32(v.lambda) };
  if (!out.B || !out.Y || !out.lambda) return null;
  try {
    return voucherKeysOk(out) ? out : null;
  } catch {
    return null;
  }
}

/** A voucher as 192 hex characters B ‖ Y ‖ λ (ShearK --voucher), or null when not acceptable. */
export function voucherFromHex(hex) {
  const s = String(hex || '').toLowerCase();
  if (!/^[0-9a-f]{192}$/.test(s)) return null;
  return loginVoucher({ voucher: { B: s.slice(0, 64), Y: s.slice(64, 128), lambda: s.slice(128) } });
}

/**
 * What the pool hands the cb-v3 template: its label book, the finder voucher
 * (the pool is the block's finder of record) and, when it charges a fee, the
 * fee voucher and rate. `minerFor(payout)` is the block miner: the payout's
 * spend hash with the finder voucher's B as admit base, so consensus binds
 * the finder half to that voucher. Null when the vouchers are not usable.
 */
export function t21TemplateSpec({ labels, magic, finder, fee = null, bps = 0 } = {}) {
  const rate = Math.floor(Number(bps) || 0);
  if (!labels || typeof labels.labelOf !== 'function' || !finder) return null;
  if (rate < 0 || rate > FEE_BPS_MAX || (rate > 0 && !fee)) return null;
  try {
    if (!voucherKeysOk(finder) || (fee && !voucherKeysOk(fee))) return null;
  } catch {
    return null;
  }
  return {
    t21: { magic, labelOf: labels.labelOf, finder, fee: fee && rate > 0 ? { voucher: fee } : null, bps: rate },
    minerFor(payout) {
      if (!isDestAddress(payout)) return null;
      const h20 = hash20FromAddress(payout);
      return h20 ? encodeDest(h20, finder.B) : null;
    },
  };
}

/**
 * The accepted-share record for a label-bound share: the note commit, the
 * nonce and the header it was proven on. No dest, dest20, address or miner.
 */
export function labelShareRecord({ noteCommit, nonce, hash, jobId, lz, shareBits, verifiedHeader }) {
  return {
    noteCommit: Buffer.from(String(noteCommit), 'hex'),
    nonce: BigInt(nonce),
    hash: String(hash || ''),
    jobId: String(jobId || ''),
    lz: Number(lz) & 0xff,
    shareBits: Number(shareBits),
    verifiedHeader: String(verifiedHeader || '').toLowerCase(),
  };
}

/** True for a record made by labelShareRecord: a 32-byte note commit and no dest. */
export function isLabelShare(rec) {
  const nc = rec?.noteCommit;
  const ok = Buffer.isBuffer(nc) ? nc.length === 32 : HEX32.test(String(nc || '').toLowerCase());
  return ok && !rec?.dest && !rec?.dest20 && !rec?.address && !rec?.miner;
}

/**
 * The pool's label issuer. `book` defaults to a t21LabelBook for `magic`
 * (written through to `file` when given, so carried shares survive a restart).
 */
export function createT21Labels({ magic, file = null, keep = 4096, book = null } = {}) {
  const labels = book || t21LabelBook({ magic, keep, file });
  return {
    book: labels,
    labelOf: (ncHex) => labels.labelOf(ncHex),
    /** Mark a connection as label-bound for this voucher. Null leaves it dest-bound. */
    bind(conn, voucher) {
      if (!conn) return;
      conn.t21Voucher = voucher || null;
      conn.t21Labels = new Map();
    },
    /** The job as this connection gets it: a labelled copy, or `job` when the connection is not label-bound. */
    jobFor(conn, job) {
      if (!conn?.t21Voucher || !job?.header) return job;
      if (!(conn.t21Labels instanceof Map)) conn.t21Labels = new Map();
      const key = headerKey(job.header);
      let nc = conn.t21Labels.get(key);
      if (!nc) {
        const got = labels.issue(conn.t21Voucher);
        if (!got) return job;
        nc = got.noteCommit.toString('hex');
        conn.t21Labels.set(key, nc);
        while (conn.t21Labels.size > T21_LABELS_PER_CONN) conn.t21Labels.delete(conn.t21Labels.keys().next().value);
      }
      // E and β let the miner check E = λG + βH against its own voucher before mining the label.
      const lab = labels.labelOf(nc);
      if (!lab) return job;
      return {
        ...job,
        shareBind: 'note',
        noteCommit: nc,
        labelE: Buffer.from(lab.E).toString('hex'),
        labelBeta: Buffer.from(scalarBytes(lab.beta)).toString('hex'),
      };
    },
    /** The note commit this connection was given for `header`, or null. */
    noteFor(conn, header) {
      if (!(conn?.t21Labels instanceof Map)) return null;
      return conn.t21Labels.get(headerKey(header)) || null;
    },
  };
}
