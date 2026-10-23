/**
 * Spreads and source locks for the public-receipt reject.
 * Kinds, amounts, portals, and wire forms. Each of block, mempool, and
 * funded-body must name public_receipt. Restoring a range exemption or the
 * empty-vault bootstrap fails the source lock.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDest } from '../../crypto/address.js';
import { MAGIC_TESTNET, PI_SHE_NANOS, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { publicReserveReceipt, publicReserveReceiptRejected } from '../../crypto/dummy.js';
import { levyNeed } from '../../crypto/levy.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { portalIdFromDest, emptyVault } from '../../crypto/reserve_vault.js';
import { verifyFundedBody } from '../../crypto/spend.js';
import { jsonWire } from '../src/p2p.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { buildTemplate } from '../src/chain.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { nativeLoaded } from '../../crypto/native_admit.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

try { setHashBackend('jit'); } catch { /* interpreter still hashes */ }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PI = PI_SHE_NANOS;
const FACTORS = [PI - 1, PI, 2 * PI, 7 * PI, 31 * PI];
const MAX_TRIES = 8_192;

after(() => closeMineWorkers());

function byte20(fill) {
  return Buffer.alloc(20, fill);
}

function payLevy(tx) {
  if (tx.kind === 'withdraw') return tx;
  for (let i = 0; i < 8; i += 1) {
    const need = levyNeed(tx);
    if (tx.fee === need) return tx;
    tx.fee = need;
  }
  tx.fee = levyNeed(tx);
  return tx;
}

function receipt({ kind, amount, portal = 1, vin }) {
  const portal20 = byte20(portal);
  const payer20 = byte20(0xA0 + portal);
  const tx = {
    id: `${kind}-p${portal}-${amount}`,
    kind,
    programId: RESERVE_PROGRAM,
    portalId: portalIdFromDest(encodeDest(portal20)),
    payoutPortalId: portalIdFromDest(encodeDest(payer20)),
    fee: 1,
    vin: vin || [{ dest20: Buffer.from(payer20) }],
    vout: [{
      kind,
      dest20: Buffer.from(portal20),
      valueProof: { v: amount },
    }],
  };
  return payLevy(tx);
}

function reasonOf(got) {
  return got?.ok === true ? '' : String(got?.reason || '');
}

describe('public receipt spread', () => {
  it('rejects every kind, amount, and portal on mempool and funded body', () => {
    const vault = emptyVault(MAGIC_TESTNET);
    vault.genesisMs = 1_700_000_000_000;
    for (const kind of ['lock', 'vote', 'withdraw']) {
      for (const portal of [1, 2, 3]) {
        for (const amount of FACTORS) {
          const tx = receipt({ kind, amount, portal });
          const label = `${kind} portal ${portal} ${amount}`;
          assert.equal(publicReserveReceipt(tx), true, label);
          assert.equal(publicReserveReceiptRejected(tx).reason, 'public_receipt', label);
          assert.equal(reasonOf(admitMempool(emptyMempool(), tx, {
            reserveState: vault,
            nowMs: vault.genesisMs,
            height: 2,
          })), 'public_receipt', label);
          assert.equal(reasonOf(verifyFundedBody([tx], () => 0, { reserveState: vault })), 'public_receipt', label);
        }
      }
    }
  });

  it('refuses $hex, address vin, and mixed vin, and $hex is not the only refusal', () => {
    const pure = receipt({ kind: 'lock', amount: PI });
    assert.equal(publicReserveReceiptRejected(pure).reason, 'public_receipt');
    const hexTx = JSON.parse(jsonWire({ tx: pure })).tx;
    assert.equal(publicReserveReceipt(hexTx), false);
    assert.equal(publicReserveReceiptRejected(hexTx), null);
    const hexFund = verifyFundedBody([hexTx], () => 0, { reserveState: emptyVault(MAGIC_TESTNET) });
    assert.equal(hexFund.ok, false);
    assert.notEqual(hexFund.reason, 'public_receipt');
    const addressed = receipt({
      kind: 'vote',
      amount: 2 * PI,
      vin: [{ dest20: byte20(0xA1), address: encodeDest(byte20(0xA1)) }],
    });
    assert.equal(publicReserveReceipt(addressed), false);
    assert.equal(verifyFundedBody([addressed], () => 0).ok, false);
    const mixed = receipt({
      kind: 'withdraw',
      amount: 7 * PI,
      vin: [
        { dest20: byte20(0xA1) },
        { dest20: byte20(0xA2), address: encodeDest(byte20(0xA2)) },
      ],
    });
    assert.equal(publicReserveReceipt(mixed), false);
    assert.equal(verifyFundedBody([mixed], () => 0).ok, false);
    assert.equal(admitMempool(emptyMempool(), hexTx, { height: 2 }).ok, false);
    assert.equal(admitMempool(emptyMempool(), addressed, { height: 2 }).ok, false);
    assert.equal(admitMempool(emptyMempool(), mixed, { height: 2 }).ok, false);
  });

  it('a refused side branch does not mint, and the next canonical block stays at principal 0', { timeout: 120_000 }, async () => {
    assert.equal(nativeLoaded(), true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-receipt-spread-'));
    const store = createRegtestStore(dir, { bits: 4 });
    const miner = encodeDest(byte20(9));
    const bits = regtestBitsOverride(MAGIC_REGTEST);
    let now = 1_700_000_000_000;
    async function append(txs) {
      const tip = store.tip();
      const built = buildTemplate({
        prev: tip ? tip.hash : undefined,
        prevHeader: tip ? tip.header : null,
        prevBlock: tip,
        height: tip ? tip.height + 1 : 1,
        miner,
        now,
        bits,
        txs,
        parentBlocks: store.blocks,
        parentFluxset: store.fluxset().pubs,
        hashBonusNanos: Number(store.reserveVault.liveHashBonusNanos || 1),
      });
      const found = await mineHeaderParallel(built.header, built.bits, MAX_TRIES, os.cpus().length);
      assert.ok(found && found.block);
      const got = await Promise.resolve(store.append({
        header: found.header,
        txs: built.txs,
        samples: built.samples,
        shareBatch: built.shareBatch || [],
        miner,
        aLeaves: built.aLeaves,
        bLeaves: built.bLeaves,
        rootA: built.rootA,
        rootB: built.rootB,
        weight: built.weight,
      }));
      now += 90_000;
      return got;
    }
    assert.equal((await append([])).ok, true);
    const tipHash = Buffer.from(store.tip().hash);
    for (const kind of ['vote', 'withdraw', 'lock']) {
      const got = await append([receipt({ kind, amount: 31 * PI, portal: 3 })]);
      assert.equal(got.ok, false, kind);
      assert.equal(got.reason, 'public_receipt', kind);
      assert.ok(Buffer.from(store.tip().hash).equals(tipHash), kind);
    }
    assert.equal((await append([])).ok, true);
    assert.equal(store.tip().height, 2);
    let principal = 0n;
    for (const p of Object.values(store.reserveVault.portals || {})) {
      principal += BigInt(p?.staked || 0) + BigInt(p?.idle || 0);
    }
    assert.equal(principal, 0n);
    const audit = auditCirculatingSupply(store.blocks, { magic: store.magic });
    assert.equal(audit.status, 'verified', audit.reason);
    assert.equal(audit.differenceNanos, 0);
    const reloaded = createRegtestStore(dir, { bits: 4 });
    assert.equal(reloaded.loadMode, 'snap');
    assert.equal(reloaded.tip().height, 2);
    let again = 0n;
    for (const p of Object.values(reloaded.reserveVault.portals || {})) {
      again += BigInt(p?.staked || 0) + BigInt(p?.idle || 0);
    }
    assert.equal(again, 0n);
  });
});

describe('public receipt mutation locks', () => {
  const chain = fs.readFileSync(path.join(ROOT, 'node/src/chain.js'), 'utf8');
  const mempool = fs.readFileSync(path.join(ROOT, 'crypto/mempool.js'), 'utf8');
  const spend = fs.readFileSync(path.join(ROOT, 'crypto/spend.js'), 'utf8');
  const admit = fs.readFileSync(path.join(ROOT, 'crypto/admit_v3.js'), 'utf8');
  const store = fs.readFileSync(path.join(ROOT, 'node/src/store.js'), 'utf8');

  it('block, mempool, funded body, and queue each call the shared predicate', () => {
    assert.match(chain, /publicReserveReceiptRejected\(tx\)/);
    assert.match(mempool, /publicReserveReceiptRejected\(tx\)/);
    assert.match(spend, /publicReserveReceiptRejected\(tx\)/);
    assert.match(store, /publicReserveReceiptRejected\(tx\)/);
  });

  it('the range exemption and the empty-vault bootstrap stay deleted', () => {
    assert.doesNotMatch(chain, /!publicReserveReceipt/);
    assert.doesNotMatch(mempool, /!publicReserveReceipt/);
    assert.doesNotMatch(chain, /publicReserveReceipt\(tx\)/);
    assert.doesNotMatch(chain, /emptyVault\(\) : null/);
    assert.doesNotMatch(admit, /publicReserveReceipt/);
    assert.doesNotMatch(spend, /if \(publicReserveReceipt\(tx\)\) return \{ ok: true/);
  });
});
