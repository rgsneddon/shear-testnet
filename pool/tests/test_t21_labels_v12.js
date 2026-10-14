/**
 * T21 share labels on the stratum side (genesis gate item 12): one pool-issued
 * label per job header, shareBind 'note' with the label's note commit on the
 * wire, shares bound to that note commit, and share records with no dest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { SHEARK_MINER_VERSION, packBits } from '../../crypto/asert.js';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';
import { destBoundShareHash, noteCommitOfShare, nonceWithShareTarget } from '../../crypto/share_batch.js';
import { meetsTarget } from '../../crypto/shear_hash.js';
import { t21ShareNc } from '../../crypto/t21.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { t21LabelBook, t21LoginVoucher } from '../../node/src/t21_template.js';
import {
  T21_LABELS_PER_CONN, createT21Labels, isLabelShare, labelShareRecord, loginVoucher, t21TemplateSpec, voucherFromHex,
} from '../src/t21_labels.js';
import { spawnSync } from 'node:child_process';
import { admitBaseFromAddress, hash20FromAddress } from '../../crypto/address.js';
import { G, H, scalarBytes } from '../../crypto/note.js';
import { isT21Coinbase } from '../../crypto/t21.js';
import {
  bindAcceptedShare, configuredFeeIdentity, createPool, judgeShare, wireJob,
} from '../src/pool.js';

const magic = MAGIC_TESTNET;
const hex = (b) => Buffer.from(b).toString('hex');

function voucherHex(v) {
  return { B: hex(v.B), Y: hex(v.Y), lambda: hex(v.lambda) };
}

function header(tag, nonce = 0n) {
  const h = Buffer.alloc(128);
  h[0] = 1;
  h[4] = tag;
  h.writeUInt32LE(packBits(250), 108);
  h.writeBigUInt64LE(nonce, 112);
  return h.toString('hex');
}

function labels() {
  return createT21Labels({ magic, book: t21LabelBook({ magic }) });
}

describe('T21 labels: one label per job header', () => {
  const voucher = t21LoginVoucher(Buffer.alloc(32, 0x31));

  it('reads a login voucher and refuses one that fails the voucher check', () => {
    const got = loginVoucher({ voucher: voucherHex(voucher) });
    assert.equal(hex(got.B), hex(voucher.B));
    const bad = { ...voucherHex(voucher), lambda: '11'.repeat(32) };
    assert.equal(loginVoucher({ voucher: bad }), null);
    assert.equal(loginVoucher({ voucher: { B: 'zz' } }), null);
    assert.equal(loginVoucher({}), null);
  });

  it('labels a bound connection\'s job, reuses the label for the same header, and issues a new one per header', () => {
    const t21 = labels();
    const conn = {};
    t21.bind(conn, voucher);
    const a = t21.jobFor(conn, { jobId: 'j1', header: header(1) });
    assert.equal(a.shareBind, 'note');
    assert.match(a.noteCommit, /^[0-9a-f]{64}$/);
    assert.equal(t21.jobFor(conn, { jobId: 'j1b', header: header(1) }).noteCommit, a.noteCommit);
    const b = t21.jobFor(conn, { jobId: 'j2', header: header(2) });
    assert.notEqual(b.noteCommit, a.noteCommit);
    assert.equal(t21.noteFor(conn, header(1)), a.noteCommit);
    assert.equal(t21.noteFor(conn, header(9)), null);
    const lab = t21.labelOf(a.noteCommit);
    assert.equal(hex(lab.voucher.B), hex(voucher.B));
    assert.equal(hex(t21ShareNc(magic, lab.E)), a.noteCommit);
    const other = {};
    t21.bind(other, voucher);
    assert.notEqual(t21.jobFor(other, { jobId: 'j1', header: header(1) }).noteCommit, a.noteCommit);
  });

  it('leaves a connection without a voucher dest-bound, and keeps a bounded label window', () => {
    const t21 = labels();
    const plain = {};
    t21.bind(plain, null);
    const job = { jobId: 'j', header: header(3) };
    assert.equal(t21.jobFor(plain, job), job);
    const conn = {};
    t21.bind(conn, voucher);
    for (let i = 0; i < T21_LABELS_PER_CONN + 5; i += 1) t21.jobFor(conn, { jobId: `j${i}`, header: header(i % 256, BigInt(i)) });
    assert.equal(conn.t21Labels.size, T21_LABELS_PER_CONN);
    assert.equal(t21.noteFor(conn, header(0, 0n)), null);
  });

  it('puts shareBind note and the note commit on the wire, dest otherwise', () => {
    const nc = 'ab'.repeat(32);
    const w = wireJob({ jobId: 'j', header: header(4), shareBind: 'note', noteCommit: nc }, 12);
    assert.equal(w.shareBind, 'note');
    assert.equal(w.noteCommit, nc);
    assert.equal(wireJob({ jobId: 'j', header: header(4) }, 12).shareBind, 'dest');
  });
});

describe('T21 labels: shares bind the label, records drop the dest', () => {
  const dest = freshStealthDest(newIdentity()).dest;
  const nc = 'cd'.repeat(32);
  const bits = 8;
  const hdr = header(5, nonceWithShareTarget(77n, bits));
  const job = { jobId: 'jn', header: hdr, shareBits: bits, blockBits: 250, bits: 250 };

  function hashFor(want) {
    for (;;) {
      const h = randomBytes(32);
      const onNote = meetsTarget(destBoundShareHash(h, Buffer.from(nc, 'hex')), bits);
      const onDest = meetsTarget(destBoundShareHash(h, noteCommitOfShare({ dest })), bits);
      if (onNote === want.note && onDest === want.dest) return h;
    }
  }

  it('credits a share whose PoW meets the width on the label note commit, whatever the dest', () => {
    const h = hashFor({ note: true, dest: false });
    const got = judgeShare({ job, header: Buffer.from(hdr, 'hex'), hash: h, dest, noteCommit: nc });
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.noteCommit, nc);
    assert.equal(got.creditedShareBits, bits);
    assert.equal(judgeShare({ job, header: Buffer.from(hdr, 'hex'), hash: h, dest }).ok, false);
  });

  it('refuses a share bound to the dest when the job carried a label', () => {
    const h = hashFor({ note: false, dest: true });
    assert.equal(judgeShare({ job, header: Buffer.from(hdr, 'hex'), hash: h, dest }).ok, true);
    const got = judgeShare({ job, header: Buffer.from(hdr, 'hex'), hash: h, dest, noteCommit: nc });
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'low_diff');
  });

  it('records a label share with its note commit and no dest field, and opens it without a payee', () => {
    const rec = labelShareRecord({
      noteCommit: nc, nonce: nonceWithShareTarget(91n, bits), hash: 'ee'.repeat(32), jobId: 'jn', lz: 9, shareBits: bits, verifiedHeader: hdr,
    });
    for (const k of ['dest', 'dest20', 'address', 'miner']) assert.equal(k in rec, false, k);
    assert.equal(isLabelShare(rec), true);
    assert.equal(hex(noteCommitOfShare(rec)), nc);
    const opened = bindAcceptedShare([], rec);
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(opened.list.length, 1);
    assert.equal(isLabelShare({ ...rec, dest }), false);
    const blank = { nonce: nonceWithShareTarget(92n, bits), hash: 'ef'.repeat(32), shareBits: bits, verifiedHeader: hdr };
    assert.equal(bindAcceptedShare([], blank).ok, false);
  });
});

function login(port, params) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('login_timeout'));
    }, 15000);
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      const msg = JSON.parse(buf.slice(0, nl));
      sock.destroy();
      resolve({ job: msg.job || null, error: msg.error || '' });
    });
    sock.write(`${JSON.stringify({ id: 1, method: 'login', params: { client: 'ShearHash', version: SHEARK_MINER_VERSION, threads: 1, ...params } })}\n`);
  });
}

describe('T21 labels: stratum login', () => {
  it('a voucher login gets a labelled job, a bad voucher is refused, a plain login stays dest-bound', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-t21-labels-'));
    const fee = configuredFeeIdentity();
    assert.equal(fee.ok, true);
    const t21 = labels();
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, miner: fee.feeDest, t21Labels: t21 });
    try {
      await new Promise((resolve) => pool.stratum.listen(0, '127.0.0.1', resolve));
      const port = pool.stratum.address().port;
      const voucher = t21LoginVoucher(Buffer.alloc(32, 0x41));
      const a = freshStealthDest(newIdentity()).dest;
      const got = await login(port, { login: `${a}.t21`, voucher: voucherHex(voucher) });
      assert.equal(got.error, '');
      assert.equal(got.job.shareBind, 'note');
      assert.match(got.job.noteCommit, /^[0-9a-f]{64}$/);
      assert.equal(hex(t21.labelOf(got.job.noteCommit).voucher.B), hex(voucher.B));
      const bad = await login(port, { login: `${freshStealthDest(newIdentity()).dest}.bad`, voucher: { ...voucherHex(voucher), lambda: '22'.repeat(32) } });
      assert.equal(bad.error, 'voucher_key');
      const plain = await login(port, { login: `${freshStealthDest(newIdentity()).dest}.plain` });
      assert.equal(plain.error, '');
      assert.equal(plain.job.shareBind, 'dest');
      assert.equal('noteCommit' in plain.job, false);
    } finally {
      pool.close();
    }
  });
});

const leScalar = (b) => BigInt(`0x${Buffer.from(b).reverse().toString('hex')}`);
const vhex = (v) => hex(v.B) + hex(v.Y) + hex(v.lambda);
const MINER_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '../../sheark-miner/ShearK-Miner');

describe('T21 labels: the miner can open its label', () => {
  it('a labelled job carries E and β with E = λG + βH and noteCommit = share bind of E', () => {
    const t21 = labels();
    const v = t21LoginVoucher(Buffer.alloc(32, 0x51));
    const conn = {};
    t21.bind(conn, v);
    const job = t21.jobFor(conn, { jobId: 'j', header: header(7) });
    const E = Buffer.from(job.labelE, 'hex');
    const want = G.multiply(leScalar(v.lambda)).add(H.multiply(leScalar(Buffer.from(job.labelBeta, 'hex'))));
    assert.equal(hex(want.toBytes()), job.labelE);
    assert.equal(hex(t21ShareNc(magic, E)), job.noteCommit);
  });

  it('ShearK accepts its own label and refuses another voucher\'s', { skip: fs.existsSync(MINER_BIN) ? false : 'ShearK not built' }, () => {
    const t21 = labels();
    const v = t21LoginVoucher(Buffer.alloc(32, 0x52));
    const other = t21LoginVoucher(Buffer.alloc(32, 0x53));
    const conn = {};
    t21.bind(conn, v);
    const job = t21.jobFor(conn, { jobId: 'j', header: header(8) });
    const check = (lam) => spawnSync(MINER_BIN, ['--t21-label-check', hex(lam), job.labelBeta, job.labelE, job.noteCommit, magic]).status;
    assert.equal(check(v.lambda), 0);
    assert.equal(check(other.lambda), 1);
  });
});

describe('T21 labels: template spec', () => {
  const finder = t21LoginVoucher(Buffer.alloc(32, 0x61));
  const fee = t21LoginVoucher(Buffer.alloc(32, 0x62));

  it('parses ShearK-style voucher hex and refuses a bad one', () => {
    assert.equal(hex(voucherFromHex(vhex(finder)).B), hex(finder.B));
    assert.equal(voucherFromHex(vhex(finder).slice(2)), null);
    assert.equal(voucherFromHex(vhex(finder).slice(0, 128) + '22'.repeat(32)), null);
  });

  it('hands the template the label book, finder and fee vouchers, and names the finder-of-record miner', () => {
    const t21 = labels();
    const spec = t21TemplateSpec({ labels: t21, magic, finder, fee, bps: 50 });
    assert.equal(spec.t21.labelOf, t21.labelOf);
    assert.equal(spec.t21.finder, finder);
    assert.equal(spec.t21.fee.voucher, fee);
    assert.equal(spec.t21.bps, 50);
    const payout = freshStealthDest(newIdentity()).dest;
    const miner = spec.minerFor(payout);
    assert.equal(hex(hash20FromAddress(miner)), hex(hash20FromAddress(payout)));
    assert.equal(hex(admitBaseFromAddress(miner)), hex(finder.B));
    assert.equal(t21TemplateSpec({ labels: t21, magic, finder, bps: 50 }), null);
    assert.equal(t21TemplateSpec({ labels: t21, magic, finder, fee, bps: 10_000 }), null);
    assert.equal(t21TemplateSpec({ labels: t21, magic, finder: { ...finder, lambda: Buffer.alloc(32, 2) } }), null);
    assert.equal(t21TemplateSpec({ labels: t21, magic, finder }).t21.fee, null);
  });

  it('the pool issues a cb-v3 job past genesis, with labelled jobs on it, and the store seals it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-t21-tpl-'));
    const feeId = configuredFeeIdentity();
    const t21 = labels();
    const pool = createPool({
      dataDir: dir, stratumPort: 0, httpPort: 0, miner: feeId.feeDest, t21Labels: t21, t21Template: { finder },
    });
    try {
      await new Promise((resolve) => pool.stratum.listen(0, '127.0.0.1', resolve));
      const port = pool.stratum.address().port;
      const first = await login(port, { login: `${freshStealthDest(newIdentity()).dest}.g` });
      const g = pool.store.jobs.get(String(first.job.jobId));
      assert.equal(isT21Coinbase(g.tpl.txs[0]), false);
      const sealedG = await pool.store.submitHeader({ jobId: first.job.jobId, nonce: 0n, miner: '', powHash: '00000001'.padEnd(64, '0') }, { trusted: true });
      assert.equal(sealedG.ok, true, sealedG.reason);
      pool.issueJob(undefined, { force: true });
      const v = t21LoginVoucher(Buffer.alloc(32, 0x63));
      const got = await login(port, { login: `${freshStealthDest(newIdentity()).dest}.v3`, voucher: voucherHex(v) });
      assert.equal(got.job.shareBind, 'note');
      const rec = pool.store.jobs.get(String(got.job.jobId));
      assert.equal(isT21Coinbase(rec.tpl.txs[0]), true);
      assert.equal(hex(admitBaseFromAddress(rec.tpl.miner)), hex(finder.B));
      assert.equal(hex(t21.labelOf(got.job.noteCommit).voucher.B), hex(v.B));
      const sealed = await pool.store.submitHeader({ jobId: got.job.jobId, nonce: 0n, miner: '', powHash: '00000002'.padEnd(64, '0') }, { trusted: true });
      assert.equal(sealed.ok, true, sealed.reason);
      assert.equal(isT21Coinbase(pool.store.tip().txs[0]), true);
    } finally {
      pool.close();
    }
  });
});
