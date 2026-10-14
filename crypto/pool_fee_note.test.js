import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAddressField,
  checkTxAddressFields,
  decodeBech32Payload,
  encodeDest,
  isPayableDest,
} from './address.js';
import { poolFeeDest, reserveFeeDest, unclaimedFinderDest } from './levy.js';
import { admitBasePub } from './admit.js';
import { pointBytes, randomScalar, wrapBlind } from './note.js';
import { coinbaseTx } from '../node/src/chain.js';

const AMOUNTS = [0n, 1n, 2n, 9n, 1000n, (1n << 53n) - 1n, (1n << 53n) + 3n, (1n << 64n) - 1n];
const OTHER_KINDS = [
  'pot', 'hash', 'finder-fee', 'reserve-fee', 'custody', 'send',
  'lock', 'vote', 'withdraw', 'vortice-register', 'evm-value',
];
const TAGS = [0, 1, 7, 19, 255];
const SEEDS = [1, 9, 40, 200];

function longDest(tag, seedByte) {
  const dest20 = Buffer.alloc(20, tag);
  const seed = Buffer.alloc(32, seedByte);
  seed[0] = tag;
  const base = pointBytes(admitBasePub(seed));
  return {
    address: encodeDest(dest20, base),
    dest20,
    wrap: wrapBlind(randomScalar(), base, Buffer.alloc(0)),
  };
}

function row(kind, extra, nanos) {
  return { kind, nanos, ...extra };
}

function coinbase(vout) {
  return { vout };
}

function reject(tx, label) {
  for (const coinbaseFlag of [false, true]) {
    const got = checkTxAddressFields(tx, { coinbase: coinbaseFlag });
    assert.equal(got.ok, false, `${label} coinbase=${coinbaseFlag}`);
    assert.equal(got.reason, 'pool_fee_dest', `${label} coinbase=${coinbaseFlag}`);
  }
}

function accept(tx, label) {
  for (const coinbaseFlag of [false, true]) {
    const got = checkTxAddressFields(tx, { coinbase: coinbaseFlag });
    assert.equal(got.ok, true, `${label} coinbase=${coinbaseFlag} ${got.reason || ''}`);
  }
}

describe('pool fee dest versus the fee note', () => {
  it('allows the canonical sink or a wrapped payable dest on pool-fee only, for any amount', () => {
    const sink = poolFeeDest();
    const sink20 = decodeBech32Payload(sink);
    assert.equal(sink20.length, 20);
    assert.equal(isPayableDest(sink), false);
    assert.equal(checkAddressField(sink).ok, true);
    assert.equal(checkAddressField(reserveFeeDest()).ok, true);
    assert.equal(checkAddressField(unclaimedFinderDest()).ok, true);

    const payables = [];
    for (const tag of TAGS) {
      for (const seedByte of SEEDS) payables.push(longDest(tag, seedByte));
      const short = encodeDest(Buffer.alloc(20, tag));
      assert.equal(isPayableDest(short), false);
      assert.equal(checkAddressField(short).ok, true);
    }
    const badB = encodeDest(Buffer.alloc(20, 3), Buffer.alloc(32, 1));
    assert.equal(isPayableDest(badB), false);

    for (const nanos of AMOUNTS) {
      accept(coinbase([row('pool-fee', { address: sink }, nanos)]), `sink address ${nanos}`);
      accept(coinbase([row('pool-fee', { dest20: Buffer.from(sink20) }, nanos)]), `sink dest20 ${nanos}`);
      accept({ kind: 'pool-fee', to: sink, nanos }, `sink to ${nanos}`);

      for (const pay of payables) {
        accept(coinbase([row('pool-fee', {
          address: pay.address,
          dest20: pay.dest20,
          rEph: pay.wrap.rEph,
          rCt: pay.wrap.rCt,
        }, nanos)]), `payable ${nanos}`);
        accept(coinbase([row('pool-fee', {
          dest20: pay.dest20,
          rEph: pay.wrap.rEph,
          rCt: pay.wrap.rCt,
        }, nanos)]), `payable compact ${nanos}`);
        reject(coinbase([row('pool-fee', { address: pay.address, dest20: pay.dest20 }, nanos)]), `payable bare ${nanos}`);
        reject(coinbase([row('pool-fee', {
          address: pay.address,
          dest20: Buffer.from(sink20),
          rEph: pay.wrap.rEph,
          rCt: pay.wrap.rCt,
        }, nanos)]), `payable mismatched ${nanos}`);
      }

      for (const kind of OTHER_KINDS) {
        reject(coinbase([row(kind, { address: sink }, nanos)]), `${kind} address ${nanos}`);
        reject(coinbase([row(kind, { dest20: Buffer.from(sink20) }, nanos)]), `${kind} dest20 ${nanos}`);
        reject({ kind, to: sink, nanos }, `${kind} to ${nanos}`);
        accept(coinbase([row(kind, { address: reserveFeeDest() }, nanos)]), `${kind} reserve ${nanos}`);
        accept(coinbase([row(kind, { address: unclaimedFinderDest() }, nanos)]), `${kind} unclaimed ${nanos}`);
        accept(coinbase([row(kind, { address: payables[0].address }, nanos)]), `${kind} payable ${nanos}`);
        accept(coinbase([row(kind, { address: encodeDest(Buffer.alloc(20, 4)) }, nanos)]), `${kind} short miner ${nanos}`);
      }

      reject(coinbase([row('pool-fee', { address: reserveFeeDest() }, nanos)]), `fee reserve ${nanos}`);
      reject(coinbase([row('pool-fee', { address: unclaimedFinderDest() }, nanos)]), `fee unclaimed ${nanos}`);
      reject(coinbase([row('pool-fee', { address: badB }, nanos)]), `fee bad B ${nanos}`);
      for (const tag of TAGS) {
        reject(coinbase([row('pool-fee', { address: encodeDest(Buffer.alloc(20, tag)) }, nanos)]), `fee short ${tag} ${nanos}`);
        reject(coinbase([row('pool-fee', { dest20: Buffer.alloc(20, tag) }, nanos)]), `fee dest20 ${tag} ${nanos}`);
      }
      const trailed = Buffer.alloc(33, 2);
      reject(coinbase([row('pool-fee', {
        dest20: payables[0].dest20,
        rEph: trailed,
        rCt: payables[0].wrap.rCt,
      }, nanos)]), `trailing rEph ${nanos}`);
      reject(coinbase([row('pool-fee', {
        dest20: payables[1].dest20,
        rEph: Buffer.alloc(32, 1),
        rCt: payables[1].wrap.rCt,
      }, nanos)]), `noncanonical rEph ${nanos}`);
    }
  });

  it('accepts builder notes for the sink fee and a payable pot, and rejects a pot paid to the sink', () => {
    const sink = poolFeeDest();
    const built = [1, 1000, (2 ** 20) + 3];
    for (const tag of [1, 19, 255]) {
      const seed = Buffer.alloc(32, tag + 3);
      const miner = encodeDest(Buffer.alloc(20, tag), pointBytes(admitBasePub(seed)));
      assert.equal(isPayableDest(miner), true);
      for (const nanos of built) {
        const fee = Math.max(1, Math.floor(nanos / 50));
        const okTx = coinbaseTx({
          height: 2,
          miner,
          potShares: [
            { address: miner, nanos, kind: 'pot' },
            { address: sink, nanos: fee, kind: 'pool-fee' },
          ],
        });
        accept({ vout: okTx.vout }, `built ${tag} ${nanos}`);
        const badTx = coinbaseTx({
          height: 2,
          miner,
          potShares: [{ address: sink, nanos, kind: 'pot' }],
        });
        reject({ vout: badTx.vout }, `built pot sink ${tag} ${nanos}`);
      }
    }
  });
});
