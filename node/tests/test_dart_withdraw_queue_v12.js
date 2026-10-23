/**
 * A lock built by the Dart wallet enters through queueTx.
 * The node mines that lock, claims it, and then mines the withdraw
 * postMaturedWithdraws built. Nothing here stubs queueSend or seals the
 * lock in JavaScript.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { newIdentity, encodeDest, hash20FromAddress, destCommitFromSpendPub, ed25519PrivateFromSeed, ed25519RawPub } from '../../crypto/address.js';
import {
  GENESIS_BPS,
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
} from '../../crypto/asert.js';
import { VAULT_PERIODS_PER_EPOCH } from '../../crypto/vault_accrual.js';
import { admitScalarFromSeed } from '../../crypto/admit.js';
import { asU8, openedCoinbaseNanos } from '../../crypto/note.js';
import { readyHeight, walletAnchor } from '../../crypto/admit_v3.js';
import { resetFs1Tree } from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import {
  chainPeriodIndex,
  leafEpochsToBurn,
  leafStubNanos,
  lockNotePrincipal,
  publicTrancheBook,
} from '../../crypto/reserve_vault.js';
import { vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wallet = path.join(root, 'wallet');
const T0 = 1_700_000_000_000;
const FLUTTER_BIN = '/tmp/flutter-sdk/flutter/bin';

const BYTE_KEYS = new Set([
  'dest20', 'spendPub', 'sig', 'withdrawNonce', 'excess', 'fs1',
  'commit', 'blob', 'cTilde', 'spendTag', 'R', 'z', 'note',
  'r', 'noteCommit', 'admitPub', 'rangeProof', 'rEph', 'rCt', 'amtCt', 'viewTag',
  'lockAuth', 'vaultLockNote', 'retireProof', 'vaultProof',
]);

function payer() {
  const id = newIdentity();
  const commit20 = destCommitFromSpendPub(id.spendPub);
  const dest = encodeDest(commit20, id.admitBase);
  return {
    id,
    dest,
    spendSeed: id.spendSeed,
    base: id.admitBase,
    pub: Buffer.from(id.spendPub).toString('hex'),
    key: id.privateKey,
  };
}

function lastStamp(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
}

let powSeq = 1;

function nextPow() {
  const hash = Buffer.alloc(32);
  hash.writeUInt32BE(powSeq, 28);
  powSeq += 1;
  return hash;
}

async function mine(store, dest, now) {
  const at = now == null ? Math.max(T0, lastStamp(store) + 90_000) : now;
  const { tpl } = store.template({ miner: dest, shareBits: 4, now: at });
  const got = await Promise.resolve(store.append({
    header: tpl.header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: nextPow(), skipSharePow: true }));
  assert.equal(got.ok, true, `append ${got.reason || ''} ${got.error || ''} h=${tpl.height}`);
  return { tpl, got };
}

async function advanceClock(store, dest, targetMs) {
  const step = 15 * 60_000;
  let guard = 0;
  while (lastStamp(store) < targetMs) {
    assert.ok(guard < 4000, 'clock');
    guard += 1;
    const want = Math.min(targetMs, lastStamp(store) + step);
    await mine(store, dest, want);
  }
}

function potOf(tpl, who) {
  const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
  assert.ok(pot && pot.r, 'pot opening');
  return {
    r: Buffer.from(asU8(pot.r)),
    v: openedCoinbaseNanos(pot),
    commit: Buffer.from(asU8(pot.commit)),
    noteCommit: Buffer.from(asU8(pot.noteCommit)),
    kind: 'pot',
    x: admitScalarFromSeed(who.spendSeed, pot),
    who,
  };
}

function liveCoins(store, coins, spent) {
  const height = store.tip().height + 1;
  const anchor = walletAnchor(height);
  assert.ok(anchor, `anchor at ${height}`);
  const live = store.anchorNote(anchor);
  assert.ok(live && live.n >= 1, `anchor ${anchor}`);
  const at = new Map();
  for (let i = 0; i < live.n; i += 1) {
    at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
  }
  const out = [];
  for (const c of coins) {
    const key = c.commit.toString('hex');
    if (spent.has(key) || !at.has(key)) continue;
    out.push({ ...c, index: at.get(key) });
  }
  return { anchor, live, coins: out };
}

function asHexBuf(raw) {
  const hex = String(raw || '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, 'hex');
}

function revive(value, key = '') {
  if (typeof value === 'string' && BYTE_KEYS.has(key)) return asHexBuf(value) || value;
  if (Array.isArray(value)) {
    if (key === 'retireProofs' || key === 'retireProof') {
      return value.map((row) => (typeof row === 'string' ? asHexBuf(row) : revive(row, key)));
    }
    return value.map((row) => revive(row, key));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [name, row] of Object.entries(value)) out[name] = revive(row, name);
    return out;
  }
  return value;
}

function payoutDest20(seed, portalHex, nonce) {
  const one = createHash('sha256').update(Buffer.concat([
    Buffer.from('shear-withdraw-payout-v1'),
    Buffer.from(seed),
    Buffer.from(portalHex, 'hex'),
    Buffer.from(nonce),
  ])).digest();
  return Buffer.from(destCommitFromSpendPub(ed25519RawPub(ed25519PrivateFromSeed(one))));
}

function notesHex(live) {
  const parts = [];
  for (let i = 0; i < live.n; i += 1) {
    parts.push(Buffer.from(asU8(live.pubs[i])));
    parts.push(Buffer.from(asU8(live.commits[i])));
  }
  return Buffer.concat(parts).toString('hex');
}

/** Same slot as Dart vaultWithdrawSlotMs: hash(portal id) inside the two-epoch window. */
function withdrawSlotMs(epochStart, epoch, portalId) {
  const close = epochStart + (epoch + 1) * RESERVE_EPOCH_MS;
  const windowBlocks = Math.floor((2 * RESERVE_EPOCH_MS) / 90_000);
  const span = windowBlocks > 0 ? windowBlocks : 1;
  const digest = createHash('sha256').update(Buffer.concat([
    Buffer.from('shear-withdraw-slot-v1'),
    Buffer.from(String(portalId).toLowerCase()),
  ])).digest();
  const pick = digest.readUInt32LE(0) % span;
  return close + pick * 90_000;
}

function epochOf(state, ms) {
  return Math.floor(chainPeriodIndex(state, ms) / VAULT_PERIODS_PER_EPOCH);
}

function runFlutter(testFile, env) {
  const ran = spawnSync('flutter', ['test', testFile], {
    cwd: wallet,
    env: {
      ...process.env,
      PATH: `${FLUTTER_BIN}${path.delimiter}${process.env.PATH || ''}`,
      ...env,
    },
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const dartErr = ran.error ? String(ran.error.message || ran.error) : '';
  assert.equal(ran.status, 0, dartErr || ran.stderr || ran.stdout || testFile);
  const rows = String(ran.stdout || '').split(/\r?\n/);
  let parsed = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const at = rows[i].indexOf('{');
    if (at < 0) continue;
    try {
      parsed = JSON.parse(rows[i].slice(at));
      break;
    } catch {
      parsed = null;
    }
  }
  assert.ok(parsed, ran.stderr || `no json from ${testFile}`);
  return revive(parsed);
}

describe('Dart withdraw queues', { concurrency: false, timeout: 2_400_000 }, () => {
  if (!fs1NativeLoaded()) {
    it('needs the native FS-1 addon', () => {
      assert.fail('shear_admit FS-1 addon is not loaded');
    });
    return;
  }

  let dir;
  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a Dart-built lock is mined, claimed, and withdrawn through postMaturedWithdraws', async () => {
    resetFs1Tree();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-dart-wd-'));
    const store = createStore(dir);
    const who = payer();
    const pay = payer();
    const coins = [];
    const spent = new Set();
    for (let n = 0; n < 4; n += 1) {
      const { tpl } = await mine(store, who.dest);
      coins.push(potOf(tpl, who));
    }
    while (store.tip().height < 24) await mine(store, who.dest);

    const view = liveCoins(store, coins, spent);
    const use = view.coins.filter((c) => c.who === who).slice(0, 4);
    assert.equal(use.length, 4, 'lock inputs');
    const total = use.reduce((s, c) => s + c.v, 0);
    const changeDest = Buffer.from(hash20FromAddress(who.dest));
    const lockFixture = {
      seed: Buffer.from(who.spendSeed).toString('hex'),
      dest: who.dest,
      lockIndex: 0,
      lockEpoch: 0,
      proveHeight: 0,
      anchor: view.anchor,
      notes: notesHex(view.live),
      inputNanos: total,
      changeDest20: changeDest.toString('hex'),
      id: 'dart-queue-lock',
      inputs: use.map((c) => ({
        index: c.index,
        kind: c.kind,
        commit: c.commit.toString('hex'),
        noteCommit: c.noteCommit.toString('hex'),
        r: c.r.toString('hex'),
        nanos: c.v,
      })),
    };
    const lockPath = path.join(dir, 'lock.json');
    fs.writeFileSync(lockPath, JSON.stringify(lockFixture));
    const built = runFlutter('test/emit_queue_lock_test.dart', { SHEAR_LOCK_FIXTURE: lockPath });
    const expectLeaf = vaultLockNote(PI_SHE_NANOS, built.scalar, built.blind, built.unlock);
    assert.ok(expectLeaf, 'js leaf');
    assert.ok(expectLeaf.note.equals(Buffer.from(asU8(built.note))), 'dart leaf matches vaultLockNote');
    const tx = built.tx;
    assert.equal(tx.nanos, 0);
    assert.equal(tx.from, undefined);
    assert.equal(tx.to, undefined);
    assert.equal(tx.payoutPortalId, undefined);
    assert.equal(tx.kind, 'lock');
    const lockOut = (tx.vout || []).find((row) => row && row.kind === 'lock');
    assert.ok(lockOut && lockOut.fundProof && lockOut.fundProof.R && lockOut.fundProof.z, 'fund proof');
    assert.equal(lockNotePrincipal(tx, MAGIC_TESTNET), BigInt(PI_SHE_NANOS));
    resetFs1Tree();
    const queuedLock = store.queueTx(tx, { nowMs: lastStamp(store) });
    assert.equal(queuedLock.ok, true, `lock queue ${queuedLock.reason || ''} ${queuedLock.error || ''}`);
    const sealed = await mine(store, who.dest);
    assert.ok(sealed.tpl.txs.some((row) => row.id === tx.id), 'lock mined');
    console.log(`e2e lock height=${sealed.tpl.height} id=${String(tx.id).slice(0, 12)}`);
    for (const c of use) spent.add(c.commit.toString('hex'));
    const changeCoin = {
      r: Buffer.from(asU8(built.change.r)),
      v: built.changeNanos,
      commit: Buffer.from(asU8(built.change.commit)),
      noteCommit: Buffer.from(asU8(built.change.noteCommit)),
      admitPub: Buffer.from(asU8(built.change.admitPub)),
      kind: 'send',
      who,
    };
    coins.push(changeCoin);

    while (store.tip().height < 240) await mine(store, who.dest);
    const root = String(store.reserveVault.epochStartRoots?.['1'] || '');
    assert.equal(root, store.reserveVault.vaultLockRoot, 'period root is the lock');
    resetFs1Tree();
    const claimFixture = {
      seed: Buffer.from(who.spendSeed).toString('hex'),
      dest: pay.dest,
      dest20: Buffer.from(hash20FromAddress(pay.dest)).toString('hex'),
      rootEpoch: 1,
      earnEpoch: 1,
      bps: GENESIS_BPS,
      remainMs: 1,
      span: 1,
      locks: [{
        amount: PI_SHE_NANOS,
        scalar: Buffer.from(asU8(built.scalar)).toString('hex'),
        blind: Buffer.from(asU8(built.blind)).toString('hex'),
        unlockEpoch: built.unlock,
        index: 0,
      }],
    };
    const claimPath = path.join(dir, 'claim.json');
    fs.writeFileSync(claimPath, JSON.stringify(claimFixture));
    const claim = runFlutter('test/emit_vault_claim_test.dart', { SHEAR_CLAIM_FIXTURE: claimPath });
    assert.equal(claim.kind, 'reward-claim');
    assert.equal(claim.from, undefined);
    assert.equal(claim.to, undefined);
    resetFs1Tree();
    const claimQueued = store.queueTx(claim, { nowMs: lastStamp(store) });
    assert.equal(claimQueued.ok, true, `claim queue ${claimQueued.reason || ''}`);
    const claimBlock = await mine(store, who.dest);
    assert.ok(claimBlock.tpl.txs.some((row) => row.id === claim.id), 'claim mined');
    console.log(`e2e claim height=${claimBlock.tpl.height} id=${String(claim.id).slice(0, 12)}`);

    const genesis = Number(store.reserveVault.genesisMs);
    assert.ok(genesis > 0, 'genesis');
    const portalId = String(built.portalId);
    const slot = withdrawSlotMs(genesis, 0, portalId);
    await advanceClock(store, who.dest, Math.max(genesis + RESERVE_EPOCH_MS, slot));
    let wall = lastStamp(store);
    const boundary = genesis + (epochOf(store.reserveVault, wall) + 1) * RESERVE_EPOCH_MS;
    if (wall + 120_000 >= boundary) {
      await advanceClock(store, who.dest, boundary + 120_000);
      wall = lastStamp(store);
    }
    assert.ok(wall >= slot, 'withdraw slot');
    assert.equal(epochOf(store.reserveVault, wall), epochOf(store.reserveVault, wall + 120_000), 'signed epoch');
    const releaseEpoch = epochOf(store.reserveVault, wall);
    assert.ok(releaseEpoch > 0, 'epoch rolled');
    const held = liveCoins(store, coins, spent);
    const input = held.coins.find((c) => c.commit.equals(changeCoin.commit));
    assert.ok(input, 'change still in the anchor');
    const chainPub = Buffer.from(asU8(held.live.pubs[input.index]));
    assert.ok(chainPub.equals(changeCoin.admitPub), 'change admit');
    const leafCommit = Buffer.from(asU8(expectLeaf.commit)).toString('hex');
    const stub = leafStubNanos(store.reserveVault, [leafCommit]);
    assert.ok(stub > 0n, 'arrival stub');
    assert.ok(stub <= BigInt(Number.MAX_SAFE_INTEGER), 'stub fits');
    const period = chainPeriodIndex(store.reserveVault, wall);
    const burn = leafEpochsToBurn(store.reserveVault, expectLeaf.note.toString('hex'), period);
    assert.equal(burn.length, 3, `burn ${burn.join(',')}`);
    const nonce = Buffer.alloc(32);
    nonce[0] = 9;
    nonce[31] = 7;
    const withdrawFixture = {
      seed: Buffer.from(who.spendSeed).toString('hex'),
      dest: who.dest,
      nonce: nonce.toString('hex'),
      nowMs: wall,
      epochStartMs: genesis,
      currentEpoch: releaseEpoch,
      anchor: held.anchor,
      notes: notesHex(held.live),
      host: {
        kind: 'send',
        commit: input.commit.toString('hex'),
        noteCommit: input.noteCommit.toString('hex'),
        r: input.r.toString('hex'),
        admitPub: chainPub.toString('hex'),
        nanos: input.v,
      },
      leaves: [{
        scalar: Buffer.from(asU8(built.scalar)).toString('hex'),
        blind: Buffer.from(asU8(built.blind)).toString('hex'),
        note: expectLeaf.note.toString('hex'),
        unlock: built.unlock,
        amount: PI_SHE_NANOS,
        epochs: burn,
        withdrawPeriod: period,
        portalId,
        lockIndex: 0,
      }],
      tranches: publicTrancheBook(store.reserveVault),
    };
    assert.ok(withdrawFixture.host.nanos > 100, 'change covers the fee');
    const withdrawPath = path.join(dir, 'withdraw.json');
    fs.writeFileSync(withdrawPath, JSON.stringify(withdrawFixture));
    const packed = runFlutter('test/emit_matured_withdraw_test.dart', { SHEAR_WITHDRAW_FIXTURE: withdrawPath });
    const body = packed.posted || packed;
    const receiptOpen = packed.receipt || null;
    const changeOpen = packed.changeNote || null;
    if (body.retireProof && typeof body.retireProof === 'string') body.retireProof = asHexBuf(body.retireProof);
    assert.equal(body.kind, 'withdraw');
    assert.equal(body.from, undefined);
    assert.equal(body.to, undefined);
    assert.equal(body.payoutPortalId, undefined);
    assert.equal(body.spendPub, undefined);
    assert.equal(body.sig, undefined);
    assert.match(String(body.id), /^wd-[0-9a-f]{32}$/);
    assert.equal(String(body.id).includes(String(wall)), false);
    const wantNanos = PI_SHE_NANOS + Number(stub);
    assert.equal(body.nanos, wantNanos);
    const want = payoutDest20(who.spendSeed, portalId, nonce);
    assert.ok(Buffer.from(body.dest20).equals(want), 'payout dest20');
    const receipt = (body.vout || []).find((row) => row && row.kind === 'withdraw');
    assert.ok(receipt, 'receipt');
    assert.ok(Buffer.from(receipt.dest20).equals(want), 'wallet payout');
    resetFs1Tree();
    const got = store.queueTx(body, { nowMs: wall });
    assert.equal(got.ok, true, `queue ${got.reason || ''} ${got.error || ''}`);
    const withdrawn = await mine(store, who.dest, wall + 1000);
    assert.ok(withdrawn.tpl.txs.some((row) => row.id === body.id), 'withdraw mined');
    console.log(`e2e withdraw height=${withdrawn.tpl.height} id=${String(body.id).slice(0, 12)}`);
    assert.ok(receiptOpen && receiptOpen.payoutSeed && receiptOpen.r, 'receipt opening');
    const ready = readyHeight(withdrawn.tpl.height);
    assert.ok(ready, 'receipt ready height');
    while (store.tip().height < ready) await mine(store, who.dest);
    const after = liveCoins(store, coins, spent);
    const receiptCommit = Buffer.from(asU8(receiptOpen.commit));
    let receiptAt = -1;
    for (let i = 0; i < after.live.n; i += 1) {
      if (Buffer.from(asU8(after.live.commits[i])).equals(receiptCommit)) receiptAt = i;
    }
    assert.ok(receiptAt >= 0, 'receipt in the anchor');
    const spendTo = payer();
    const payNanos = 100000000000;
    const spendFixture = {
      seed: Buffer.from(who.spendSeed).toString('hex'),
      to: spendTo.dest,
      anchor: after.anchor,
      notes: notesHex(after.live),
      payNanos,
      note: {
        kind: 'withdraw',
        commit: receiptCommit.toString('hex'),
        noteCommit: Buffer.from(asU8(receiptOpen.noteCommit)).toString('hex'),
        r: Buffer.from(asU8(receiptOpen.r)).toString('hex'),
        admitPub: Buffer.from(asU8(after.live.pubs[receiptAt])).toString('hex'),
        nanos: body.nanos,
        payoutSeed: Buffer.from(asU8(receiptOpen.payoutSeed)).toString('hex'),
      },
    };
    const spendPath = path.join(dir, 'spend.json');
    fs.writeFileSync(spendPath, JSON.stringify(spendFixture));
    resetFs1Tree();
    const spentBody = runFlutter('test/emit_receipt_spend_test.dart', { SHEAR_SPEND_FIXTURE: spendPath });
    assert.ok(spentBody.fs1, 'receipt spend proof');
    assert.ok(Array.isArray(spentBody.vin) && spentBody.vin.length === 1, 'receipt spend vin');
    assert.equal(spentBody.kind, undefined, 'sealed send posts no kind');
    assert.equal(spentBody.from, undefined);
    assert.equal(spentBody.to, undefined);
    const posted = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', spentBody, {
      store,
      miners: new Map(),
      queueSend(draft, meta) {
        const id = draft.id || `send-${Date.now()}`;
        const tx = { id, ...draft };
        const got = store.queueTx(tx, { ...(meta || {}), nowMs: wall + 2000 });
        if (!got || got.ok === false) return got;
        return got.tx || tx;
      },
    });
    assert.equal(posted.status, 200, `spend queue ${posted.json?.reason || ''} ${posted.json?.state || ''}`);
    const spentId = String(posted.json?.tx?.id || '');
    const spentBlock = await mine(store, who.dest, wall + 2000);
    const spentMined = spentId
      ? spentBlock.tpl.txs.some((row) => row.id === spentId)
      : spentBlock.tpl.txs.length > 1;
    assert.ok(spentMined, 'receipt spend mined');
    console.log(`e2e spend height=${spentBlock.tpl.height} id=${spentId.slice(0, 12)}`);
    assert.ok(changeOpen && changeOpen.changeSeed, 'withdraw change recorded');
  });
});
