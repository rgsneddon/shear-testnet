/**
 * A withdraw built by the Dart wallet enters through queueTx.
 * The chain lock is mined here. Dart seals the payout, proves the spend,
 * and the wallet recognises that one-time dest20.
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
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import { VAULT_PERIODS_PER_EPOCH } from '../../crypto/vault_accrual.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { admitScalarFromSeed, attachAdmitPub } from '../../crypto/admit.js';
import {
  asU8,
  kernelExcess,
  openedCoinbaseNanos,
  pointBytes,
  proveRange,
  randomScalar,
  scalarBytes,
  sealHiddenNote,
  commit,
} from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { walletAnchor } from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  resetFs1Tree,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { signSpendTx } from '../../crypto/spend.js';
import {
  chainPeriodIndex,
  consensusUnlockPeriod,
  leafEpochsToBurn,
  leafStubNanos,
  portalsFromSeed,
  publicTrancheRows,
  proveLockEquality,
} from '../../crypto/reserve_vault.js';
import { vaultLockNote } from '../../crypto/vault_reward_fs1.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wallet = path.join(root, 'wallet');
const T0 = 1_700_000_000_000;

const BYTE_KEYS = new Set([
  'dest20', 'spendPub', 'sig', 'withdrawNonce', 'excess', 'fs1',
  'commit', 'blob', 'cTilde', 'spendTag', 'R', 'z', 'note',
  'r', 'noteCommit', 'admitPub', 'rangeProof', 'rEph', 'rCt', 'amtCt', 'viewTag',
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
    assert.ok(guard < 2000, 'clock');
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

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function placeholders(k) {
  const fs1 = Buffer.alloc(fs1BlobLen(k), 255);
  fs1[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < k; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({
      blob,
      cTilde: Buffer.alloc(32, 255),
      spendTag: Buffer.alloc(32, 255),
    });
  }
  return { fs1, proofs, vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })) };
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

function hiddenChange(nanos, dest20, admitBase) {
  let note = attachAdmitPub(sealHiddenNote(nanos, { dest20, kind: 'send', admitBase }), { admitBase });
  note = { ...note, kind: 'send', dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  delete note.valueProof;
  return note;
}

function proveSpend(tx, use, anchor, live, outs) {
  const proven = fs1ProveSpend({
    live,
    anchor,
    indices: use.map((c) => c.index),
    xs: use.map((c) => c.x),
    tx,
    magic: MAGIC_TESTNET,
  });
  assert.ok(proven, 'fs1 prove');
  const excess = kernelExcess(outs, use.map((c, i) => ({ r: c.r, t: proven.t[i] })));
  assert.ok(excess, 'excess');
  const settled = compactTx({
    ...tx,
    vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
    vout: outs,
    fs1: proven.fs1,
    admit_proofs: proven.proofs,
    excess,
  });
  assert.ok(txBodyDigestFs1(settled, MAGIC_TESTNET).equals(proven.digest), 'digest');
  return settled;
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

describe('Dart withdraw queues', { concurrency: false, timeout: 1_800_000 }, () => {
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

  it('a Dart-built withdraw is accepted by queueTx and the wallet recognises the payout', async () => {
    resetFs1Tree();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-dart-wd-'));
    const store = createStore(dir);
    const who = payer();
    const coins = [];
    const spent = new Set();
    for (let n = 0; n < 4; n += 1) {
      const { tpl } = await mine(store, who.dest);
      coins.push(potOf(tpl, who));
    }
    while (store.tip().height < 24) await mine(store, who.dest);

    const portal = portalsFromSeed(who.spendSeed, 1)[0];
    assert.ok(portal && portal.portalId && portal.dest20.length === 20, 'portal');
    // The lock owner is the portal spend key. The identity key is not it.
    const ownerKey = ed25519PrivateFromSeed(portal.spendSeed);
    const ownerPub = ed25519RawPub(ownerKey).toString('hex');
    const view = liveCoins(store, coins, spent);
    const use = view.coins.filter((c) => c.who === who).slice(0, 4);
    assert.equal(use.length, 4, 'lock inputs');
    const total = use.reduce((s, c) => s + c.v, 0);
    const blind = randomScalar();
    const scalar = randomScalar();
    const unlock = consensusUnlockPeriod(0);
    const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
    assert.ok(leaf, 'leaf');
    const funded = pointBytes(commit(PI_SHE_NANOS, blind));
    const range = proveRange(PI_SHE_NANOS, blind);
    assert.ok(range, 'range');
    const d20 = Buffer.from(portal.dest20);
    const changeDest = Buffer.from(hash20FromAddress(who.dest));
    const ph = placeholders(4);
    let fee = LEVY_FLOOR_UNITS;
    let tx = null;
    let spentOuts = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const changeN = total - fee - PI_SHE_NANOS;
      assert.ok(changeN > 0, `lock change ${changeN}`);
      const outs = [
        {
          kind: 'lock',
          commit: funded,
          rangeProof: range,
          r: scalarBytes(blind),
          dest20: d20,
          portalId: portal.portalId,
          viewTag: Buffer.from([1]),
        },
        hiddenChange(changeN, changeDest, who.base),
      ];
      const draft = compactTx({
        id: 'dart-queue-lock',
        kind: 'lock',
        anchor: view.anchor,
        fee,
        nanos: 0,
        programId: RESERVE_PROGRAM,
        portalId: portal.portalId,
        ownerPub,
        vaultLockNote: leaf.note,
        vin: ph.vin,
        vout: outs,
        fs1: ph.fs1,
        admit_proofs: ph.proofs,
      });
      const need = levyNeed(draft);
      if (fee >= need && fee <= LEVY_CAP_NANOS) {
        tx = proveSpend(draft, use, view.anchor, view.live, outs);
        spentOuts = outs;
        break;
      }
      const next = need + rangeSlack(outs);
      assert.ok(next > fee && next <= LEVY_CAP_NANOS, `lock levy ${need}`);
      fee = next;
    }
    assert.ok(tx, 'lock fee');
    tx.ownerPub = ownerPub;
    // The coins sit at the identity dest. A compact FS-1 lock authorises with
    // lockAuth, not that spendPub. The portal key would fail the coin dest.
    signSpendTx(tx, ownerKey);
    delete tx.spendPub;
    delete tx.sig;
    const fund = proveLockEquality(funded, PI_SHE_NANOS, blind, tx, MAGIC_TESTNET, 0);
    assert.ok(fund, 'fund');
    const lockOut = tx.vout.find((row) => String(row?.kind || '') === 'lock');
    assert.ok(lockOut, 'lock out');
    lockOut.fundProof = fund;
    assert.equal(tx.from, undefined);
    resetFs1Tree();
    const queuedLock = store.queueTx(tx);
    assert.equal(queuedLock.ok, true, `lock queue ${queuedLock.reason}`);
    const sealed = await mine(store, who.dest);
    assert.ok(sealed.tpl.txs.some((row) => row.id === 'dart-queue-lock'), 'lock mined');
    for (const c of use) spent.add(c.commit.toString('hex'));
    const change = spentOuts[1];
    const changeCoin = {
      r: Buffer.from(asU8(change.r)),
      v: total - tx.fee - PI_SHE_NANOS,
      commit: Buffer.from(asU8(change.commit)),
      noteCommit: Buffer.from(asU8(change.noteCommit)),
      kind: 'send',
      x: admitScalarFromSeed(who.spendSeed, change),
      who,
    };
    coins.push(changeCoin);

    const genesis = Number(store.reserveVault.genesisMs);
    await advanceClock(store, who.dest, genesis + RESERVE_EPOCH_MS);
    const wall = lastStamp(store) + 1_000;
    assert.ok(wall < genesis + 2 * RESERVE_EPOCH_MS, 'release epoch');
    const held = liveCoins(store, coins, spent);
    const input = held.coins.find((c) => c.commit.equals(changeCoin.commit));
    assert.ok(input, 'change still in the anchor');
    const stub = leafStubNanos(store.reserveVault, [leaf.commit.toString('hex')]);
    assert.ok(stub > 0n, 'arrival stub');
    const withdrawNanos = PI_SHE_NANOS + Number(stub);
    const period = chainPeriodIndex(store.reserveVault, wall);
    const burn = leafEpochsToBurn(store.reserveVault, leaf.note.toString('hex'), period);
    assert.equal(burn.length, 3, `burn ${burn.join(',')}`);
    const nonce = Buffer.alloc(32);
    nonce[0] = 9;
    nonce[31] = 7;
    const fixture = {
      seed: Buffer.from(who.spendSeed).toString('hex'),
      nonce: nonce.toString('hex'),
      portalId: portal.portalId,
      id: 'dart-queue-wd',
      anchor: held.anchor,
      fee: LEVY_CAP_NANOS,
      nanos: withdrawNanos,
      inputValue: input.v,
      changeDest20: changeDest.toString('hex'),
      notes: notesHex(held.live),
      index: input.index,
      spent: {
        kind: 'send',
        commit: input.commit.toString('hex'),
        noteCommit: input.noteCommit.toString('hex'),
        r: input.r.toString('hex'),
      },
      leaf: {
        scalar: scalarBytes(scalar).toString('hex'),
        blind: scalarBytes(blind).toString('hex'),
        note: Buffer.from(leaf.note).toString('hex'),
        unlock,
        amount: PI_SHE_NANOS,
        epochs: burn,
        withdrawPeriod: period,
        lockIndex: 0,
      },
      releaseEpoch: Math.floor(period / VAULT_PERIODS_PER_EPOCH),
      // The wallet reads the node serializer. The test does not copy the rows.
      nodePortal: {
        ok: true,
        portalId: portal.portalId,
        tranches: publicTrancheRows(store.reserveVault.portals[portal.portalId]),
      },
    };
    assert.ok(fixture.inputValue > fixture.fee, 'change covers the fee');
    const fixturePath = path.join(dir, 'fixture.json');
    fs.writeFileSync(fixturePath, JSON.stringify(fixture));
    const ran = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'flutter', 'test', 'test/emit_proved_withdraw_test.dart'], {
        cwd: wallet,
        env: { ...process.env, SHEAR_WITHDRAW_FIXTURE: fixturePath },
        encoding: 'utf8',
        timeout: 600_000,
      })
      : spawnSync('flutter', ['test', 'test/emit_proved_withdraw_test.dart'], {
        cwd: wallet,
        env: { ...process.env, SHEAR_WITHDRAW_FIXTURE: fixturePath },
        encoding: 'utf8',
        timeout: 600_000,
      });
    const dartErr = ran.error ? String(ran.error.message || ran.error) : '';
    assert.equal(ran.status, 0, dartErr || ran.stderr || ran.stdout || 'dart withdraw');
    const line = String(ran.stdout || '').split(/\r?\n/).map((row) => row.trim()).filter((row) => row.startsWith('{')).pop();
    assert.ok(line, ran.stdout || ran.stderr || 'no withdraw json');
    const body = revive(JSON.parse(line));
    if (body.retireProof && typeof body.retireProof === 'string') body.retireProof = asHexBuf(body.retireProof);
    assert.equal(body.kind, 'withdraw');
    assert.equal(body.from, undefined);
    assert.equal(body.to, undefined);
    assert.equal(body.payoutPortalId, undefined);
    assert.equal(body.spendPub, undefined);
    assert.equal(body.sig, undefined);
    const want = payoutDest20(who.spendSeed, portal.portalId, nonce);
    assert.ok(Buffer.from(body.dest20).equals(want), 'payout dest20');
    const receipt = (body.vout || []).find((row) => row && row.kind === 'withdraw');
    assert.ok(receipt, 'receipt');
    assert.ok(Buffer.from(receipt.dest20).equals(want), 'wallet payout');
    resetFs1Tree();
    const got = store.queueTx(body, { nowMs: wall });
    assert.equal(got.ok, true, `queue ${got.reason || ''} ${got.error || ''}`);
  });
});
