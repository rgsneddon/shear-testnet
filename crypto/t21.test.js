/**
 * T21 hidden coinbase. Fast cases first, then two full cb-v3 builds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { G, H, pointBytes, scalarBytes } from './note.js';
import { feeOf, lawDust, splitLaw } from './t21_law.js';
import { priceWeights, weightPay } from './t21_escrow.js';
import {
  CB_SHARE_MAX, GEN_H, K_MIN, T21_FINGERPRINT_TOKENS, T21_OWED_GLOBAL, T21_OWED_MAX, T21_OWED_TTL, T21_REQUIRE_ALL_COINBASES, T21_SETTLE_WINDOW, VOUCHER_GAP,
  W_HASH_MAX,
} from './t21_params.js';
import {
  publicVoucher, voucherAt, voucherKeysOk, voucherLambda, vouchersFromShewall, walletSecretBytes,
} from './t21_voucher.js';
import { packShewall, sealShewallBin } from './shewall_bin.js';
import {
  AGG_KEYS, CHUNK_KEYS, buildT21Coinbase, genesisGateStatus, minerShare, observerView, openOutput, payoutDelta,
  statementOf, supplyIdentities, t21Anchor, t21CbOnly, t21EconomicCarry, t21OwedNext, t21OwedOf, t21ShareNc, vaultCommit, verifyT21Coinbase,
} from './t21.js';
import { MAX_HASH_UNITS_PER_BLOCK, consensusFingerprint } from './asert.js';
import { accountShareUnits, aLeavesFromShares, t21ShareCredit } from './share_batch.js';
import { buildDualTree } from './clearing.js';
import {
  C_MAX, K_VW, MAX_BLOCK_VERIFY_WEIGHT, PAYEE_ROW_BYTES, R_VW_WEIGHT, R_WEIGHT, W_ROW_0X23,
  blockBudget, countPayees, payeeCapLive, publicBytes, txBudget, txVerifyWeight,
} from './block_budget.js';
import { nativeLoaded } from './native_admit.js';
import { encodeDest } from './address.js';
import { reserveFeeDest, splitLevy } from './levy.js';
import {
  coinbaseFormRejected, coinbaseLevyPays, sealLevyNote, t21HashLedgerOk, t21ShareUnits,
} from '../node/src/chain.js';

const magic = 'shear-testnet-v12';
const prevHash = Buffer.alloc(32, 1);
const secrets = [1, 2, 3, 4, 5].map((n) => Buffer.alloc(32, n));
const feeSecret = Buffer.alloc(32, 8);
const dummySecret = Buffer.alloc(32, 9);

function voucher(i, ctr = 0) {
  return voucherAt(secrets[i], ctr);
}

function payee(i, weights, extra = {}) {
  const v = voucher(i);
  return { voucher: publicVoucher(v), shares: weights.map((w) => minerShare(v, w)), ...extra };
}

/** Chain-side inputs: what consensus derives without trusting the coinbase. */
function expectFor(tx, over = {}) {
  return {
    S: BigInt(tx.t21.S),
    cin: BigInt(tx.t21.cin),
    u: BigInt(tx.t21.u),
    height: tx.t21.height,
    magic,
    prevHash,
    shares: tx.t21.shares.map((s) => ({ nc: t21ShareNc(magic, s.E), units: BigInt(s.w) })),
    prevEs: new Set(),
    vaults: [],
    hashBudget: BigInt(tx.t21.u) * W_HASH_MAX,
    ...over,
  };
}

function clone(tx) {
  return {
    ...tx,
    vout: tx.vout.map((o) => ({ ...o, ra: o.ra ? { ...o.ra } : o.ra })),
    t21: { ...tx.t21, shares: tx.t21.shares.map((s) => ({ ...s })) },
  };
}

function restate(tx) {
  tx.t21.stmt = statementOf(tx);
  return tx;
}

describe('T21 splitLaw, fee and params', () => {
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
    assert.equal(lawDust([2n, 2n], 4n), 1n);
    assert.equal(feeOf(10_000n, 200n), 200n);
    assert.equal(feeOf(10_000n, 201n), null);
    assert.equal(Buffer.from(pointBytes(H)).toString('hex'), GEN_H);
    assert.equal(K_MIN, 4);
    const parts = consensusFingerprint().split(':');
    for (const token of T21_FINGERPRINT_TOKENS) assert.equal(parts.includes(token), true, token);
  });

  it('must-fix 9: fingerprint keys are unique and T21 tokens are built from constants', async () => {
    const parts = consensusFingerprint().split(':');
    const keys = parts.filter((t) => t.includes('=')).map((t) => t.split('=')[0]);
    assert.equal(new Set(keys).size, keys.length, keys.filter((k, i) => keys.indexOf(k) !== i).join());
    assert.equal(parts.filter((t) => t.startsWith('RANGE=')).length, 1);
    for (const t of ['CB_ONLY=cb-v3-at-genesis-pin', 'CB_RANGE=bp-agg-16x32+0x02',
      'SPLIT_TALLY=logup-inv-schnorr+shear-logup-x-v1', 'SEND_WEIGHT=25+25n,n<=8,R2336', 'DEPTH=7', 'INPUT_MAX=8']) {
      assert.ok(parts.includes(t), t);
    }
    const src = readFileSync(new URL('./t21_params.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('T21_FINGERPRINT_TOKENS = Object.freeze(['));
    const lines = block.slice(0, block.indexOf(']);')).split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    assert.equal(lines.length, T21_FINGERPRINT_TOKENS.length);
    for (const l of lines) assert.match(l, /^`[A-Z0-9_]+=.*\$\{.+\}.*`,$/);
    const params = await import('./t21_params.js');
    const budget = await import('./block_budget.js');
    const note = await import('./note.js');
    assert.equal(params.SEND_W_BASE, budget.W_FS1_BASE);
    assert.equal(params.SEND_W_PER_INPUT, budget.W_FS1_PER_INPUT);
    assert.equal(params.SEND_R_WEIGHT, budget.R_WEIGHT);
    assert.equal(budget.fs1VerifyWeight(params.SEND_INPUT_MAX + 1), null);
    assert.equal(params.AMT_CT_DOM, note.AMOUNT_CT_DST.toString());
  });

  it('keeps the remainder off the last payee: odd pots carry one nano', () => {
    const odd = [splitLaw({ R: 11n, W: 2n, Wi: 1n }), splitLaw({ R: 11n, W: 2n, Wi: 1n })];
    assert.equal(odd[0].v, odd[1].v);
    assert.equal(lawDust(odd.map((r) => r.rho), 2n), 1n);
  });
});

describe('T21 vouchers (must-fix 12)', () => {
  it('derives vouchers from the wallet secret and stops after the gap', () => {
    assert.throws(() => walletSecretBytes('abandon abandon abandon'), /seed_phrase/);
    const a = voucherAt(secrets[0], 0);
    assert.equal(a.lambdaBytes.toString('hex'), voucherAt(secrets[0], 0).lambdaBytes.toString('hex'));
    assert.notEqual(voucherAt(secrets[0], 1).lambdaBytes.toString('hex'), a.lambdaBytes.toString('hex'));
    assert.ok(VOUCHER_GAP > 0);
  });

  it('restores vouchers from shewall.bin and a password', () => {
    const dest20 = createHash('sha256').update('t21').digest().subarray(0, 20);
    const env = sealShewallBin(packShewall({ seed32: secrets[0], dest20 }), 't21-pass');
    const want = voucherAt(secrets[0], 4).lambdaBytes.toString('hex');
    const found = vouchersFromShewall(env, 't21-pass', [want]);
    assert.equal(found.length, 1);
    assert.equal(found[0].ctr, 4);
  });

  it('matches crypto/vectors/t21_voucher.txt (shared with shear-fs1)', () => {
    const rows = readFileSync(new URL('./vectors/t21_voucher.txt', import.meta.url), 'utf8')
      .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t'));
    assert.ok(rows.length >= 11);
    for (const [name, B, Y, lambda, , , want] of rows) {
      const pub = { B: Buffer.from(B, 'hex'), Y: Buffer.from(Y, 'hex'), lambda: Buffer.from(lambda, 'hex') };
      assert.equal(voucherKeysOk(pub), want === 'ok', name);
    }
  });

  it('accepts a wallet voucher and refuses bad B*, Y, or lambda', () => {
    const pub = publicVoucher(voucher(0));
    assert.equal(voucherKeysOk(pub), true);
    assert.equal(voucherKeysOk({ ...pub, Y: pub.B }), false);
    assert.equal(voucherKeysOk({ ...pub, B: Buffer.alloc(32) }), false);
    assert.equal(voucherKeysOk({ ...pub, B: Buffer.alloc(32, 0xff) }), false);
    assert.equal(voucherKeysOk({ ...pub, lambda: Buffer.alloc(32) }), false);
    assert.equal(voucherKeysOk({ ...pub, lambda: Buffer.alloc(32, 0xff) }), false);
    assert.equal(voucherKeysOk({ ...pub, lambda: Buffer.alloc(31, 1) }), false);
    assert.equal(voucherKeysOk({ ...pub, lambda: publicVoucher(voucher(1)).lambda }), false);
    assert.equal(voucherKeysOk({ ...publicVoucher(voucher(1)), lambda: pub.lambda }), false);
  });
});

describe('T21 vault rows (must-fix 6, KT-10)', () => {
  const mintId = Buffer.from('mint-1');
  const owner = publicVoucher(voucher(4)).B;

  it('derives r from the parent hash, deterministically', () => {
    const a = vaultCommit(50n, mintId, 7, prevHash);
    assert.equal(a.commit.length, 32);
    assert.equal(Buffer.from(a.commit).toString('hex'), Buffer.from(vaultCommit(50n, mintId, 7, prevHash).commit).toString('hex'));
    assert.notEqual(Buffer.from(a.commit).toString('hex'), Buffer.from(vaultCommit(50n, mintId, 7, Buffer.alloc(32, 2)).commit).toString('hex'));
    assert.notEqual(Buffer.from(a.commit).toString('hex'), Buffer.from(vaultCommit(50n, mintId, 8, prevHash).commit).toString('hex'));
  });

  it('pays the owner key, is a leaf, and is refused unless chain state lists it', () => {
    const built = buildT21Coinbase({
      S: 1000n, cin: 0n, height: 7, magic, prevHash, payees: [], vaults: [{ vaultNanos: 50n, mintId, B: owner }],
    });
    const row = built.tx.vout[0];
    assert.equal(row.kindCode, 0x23);
    assert.notEqual(Buffer.from(row.admitPub).toString('hex'), Buffer.from(pointBytes(G)).toString('hex'));
    assert.equal(Buffer.from(row.B).toString('hex'), Buffer.from(owner).toString('hex'));
    const listed = expectFor(built.tx, { shares: [], vaults: [{ mintId, vaultNanos: 50n, B: owner }] });
    const ok = verifyT21Coinbase({ tx: built.tx, expect: listed });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.vaultPaid, 50n);
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: { ...listed, vaults: [] } }).reason, 'vault_pin');
    const otherOwner = { ...listed, vaults: [{ mintId, vaultNanos: 50n, B: publicVoucher(voucher(3)).B }] };
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: otherOwner }).reason, 'vault_pin');
    const moved = { ...listed, prevHash: Buffer.alloc(32, 2) };
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: moved }).reason, 'cb_form');
  });

  const pend = (k, B = owner) => ({ mintId: Buffer.from(`mint-${k}`), vaultNanos: BigInt(10 + k), B });
  const vaultBuild = (vaults) => buildT21Coinbase({ S: 1000n, cin: 0n, height: 7, magic, prevHash, payees: [], vaults });
  const mintsOf = (tx) => tx.vout.filter((o) => o.kindCode === 0x23).map((o) => Buffer.from(o.mintId).toString());

  it('pays the pending list in order and refuses a reorder or a missing row', () => {
    const list = [pend(1), pend(2), pend(3)];
    const built = vaultBuild(list);
    assert.deepEqual(mintsOf(built.tx), ['mint-1', 'mint-2', 'mint-3']);
    const ok = verifyT21Coinbase({ tx: built.tx, expect: expectFor(built.tx, { shares: [], vaults: list }) });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.vaultPaid, 11n + 12n + 13n);
    const swapped = expectFor(built.tx, { shares: [], vaults: [list[1], list[0], list[2]] });
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: swapped }).reason, 'vault_pin');
    const short = vaultBuild(list.slice(0, 2));
    assert.equal(verifyT21Coinbase({ tx: short.tx, expect: expectFor(short.tx, { shares: [], vaults: list }) }).reason, 'vault_pin');
  });

  it('pays at most K_VW rows per block, oldest first', () => {
    const list = [...Array(K_VW + 2)].map((_, k) => pend(k));
    const built = vaultBuild(list);
    assert.deepEqual(mintsOf(built.tx), list.slice(0, K_VW).map((p) => p.mintId.toString()));
    const ok = verifyT21Coinbase({ tx: built.tx, expect: expectFor(built.tx, { shares: [], vaults: list }) });
    assert.equal(ok.ok, true, ok.reason);
  });

  it('skips an entry whose row is not a leaf, so a fixed blind cannot stall the chain', () => {
    const p = pend(9);
    const { commit: C } = vaultCommit(p.vaultNanos, p.mintId, 7, prevHash);
    const d = payoutDelta({ magic, height: 7, prevHash, index: 0, commit: C });
    const stuck = { ...p, B: pointBytes(G.multiply(d).negate()) };
    const list = [stuck, pend(1)];
    const built = vaultBuild(list);
    assert.deepEqual(mintsOf(built.tx), ['mint-1']);
    const ok = verifyT21Coinbase({ tx: built.tx, expect: expectFor(built.tx, { shares: [], vaults: list }) });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.vaultPaid, 11n);
    const bad = clone(built.tx);
    bad.vout[0] = { ...bad.vout[0], mintId: stuck.mintId };
    assert.equal(verifyT21Coinbase({ tx: bad, expect: expectFor(built.tx, { shares: [], vaults: list }) }).reason, 'vault_pin');
  });
});

describe('T21 empty batch and the cb-only gate (must-fix 5)', () => {
  it('carries the whole pot only when no share is proven', () => {
    const built = buildT21Coinbase({ S: 3n, cin: 2n, height: 1, magic, prevHash, payees: [] });
    const expect = expectFor(built.tx, { shares: [] });
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect }).ok, true);
    assert.equal(verifyT21Coinbase({ tx: built.tx }).reason, 'pot_sched');
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: { ...expect, S: 4n } }).reason, 'pot_sched');
    const carried = restate({ ...clone(built.tx), carryNanos: 4 });
    assert.equal(verifyT21Coinbase({ tx: carried, expect }).reason, 'pot_sched');
    const proven = { ...expect, shares: [{ nc: Buffer.alloc(32), units: 1n }] };
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: proven }).reason, 'share_bind');
  });

  it('turns cb-v3-only on with the genesis hash', () => {
    assert.equal(T21_REQUIRE_ALL_COINBASES, false);
    assert.equal(t21CbOnly(''), false);
    assert.equal(t21CbOnly('ab'.repeat(32)), true);
  });
});

describe('T21 cb-v3 coinbase', { timeout: 600_000 }, () => {
  const S = 5_000_000_000n;
  const fees = 1_000_000;
  const fin = BigInt(splitLevy(fees).finder);
  const feeVoucher = voucherAt(feeSecret, 0);
  let built;
  let expect;

  it('builds and verifies four payees, the finder half split by weight, and a fee note', () => {
    built = buildT21Coinbase({
      S,
      cin: 3n,
      bps: 100,
      u: 0n,
      phi: fin,
      height: 9,
      magic,
      prevHash,
      dummySecret,
      fee: { voucher: publicVoucher(feeVoucher) },
      payees: [payee(0, [25n, 3n]), payee(1, [26n]), payee(2, [27n, 1n]), payee(3, [28n])],
    });
    expect = expectFor(built.tx, { phi: fin });
    const gate = verifyT21Coinbase({ tx: built.tx, expect });
    assert.equal(gate.ok, true, gate.reason);
    assert.equal(gate.phi, fin);
    assert.equal(gate.finB, null);
    assert.ok(built.tx.vout.every((o) => o.fin == null || BigInt(o.fin) === 0n));
    assert.equal(gate.f, 50_000_000n);
    const dust = BigInt(built.tx.carryNanos || 0) + BigInt(built.tx.t21.potCarry || 0);
    assert.equal(gate.paid, S + 3n - dust + fin);
    const R = S + 3n - feeOf(S, 100n);
    const priced = priceWeights(R + fin, 0n, [28n, 26n, 28n, 28n]);
    const pots = built.secrets.filter((s) => s.kind === 'pot' && s.v > 0n).map((s) => s.v);
    const want = priced.rows.map((r) => r.v);
    const byValue = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    assert.deepEqual(pots.sort(byValue), want.sort(byValue));
    assert.equal(pots.reduce((a, v) => a + v, 0n) + priced.dust, R + fin);
    const supply = supplyIdentities(built);
    assert.equal(supply.ok, true);
    assert.equal(supply.paid, gate.paid);
    const redirected = clone(built.tx);
    redirected.vout.find((o) => o.kind === 'pot').fin = fin.toString();
    assert.equal(verifyT21Coinbase({ tx: redirected, expect }).reason, 'finder_row');
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: { ...expect, phi: 0n } }).reason, 'split_law');
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: { ...expect, phi: fin - 1n } }).reason, 'split_law');
    assert.throws(() => buildT21Coinbase({
      S, cin: 3n, bps: 100, u: 0n, phi: fin, height: 9, magic, prevHash, dummySecret,
      fee: { voucher: publicVoucher(feeVoucher) },
      payees: [payee(0, [25n, 3n], { fin }), payee(1, [26n]), payee(2, [27n, 1n]), payee(3, [28n])],
    }), (err) => err.reason === 'finder_row');
    const feeRows = built.tx.vout.filter((o) => o.kind === 'pool-fee');
    assert.equal(feeRows.length, 1);
    const index = built.tx.vout.indexOf(feeRows[0]);
    const opened = openOutput(feeRows[0], feeSecret, { magic, height: 9, prevHash, index });
    assert.equal(opened.v, gate.f);
  });

  it('B1: publishes no limbs; an extra agg or chunk key is cb_wrap', () => {
    for (const o of built.tx.vout) {
      assert.deepEqual(Object.keys(o.ra.agg).sort(), [...AGG_KEYS].sort());
      for (const c of o.ra.chunks) assert.deepEqual(Object.keys(c).sort(), [...CHUNK_KEYS].sort());
    }
    const leak = clone(built.tx);
    leak.vout[0].ra = { ...leak.vout[0].ra, agg: { ...leak.vout[0].ra.agg, vLimbs: [1, 2, 3, 4] } };
    assert.equal(verifyT21Coinbase({ tx: leak, expect }).reason, 'cb_wrap');
    const leak2 = clone(built.tx);
    leak2.vout[1].ra = { ...leak2.vout[1].ra, chunks: leak2.vout[1].ra.chunks.map((c, i) => (i ? c : { ...c, m: 5 })) };
    assert.equal(verifyT21Coinbase({ tx: leak2, expect }).reason, 'cb_wrap');
  });

  it('B2: a share is (w, E) only; a share label is refused', () => {
    for (const s of built.tx.t21.shares) assert.deepEqual(Object.keys(s).sort(), ['E', 'w']);
    const labelled = clone(built.tx);
    labelled.t21.shares[0].lambda = publicVoucher(voucher(0)).lambda;
    assert.equal(verifyT21Coinbase({ tx: labelled, expect }).reason, 'share_label');
    assert.ok(observerView(labelled).leaks.some((l) => l.key === 'lambda'));
  });

  it('B3: subsidy, carry, bonus, and parent are chain state', () => {
    assert.equal(verifyT21Coinbase({ tx: built.tx }).reason, 'pot_sched');
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: { ...expect, S: S + 1n } }).reason, 'pot_sched');
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: { ...expect, cin: 0n } }).reason, 'pot_sched');
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: { ...expect, u: 1n } }).reason, 'pot_sched');
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: { ...expect, height: 10 } }).reason, 'cb_form');
    const inflated = restate({ ...clone(built.tx), carryNanos: 0 });
    if (built.tx.carryNanos !== 0) assert.equal(verifyT21Coinbase({ tx: inflated, expect }).ok, false);
    const over = restate({ ...clone(built.tx), carryNanos: built.tx.vout.length });
    assert.equal(verifyT21Coinbase({ tx: over, expect }).reason, 'pot_carry');
  });

  it('B4: every share is a proven batch share at its weight', () => {
    const missing = { ...expect, shares: expect.shares.slice(1) };
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: missing }).reason, 'share_bind');
    const reweighed = { ...expect, shares: expect.shares.map((s, i) => (i ? s : { ...s, units: s.units + 1n })) };
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: reweighed }).reason, 'share_bind');
    const foreignE = { ...expect, shares: expect.shares.map((s, i) => (i ? s : { ...s, nc: Buffer.alloc(32, 7) })) };
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: foreignE }).reason, 'share_bind');
    const replay = { ...expect, prevEs: new Set([Buffer.from(built.tx.t21.shares[0].E).toString('hex')]) };
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: replay }).reason, 'share_label');
    // Weight moved in both the block and the proven batch: the tally no longer balances.
    const shifted = clone(built.tx);
    shifted.t21.shares[0].w = String(BigInt(shifted.t21.shares[0].w) + 1n);
    shifted.t21.shares[1].w = String(BigInt(shifted.t21.shares[1].w) - 1n);
    restate(shifted);
    assert.equal(verifyT21Coinbase({ tx: shifted, expect: expectFor(shifted, { phi: fin }) }).reason, 'split_tally');
  });

  it('P0-1: a pool cannot pay a miner\'s shares to its own keys', () => {
    const victim = voucher(3);
    const thief = voucherAt(Buffer.alloc(32, 0x66), 0);
    const base = {
      S, cin: 0n, u: 0n, height: 9, magic, prevHash, dummySecret, voucherOk: () => true,
    };
    const honest = [payee(0, [5n]), payee(1, [5n]), payee(2, [5n])];
    const victimShares = [minerShare(victim, 1000n)];
    // Victim's label, thief's keys: the tally balances, so only the label binding refuses it.
    const swapped = buildT21Coinbase({
      ...base,
      payees: [...honest, { voucher: { ...publicVoucher(thief), lambda: publicVoucher(victim).lambda }, shares: victimShares }],
    });
    assert.equal(verifyT21Coinbase({ tx: swapped.tx, expect: expectFor(swapped.tx) }).reason, 'split_label');
    // The thief's own label on the victim's shares: E still opens to the victim's label.
    const relabelled = buildT21Coinbase({
      ...base,
      payees: [...honest, { voucher: publicVoucher(thief), shares: victimShares }],
    });
    assert.equal(verifyT21Coinbase({ tx: relabelled.tx, expect: expectFor(relabelled.tx) }).reason, 'split_tally');
  });

  it('binds every row field into the statement', () => {
    const lied = clone(built.tx);
    const ct = Buffer.from(lied.vout[0].amtCt);
    ct[0] ^= 0xff;
    lied.vout[0].amtCt = ct;
    assert.equal(verifyT21Coinbase({ tx: lied, expect }).reason, 'split_law');
    restate(lied);
    assert.equal(verifyT21Coinbase({ tx: lied, expect }).ok, false);
  });

  it('must-fix 11: the observer derives no per-row amount (D >= 4)', () => {
    const payees = built.tx.vout.filter((o) => o.kind === 'pot');
    assert.ok(payees.length >= 4);
    const truth = built.secrets.filter((s) => s.v >= 1000n);
    assert.ok(truth.length >= 4);
    const view = observerView(built.tx, { truth });
    assert.deepEqual(view.leaks, []);
    // The harness does fail on a derivable amount.
    const planted = clone(built.tx);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(truth[0].v);
    planted.vout[0].memo = buf;
    assert.ok(observerView(planted, { truth }).leaks.length > 0);
    const plain = clone(built.tx);
    plain.vout[2].nanos = 1;
    assert.ok(observerView(plain).leaks.some((l) => l.key === 'nanos'));
  });

  it('opens a payee row by amtCt and, if amtCt lies, by VE', () => {
    const B = publicVoucher(voucher(1)).B;
    const index = built.tx.vout.findIndex((o) => Buffer.from(o.B).equals(B));
    const row = built.tx.vout[index];
    const ctx = { magic, height: 9, prevHash, index };
    const opened = openOutput(row, secrets[1], ctx);
    assert.equal(opened.via, 'amtCt');
    assert.equal(opened.v, built.secrets.find((s) => s.index === index).v);
    const ct = Buffer.from(row.amtCt);
    ct[0] ^= 0xff;
    const viaVe = openOutput({ ...row, amtCt: ct }, secrets[1], ctx);
    assert.equal(viaVe.via, 've');
    assert.equal(viaVe.v, opened.v);
  });

  it('must-fix 8: evicts a payee whose row is not a leaf, defers it, and rebuilds once', () => {
    const bad = { ...publicVoucher(voucher(2)), Y: publicVoucher(voucher(2)).B };
    const out = buildT21Coinbase({
      S: 50_000n,
      cin: 0n,
      height: 4,
      magic,
      prevHash,
      dummySecret,
      payees: [
        payee(0, [2n], { forceNonLeaf: true }),
        payee(1, [2n]),
        { voucher: bad, shares: [minerShare(voucher(2), 5n)] },
      ],
    });
    assert.deepEqual(out.deferred.map((d) => d.reason).sort(), ['admit_note_point', 'voucher_key']);
    assert.equal(out.tx.t21.shares.length, 1);
    assert.equal(out.tx.vout.filter((o) => o.kind === 'pot').length, K_MIN);
    const gate = verifyT21Coinbase({ tx: out.tx, expect: expectFor(out.tx) });
    assert.equal(gate.ok, true, gate.reason);
  });
});

describe('T21 hash bonus budget (P0-2, P1-1)', { timeout: 600_000 }, () => {
  const u = 1000n;
  const base = { S: 5_000_000n, cin: 0n, u, height: 9, magic, prevHash, dummySecret };
  const fill = (top) => [payee(0, [1n << 47n, top]), payee(1, [1n]), payee(2, [1n]), payee(3, [1n])];

  it('caps W below 2^48 and u·W at B_h', () => {
    assert.equal(W_HASH_MAX, 1n << 48n);
    assert.ok(W_HASH_MAX > BigInt(MAX_HASH_UNITS_PER_BLOCK));
    const at = buildT21Coinbase({ ...base, payees: fill((1n << 47n) - 4n) });
    assert.equal(at.W, W_HASH_MAX - 1n);
    const demand = u * at.W;
    const ex = expectFor(at.tx);
    for (const [Bh, want] of [[2n * demand, true], [demand, true], [demand / 2n, false], [demand / 10n, false]]) {
      const got = verifyT21Coinbase({ tx: at.tx, expect: { ...ex, hashBudget: Bh } });
      assert.equal(got.ok, want, `B_h=${Bh}: ${got.reason}`);
      if (!want) assert.equal(got.reason, 'hash_budget');
    }
    const { hashBudget, ...noBudget } = ex;
    assert.equal(verifyT21Coinbase({ tx: at.tx, expect: noBudget }).reason, 'hash_budget');
    const empty = buildT21Coinbase({ ...base, payees: [] });
    assert.equal(verifyT21Coinbase({ tx: empty.tx, expect: expectFor(empty.tx, { shares: [], hashBudget: 0n }) }).ok, true);
  });

  it('refuses W at 2^48 even with an unlimited budget', () => {
    assert.throws(() => buildT21Coinbase({ ...base, payees: fill((1n << 47n) - 3n) }), (e) => e.reason === 'split_cap');
    const at = buildT21Coinbase({ ...base, payees: fill((1n << 47n) - 4n) });
    const tx = structuredClone(at.tx);
    const top = tx.t21.shares.find((s) => BigInt(s.w) === (1n << 47n) - 4n);
    top.w = String((1n << 47n) - 3n);
    const got = verifyT21Coinbase({ tx, expect: expectFor(tx, { hashBudget: 1n << 62n }) });
    assert.equal(got.reason, 'split_cap');
  });

  it('credits every share its full 2^bits: no pro-rata cut, no round-robin (ME G6)', () => {
    const rows = [...Array(8)].map((_, i) => ({
      noteCommit: t21ShareNc(magic, pointBytes(G.multiply(BigInt(i + 2)))), nonce: (28n << 56n) | BigInt(i), shareBits: 28,
    }));
    const credit = t21ShareCredit();
    const acc = accountShareUnits(rows, credit.unitCap, credit);
    assert.equal(acc.ok, true);
    const leaves = aLeavesFromShares(acc.bound, acc.room, acc.retained);
    assert.equal(leaves.length, 8);
    assert.ok(leaves.every((l) => l.count === 2 ** 28));
    const shares = t21ShareUnits({}, [], leaves, false, null).shares;
    assert.equal(shares.reduce((n, l) => n + l.units, 0n), 8n << 28n);
    // Over the cap the whole batch is hash_units; nothing is scaled down.
    assert.equal(accountShareUnits(rows, 7n << 28n, credit).reason, 'hash_units');
    // A share past the cb-v3 width is share_target, wider than the legacy 28.
    const wide = { ...rows[0], nonce: (40n << 56n) | 1n, shareBits: 40 };
    assert.equal(accountShareUnits([wide], credit.unitCap, credit).units, 2 ** 40);
    const tooWide = { ...rows[0], nonce: (48n << 56n) | 1n, shareBits: 48 };
    assert.equal(accountShareUnits([tooWide], credit.unitCap, credit).units, 0);
    // The legacy coinbase still retains 2^28 across the same eight.
    const legacy = accountShareUnits(rows);
    assert.equal(legacy.units, MAX_HASH_UNITS_PER_BLOCK);
  });

  it('binds a buried pruned block\'s W to the header through its aLeaves', () => {
    const leaves = [{ noteCommit: Buffer.alloc(32, 3), count: 40 }, { noteCommit: Buffer.alloc(32, 4), count: 2 }];
    const decoded = { continuityRoot: buildDualTree({ aLeaves: leaves, bLeaves: [] }).continuityRoot };
    const got = t21ShareUnits({ aLeaves: leaves, bLeaves: [], bLeavesPruned: true }, [], null, true, decoded);
    assert.equal(got.ok, true, got.reason);
    assert.deepEqual(got.shares.map((s) => s.units), [40n, 2n]);
    const inflated = leaves.map((l, i) => (i ? l : { ...l, count: 1 << 27 }));
    assert.equal(t21ShareUnits({ aLeaves: inflated }, [], null, true, decoded).reason, 'continuity');
    assert.equal(t21ShareUnits({ aLeaves: [{ count: 5 }] }, [], null, true, decoded).reason, 'hash_bonus');
    assert.deepEqual(t21ShareUnits({ aLeaves: leaves }, [], null, false, decoded).shares, []);
    const built = buildT21Coinbase({ S: 3n, cin: 2n, height: 1, magic, prevHash, payees: [] });
    assert.equal(verifyT21Coinbase({ tx: built.tx, expect: expectFor(built.tx, { shares: 'buried' }) }).reason, 'share_bind');
  });
});

describe('T21 payee cap (P1-3)', () => {
  it('uses the block budget\'s live cap: 171 pot rows on today\'s frame', () => {
    assert.equal(payeeCapLive(), 171);
    const rows = (n) => [...Array(n)].map(() => ({ kind: 'pot', kindCode: 0x20 }));
    const tx = (n) => ({
      coinbase: true, cbForm: 'cb-v3', vout: [...rows(n), { kind: 'pool-fee', kindCode: 0x20 }], t21: { shares: [] },
    });
    assert.equal(verifyT21Coinbase({ tx: tx(172), expect: {} }).reason, 'payee_cap');
    assert.notEqual(verifyT21Coinbase({ tx: tx(171), expect: {} }).reason, 'payee_cap');
  });
});

describe('T21 verify weight and share cap', () => {
  const cb = ({ shares = 0, vw = 0 } = {}) => ({
    coinbase: true,
    cbForm: 'cb-v3',
    vout: [
      ...[...Array(payeeCapLive())].map(() => ({ kind: 'pot', kindCode: 0x20 })),
      { kind: 'pool-fee', kindCode: 0x20 },
      { kind: 'reserve-fee' },
      ...[...Array(vw)].map(() => ({ kind: 'vault-withdraw-pinned', kindCode: 0x23 })),
    ],
    t21: { shares: [...Array(shares)].map(() => ({ w: '1', E: Buffer.alloc(32) })) },
  });

  it('fits 171 settle rows beside 171 payees in the block byte and weight budget', () => {
    const n = payeeCapLive();
    assert.equal(n, 171);
    const heavy = (kind) => ({ kind, kindCode: 0x20, commit: Buffer.alloc(PAYEE_ROW_BYTES) });
    const tx = {
      coinbase: true,
      cbForm: 'cb-v3',
      vout: [
        ...Array.from({ length: n }, () => heavy('pot')),
        ...Array.from({ length: n }, () => heavy('settle')),
        heavy('pool-fee'),
        { kind: 'reserve-fee', commit: Buffer.alloc(PAYEE_ROW_BYTES) },
      ],
      t21: { shares: [] },
    };
    assert.equal(countPayees(tx), n);
    const weight = txVerifyWeight(tx);
    assert.equal(weight, 300 + (n + n + 2) * 60);
    assert.ok(weight + R_WEIGHT + R_VW_WEIGHT <= MAX_BLOCK_VERIFY_WEIGHT);
    assert.ok(publicBytes(tx) <= C_MAX);
    const budget = blockBudget([tx]);
    assert.equal(budget.ok, true, budget.reason);
    assert.equal(budget.payees, n);
  });

  it('prices a full payout at 10,680 wu and fits 7,485 shares beside both reserves', () => {
    assert.equal(txVerifyWeight(cb()), 10_680);
    assert.equal(CB_SHARE_MAX, 7_485);
    const full = cb({ shares: CB_SHARE_MAX, vw: K_VW });
    // The 0x23 rows' 1 wu is already inside R_VW_WEIGHT.
    const block = txVerifyWeight(full) + R_WEIGHT + R_VW_WEIGHT - K_VW * W_ROW_0X23;
    assert.ok(block <= MAX_BLOCK_VERIFY_WEIGHT, String(block));
    assert.ok(block + 3 > MAX_BLOCK_VERIFY_WEIGHT, String(block));
    assert.equal(txBudget(full).ok, true);
    assert.equal(blockBudget([full]).ok, true);
  });

  it('refuses one share over the cap in the budget and in consensus', () => {
    const over = cb({ shares: CB_SHARE_MAX + 1 });
    assert.equal(txBudget(over).reason, 'share_cap');
    assert.equal(blockBudget([over]).reason, 'share_cap');
    assert.equal(verifyT21Coinbase({ tx: over, expect: {} }).reason, 'share_cap');
    assert.notEqual(verifyT21Coinbase({ tx: cb({ shares: CB_SHARE_MAX }), expect: {} }).reason, 'share_cap');
  });

  it('refuses a share total past shareMax instead of splitting a payee', () => {
    assert.throws(() => buildT21Coinbase({
      S: 50_000n, cin: 0n, height: 4, magic, prevHash, dummySecret, shareMax: 3,
      payees: [payee(0, [2n, 2n]), payee(1, [3n, 1n]), payee(2, [4n])],
    }), (err) => err.reason === 'share_cap');
  });
});

describe('T21 chain rules (must-fix 3, 5)', { timeout: 600_000 }, () => {
  it('refuses a legacy coinbase once the genesis hash is pinned', () => {
    const legacy = { coinbase: true, vout: [{ kind: 'pot', nanos: 1 }] };
    const v3 = { coinbase: true, cbForm: 'cb-v3', vout: [] };
    assert.equal(coinbaseFormRejected(legacy, ''), null);
    assert.equal(coinbaseFormRejected(legacy, 'ab'.repeat(32)).reason, 'cb_form');
    assert.equal(coinbaseFormRejected(v3, 'ab'.repeat(32)), null);
    assert.equal(coinbaseFormRejected(legacy), null);
  });

  it('needs an empty hash-owed ledger on the parent and none on the coinbase', () => {
    const v3 = { coinbase: true, cbForm: 'cb-v3', vout: [] };
    assert.equal(t21HashLedgerOk(null, v3), true);
    assert.equal(t21HashLedgerOk(v3, v3), true);
    assert.equal(t21HashLedgerOk({ hashDustNanos: '5' }, v3), false);
    assert.equal(t21HashLedgerOk(null, { ...v3, hashAcceptedUnits: '3' }), false);
  });

  const fees = 1_000_000;
  const phi = BigInt(splitLevy(fees).finder);
  const finVoucher = voucher(0);
  let levyTx;

  it('folds the finder half into the payee split beside the public reserve-fee row', () => {
    const built = buildT21Coinbase({
      S: 100_000n, cin: 0n, height: 2, magic, prevHash, dummySecret, phi,
      payees: [payee(0, [5n])],
      publicRows: [sealLevyNote(splitLevy(fees).reserve, reserveFeeDest(), 'reserve-fee')],
    });
    levyTx = built.tx;
    assert.equal(verifyT21Coinbase({ tx: levyTx, expect: expectFor(levyTx, { phi }) }).ok, true);
    assert.equal(built.phi, phi);
    const priced = priceWeights(100_000n + phi, 0n, [5n]);
    const pot = built.secrets.find((s) => s.kind === 'pot' && s.v > 0n);
    assert.equal(pot.v, priced.rows[0].v);
    assert.equal(pot.v + priced.dust, 100_000n + phi);
  });

  // Opening the reserve-fee note checks its range proof, which only the native addon verifies.
  const noNative = nativeLoaded() ? false : 'needs crypto/native/shearadmit.node (npm run build:admit)';
  it('does not bind the finder half to the block miner', () => {
    const tx = levyTx;
    const miner = encodeDest(Buffer.alloc(20, 5), publicVoucher(finVoucher).B);
    const other = encodeDest(Buffer.alloc(20, 5), publicVoucher(voucher(1)).B);
    // The success path opens the reserve-fee note, which needs the native addon.
    if (nativeLoaded()) {
      assert.equal(coinbaseLevyPays(tx, fees, miner).ok, true);
      assert.equal(coinbaseLevyPays(tx, fees, other).ok, true);
      assert.equal(coinbaseLevyPays(tx, fees, '').ok, true);
    }
    assert.equal(verifyT21Coinbase({ tx, expect: expectFor(tx, { phi: phi + 1n }) }).reason, 'split_law');
    const withRow = { ...tx, vout: tx.vout.concat([{ kind: 'finder-fee', nanos: Number(phi) }]) };
    assert.equal(coinbaseLevyPays(withRow, fees, miner).reason, 'levy_split');
    const planted = clone(tx);
    planted.vout.find((o) => o.kind === 'pot').fin = phi.toString();
    assert.equal(coinbaseLevyPays(planted, fees, miner).reason, 'finder_row');
  });

  it('refuses a public finder-fee row beside shares', () => {
    const miner = encodeDest(Buffer.alloc(20, 5), publicVoucher(finVoucher).B);
    const withRow = { ...levyTx, vout: levyTx.vout.concat([sealLevyNote(Number(phi), miner, 'finder-fee')]) };
    assert.equal(verifyT21Coinbase({ tx: withRow, expect: expectFor(levyTx, { phi }) }).reason, 'levy_split');
    assert.throws(() => buildT21Coinbase({
      S: 100_000n, cin: 0n, height: 2, magic, prevHash, dummySecret, phi,
      payees: [payee(0, [5n], { fin: phi })],
      publicRows: [sealLevyNote(Number(phi), miner, 'finder-fee')],
    }), (e) => e.reason === 'finder_row');
  });

  it('an empty round pays the finder half as one public finder-fee note to the block miner', { skip: noNative }, () => {
    const miner = encodeDest(Buffer.alloc(20, 5), publicVoucher(finVoucher).B);
    const other = encodeDest(Buffer.alloc(20, 6), publicVoucher(voucher(1)).B);
    const { reserve, finder } = splitLevy(fees);
    const reserveRow = sealLevyNote(reserve, reserveFeeDest(), 'reserve-fee');
    const build = (rows) => buildT21Coinbase({ S: 100_000n, cin: 7n, height: 2, magic, prevHash, payees: [], publicRows: rows }).tx;
    const tx = build([reserveRow, sealLevyNote(finder, miner, 'finder-fee')]);
    assert.equal(tx.t21.shares.length, 0);
    assert.equal(verifyT21Coinbase({ tx, expect: expectFor(tx, { hashBudget: 0n }) }).ok, true);
    assert.equal(coinbaseLevyPays(tx, fees, miner).ok, true);
    assert.equal(coinbaseLevyPays(tx, fees, other).reason, 'finder_row');
    assert.equal(coinbaseLevyPays(tx, fees, '').reason, 'finder_row');
    assert.equal(coinbaseLevyPays(tx, fees * 2, miner).reason, 'levy_split');
    assert.equal(coinbaseLevyPays(build([reserveRow]), fees, miner).reason, 'finder_row');
    assert.equal(coinbaseLevyPays(build([reserveRow, sealLevyNote(finder, other, 'finder-fee')]), fees, miner).reason, 'finder_row');
    const two = build([reserveRow, sealLevyNote(finder - 1, miner, 'finder-fee'), sealLevyNote(1, miner, 'finder-fee')]);
    assert.equal(coinbaseLevyPays(two, fees, miner).reason, 'finder_row');
    assert.equal(coinbaseLevyPays(build([]), 0, miner).ok, true);
    assert.equal(coinbaseLevyPays(build([sealLevyNote(5, miner, 'finder-fee')]), 0, miner).reason, 'levy_split');
  });
});

describe('T21 payee-cap escrow (sealed at defer, paid by any producer)', { timeout: 600_000 }, () => {
  const u = 10n;
  const H = 20;
  const producer = Buffer.alloc(32, 4);
  const other = Buffer.alloc(32, 9);
  const leafOf = (s) => ({ nc: t21ShareNc(magic, s.E), units: BigInt(s.w) });
  const late = payee(4, [40n, 9n]);
  const paid = [payee(0, [5n]), payee(1, [7n]), payee(2, [3n]), payee(3, [2n])];
  let blockH;

  it('seals one escrow row for the overflow payee, priced on this round including the finder half', () => {
    const phi = 1_000n;
    blockH = buildT21Coinbase({
      S: 1_000_000n, cin: 0n, u, phi, height: H, magic, prevHash, dummySecret, producer,
      payees: paid, escrowPayees: [late],
    });
    const tx = blockH.tx;
    assert.equal(tx.t21.owed.length, 1);
    assert.equal(tx.t21.owed[0].shares.length, 2);
    assert.equal(tx.t21.owed[0].since, H);
    assert.equal(tx.t21.defer.length, 2);
    const priced = priceWeights(1_000_000n + phi, u, [5n, 7n, 3n, 2n, 49n]);
    assert.equal(BigInt(tx.t21.owed[0].hash), priced.rows[4].hash);
    assert.equal(BigInt(tx.t21.owed[0].pot), priced.rows[4].pot);
    assert.equal(priced.rows.reduce((a, r) => a + r.pot, 0n) + priced.dust, 1_000_000n + phi);
    assert.equal(supplyIdentities(blockH).ok, true);
    const leaves = [...paid, late].flatMap((p) => p.shares.map(leafOf));
    const seen = { shares: leaves, owedIn: [], producer, phi };
    const ok = verifyT21Coinbase({ tx, expect: expectFor(tx, seen) });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.W, 17n);
    assert.equal(ok.phi, phi);
    assert.equal(ok.escrowPot, BigInt(tx.t21.owed[0].pot));
    assert.equal(verifyT21Coinbase({ tx, expect: expectFor(tx, { ...seen, producer: other }) }).reason, 'owed_list');
    const again = payee(4, [4n]);
    const paidNow = [payee(0, [6n]), payee(1, [1n]), payee(2, [2n])];
    const owedIn = t21OwedOf(tx);
    const folded = buildT21Coinbase({
      S: 1_000_000n, cin: 0n, u, height: H + 1, magic, prevHash, dummySecret, producer,
      payees: paidNow,
      folds: [{ id: t21Anchor(owedIn[0]), shares: again.shares }],
      owedIn,
    });
    const grown = folded.tx.t21.owed[0];
    assert.equal(folded.tx.t21.owed.length, 1);
    assert.equal(grown.shares.length, 3);
    assert.equal(grown.since, H);
    assert.equal(t21Anchor(grown), t21Anchor(owedIn[0]));
    assert.equal(folded.tx.t21.defer.length, 1);
    const delta = weightPay(1_000_000n, 6n + 1n + 2n + 4n, 4n, u);
    assert.equal(BigInt(grown.pot), BigInt(owedIn[0].pot) + delta.pot);
    assert.equal(BigInt(grown.hash), BigInt(owedIn[0].hash) + delta.hash);
    const foldLeaves = [...paidNow, again].flatMap((p) => p.shares.map(leafOf));
    const foldOk = verifyT21Coinbase({
      tx: folded.tx,
      expect: expectFor(folded.tx, { shares: foldLeaves, owedIn, producer, height: H + 1 }),
    });
    assert.equal(foldOk.ok, true, foldOk.reason);
    assert.equal(foldOk.escrowPot, delta.pot);
    const relabel = structuredClone(tx);
    relabel.t21.owed[0].B = pointBytes(G.multiply(9n));
    assert.equal(verifyT21Coinbase({ tx: relabel, expect: expectFor(relabel, seen) }).reason, 'share_label');
    const dropped = structuredClone(tx);
    dropped.t21.owed = [];
    delete dropped.t21.defer;
    assert.equal(verifyT21Coinbase({ tx: dropped, expect: expectFor(dropped, seen) }).reason, 'share_bind');
  });

  it('a later producer settles the sealed value, and the row cannot be redirected', () => {
    const owedIn = t21OwedOf(blockH.tx);
    const row = owedIn[0];
    const fresh = [payee(0, [6n]), payee(1, [1n]), payee(2, [2n])];
    const next = buildT21Coinbase({
      S: 1_000_000n, cin: 0n, u, height: H + 1, magic, prevHash, dummySecret,
      payees: fresh, settle: [row], owedIn, producer: other,
    });
    const tx = next.tx;
    assert.equal(tx.t21.owed, undefined);
    assert.equal(tx.t21.defer, undefined);
    assert.equal(next.settleV, BigInt(row.pot) + BigInt(row.hash));
    const ex = expectFor(tx, { owedIn, producer: other });
    const ok = verifyT21Coinbase({ tx, expect: ex });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.W, 9n);
    assert.equal(ok.settleV, next.settleV);
    const lost = structuredClone(tx);
    lost.t21.owed = owedIn;
    assert.equal(verifyT21Coinbase({ tx: lost, expect: ex }).reason, 'owed_list');
    const redirect = structuredClone(tx);
    const settleOut = redirect.vout.find((o) => o.kind === 'settle');
    const index = redirect.vout.indexOf(settleOut);
    settleOut.B = pointBytes(G.multiply(3n));
    assert.equal(verifyT21Coinbase({ tx: redirect, expect: ex }).reason, 'split_label');
    const B = G.multiply(3n);
    const delta = payoutDelta({
      magic: redirect.t21.magic, height: redirect.t21.height, prevHash: redirect.t21.prevHash, index, commit: settleOut.commit,
    });
    settleOut.B = pointBytes(B);
    settleOut.admitPub = pointBytes(B.add(G.multiply(delta)));
    settleOut.lambda = Buffer.from(scalarBytes(voucherLambda(settleOut.B, settleOut.Y)));
    assert.equal(verifyT21Coinbase({ tx: redirect, expect: ex }).reason, 'owed_list');
  });

  it('TTL returns the escrow to the pot and refuses a late settlement', () => {
    const owedIn = t21OwedOf(blockH.tx);
    const stay = t21OwedNext({ owedIn, height: H + T21_OWED_TTL });
    assert.equal(stay.back, 0n);
    assert.equal(stay.owed.length, 1);
    const far = H + T21_OWED_TTL + 1;
    const drop = t21OwedNext({ owedIn, height: far });
    assert.equal(drop.owed.length, 0);
    assert.equal(drop.back, BigInt(owedIn[0].pot) + BigInt(owedIn[0].hash));
    assert.equal(drop.backHash, BigInt(owedIn[0].hash));
    const empty = buildT21Coinbase({ S: 3n, cin: 2n, height: far, magic, prevHash, payees: [], owedIn });
    assert.equal(empty.tx.t21.owed, undefined);
    assert.equal(BigInt(empty.tx.t21.back), drop.back);
    assert.equal(t21EconomicCarry(empty.tx), 5n + drop.back);
    const ex = expectFor(empty.tx, { shares: [], owedIn, hashBudget: 0n, height: far });
    assert.equal(verifyT21Coinbase({ tx: empty.tx, expect: ex }).ok, true);
    const dueH = H + T21_OWED_TTL - T21_SETTLE_WINDOW;
    const dueEmpty = buildT21Coinbase({ S: 3n, cin: 2n, height: dueH, magic, prevHash, payees: [], owedIn });
    assert.equal(verifyT21Coinbase({
      tx: dueEmpty.tx, expect: expectFor(dueEmpty.tx, { shares: [], owedIn, hashBudget: 0n, height: dueH }),
    }).reason, 'owed_due');
    const dueSettle = buildT21Coinbase({
      S: 3n, cin: 2n, height: dueH, magic, prevHash, dummySecret, payees: [], settle: owedIn, owedIn,
    });
    const dueOk = verifyT21Coinbase({
      tx: dueSettle.tx, expect: expectFor(dueSettle.tx, { shares: [], owedIn, hashBudget: 0n, height: dueH }),
    });
    assert.equal(dueOk.ok, true, dueOk.reason);
    assert.equal(dueOk.settleV, BigInt(owedIn[0].pot) + BigInt(owedIn[0].hash));
    assert.equal(dueSettle.tx.t21.owed, undefined);
    assert.throws(() => buildT21Coinbase({
      S: 3n, cin: 2n, u, height: far, magic, prevHash, dummySecret, producer,
      payees: paid, settle: owedIn, owedIn,
    }), (err) => err.reason === 'owed_list' || err.reason === 'owed_ttl');
  });

  it('one producer cannot publish T21_OWED_MAX + 1 rows', () => {
    const empty = buildT21Coinbase({ S: 3n, cin: 2n, height: 5, magic, prevHash, payees: [] });
    const by = Buffer.alloc(32, 3);
    const row = (i) => {
      const E = Buffer.alloc(32);
      E.writeUInt32BE(i + 1, 28);
      return {
        since: 1,
        by,
        B: Buffer.alloc(32, 2),
        Y: Buffer.alloc(32, 3),
        lambda: Buffer.alloc(32, 4),
        pot: '1',
        hash: '1',
        shares: [{ w: '1', E }],
      };
    };
    const owed = Array.from({ length: T21_OWED_MAX + 1 }, (_, i) => row(i));
    const tx = empty.tx;
    tx.t21.owed = owed;
    assert.equal(verifyT21Coinbase({
      tx, expect: expectFor(tx, { shares: [], owedIn: owed, hashBudget: 0n }),
    }).reason, 'owed_cap');
    const under = owed.slice(0, T21_OWED_MAX);
    tx.t21.owed = under;
    assert.notEqual(verifyT21Coinbase({
      tx, expect: expectFor(tx, { shares: [], owedIn: under, hashBudget: 0n }),
    }).reason, 'owed_cap');
  });

  it('a list past the global cap is owed_cap even when every producer is under quota', () => {
    const empty = buildT21Coinbase({ S: 3n, cin: 2n, height: 5, magic, prevHash, payees: [] });
    const row = (i) => {
      const E = Buffer.alloc(32);
      E.writeUInt32BE(i + 1, 28);
      const by = Buffer.alloc(32);
      by.writeUInt32BE(Math.floor(i / T21_OWED_MAX) + 1, 28);
      return {
        since: 1, by, B: Buffer.alloc(32, 2), Y: Buffer.alloc(32, 3), lambda: Buffer.alloc(32, 4),
        pot: '1', hash: '1', shares: [{ w: '1', E }],
      };
    };
    const tx = empty.tx;
    const under = Array.from({ length: T21_OWED_GLOBAL }, (_, i) => row(i));
    tx.t21.owed = under;
    assert.notEqual(verifyT21Coinbase({
      tx, expect: expectFor(tx, { shares: [], owedIn: under, hashBudget: 0n }),
    }).reason, 'owed_cap');
    const over = under.concat([row(T21_OWED_GLOBAL)]);
    tx.t21.owed = over;
    assert.equal(verifyT21Coinbase({
      tx, expect: expectFor(tx, { shares: [], owedIn: over, hashBudget: 0n }),
    }).reason, 'owed_cap');
  });
});

describe('T21 genesis gate', () => {
  it('lists the open items and does not cut genesis', async () => {
    const { V12_GENESIS_BLOCK_HASH } = await import('../node/src/chain.js');
    assert.equal(V12_GENESIS_BLOCK_HASH, '');
    const status = genesisGateStatus();
    assert.equal(status.requireAllCoinbases, false);
    assert.deepEqual(status.open, [1, 2, 4, 5, 6, 7, 10]);
    assert.equal(fs.existsSync(new URL('../specs/t21-coinbase.md', import.meta.url)), true);
  });
});

describe('T21 seeded prover', { timeout: 600_000 }, () => {
  const bytesOf = (tx) => JSON.stringify(tx, (k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data).toString('hex');
    if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
    return v;
  });

  it('one seed builds the same bytes, another seed does not', () => {
    const payees = [payee(0, [5n]), payee(1, [7n])];
    const spec = { S: 1_000_000n, cin: 0n, u: 1n, height: 4, magic, prevHash, payees, seed: Buffer.alloc(32, 7) };
    const a = buildT21Coinbase(spec);
    const b = buildT21Coinbase(spec);
    assert.equal(bytesOf(a.tx), bytesOf(b.tx));
    const c = buildT21Coinbase({ ...spec, seed: Buffer.alloc(32, 8) });
    assert.notEqual(bytesOf(a.tx), bytesOf(c.tx));
    const ok = verifyT21Coinbase({ tx: a.tx, expect: expectFor(a.tx) });
    assert.equal(ok.ok, true, ok.reason);
  });
});
