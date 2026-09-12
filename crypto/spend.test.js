import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NANOS_PER_SHE, SPENDABLE_CONFIRMATIONS } from './asert.js';
import { levyNanos } from './levy.js';
import { fundedDebit, matureSpendableNanos, mempoolDebitNanos, verifyFundedBody, verifyDestOpening, flowSendNeedsOpen, indexedDestOpening, signSpendTx, verifySpendSig } from './spend.js';
import { newIdentity, destOpeningFromView, hash20FromAddress, silentPay, ed25519SeedOf, stealthSpendPrivate, recognizeSilentDest, ed25519PrivateFromSeed, ed25519RawPub, encodeDest } from './address.js';
import { destCommitFromSpendPub } from './stealth_ed25519.js';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { destAtIndex, closureCommit } from './flow_sheet.js';

const dest = 'ssa1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const other = 'ssa1qyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';

describe('funded spend / no double-spend', () => {
  it('debits amount plus levy from the sender', () => {
    const nanos = 4 * NANOS_PER_SHE;
    const fee = levyNanos(nanos);
    const d = fundedDebit({
      kind: 'send',
      from: dest,
      to: other,
      nanos,
      fee,
      vin: [{ address: dest }],
      vout: [{ address: other, nanos }],
    });
    assert.equal(d.from, dest);
    assert.equal(d.nanos, nanos + fee);
  });

  it('fundedDebit includes change vout so leftover leaves from', () => {
    const pay = 2 * NANOS_PER_SHE;
    const leftover = 3 * NANOS_PER_SHE;
    const fee = levyNanos(pay);
    const change = 'ssa1qzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    const d = fundedDebit({
      kind: 'send',
      from: dest,
      to: other,
      nanos: pay,
      fee,
      vin: [{ address: dest }],
      vout: [
        { address: other, nanos: pay, kind: 'send' },
        { address: change, nanos: leftover, kind: 'send' },
      ],
    });
    assert.equal(d.from, dest);
    assert.equal(d.amount, pay);
    assert.equal(d.change, leftover);
    assert.equal(d.nanos, pay + leftover + fee);
  });

  it('credits incoming only after 6 confs and always subtracts a sealed send', () => {
    const rows = [
      { from: 'coinbase', to: dest, nanos: 10 * NANOS_PER_SHE, height: 1, kind: 'coinbase' },
      { from: dest, to: other, nanos: 3 * NANOS_PER_SHE, height: 10, kind: 'send' },
    ];
    const coinbase = rows[0];
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
    assert.equal(matureSpendableNanos([coinbase], dest, 5, SPENDABLE_CONFIRMATIONS), 0);
    assert.equal(matureSpendableNanos([coinbase], dest, 6, SPENDABLE_CONFIRMATIONS), 10 * NANOS_PER_SHE);
    assert.equal(matureSpendableNanos(rows, dest, 10, SPENDABLE_CONFIRMATIONS), 7 * NANOS_PER_SHE);
  });

  it('rejects two spends of the same mature coins in one body', () => {
    const id = newIdentity();
    const { privateKey: eph } = generateKeyPairSync('x25519');
    const pay = silentPay(id.paymentCode, eph);
    const from = pay.dest;
    const to = from;
    const nanos = NANOS_PER_SHE;
    const fee = levyNanos(nanos);
    const spendableOf = (addr) => (addr === from ? 2 * NANOS_PER_SHE : 0);
    const rec = recognizeSilentDest({
      viewKey: id.viewKey, spendPub: id.spendPub, dest: from, ephPub: pay.ephPub,
    });
    const key = stealthSpendPrivate(rec.shared, ed25519SeedOf(id.privateKey));
    const tx = (txid, amount) => signSpendTx({
      id: txid,
      kind: 'send',
      from,
      to,
      nanos: amount,
      fee,
      vin: [{ address: from }],
      vout: [{ address: to, nanos: amount }],
    }, key);
    const once = verifyFundedBody([tx('a', nanos)], spendableOf);
    assert.equal(once.ok, true, once.reason);
    const twice = verifyFundedBody([tx('a', nanos), tx('b', nanos)], spendableOf);
    assert.equal(twice.ok, false);
    assert.equal(twice.reason, 'replay');
    const over = verifyFundedBody([tx('a', nanos), tx('b', nanos + NANOS_PER_SHE)], spendableOf);
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'insufficient');
  });

  it('mempool already-queued debit blocks a second pull of the same coins', () => {
    const nanos = NANOS_PER_SHE;
    const fee = levyNanos(nanos);
    const queued = [{
      kind: 'send', from: dest, to: other, nanos, fee,
      vin: [{ address: dest }],
    }];
    assert.equal(mempoolDebitNanos(queued, dest), nanos + fee);
    assert.equal(mempoolDebitNanos(queued, other), 0);
  });

  it('mints and coinbase are not funded debits', () => {
    assert.equal(fundedDebit({ coinbase: true, vout: [{ nanos: NANOS_PER_SHE }] }), null);
    assert.equal(fundedDebit({ mint: true, kind: 'reserve', nanos: 1 }), null);
  });

  it('spend sig is required for Flow send; opening is not authority', () => {
    const id = newIdentity();
    const { privateKey: eph } = generateKeyPairSync('x25519');
    const pay = silentPay(id.paymentCode, eph);
    const from = pay.dest;
    const spendH = hash20FromAddress(id.address);
    const open = destOpeningFromView(id.viewKey, id.spendPub, 0);
    assert.equal(verifyDestOpening(from, open), false);
    const tx = {
      kind: 'send', from, to: from, nanos: 1, fee: 100,
      vin: [{ address: from }],
    };
    assert.equal(flowSendNeedsOpen(tx), true);
    assert.equal(flowSendNeedsOpen({ kind: 'pool-withdraw', from, vin: [{ address: from }], nanos: 1, fee: 100 }), false);

    const rec = recognizeSilentDest({
      viewKey: id.viewKey, spendPub: id.spendPub, dest: from, ephPub: pay.ephPub,
    });
    const key = stealthSpendPrivate(rec.shared, ed25519SeedOf(id.privateKey));
    const signed = signSpendTx({ ...tx, vout: [{ address: from, nanos: 1 }] }, key);
    assert.equal(verifySpendSig(signed), true);
    const foreign = generateKeyPairSync('ed25519');
    const stolen = signSpendTx({ ...signed, sig: undefined, spendPub: undefined }, foreign.privateKey);
    assert.equal(verifySpendSig(stolen), false);

    const heightDest = destAtIndex(id.address, { index: 0, viewKey: id.viewKey });
    const idxOpen = indexedDestOpening(spendH, closureCommit(id.viewKey), 0);
    assert.equal(verifyDestOpening(heightDest, idxOpen), true);
  });

  it('RFC 8032 seed pub and sig verify the same way as node verifySpendSig', () => {
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
    const key = ed25519PrivateFromSeed(seed);
    const pub = ed25519RawPub(key);
    assert.equal(pub.toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const rfcSig = Buffer.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex');
    const nodePub = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]),
      format: 'der',
      type: 'spki',
    });
    assert.equal(verify(null, Buffer.alloc(0), nodePub, rfcSig), true);
    const from = encodeDest(destCommitFromSpendPub(pub));
    const tx = {
      kind: 'send',
      from,
      vin: [{ prev: Buffer.alloc(32), index: 0 }],
      vout: [{ address: from, nanos: 1, kind: 'send' }],
    };
    signSpendTx(tx, key);
    assert.equal(verifySpendSig(tx), true);
  });
});
