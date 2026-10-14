/**
 * T21 hidden coinbase. Fast cases first. One full cb-v3 build at the end.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { potPaysFromLeaves } from '../node/src/chain.js';
import { H, pointBytes } from './note.js';
import { feeOf, lawDust, splitLaw } from './t21_law.js';
import {
  GEN_H, K_MIN, T21_FINGERPRINT_TOKENS, T21_REQUIRE_ALL_COINBASES, VOUCHER_GAP,
} from './t21_params.js';
import { voucherAt, vouchersFromShewall, walletSecretBytes } from './t21_voucher.js';
import { packShewall, sealShewallBin } from './shewall_bin.js';
import {
  batchWeightOf, buildT21Coinbase, observerView, openOutput, pickChallenge,
  rowIsLeaf, settleBatch, shareBindTag, statementOf, supplyIdentities,
  vaultCommit, verifyT21Coinbase, genesisGateStatus,
} from './t21.js';
import { hashToScalar } from './note.js';

const secret = Buffer.alloc(32, 4);
const dummySecret = Buffer.alloc(32, 9);
const prevHash = Buffer.alloc(32, 1);
const header = Buffer.alloc(80, 2);
const jobKey = Buffer.alloc(32, 3);

function payee(ctr, weights, extra = {}) {
  return {
    secret,
    ctr,
    kind: 'pot',
    fin: 0,
    shares: weights.map((w) => ({ w, header, jobKey })),
    ...extra,
  };
}

describe('T21 S0 splitLaw and tokens', () => {
  it('matches an independent division over the spread, including a 1.8e14 carry', () => {
    const raw = JSON.parse(readFileSync(new URL('./vectors/t21_splitlaw.json', import.meta.url), 'utf8'));
    for (const row of raw.cases) {
      const got = splitLaw({
        R: BigInt(row.R), W: BigInt(row.W), Wi: BigInt(row.Wi), u: BigInt(row.u), fin: BigInt(row.fin),
      });
      const num = (BigInt(row.R) + BigInt(row.W) * BigInt(row.u)) * BigInt(row.Wi) + BigInt(row.W) * BigInt(row.fin);
      assert.equal(got.v, num / BigInt(row.W));
      assert.equal(got.rho, num % BigInt(row.W));
      assert.equal(got.v.toString(), row.v);
      assert.equal(got.rho.toString(), row.rho);
    }
    const dust = lawDust([2n, 2n], 4n);
    assert.equal(dust, 1n);
    assert.equal(feeOf(10_000n, 200n), 200n);
    assert.equal(feeOf(10_000n, 201n), null);
    assert.equal(pointBytes(H).toString('hex'), GEN_H);
    assert.equal(T21_FINGERPRINT_TOKENS[T21_FINGERPRINT_TOKENS.length - 1], `GEN_H=${GEN_H}`);
    assert.equal(T21_REQUIRE_ALL_COINBASES, false);
    assert.equal(K_MIN, 4);
    for (const token of T21_FINGERPRINT_TOKENS) {
      assert.equal(typeof token, 'string');
      assert.match(readFileSync(new URL('./t21_params.js', import.meta.url), 'utf8'), new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});

describe('T21 S1 share bind and S2 vouchers', () => {
  it('derives vouchers from the wallet secret and stops after the gap', () => {
    assert.throws(() => walletSecretBytes('abandon abandon abandon'), /seed_phrase/);
    const a = voucherAt(secret, 0);
    const b = voucherAt(secret, 0);
    assert.equal(a.lambdaBytes.toString('hex'), b.lambdaBytes.toString('hex'));
    assert.notEqual(voucherAt(secret, 1).lambdaBytes.toString('hex'), a.lambdaBytes.toString('hex'));
    const labels = new Set([0, 10, 256, 257].map((c) => voucherAt(secret, c).lambdaBytes.toString('hex')));
    const found = [];
    let misses = 0;
    for (let c = 0; misses < VOUCHER_GAP; c += 1) {
      const v = voucherAt(secret, c);
      if (labels.has(v.lambdaBytes.toString('hex')) && (c === 0 || c === 10 || c === 256)) {
        found.push(c);
        misses = 0;
      } else misses += 1;
    }
    assert.deepEqual(found, [0, 10, 256]);
    assert.equal(found.includes(257), false);
    const E = pointBytes(a.B);
    const tag = shareBindTag(header, jobKey, E);
    assert.equal(tag.length, 32);
    const other = Buffer.from(E);
    other[0] ^= 1;
    assert.notEqual(shareBindTag(header, jobKey, other).toString('hex'), tag.toString('hex'));
  });

  it('restores vouchers from shewall.bin and a password', () => {
    const dest20 = createHash('sha256').update('t21').digest().subarray(0, 20);
    const packed = packShewall({ seed32: secret, dest20 });
    const env = sealShewallBin(packed, 't21-pass');
    const want = voucherAt(secret, 4).lambdaBytes.toString('hex');
    const found = vouchersFromShewall(env, 't21-pass', [want]);
    assert.equal(found.length, 1);
    assert.equal(found[0].ctr, 4);
  });
});

describe('T21 structural rules', () => {
  it('rejects the listed codes before a proof', () => {
    const base = {
      coinbase: true,
      cbForm: 'cb-v3',
      carryNanos: 5,
      vout: [],
      excess: Buffer.alloc(32),
      t21: {
        S: '3', cin: '2', bps: 0, u: '0', height: 1, magic: 'm',
        prevHash, shares: [],
      },
    };
    base.t21.stmt = statementOf(base);
    base.t21.bw = batchWeightOf(base.t21.stmt);
    assert.equal(verifyT21Coinbase({ tx: base }).ok, true);

    const short = structuredClone(base);
    short.vout = [{ amtCt: Buffer.alloc(3), kind: 'pot' }];
    short.t21 = { ...base.t21 };
    assert.equal(verifyT21Coinbase({ tx: short }).reason, 'amount_ct');

    const plain = structuredClone(base);
    plain.vout = [{ kind: 'pot', kindCode: 0x20, nanos: 1, commit: Buffer.alloc(32, 1) }];
    plain.t21 = { ...base.t21, shares: [{ w: '1' }] };
    assert.equal(verifyT21Coinbase({ tx: plain }).reason, 'amount_field');

    const open = structuredClone(base);
    open.vout = [{ kind: 'pot', kindCode: 0x20, valueProof: { v: 1 }, commit: Buffer.alloc(32, 1) }];
    open.t21 = { ...base.t21, shares: [{ w: '1' }] };
    assert.equal(verifyT21Coinbase({ tx: open }).reason, 'value_open');

    const carried = structuredClone(base);
    carried.carryNanos = 4;
    carried.t21 = { ...base.t21 };
    carried.t21.stmt = statementOf(carried);
    carried.t21.bw = batchWeightOf(carried.t21.stmt);
    assert.equal(verifyT21Coinbase({ tx: carried }).reason, 'pot_sched');

    const noted = structuredClone(base);
    noted.vout = [{ kind: 'pot', kindCode: 0x20 }];
    noted.t21 = { ...base.t21 };
    assert.equal(verifyT21Coinbase({ tx: noted }).reason, 'pot_carry');

    const fee = structuredClone(base);
    fee.t21 = { ...base.t21, bps: 201 };
    assert.equal(verifyT21Coinbase({ tx: fee }).reason, 'fee_sched');

    const many = structuredClone(base);
    many.t21 = { ...base.t21, shares: Array.from({ length: 65537 }, () => ({ w: '1' })) };
    assert.equal(verifyT21Coinbase({ tx: many }).reason, 'split_cap');

    const rows = structuredClone(base);
    rows.t21 = { ...base.t21, shares: [{ w: '1', E: Buffer.alloc(32, 2), bind: Buffer.alloc(32), header, jobKey, lambda: Buffer.alloc(32, 8) }] };
    rows.vout = Array.from({ length: 471 }, () => ({ kind: 'pot', kindCode: 0x20 }));
    assert.equal(verifyT21Coinbase({ tx: rows }).reason, 'payee_cap');

    const wide = structuredClone(base);
    wide.vout = new Array(65537);
    assert.equal(verifyT21Coinbase({ tx: wide }).reason, 'tx_cap');

    const heavy = structuredClone(base);
    heavy.t21 = { ...base.t21, shares: [{ w: String((1n << 28n) + 1n) }] };
    assert.equal(verifyT21Coinbase({ tx: heavy }).reason, 'split_cap');

    const X0 = hashToScalar(Buffer.from('shear-logup-x-v1'), Buffer.from('stmt'), Buffer.from([0]));
    const picked = pickChallenge(Buffer.from('stmt'), [X0]);
    assert.notEqual(picked.n, 0);

    const vault = vaultCommit(50n, Buffer.from('mint'), 7, Buffer.alloc(32, 6));
    assert.ok(vault.commit.length === 32);
    const again = vaultCommit(50n, Buffer.from('mint'), 7, Buffer.alloc(32, 6));
    assert.equal(vault.commit.toString('hex'), again.commit.toString('hex'));
    const moved = vaultCommit(50n, Buffer.from('mint'), 8, Buffer.alloc(32, 6));
    assert.notEqual(vault.commit.toString('hex'), moved.commit.toString('hex'));

    const badLeaf = { admitPub: Buffer.alloc(32), commit: Buffer.alloc(32), lambda: Buffer.alloc(32, 1) };
    assert.equal(rowIsLeaf(badLeaf), false);
    const settled = settleBatch([badLeaf], [{ lambda: badLeaf.lambda, w: '1' }]);
    assert.equal(settled.evicted, true);
    assert.equal(settled.deferred.length, 1);
    assert.equal(settled.shares.length, 0);
  });
});

describe('T21 S5 no last-payee re-split', () => {
  it('keeps the remainder off the last payee', () => {
    const leaves = [
      { noteCommit: Buffer.alloc(32, 1), count: 1 },
      { noteCommit: Buffer.alloc(32, 2), count: 1 },
    ];
    const old = potPaysFromLeaves(leaves, null, 0, 11, 0);
    assert.equal(old.length, 2);
    const nanos = old.map((r) => r.nanos).sort((a, b) => a - b);
    assert.deepEqual(nanos, [5, 6]);
    const a = splitLaw({ R: 10n, W: 2n, Wi: 1n });
    const b = splitLaw({ R: 10n, W: 2n, Wi: 1n });
    assert.equal(a.v, 5n);
    assert.equal(b.v, 5n);
    assert.equal(a.rho + b.rho, 0n);
    assert.equal(lawDust([a.rho, b.rho], 2n), 0n);
    const odd = [splitLaw({ R: 11n, W: 2n, Wi: 1n }), splitLaw({ R: 11n, W: 2n, Wi: 1n })];
    assert.equal(odd[0].v + odd[1].v, 10n);
    assert.equal(lawDust(odd.map((r) => r.rho), 2n), 1n);
  });
});

describe('T21 cb-v3 coinbase', { timeout: 180_000 }, () => {
  it('proves a 4-note coinbase, rejects a mutated statement, and opens amtCt or VE', () => {
    const built = buildT21Coinbase({
      S: 100_000n,
      cin: 0n,
      bps: 0,
      u: 0n,
      height: 3,
      magic: 'shear-testnet-v12',
      prevHash,
      dummySecret,
      payees: [payee(1, [1n, 1n])],
    });
    assert.equal(built.tx.vout.filter((o) => o.kind !== 'vault-withdraw-pinned').length, K_MIN);
    assert.equal(built.dust, 0n);
    const gate = verifyT21Coinbase({ tx: built.tx, blockHash: Buffer.alloc(32) });
    assert.equal(gate.ok, true, gate.reason);
    const supply = supplyIdentities(built);
    assert.equal(supply.ok, true);
    const view = observerView(built.tx);
    assert.equal(view.leaks.length, 0);
    assert.equal(view.rows >= K_MIN, true);
    const pay = built.tx.vout.find((o) => o.kind === 'pot');
    const opened = openOutput(pay, secret, {
      magic: 'shear-testnet-v12', height: 3, prevHash, index: built.tx.vout.indexOf(pay),
    });
    assert.equal(opened.via, 'amtCt');
    assert.equal(opened.v, built.secrets.find((s) => s.kind === 'pot').v);
    const lied = { ...pay, amtCt: Buffer.from(pay.amtCt) };
    lied.amtCt = Buffer.from(lied.amtCt);
    lied.amtCt[0] ^= 0xff;
    const viaVe = openOutput(lied, secret, {
      magic: 'shear-testnet-v12', height: 3, prevHash, index: built.tx.vout.indexOf(pay),
    });
    assert.equal(viaVe.via, 've');
    assert.equal(viaVe.v, opened.v);
    const mutated = {
      ...built.tx,
      vout: built.tx.vout.map((o, i) => (i === 0 ? { ...o, amtCt: lied.amtCt } : o)),
      t21: built.tx.t21,
    };
    const bad = verifyT21Coinbase({ tx: mutated });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'split_law');
    const foreign = {
      ...built.tx,
      t21: {
        ...built.tx.t21,
        shares: built.tx.t21.shares.map((s, i) => (i === 0 ? { ...s, w: '9' } : s)),
      },
    };
    foreign.t21.stmt = statementOf(foreign);
    foreign.t21.bw = batchWeightOf(foreign.t21.stmt);
    assert.equal(verifyT21Coinbase({ tx: foreign }).reason, 'split_tally');
  });

  it('defers a non-leaf voucher instead of re-splitting', () => {
    const built = buildT21Coinbase({
      S: 50_000n,
      cin: 0n,
      bps: 0,
      u: 0n,
      height: 4,
      magic: 'shear-testnet-v12',
      prevHash,
      dummySecret,
      payees: [payee(2, [2n], { breakLeaf: true }), payee(3, [2n])],
    });
    assert.equal(built.deferred.length, 1);
    assert.equal(built.tx.t21.shares.length, 1);
    assert.equal(verifyT21Coinbase({ tx: built.tx }).ok, true);
  });
});

describe('T21 genesis gate', () => {
  it('lists the open items and does not cut genesis', async () => {
    const { V12_GENESIS_BLOCK_HASH } = await import('../node/src/chain.js');
    assert.equal(V12_GENESIS_BLOCK_HASH, '');
    const status = genesisGateStatus();
    assert.equal(status.requireAllCoinbases, false);
    assert.deepEqual(status.open, [2, 4, 5, 6, 7, 10]);
    assert.equal(fs.existsSync(new URL('../specs/t21-coinbase.md', import.meta.url)), true);
  });
});
