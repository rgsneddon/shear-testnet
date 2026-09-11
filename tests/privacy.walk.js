/**
 * Walk-the-walk Shear privacy. Drives shipped dest, compact, spend-sig,
 * memo, HRP, pool-ident, and RPC-bind paths. Amounts stay public.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  newIdentity,
  payoutDest,
  aliasDestOfSilentId,
  encodeDest,
  isDestAddress,
  isFullPaymentCode,
  isPaymentFingerprint,
  silentDestFromCode,
  silentPay,
  recognizeSilentDest,
  freshStealthDest,
  checkAddressField,
  checkTxAddressFields,
  ed25519SeedOf,
  stealthSpendPrivate,
  hash20FromAddress,
} from '../crypto/address.js';
import {
  hasherPayoutDest,
  destForLogin,
  memoSeal,
  memoOpen,
  explorerRowPublic,
  destAtIndex,
} from '../crypto/flow_sheet.js';
import { compactTx, compactChainBlock } from '../crypto/chronoflux.js';
import { signSpendTx, verifySpendSig, verifyFundedBody } from '../crypto/spend.js';
import { admitMempool, emptyMempool } from '../crypto/mempool.js';
import { levyNanos } from '../crypto/levy.js';
import { NANOS_PER_SHE, HASH_TX_LIVE, SPENDABLE_CONFIRMATIONS, consensusFingerprint } from '../crypto/asert.js';
import { sealShewallBin, openShewallBin, sealShewallBinPbkdf2, openAndResealShewallBin, shewallNeedsMigrate, packShewall, SHEWALL_ENC_KIND, SHEWALL_ENC_KIND_V1 } from '../crypto/shewall_bin.js';
import { RPC_HOST } from '../node/src/rpc.js';
import { admitClient, serializeMinerRow, publicMinerTag } from '../pool/src/pool.js';
import { writePoolIdent, readPoolIdent } from '../pool/src/pool_ident.js';
import { walletSubmitLog, newConnId, lineJoinsIpToIdentity } from '../crypto/privacy_net.js';
import { explorerRowPublic as _pub } from '../crypto/flow_sheet.js';

void _pub;

describe('privacy.walk', () => {
  it('1–6: published full payment code yields unlinkable stealth dests; fingerprint cannot pay', () => {
    const alice = newIdentity();
    assert.equal(isFullPaymentCode(alice.paymentCode), true);
    assert.equal(isPaymentFingerprint(alice.paymentFingerprint), true);
    assert.equal(payoutDest(alice.paymentCode), null);
    assert.notEqual(alice.paymentCode, alice.paymentFingerprint);

    const bobEph = generateKeyPairSync('x25519').privateKey;
    const bobPay = silentPay(alice.paymentCode, bobEph);
    assert.ok(bobPay);
    assert.equal(isDestAddress(bobPay.dest), true);
    assert.equal(bobPay.dest.startsWith('ssa1'), true);
    const alias = aliasDestOfSilentId(alice.paymentCode);
    assert.ok(alias);
    assert.notEqual(bobPay.dest, alias);
    assert.equal(payoutDest(alice.paymentFingerprint), null);
    assert.notEqual(bobPay.dest, aliasDestOfSilentId(alice.paymentFingerprint));

    const carolEph = generateKeyPairSync('x25519').privateKey;
    const carolPay = silentPay(alice.paymentCode, carolEph);
    assert.ok(carolPay);
    assert.notEqual(carolPay.dest, bobPay.dest);

    assert.equal(silentDestFromCode(alice.paymentFingerprint, bobEph), null);

    const recBob = recognizeSilentDest({
      viewKey: alice.viewKey,
      spendPub: alice.spendPub,
      dest: bobPay.dest,
      ephPub: bobPay.ephPub,
    });
    const recCarol = recognizeSilentDest({
      viewKey: alice.viewKey,
      spendPub: alice.spendPub,
      dest: carolPay.dest,
      ephPub: carolPay.ephPub,
    });
    assert.ok(recBob);
    assert.ok(recCarol);
    assert.equal(recBob.dest, bobPay.dest);
    assert.equal(recCarol.dest, carolPay.dest);

    const seed = ed25519SeedOf(alice.privateKey);
    const spendKey = stealthSpendPrivate(recBob.shared, seed);
    const nanos = NANOS_PER_SHE;
    const fee = levyNanos(nanos);
    const change = freshStealthDest(alice.paymentCode);
    assert.ok(change);
    assert.notEqual(change.dest, bobPay.dest);
    const tx = signSpendTx({
      kind: 'send',
      from: bobPay.dest,
      to: carolPay.dest,
      nanos,
      fee,
      vin: [{ address: bobPay.dest }],
      vout: [
        { address: carolPay.dest, nanos, kind: 'send' },
        { address: change.dest, nanos: NANOS_PER_SHE, kind: 'send' },
      ],
      ephPub: carolPay.ephPub.toString('hex'),
    }, spendKey);
    assert.equal(verifySpendSig(tx), true);
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    const funded = verifyFundedBody([tx], (addr) => (addr === bobPay.dest ? 3 * NANOS_PER_SHE : 0));
    assert.equal(funded.ok, true, funded.reason);
    assert.notEqual(change.dest, bobPay.dest);
    const foreign = generateKeyPairSync('ed25519');
    const stolen = signSpendTx({ ...tx, sig: undefined, spendPub: undefined }, foreign.privateKey);
    assert.equal(verifySpendSig(stolen), false);
  });

  it('7–8: sealed compact body drops openings and identity; spend sig still verifies', async () => {
    const alice = newIdentity();
    const eph = generateKeyPairSync('x25519').privateKey;
    const pay = silentPay(alice.paymentCode, eph);
    const rec = recognizeSilentDest({
      viewKey: alice.viewKey,
      spendPub: alice.spendPub,
      dest: pay.dest,
      ephPub: pay.ephPub,
    });
    const spendKey = stealthSpendPrivate(rec.shared, ed25519SeedOf(alice.privateKey));
    const nanos = NANOS_PER_SHE;
    const fee = levyNanos(nanos);
    const fat = signSpendTx({
      kind: 'send',
      from: pay.dest,
      to: pay.dest,
      nanos,
      fee,
      open: 'aa'.repeat(64),
      portalOpen: 'bb'.repeat(60),
      viewKey: alice.viewKey,
      C: 'cc'.repeat(32),
      scanPub: alice.scanPub.toString('hex'),
      spendHash20: hash20FromAddress(alice.address).toString('hex'),
      ip: '203.0.113.9',
      login: alice.paymentCode,
      memoPlain: 'secret',
      vin: [{ address: pay.dest, open: 'aa'.repeat(64) }],
      vout: [{ address: pay.dest, nanos, kind: 'send' }],
      ephPub: pay.ephPub.toString('hex'),
    }, spendKey);
    const sealed = compactTx(fat);
    const blob = JSON.stringify(sealed);
    assert.equal(sealed.open, undefined);
    assert.equal(sealed.portalOpen, undefined);
    assert.equal(sealed.viewKey, undefined);
    assert.equal(sealed.C, undefined);
    assert.equal(sealed.scanPub, undefined);
    assert.equal(sealed.spendHash20, undefined);
    assert.equal(sealed.ip, undefined);
    assert.equal(sealed.login, undefined);
    assert.equal(sealed.memoPlain, undefined);
    assert.equal(/she1|shear1/.test(blob.replace(/ssa1/gi, '')), false);
    assert.equal(/203\.0\.113\.9/.test(blob), false);
    assert.equal(verifySpendSig(sealed), true);
    assert.equal(destAtIndex(sealed.from, { index: 0 }), null);
    assert.equal(destAtIndex(sealed.from, { index: 0, viewKey: alice.viewKey }), null);
    const chain = compactChainBlock({
      height: 1,
      miner: pay.dest,
      txs: [compactTx({ coinbase: true, height: 1, vout: [{ address: pay.dest, nanos, kind: 'pot' }] }), sealed],
    });
    const chainBlob = JSON.stringify(chain);
    assert.equal(/"open"/.test(chainBlob), false);
    assert.equal(/portalOpen/.test(chainBlob), false);
    const { packEpochBlock, unpackEpochBlock } = await import('../crypto/chainbin.js');
    const packed = packEpochBlock({
      header: Buffer.alloc(128),
      hash: Buffer.alloc(32),
      height: 1,
      txs: [fat],
    });
    const unpacked = unpackEpochBlock(packed);
    const persisted = JSON.stringify(unpacked.txs);
    assert.equal(/"open"/.test(persisted), false);
    assert.equal(/portalOpen/.test(persisted), false);
    assert.equal(/viewKey/.test(persisted), false);
    const { encodeWireBlock } = await import('../node/src/p2p.js');
    const wire = JSON.stringify(encodeWireBlock({
      header: Buffer.alloc(128),
      hash: Buffer.alloc(32),
      height: 1,
      txs: [fat],
    }));
    assert.equal(/"open"/.test(wire), false);
    assert.equal(/viewKey/.test(wire), false);
  });

  it('9: memo opens only with stealth shared secret; public JSON is amounts+dests+memo boolean', () => {
    const alice = newIdentity();
    const bobEph = generateKeyPairSync('x25519').privateKey;
    const pay = silentPay(alice.paymentCode, bobEph);
    const rec = recognizeSilentDest({
      viewKey: alice.viewKey,
      spendPub: alice.spendPub,
      dest: pay.dest,
      ephPub: pay.ephPub,
    });
    const env = memoSeal(pay.dest, 'hello stealth', pay.shared);
    assert.equal(memoOpen(pay.dest, env, pay.shared), 'hello stealth');
    assert.equal(memoOpen(pay.dest, env, rec.shared), 'hello stealth');
    assert.equal(memoOpen(pay.dest, env), null);
    assert.equal(memoOpen(pay.dest, env, Buffer.alloc(32)), null);
    const pub = explorerRowPublic({
      id: 'x',
      from: pay.dest,
      to: pay.dest,
      amount: 1,
      height: 1,
      memoCt: env,
      memoPlain: 'hello stealth',
    });
    assert.equal(pub.memo, true);
    assert.equal(pub.to, pay.dest);
    assert.equal(pub.from, pay.dest);
    assert.equal(pub.amount, 1);
    assert.equal(pub.memoCt, undefined);
    assert.equal(pub.memoPlain, undefined);
  });

  it('10: stratum she1 is RAM-only; serialized miner row and pool-miner.json have no she1/IP/UA', () => {
    const alice = newIdentity();
    const owned = freshStealthDest(alice.paymentCode).dest;
    const sheOnly = admitClient({ login: alice.paymentCode, client: 'ShearHash' });
    assert.equal(sheOnly.payoutDest, '');
    assert.equal(sheOnly.ramAlias, true);
    const sheOwned = admitClient({ login: `${alice.paymentCode}.worker`, dest: owned, client: 'ShearHash' });
    assert.equal(sheOwned.payoutDest, owned);
    assert.equal(sheOwned.login.startsWith('ssa1'), true);
    assert.equal(hasherPayoutDest(alice.paymentCode, { dest: aliasDestOfSilentId(alice.paymentCode) }), null);
    assert.equal(hasherPayoutDest(owned), owned);
    const row = serializeMinerRow({
      login: alice.paymentCode,
      payoutDest: owned,
      hashrate: 12,
      ip: '198.51.100.4',
      userAgent: 'ShearK',
    });
    const rowJson = JSON.stringify(row);
    assert.equal(/she1|shear1/.test(rowJson), false);
    assert.equal(/198\.51\.100\.4/.test(rowJson), false);
    assert.equal(/ShearK|userAgent|user-agent/i.test(rowJson), false);
    assert.match(publicMinerTag(owned), /^m[0-9a-f]{8}$/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-'));
    const file = path.join(dir, 'pool-miner.json');
    writePoolIdent(file, { dest20: hash20FromAddress(owned) });
    const disk = fs.readFileSync(file, 'utf8');
    assert.equal(/she1|shear1|viewKey|paymentCode|"ip"|userAgent/.test(disk), false);
    const got = readPoolIdent(file);
    assert.equal(got.miner, owned);
  });

  it('11: typed HRP on every address field; she/shear are silent_id_on_chain / rest_frame_on_chain', () => {
    const alice = newIdentity();
    assert.equal(checkAddressField(alice.paymentCode).reason, 'silent_id_on_chain');
    assert.equal(checkAddressField(alice.paymentFingerprint).reason, 'silent_id_on_chain');
    assert.equal(checkAddressField(alice.address).reason, 'rest_frame_on_chain');
    const dest = freshStealthDest(alice.paymentCode).dest;
    assert.equal(checkAddressField(dest).ok, true);
    const sheTx = { kind: 'send', from: dest, to: alice.paymentCode, vin: [{ address: dest }], vout: [{ address: alice.paymentCode, nanos: 1 }] };
    assert.equal(checkTxAddressFields(sheTx).reason, 'silent_id_on_chain');
    const restTx = { kind: 'send', from: dest, to: alice.address, vin: [{ address: dest }], vout: [{ address: alice.address, nanos: 1 }] };
    assert.equal(checkTxAddressFields(restTx).reason, 'rest_frame_on_chain');
    const pool = emptyMempool();
    assert.equal(admitMempool(pool, sheTx).reason, 'silent_id_on_chain');
    assert.equal(HASH_TX_LIVE, 1);
    const fp = consensusFingerprint();
    assert.match(fp, /DEST_HRP_SSA_ONLY=1/);
    assert.match(fp, /SPEND_SIG_ONLY=1/);
    assert.match(fp, /MEMO_NOT_DEST_KEYED=1/);
  });

  it('12: RPC default bind is 127.0.0.1; submit log does not join IP to dest/login', () => {
    assert.equal(RPC_HOST, '127.0.0.1');
    const line = walletSubmitLog({ connId: newConnId(), ok: true });
    assert.equal(lineJoinsIpToIdentity(line), false);
    assert.equal(/127\.0\.0\.1|0\.0\.0\.0/.test(line), false);
    assert.equal(/she1|ssa1|login|dest/.test(line), false);
  });

  it('13: change is a fresh stealth dest of the sender, not parent and not dest index 0', () => {
    const alice = newIdentity();
    const parent = freshStealthDest(alice.paymentCode).dest;
    const changeA = freshStealthDest(alice.paymentCode).dest;
    const changeB = freshStealthDest(alice.paymentCode).dest;
    assert.notEqual(changeA, parent);
    assert.notEqual(changeB, parent);
    assert.notEqual(changeA, changeB);
    const idx0 = destAtIndex(alice.address, { index: 0, viewKey: alice.viewKey });
    assert.notEqual(changeA, idx0);
    assert.equal(hasherPayoutDest(alice.paymentCode), null);
    const mailbox = freshStealthDest(alice.paymentCode).dest;
    assert.equal(hasherPayoutDest(alice.paymentCode, { dest: mailbox }), mailbox);
  });

  it('shewall.bin is Argon2id; PBKDF2 envelopes re-seal; JSON refused', () => {
    const packed = packShewall({
      seed32: Buffer.alloc(32, 7),
      dest20: Buffer.alloc(20, 3),
    });
    const sealed = sealShewallBin(packed, 'correct-horse');
    assert.equal(Buffer.from(sealed).subarray(0, SHEWALL_ENC_KIND.length).toString(), SHEWALL_ENC_KIND);
    assert.equal(openShewallBin(sealed, 'correct-horse').equals(packed), true);
    const old = sealShewallBinPbkdf2(packed, 'correct-horse');
    assert.equal(shewallNeedsMigrate(old), true);
    assert.equal(Buffer.from(old).subarray(0, SHEWALL_ENC_KIND_V1.length).toString(), SHEWALL_ENC_KIND_V1);
    const migrated = openAndResealShewallBin(old, 'correct-horse');
    assert.equal(shewallNeedsMigrate(migrated), false);
    assert.equal(openShewallBin(migrated, 'correct-horse').equals(packed), true);
    assert.throws(() => openShewallBin(Buffer.from('{"wallet":true}'), 'x'), /json_refused/);
  });
});
