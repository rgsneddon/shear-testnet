/**
 * Full-node probe for a public reserve receipt.
 *
 * Shape (crypto/dummy.js publicReserveReceipt): lock, dest20-only vin, opened
 * valueProof.v, no commitment, no range proof, no owner signature, no funding
 * note. Amounts are {<pi, 1, 2, 7, 31} * PI_SHE_NANOS across 3 portals.
 *
 * Block, mempool, and funded-body checks share publicReserveReceiptRejected.
 * A mined regtest block of these receipts must fail full validation, and a
 * supply audit of that body must be a mismatch. It does not withdraw.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { PI_SHE_NANOS, RESERVE_PROGRAM, hashBonusUnitNanos } from '../../crypto/asert.js';
import { publicReserveReceipt, publicReserveReceiptRejected, moneyNeedsRange } from '../../crypto/dummy.js';
import { levyNeed } from '../../crypto/levy.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import {
  portalIdFromDest,
  publicVaultView,
  cloneVault,
  trialReserveApply,
} from '../../crypto/reserve_vault.js';
import {
  fundedDebit,
  reserveAuth,
  typedCommitSum,
  verifyFundedBody,
} from '../../crypto/spend.js';
import { typedKindNeedsAdmitV3 } from '../../crypto/admit_v3.js';
import { jsonWire } from '../src/p2p.js';
import { createP2p, fingerprintHelloHash } from '../src/p2p.js';
import { createRpc } from '../src/rpc.js';
import { auditCirculatingSupply } from '../src/supply.js';
import { decodeHeader } from '../../crypto/header.js';
import { buildTemplate, verifyBlock } from '../src/chain.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { nativeLoaded } from '../../crypto/native_admit.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';

try { setHashBackend('jit'); } catch { /* interpreter still hashes */ }

const MAX_TRIES = 8_192;
const T0 = 1_700_000_000_000;
const PI = PI_SHE_NANOS;

after(() => closeMineWorkers());

function byte20(fill) {
  return Buffer.alloc(20, fill);
}

function payLevy(tx) {
  for (let i = 0; i < 8; i += 1) {
    const need = levyNeed(tx);
    if (tx.fee === need) return need;
    tx.fee = need;
  }
  tx.fee = levyNeed(tx);
  return tx.fee;
}

/** Lock receipt the public-reserve predicate recognises. No sig, no commit, no proof. */
function publicLock({ id, amount, portal20, payer20, fee = 0 }) {
  const portalDest = encodeDest(portal20);
  const tx = {
    id,
    kind: 'lock',
    programId: RESERVE_PROGRAM,
    // payoutPortalId on a lock is vote_leak (cb733226) and would hide the
    // public_receipt reason this suite pins. The payer stays the vin dest20.
    portalId: portalIdFromDest(portalDest),
    fee,
    vin: [{ dest20: Buffer.from(payer20) }],
    vout: [{
      kind: 'lock',
      dest20: Buffer.from(portal20),
      valueProof: { v: amount },
    }],
  };
  if (fee > 0) payLevy(tx);
  return tx;
}

function amountMatrix() {
  const factors = [
    ['lt-pi', PI - 1],
    ['1pi', PI],
    ['2pi', 2 * PI],
    ['7pi', 7 * PI],
    ['31pi', 31 * PI],
  ];
  const rows = [];
  for (let portal = 1; portal <= 3; portal += 1) {
    for (const [label, amount] of factors) {
      rows.push(publicLock({
        id: `lock-p${portal}-${label}`,
        amount,
        portal20: byte20(portal),
        payer20: byte20(0xA0 + portal),
        fee: 1,
      }));
    }
  }
  return rows;
}

function asArrayTx(tx) {
  return JSON.parse(JSON.stringify(tx, (_k, v) => (Buffer.isBuffer(v) ? [...v] : v)));
}

function verdict(got) {
  if (!got || typeof got !== 'object') return { ok: false, reason: 'no_result' };
  if (got.ok === true) return { ok: true, reason: '' };
  const reason = String(got.reason || got.error || 'reject');
  const error = got.error == null ? '' : String(got.error);
  return error && error !== reason ? { ok: false, reason, error } : { ok: false, reason };
}

function vaultSnap(store) {
  const portals = [];
  let principal = 0n;
  for (const [id, p] of Object.entries(store.reserveVault?.portals || {})) {
    const staked = BigInt(p?.staked || 0);
    const idle = BigInt(p?.idle || 0);
    principal += staked + idle;
    if (staked !== 0n || idle !== 0n) {
      portals.push({
        id,
        staked: staked.toString(),
        idle: idle.toString(),
        owner: String(p.ownerPub || ''),
      });
    }
  }
  const view = publicVaultView(store.reserveVault, 0);
  const supply = typeof store.supplyState === 'function' ? store.supplyState() : null;
  return {
    height: Number(store.tip()?.height || 0),
    principal: principal.toString(),
    totalLocked: String(view.totalLockedNanos ?? 0),
    totalStaked: String(view.totalStakedNanos ?? 0),
    totalIdle: String(view.totalIdleNanos ?? 0),
    portals,
    mintedInterest: supply ? String(supply.mintedInterest) : null,
    mintedPot: supply ? String(supply.mintedPot) : null,
  };
}

function supplyAudit(store) {
  const audit = auditCirculatingSupply(store.blocks, { magic: store.magic });
  return {
    status: audit.status,
    reason: audit.reason || '',
    circulatingNanos: audit.circulatingNanos,
    extraMintNanos: audit.extraMintNanos,
    differenceNanos: audit.differenceNanos,
  };
}

function rpcCall(port, method, params) {
  const body = JSON.stringify({ method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function p2pTx(port, magic, tx) {
  const line = `${JSON.stringify({ type: 'tx', magic, tx })}\n`;
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write(`${JSON.stringify({ type: 'hello', magic, fingerprint: fingerprintHelloHash(magic) })}\n${line}`);
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, 30);
    });
    sock.on('error', reject);
  });
}

async function mineAppend(store, miner, txs, now) {
  const tip = store.tip();
  const bits = regtestBitsOverride(MAGIC_REGTEST);
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
    hashBonusNanos: hashBonusUnitNanos(store.reserveVault.liveHashBonusNanos),
  });
  assert.equal(built.bits, bits, 'regtest template bits');
  assert.equal(decodeHeader(built.header).bits, bits);
  const found = await mineHeaderParallel(built.header, built.bits, MAX_TRIES, os.cpus().length);
  assert.ok(found && found.block, 'regtest PoW');
  const appended = await Promise.resolve(store.append({
    header: found.header,
    txs: built.txs,
    shareBatch: built.shareBatch || [],
    aLeaves: built.aLeaves,
    bLeaves: built.bLeaves,
    rootA: built.rootA,
    rootB: built.rootB,
    weight: built.weight,
  }));
  return { built, found, appended: verdict(appended), raw: appended };
}

function dropLoadCache(dir) {
  for (const name of ['book.seal', 'book.snap', 'vault.snap']) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
}

describe('P0 public reserve receipt', () => {
  it('unfunded public lock is rejected and does not mint vault stake', { timeout: 180_000 }, async () => {
    assert.equal(nativeLoaded(), true, 'shearadmit.node must be loaded for full validation');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p0-reserve-'));
    const miner = encodeDest(byte20(9));
    const store = createRegtestStore(dir, { bits: 4 });
    assert.equal(store.magic, MAGIC_REGTEST);
    // queueTx returns the trial vault, whose bigint fields RPC cannot encode.
    // Drop that return field after admission so the RPC response can be read.
    // Admission itself is unchanged.
    const queueTx = store.queueTx.bind(store);
    store.queueTx = (tx, opts) => {
      const got = queueTx(tx, opts);
      if (got && typeof got === 'object' && got.vaultState) {
        got.vaultPrincipal = vaultPrincipal(got.vaultState);
        delete got.vaultState;
      }
      return got;
    };
    const p2p = createP2p({
      store,
      port: 0,
      host: '127.0.0.1',
      magic: store.magic,
    });
    const rpc = createRpc({ store, p2p, port: 0, host: '127.0.0.1' });
    const rpcFaults = [];
    const onReject = (err) => {
      rpcFaults.push(String(err?.message || err));
    };
    process.on('unhandledRejection', onReject);
    const p2pBound = await p2p.listen();
    const rpcBound = await rpc.listen();
    assert.equal(p2pBound.host, '127.0.0.1');
    assert.equal(rpcBound.host, '127.0.0.1');
    assert.notEqual(p2pBound.port, 30303);
    assert.notEqual(rpcBound.port, 18332);
    const report = {
      head: process.env.SHEAR_PROBE_HEAD || 'ba3db91b',
      datadir: dir,
      rpc: rpcBound.port,
      p2p: p2pBound.port,
      seeds: [],
    };
    try {
      let now = T0;
      for (let i = 0; i < 3; i += 1) {
        const mined = await mineAppend(store, miner, [], now);
        assert.equal(mined.appended.ok, true, mined.appended.reason || 'empty block');
        now += 90_000;
      }
      const before = vaultSnap(store);
      const beforeAudit = supplyAudit(store);
      assert.equal(before.principal, '0');
      assert.equal(before.height, 3);
      report.before = before;
      report.beforeAudit = beforeAudit;
      const parentVault = cloneVault(store.reserveVault);
      const parentSupply = store.supplyState();

      const matrix = amountMatrix();
      assert.equal(matrix.length, 15);
      const sample = matrix[0];
      assert.equal(publicReserveReceipt(sample), true);
      assert.equal(publicReserveReceiptRejected(sample).reason, 'public_receipt');
      assert.equal(sample.sig, undefined);
      assert.equal(sample.spendPub, undefined);
      assert.equal(sample.vout[0].commit, undefined);
      assert.equal(sample.vout[0].rangeProof, undefined);
      assert.equal(typedKindNeedsAdmitV3(sample), true);
      assert.equal(typedCommitSum(sample).reason, 'commit_sum');
      assert.equal(reserveAuth(sample, store.reserveVault).reason, 'unsigned');
      assert.equal(fundedDebit(sample), null);
      assert.equal(moneyNeedsRange(sample), true);
      const body = verifyFundedBody(matrix, () => 0, { reserveState: store.reserveVault });
      report.verifyFundedBody = verdict(body);
      const trial = trialReserveApply({
        state: cloneVault(store.reserveVault),
        txs: matrix,
        nowMs: now,
        genesisMs: Number(store.reserveVault.genesisMs) || T0,
      });
      report.vaultTrial = {
        ok: trial.ok === true,
        reason: trial.ok ? '' : String(trial.reason || ''),
        principal: trial.ok ? vaultPrincipal(trial.state) : null,
      };

      const zero = publicLock({
        id: 'lock-zero-fee',
        amount: PI,
        portal20: byte20(4),
        payer20: byte20(0xB4),
        fee: 0,
      });
      assert.equal(publicReserveReceipt(zero), true);
      const rpcZero = await rpcCall(rpcBound.port, 'queueTx', asArrayTx(zero));
      report.rpcZeroFee = { status: rpcZero.status, ...verdict(rpcZero.body) };

      const levyOne = publicLock({
        id: 'lock-levy-rpc',
        amount: 31 * PI,
        portal20: byte20(5),
        payer20: byte20(0xB5),
        fee: 1,
      });
      let rpcLevy = null;
      let rpcLevyError = '';
      try {
        rpcLevy = await rpcCall(rpcBound.port, 'queueTx', asArrayTx(levyOne));
      } catch (err) {
        rpcLevyError = String(err?.message || err);
      }
      const rpcLevyQueued = store.mempool.some((tx) => tx.id === levyOne.id);
      report.rpcLevy = rpcLevy
        ? { status: rpcLevy.status, ...verdict(rpcLevy.body), fee: levyOne.fee, queued: rpcLevyQueued }
        : { ok: rpcLevyQueued, reason: rpcLevyQueued ? '' : (rpcLevyError || 'not_queued'), fee: levyOne.fee, queued: rpcLevyQueued, responseError: rpcLevyError };
      report.rpcFaults = rpcFaults.slice();

      const p2pArr = publicLock({
        id: 'lock-levy-p2p-array',
        amount: PI - 1,
        portal20: byte20(6),
        payer20: byte20(0xB6),
        fee: 1,
      });
      const memBefore = store.mempool.length;
      await p2pTx(p2pBound.port, store.magic, asArrayTx(p2pArr));
      const p2pHit = store.mempool.find((tx) => tx.id === p2pArr.id);
      report.p2pByteArray = p2pHit
        ? { ok: true, reason: '', queuedBySocket: true }
        : { ...verdict(store.queueTx(asArrayTx(p2pArr))), queuedBySocket: false, mempool: store.mempool.length - memBefore };

      const p2pHexTx = publicLock({
        id: 'lock-levy-p2p-hex',
        amount: 2 * PI,
        portal20: byte20(7),
        payer20: byte20(0xB7),
        fee: 1,
      });
      const hexLine = jsonWire({ type: 'tx', magic: store.magic, tx: p2pHexTx });
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host: '127.0.0.1', port: p2pBound.port }, () => {
          sock.write(`${hexLine}\n`);
          setTimeout(() => {
            sock.destroy();
            resolve();
          }, 30);
        });
        sock.on('error', reject);
      });
      const hexHit = store.mempool.find((tx) => tx.id === p2pHexTx.id);
      const hexParsed = JSON.parse(hexLine);
      const hexDirect = hexHit ? { ok: true, reason: '' } : verdict(store.queueTx(hexParsed.tx));
      report.p2pHexWire = { ...hexDirect, queuedBySocket: !!hexHit };
      report.mempoolIds = store.mempool.map((tx) => tx.id);
      report.vaultAfterMempool = vaultSnap(store);
      store.mempool.length = 0;
      const parentFlux = store.fluxset();

      const mined = await mineAppend(store, miner, matrix, now);
      report.block = {
        ...mined.appended,
        height: Number(store.tip()?.height || 0),
        txCount: mined.built.txs.length,
        fees: matrix.reduce((n, tx) => n + tx.fee, 0),
      };
      report.after = vaultSnap(store);
      report.afterAudit = supplyAudit(store);
      const principalDelta = BigInt(report.after.principal) - BigInt(before.principal);
      report.principalDelta = principalDelta.toString();

      const parentBlock = store.blocks[store.blocks.length - 1];
      const genesisMs = Number(decodeHeader(Buffer.from(store.blocks[0].header)).timestamp);
      const parentView = {
        hash: parentBlock.hash,
        header: parentBlock.header,
        height: parentBlock.height,
        txs: parentBlock.txs,
        weight: parentBlock.weight,
        shareBatch: parentBlock.shareBatch,
      };
      const verifyOpts = {
        magic: store.magic,
        genesisMs,
        reserveState: parentVault,
        parentSupply,
        parentFluxset: parentFlux,
        parentSpendTags: parentFlux.spendTags,
        evmHistory: store.blocks.slice(),
        hashBonusNanos: hashBonusUnitNanos(parentVault.liveHashBonusNanos),
        nowMs: Date.now(),
      };
      const liveBlock = {
        header: mined.found.header,
        txs: mined.built.txs,
        shareBatch: mined.built.shareBatch || [],
        aLeaves: mined.built.aLeaves,
        bLeaves: mined.built.bLeaves,
        rootA: mined.built.rootA,
        rootB: mined.built.rootB,
        weight: mined.built.weight,
      };
      const recheckLive = await Promise.resolve(verifyBlock(liveBlock, parentView, verifyOpts));
      report.revalidateLive = verdict(recheckLive);
      report.revalidate = report.revalidateLive;

      let reloaded = null;
      let reloadError = '';
      try {
        reloaded = createRegtestStore(dir, { bits: 4 });
      } catch (err) {
        reloadError = String(err?.message || err);
      }
      report.reload = reloaded
        ? { ok: true, reason: '', mode: reloaded.loadMode, ...vaultSnap(reloaded), audit: supplyAudit(reloaded) }
        : { ok: false, reason: reloadError };
      if (!reloaded) {
        dropLoadCache(dir);
        try {
          reloaded = createRegtestStore(dir, { bits: 4 });
          report.reloadStripped = { ok: true, reason: '', mode: reloaded.loadMode, ...vaultSnap(reloaded) };
        } catch (err) {
          report.reloadStripped = { ok: false, reason: String(err?.message || err) };
        }
      }

      const attackBlock = {
        header: mined.found.header,
        txs: mined.built.txs,
        shareBatch: mined.built.shareBatch || [],
      };
      report.attackAudit = supplyAudit({
        blocks: store.blocks.concat([attackBlock]),
        magic: store.magic,
      });

      console.log(`P0_PUBLIC_RESERVE_RECEIPT ${JSON.stringify(report)}`);

      assert.equal(report.verifyFundedBody.reason, 'public_receipt');
      assert.equal(report.rpcZeroFee.reason, 'public_receipt');
      assert.equal(report.rpcLevy.ok, false);
      assert.equal(report.rpcLevy.reason, 'public_receipt');
      assert.equal(report.p2pByteArray.ok, false);
      assert.equal(report.p2pByteArray.reason, 'public_receipt');
      // Hex wire decodes and hits the receipt gate. It is still not queued.
      assert.equal(report.p2pHexWire.reason, 'public_receipt');
      assert.equal(report.p2pHexWire.queuedBySocket, false);
      assert.equal(report.vaultAfterMempool.principal, '0');
      assert.equal(report.block.ok, false);
      assert.equal(report.block.reason, 'public_receipt');
      assert.equal(report.principalDelta, '0');
      assert.equal(report.after.principal, '0');
      assert.equal(report.after.totalLocked, before.totalLocked);
      assert.equal(report.afterAudit.status, 'verified');
      assert.equal(report.afterAudit.differenceNanos, 0);
      assert.equal(report.revalidateLive.reason, 'public_receipt');
      assert.equal(report.revalidate.reason, 'public_receipt');
      assert.equal(report.attackAudit.status, 'mismatch');
      assert.equal(report.attackAudit.differenceNanos, 39584067435105);
      assert.equal(report.reload.ok, true);
      assert.equal(report.reload.mode, 'snap');
      assert.equal(report.reload.principal, '0');
      assert.equal(report.reload.height, 3);
    } finally {
      process.off('unhandledRejection', onReject);
      try { rpc.close(); } catch { /* already closed */ }
      try { p2p.close(); } catch { /* already closed */ }
    }
  });
});

function vaultPrincipal(state) {
  let n = 0n;
  for (const p of Object.values(state?.portals || {})) {
    n += BigInt(p?.staked || 0) + BigInt(p?.idle || 0);
  }
  return n.toString();
}
