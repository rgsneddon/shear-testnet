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
import { createRpc } from '../src/rpc.js';
import { decodeHeader } from '../../crypto/header.js';
import { newIdentity, encodeDest, hash20FromAddress, destCommitFromSpendPub, ed25519PrivateFromSeed, ed25519RawPub } from '../../crypto/address.js';
import {
  GENESIS_BPS,
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
} from '../../crypto/asert.js';
import { VAULT_PERIODS_PER_EPOCH } from '../../crypto/vault_accrual.js';
import { admitBaseScalar, admitScalarFromSeed } from '../../crypto/admit.js';
import { asU8, openedCoinbaseNanos, openNoteAmount } from '../../crypto/note.js';
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
import { compactTx } from '../../crypto/chronoflux.js';
import { censusOf, voteCloseHeight } from '../../crypto/leaf_vote.js';
import { bodyParityLine } from './body_parity.js';
import { buildSend, hiddenOut } from './fs1_send_kit.js';
import { everyFieldBound, stripFieldsIn } from './body_bound.js';
import { droppedTemplateReads } from './compact_reads.js';
import { amountBoundsRefused, coinbaseObserveRefused } from './amount_bounds.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wallet = path.join(root, 'wallet');
const T0 = 1_700_000_000_000;
const FLUTTER_BIN = '/tmp/flutter-sdk/flutter/bin';

const BYTE_KEYS = new Set([
  'dest20', 'spendPub', 'sig', 'withdrawNonce', 'excess', 'fs1',
  'commit', 'blob', 'cTilde', 'spendTag', 'R', 'z', 'note',
  'r', 'noteCommit', 'admitPub', 'rangeProof', 'rEph', 'rCt', 'amtCt', 'viewTag',
  'lockAuth', 'vaultLockNote', 'retireProof', 'vaultProof',
  'voteProof', 'voteOutput', 'changeSeed', 'piProof',
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

const scanned = [];

function hexOf(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'string') {
    const hex = v.replace(/^0x/i, '');
    return /^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0 ? hex : undefined;
  }
  try {
    const b = Buffer.from(asU8(v));
    return b.length ? b.toString('hex') : undefined;
  } catch {
    return undefined;
  }
}

function scanRow(tx) {
  const vout = [];
  for (const o of tx?.vout || []) {
    if (!o || !o.commit) continue;
    const row = { kind: o.kind || '' };
    for (const key of ['commit', 'noteCommit', 'dest20', 'admitPub', 'rEph', 'rCt', 'amtCt', 'portalId']) {
      const hex = hexOf(o[key]);
      if (hex) row[key] = hex;
    }
    if (row.commit && row.noteCommit) vout.push(row);
  }
  const row = { kind: tx?.kind || '', vout };
  if (tx?.coinbase) row.coinbase = true;
  const portal = hexOf(tx?.portalId);
  if (portal && portal.length === 64) row.portalId = portal;
  const nonce = hexOf(tx?.withdrawNonce);
  if (nonce && nonce.length === 64) row.withdrawNonce = nonce;
  return row;
}

function rememberScanned(tpl) {
  for (const tx of tpl?.txs || []) {
    try {
      scanned.push(scanRow(compactTx(tx)));
    } catch {
      scanned.push(scanRow(tx));
    }
  }
}

async function mine(store, dest, now) {
  const at = now == null ? Math.max(T0, lastStamp(store) + 90_000) : now;
  const { tpl } = store.template({ miner: dest, shareBits: 4, now: at });
  const got = await Promise.resolve(store.append({
    header: tpl.header,
    height: tpl.height,
    txs: tpl.txs,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: nextPow(), skipSharePow: true }));
  assert.equal(got.ok, true, `append ${got.reason || ''} ${got.error || ''} h=${tpl.height}`);
  rememberScanned(tpl);
  return { tpl, got };
}

/**
 * One real body, before it is queued: every compact field is in the leaf,
 * and the compact body carries no strip-list field.
 */
function checkBody(row, name) {
  const bound = everyFieldBound(row, name);
  assert.deepEqual(stripFieldsIn(compactTx(row)), [], `${name}: strip-list fields`);
  return bound;
}

/**
 * The block the next mine() will seal, with `id` queued, validated by the
 * store in compact form under the read walk: no validator read lands on a
 * field compaction drops. `nowMs` is the stamp that mine() will use.
 */
async function walkQueued(store, dest, id, name, nowMs = null) {
  const now = nowMs == null ? Math.max(T0, lastStamp(store) + 90_000) : nowMs;
  resetFs1Tree();
  const walked = await droppedTemplateReads({ store, miner: dest, now, sealHeader: async (header) => header });
  if (id != null && id !== '') assert.ok(walked.ids.includes(String(id)), `${name} is in the walked block`);
  assert.ok(walked.ids.length >= 2, `${name}: the walked block holds the queued tx`);
  assert.equal(walked.verdict.ok, true, `${name} walked block ${walked.verdict.reason || ''} (plain ${JSON.stringify(walked.plain)})`);
  assert.deepEqual(walked.misses, [], `${name}: a validator reads a field compaction drops (${JSON.stringify(walked.readers)})`);
  resetFs1Tree();
}

/**
 * Every negative or overflowing amount on the queued tx `id` is refused at
 * admission and in the next block, or is a field compaction drops
 * (amount_bounds.js). The rows go to the log for the Review.
 */
async function boundsQueued(store, dest, id, name, nowMs = null, admitMs = null, kind = '') {
  const now = nowMs == null ? Math.max(T0, lastStamp(store) + 90_000) : nowMs;
  const rows = await amountBoundsRefused({
    store, miner: dest, now, id, kind, name, nowMs: admitMs == null ? lastStamp(store) : admitMs, beforeEach: resetFs1Tree,
  });
  console.log(`amount bounds ${name}: ${JSON.stringify(rows)}`);
  resetFs1Tree();
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

function wireHex(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return String(v ?? '');
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

/**
 * What a chain read tells the wallet: the tip, and the block each note
 * commitment was mined in (wallet/bin/emit_heights.dart applies it).
 */
function heightsOf(store) {
  const heights = {};
  const note = (o, at) => {
    if (o && o.commit) heights[Buffer.from(asU8(o.commit)).toString('hex')] = at;
  };
  for (const b of store.blocks) {
    const at = Number(b.height);
    for (const tx of b.txs || []) {
      for (const o of tx.vout || []) note(o, at);
      note(tx.voteOutput, at);
    }
  }
  return { tip: Number(store.tip().height), heights };
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
    // No datadir lock: the restart below opens this book in a second process.
    const store = createStore(dir, { lock: false });
    const who = payer();
    const pay = payer();
    const coins = [];
    const spent = new Set();
    for (let n = 0; n < 4; n += 1) {
      const { tpl } = await mine(store, who.dest);
      coins.push(potOf(tpl, who));
    }
    let voteFee = null;
    while (store.tip().height < 24) {
      const { tpl } = await mine(store, who.dest);
      if (!voteFee) voteFee = potOf(tpl, who);
    }
    assert.ok(voteFee, 'vote fee pot');
    coins.push(voteFee);

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
    fs.writeFileSync(lockPath, JSON.stringify({ ...lockFixture, ...heightsOf(store) }));
    const built = runFlutter('test/emit_queue_lock_test.dart', { SHEAR_LOCK_FIXTURE: lockPath });
    const expectLeaf = vaultLockNote(PI_SHE_NANOS, built.scalar, built.blind, built.unlock);
    assert.ok(expectLeaf, 'js leaf');
    assert.ok(expectLeaf.note.equals(Buffer.from(asU8(built.note))), 'dart leaf matches vaultLockNote');
    const tx = built.tx;
    // The amount is hidden in the lock commit: no plaintext copy beside it.
    assert.equal(Object.prototype.hasOwnProperty.call(tx, 'nanos'), false, 'no top-level nanos on a hidden lock');
    assert.equal(tx.from, undefined);
    assert.equal(tx.to, undefined);
    assert.equal(tx.payoutPortalId, undefined);
    assert.equal(tx.kind, 'lock');
    const lockOut = (tx.vout || []).find((row) => row && row.kind === 'lock');
    assert.ok(lockOut && lockOut.fundProof && lockOut.fundProof.R && lockOut.fundProof.z, 'fund proof');
    assert.equal(lockNotePrincipal(tx, MAGIC_TESTNET), BigInt(PI_SHE_NANOS));
    // A relayer or miner can strip the π fundProof without changing a signed
    // byte. The stripped lock is refused on p2p (queueTx) and RPC, so its leaf
    // can never be indexed unbooked (old code accepted it).
    checkBody(tx, 'dart lock');
    assert.deepEqual(stripFieldsIn(compactTx({ ...tx, nanos: PI_SHE_NANOS })), [], 'compaction never carries a hidden lock amount');
    // A hidden lock never carries its amount in clear: the real lock with a
    // top-level nanos added is amount_field on p2p and RPC.
    for (const plain of [PI_SHE_NANOS, 0]) {
      resetFs1Tree();
      const leaked = store.queueTx({ ...structuredClone(tx), nanos: plain }, { nowMs: lastStamp(store) });
      assert.equal(leaked.reason, 'amount_field', `a hidden lock with nanos ${plain}: ${leaked.reason}`);
      resetFs1Tree();
      const viaRpcLeak = await Promise.resolve(createRpc({ store, port: 0, host: '127.0.0.1' })
        .dispatch('queuetx', { tx: { ...structuredClone(tx), nanos: plain } }));
      assert.equal(viaRpcLeak.reason, 'amount_field', `RPC hidden lock with nanos ${plain}`);
    }
    const strippedLock = structuredClone(tx);
    for (const row of strippedLock.vout) if (row && row.kind === 'lock') delete row.fundProof;
    resetFs1Tree();
    const viaPeer = store.queueTx(structuredClone(strippedLock), { nowMs: lastStamp(store) });
    assert.equal(viaPeer.ok, false, `stripped lock via p2p: ok=${viaPeer.ok} reason=${viaPeer.reason}`);
    assert.equal(viaPeer.reason, 'stake_reward', `stripped lock via p2p: ${viaPeer.reason}`);
    resetFs1Tree();
    const viaRpc = await Promise.resolve(createRpc({ store, port: 0, host: '127.0.0.1' })
      .dispatch('queuetx', { tx: structuredClone(strippedLock) }));
    assert.equal(viaRpc.ok, false, `stripped lock via RPC: ok=${viaRpc.ok} reason=${viaRpc.reason}`);
    assert.equal(viaRpc.reason, 'stake_reward', `stripped lock via RPC: ${viaRpc.reason}`);
    resetFs1Tree();
    const relayed = [];
    const lockApi = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', tx, {
      store,
      miners: new Map(),
      queueSend(draft) {
        relayed.push(draft);
        assert.equal(draft, tx, 'pool relays the posted lock');
        const got = store.queueTx(draft, { nowMs: lastStamp(store) });
        if (!got || got.ok === false) return got;
        return got.tx || draft;
      },
    });
    assert.equal(lockApi.status, 200, `lock relay ${lockApi.json?.reason || ''}`);
    assert.equal(relayed.length, 1);
    assert.equal(relayed[0], tx);
    assert.equal(relayed[0].piProof, tx.piProof);
    await walkQueued(store, who.dest, tx.id, 'dart lock');
    await boundsQueued(store, who.dest, tx.id, 'dart lock');
    console.log(`coinbase observe: ${await coinbaseObserveRefused({ store, miner: who.dest, now: Math.max(T0, lastStamp(store) + 90_000), beforeEach: resetFs1Tree })}`);
    resetFs1Tree();
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
    fs.writeFileSync(claimPath, JSON.stringify({ ...claimFixture, ...heightsOf(store) }));
    const claim = runFlutter('test/emit_vault_claim_test.dart', { SHEAR_CLAIM_FIXTURE: claimPath });
    assert.equal(claim.kind, 'reward-claim');
    assert.equal(claim.from, undefined);
    assert.equal(claim.to, undefined);
    const claimBound = checkBody(claim, 'dart claim');
    assert.ok(claimBound.checked.some((p) => p.startsWith('vaultProof')), 'the live vault proof is in the leaf');
    resetFs1Tree();
    const claimQueued = store.queueTx(claim, { nowMs: lastStamp(store) });
    assert.equal(claimQueued.ok, true, `claim queue ${claimQueued.reason || ''}`);
    await walkQueued(store, who.dest, claim.id, 'dart claim');
    await boundsQueued(store, who.dest, claim.id, 'dart claim');
    const claimBlock = await mine(store, who.dest);
    assert.ok(claimBlock.tpl.txs.some((row) => row.id === claim.id), 'claim mined');
    console.log(`e2e claim height=${claimBlock.tpl.height} id=${String(claim.id).slice(0, 12)}`);

    const genesis = Number(store.reserveVault.genesisMs);
    assert.ok(genesis > 0, 'genesis');
    const lockPortal = store.reserveVault.portals[String(built.portalId)];
    assert.equal(lockPortal && lockPortal.qualified, true, 'lock qualifies');
    assert.ok(Number(store.reserveVault.epochStartMs) > 0, 'epoch opened');
    const portalId = String(built.portalId);
    await advanceClock(store, who.dest, genesis + RESERVE_EPOCH_MS);
    await mine(store, who.dest, lastStamp(store) + 90_000);
    assert.equal(store.reserveVault.currentEpoch, 1, 'epoch 1');
    const census = censusOf(store.reserveVault, 1);
    assert.ok(census && census.known && census.leafCount >= 1, 'census');
    const voteClose = voteCloseHeight(census.openHeight, MAGIC_TESTNET);
    assert.ok(voteClose != null && store.tip().height + 1 <= voteClose, 'vote window');
    const backupPath = path.join(dir, 'before.shewall.bin');
    const backupFixture = path.join(dir, 'backup.json');
    fs.writeFileSync(backupFixture, JSON.stringify({
      seed: Buffer.from(who.spendSeed).toString('hex'),
      password: 'shear-restore-test',
      out: backupPath,
    }));
    const backed = runFlutter('test/emit_shewall_backup_test.dart', { SHEAR_BACKUP_FIXTURE: backupFixture });
    assert.equal(backed.ok, true, 'shewall backup');
    assert.ok(fs.statSync(backupPath).size > 32, 'shewall bytes');
    const voteView = liveCoins(store, coins, spent);
    const feeCoin = voteView.coins.find((c) => c.commit.equals(voteFee.commit));
    assert.ok(feeCoin, 'fee pot still live');
    const feePub = Buffer.from(asU8(voteView.live.pubs[feeCoin.index]));
    const voteFixture = {
      seed: Buffer.from(who.spendSeed).toString('hex'),
      dest: who.dest,
      epoch: 1,
      openHeight: census.openHeight,
      leafCount: census.leafCount,
      anchor: voteView.anchor,
      notes: notesHex(voteView.live),
      fee: {
        commit: feeCoin.commit.toString('hex'),
        noteCommit: feeCoin.noteCommit.toString('hex'),
        r: feeCoin.r.toString('hex'),
        admitPub: feePub.toString('hex'),
        nanos: feeCoin.v,
      },
      leaf: {
        scalar: Buffer.from(asU8(built.scalar)).toString('hex'),
        blind: Buffer.from(asU8(built.blind)).toString('hex'),
        note: expectLeaf.note.toString('hex'),
        unlock: built.unlock,
        amount: PI_SHE_NANOS,
        epochs: [0],
        portalId,
        lockIndex: 0,
      },
    };
    const votePath = path.join(dir, 'vote.json');
    fs.writeFileSync(votePath, JSON.stringify({ ...voteFixture, ...heightsOf(store) }));
    resetFs1Tree();
    const voted = runFlutter('test/emit_leaf_vote_test.dart', { SHEAR_VOTE_FIXTURE: votePath });
    const voteBody = voted.posted || voted;
    assert.equal(voteBody.kind, 'leaf-vote');
    assert.equal(voteBody.portalId, undefined);
    assert.equal(voteBody.feeInput, undefined);
    assert.ok(voteBody.voteProof, 'vote proof');
    assert.ok(voted.change && voted.change.changeSeed, 'vote change');
    checkBody(voteBody, 'dart leaf vote');
    resetFs1Tree();
    const voteQueued = store.queueTx(voteBody, { nowMs: lastStamp(store) });
    assert.equal(voteQueued.ok, true, `vote queue ${voteQueued.reason || ''} ${voteQueued.error || ''}`);
    await walkQueued(store, who.dest, voteBody.id, 'dart leaf vote');
    await boundsQueued(store, who.dest, voteBody.id, 'dart leaf vote', null, null, 'leaf-vote');
    const voteBlock = await mine(store, who.dest);
    assert.ok(voteBlock.tpl.txs.some((row) => row.kind === 'leaf-vote'), 'vote mined');
    console.log(`e2e vote height=${voteBlock.tpl.height}`);
    spent.add(feeCoin.commit.toString('hex'));
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
        spendSeed: Buffer.from(asU8(built.changeSeed)).toString('hex'),
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
    fs.writeFileSync(withdrawPath, JSON.stringify({ ...withdrawFixture, ...heightsOf(store) }));
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
    assert.ok(receipt.rEph, 'receipt wrapped to the wallet');
    assert.ok(Buffer.from(receipt.dest20).equals(want), 'wallet payout');
    // The wallet's real FS-1 withdraw with a stray identity signature added is
    // refused before it is queued (old code accepted it: the SAL and rewardSig
    // authorise the withdraw, so the sig was never checked, only carried).
    for (const field of ['sig', 'signature']) {
      resetFs1Tree();
      const probe = store.queueTx({ ...structuredClone(body), [field]: 'ab'.repeat(64) }, { nowMs: wall });
      assert.equal(probe.reason, 'vote_leak', `${field} on the real withdraw: ok=${probe.ok} reason=${probe.reason}`);
    }
    checkBody(body, 'dart withdraw');
    resetFs1Tree();
    const got = store.queueTx(body, { nowMs: wall });
    assert.equal(got.ok, true, `queue ${got.reason || ''} ${got.error || ''}`);
    // An admitted id names one body. The same body again is a duplicate; a
    // changed body under that id was never verified or queued, so it is
    // refused, not reported ok (the wallet marks its note spent on an ok).
    const again = store.queueTx(structuredClone(body), { nowMs: wall });
    assert.equal(again.ok, true, `resend ${again.reason || ''}`);
    assert.equal(again.duplicate, true, 'resend is a duplicate');
    const changed = structuredClone(body);
    changed.fee = Number(changed.fee) + 1;
    const reused = store.queueTx(changed, { nowMs: wall });
    assert.equal(reused.ok, false, 'a changed body under an admitted id is not ok');
    assert.equal(reused.reason, 'id_reused');
    assert.equal(store.mempool.filter((row) => String(row.id) === String(body.id)).length, 1, 'one body for the id');
    await walkQueued(store, who.dest, body.id, 'dart withdraw', wall + 1000);
    await boundsQueued(store, who.dest, body.id, 'dart withdraw', wall + 1000, wall);
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
    const restorePath = path.join(dir, 'restore.json');
    fs.writeFileSync(restorePath, JSON.stringify({
      shewall: backupPath,
      password: 'shear-restore-test',
      anchor: after.anchor,
      notes: notesHex(after.live),
      txs: scanned,
    }));
    resetFs1Tree();
    const restored = runFlutter('test/emit_restore_scan_test.dart', { SHEAR_RESTORE_FIXTURE: restorePath });
    assert.equal(restored.ok, true, 'restored scan');
    assert.ok(restored.nextLockIndex >= 1, 'spent lock index is not reused');
    assert.equal(restored.receipt, receiptCommit.toString('hex'));
    assert.ok(restored.openings?.receipt && restored.openings.withdrawChange && restored.openings.voteChange, 'three openings');
    console.log(`e2e restore index=${restored.nextLockIndex} receipt=${String(restored.receipt).slice(0, 12)}`);
    assert.ok(changeOpen && changeOpen.changeSeed, 'withdraw change recorded');
    async function postRestored(label, opening, payNanos) {
      const view = liveCoins(store, coins, spent);
      const commit = Buffer.from(opening.commit, 'hex');
      let at = -1;
      for (let i = 0; i < view.live.n; i += 1) {
        if (Buffer.from(asU8(view.live.commits[i])).equals(commit)) at = i;
      }
      assert.ok(at >= 0, `${label} in the anchor`);
      const nanos = Number(opening.nanos);
      assert.ok(nanos > payNanos + 100_000_000, `${label} covers pay and cap (${nanos})`);
      const spendFixture = {
        seed: Buffer.from(who.spendSeed).toString('hex'),
        to: payer().dest,
        anchor: view.anchor,
        notes: notesHex(view.live),
        payNanos,
        note: {
          kind: opening.kind || 'send',
          commit: wireHex(opening.commit),
          noteCommit: wireHex(opening.noteCommit),
          r: wireHex(opening.r),
          admitPub: Buffer.from(asU8(view.live.pubs[at])).toString('hex'),
          nanos,
          spendSeed: wireHex(opening.spendSeed),
          ...(opening.payoutSeed ? { payoutSeed: wireHex(opening.payoutSeed) } : {}),
          ...(opening.changeSeed ? { changeSeed: wireHex(opening.changeSeed) } : {}),
        },
      };
      const spendPath = path.join(dir, `spend-${label.replace(/\s+/g, '-')}.json`);
      fs.writeFileSync(spendPath, JSON.stringify({ ...spendFixture, ...heightsOf(store) }));
      resetFs1Tree();
      const spentBody = runFlutter('test/emit_receipt_spend_test.dart', { SHEAR_SPEND_FIXTURE: spendPath });
      assert.ok(spentBody.fs1, `${label} spend proof`);
      assert.ok(Array.isArray(spentBody.vin) && spentBody.vin.length === 1, `${label} vin`);
      assert.equal(spentBody.kind, undefined, `${label} posts no kind`);
      assert.equal(spentBody.from, undefined);
      assert.equal(spentBody.to, undefined);
      const posted = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', spentBody, {
        store,
        miners: new Map(),
        queueSend(draft, meta) {
          const id = draft.id || `send-${Date.now()}`;
          const queued = { id, ...draft };
          const got = store.queueTx(queued, { ...(meta || {}), nowMs: wall + 2000 });
          if (!got || got.ok === false) return got;
          return got.tx || queued;
        },
      });
      assert.equal(posted.status, 200, `${label} queue ${posted.json?.reason || ''} ${posted.json?.state || ''}`);
      const spentId = String(posted.json?.tx?.id || '');
      const spentBlock = await mine(store, who.dest, wall + 2000);
      const spentMined = spentId
        ? spentBlock.tpl.txs.some((row) => row.id === spentId)
        : spentBlock.tpl.txs.length > 1;
      assert.ok(spentMined, `${label} mined`);
      console.log(`e2e ${label} height=${spentBlock.tpl.height} id=${spentId.slice(0, 12)}`);
      spent.add(commit.toString('hex'));
    }
    await postRestored('receipt', restored.openings.receipt, 100_000_000_000);
    await postRestored('withdraw change', restored.openings.withdrawChange, 1000);
    await postRestored('vote change', restored.openings.voteChange, 1000);

    // A restart reads the same bodies. Every block's merkle rebuilt from
    // its stored bodies is the root its header seals, in this process and
    // in a second one that reads the book back from disk, and the reopened
    // tip, supply, vault root and spent tags are the live ones.
    const live = bodyParityLine(store);
    assert.deepEqual(live.mismatched, [], 'live bodies match their headers');
    const opener = path.join(path.dirname(fileURLToPath(import.meta.url)), 'body_parity_open.js');
    const opened = spawnSync(process.execPath, [opener, dir], { encoding: 'utf8', timeout: 900_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(opened.status, 0, opened.stderr || opened.stdout || 'restart process');
    const restarted = JSON.parse(String(opened.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop());
    assert.deepEqual(restarted.mismatched, [], 'reloaded bodies match their headers');
    for (const k of ['height', 'hash', 'circulating', 'supplyStatus', 'principal', 'vaultRoot', 'spendTags']) {
      assert.deepEqual(restarted[k], live[k], `restart ${k}`);
    }
  });

  it('a wallet with one 10 SHE note locks one π leaf, and the change is exactly Spendable and what a send can use', async () => {
    resetFs1Tree();
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-dart-pi-'));
    const SHE = 100_000_000_000;
    const TEN = 10 * SHE;
    const DEPTH = 8;
    try {
      const store = createStore(lockDir, { lock: false });
      const miner = payer();
      const wallet = payer();
      const seedHex = Buffer.from(wallet.spendSeed).toString('hex');
      // The Dart wallet restores itself from the seed; the payer seals to its home dest.
      const ident = runFlutter('test/emit_wallet_identity_test.dart', { SHEAR_WALLET_SEED: seedHex });
      const home20 = Buffer.from(asU8(ident.dest20));
      assert.equal(String(ident.admitBase), Buffer.from(wallet.base).toString('hex'), 'Dart and JS derive one admit base');
      const coins = [];
      const spent = new Set();
      for (let n = 0; n < 14; n += 1) {
        const { tpl } = await mine(store, miner.dest);
        coins.push(potOf(tpl, miner));
      }
      while (store.tip().height < 24) await mine(store, miner.dest);
      const miner20 = Buffer.from(hash20FromAddress(miner.dest));
      const coinOf = (sealed, owner, v) => {
        const opened = openNoteAmount(sealed, admitBaseScalar(owner.spendSeed));
        assert.ok(opened, 'the owner opens its note');
        assert.equal(Number(opened.v), v, 'the owner reads the amount');
        return {
          r: Buffer.from(asU8(opened.r)),
          v: Number(opened.v),
          commit: Buffer.from(asU8(sealed.commit)),
          noteCommit: Buffer.from(asU8(sealed.noteCommit)),
          admitPub: Buffer.from(asU8(sealed.admitPub)),
          x: admitScalarFromSeed(owner.spendSeed, sealed),
          who: owner,
        };
      };
      const sealedOut = (txId) => store.blocks[store.blocks.length - 1].txs.find((row) => row.id === txId);
      // A wallet anchor is quantised: a new note is spendable once an anchor row holds it.
      const untilLive = async (want, extra = []) => {
        for (let i = 0; i < 64; i += 1) {
          const v = liveCoins(store, [...coins, ...extra], spent);
          if (want.every((c) => v.coins.some((row) => row.commit.equals(c.commit)))) return v;
          await mine(store, miner.dest);
        }
        assert.fail('notes never reached a wallet anchor');
      };
      const sendAndMine = async (built) => {
        resetFs1Tree();
        const queued = store.queueTx(built.tx, { nowMs: lastStamp(store) });
        assert.equal(queued.ok, true, `${built.tx.id} queue ${queued.reason || ''}`);
        const { tpl } = await mine(store, miner.dest);
        assert.ok(tpl.txs.some((row) => row.id === built.tx.id), `${built.tx.id} mined`);
        for (const c of built.used) spent.add(c.commit.toString('hex'));
        return sealedOut(built.tx.id);
      };
      // Two sends gather the miner's pots; a third pays the wallet one note of exactly 10 SHE.
      const gather = async (id, use) => {
        const view = liveCoins(store, coins, spent);
        const picked = view.coins.filter((c) => use.some((u) => u.commit.equals(c.commit)));
        assert.equal(picked.length, use.length, `${id} inputs live`);
        const built = buildSend({
          id,
          coins: picked,
          anchor: view.anchor,
          live: view.live,
          magic: store.magic,
          outsOf: (room) => [hiddenOut(room, miner20, miner.base, 'send'), hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy')],
        });
        const row = await sendAndMine({ ...built, used: picked });
        const coin = coinOf(row.vout[0], miner, built.total - built.fee);
        coins.push(coin);
        return coin;
      };
      const a = await gather('gather-a', coins.slice(0, 8));
      const b = await gather('gather-b', coins.slice(8, 14));
      assert.ok(a.v + b.v > TEN + SHE, `gathered ${a.v + b.v}`);
      const view = await untilLive([a, b]);
      const pair = view.coins.filter((c) => c.commit.equals(a.commit) || c.commit.equals(b.commit));
      const payTen = buildSend({
        id: 'pay-ten',
        coins: pair,
        anchor: view.anchor,
        live: view.live,
        magic: store.magic,
        outsOf: (room) => [
          hiddenOut(TEN, home20, wallet.base, 'send'),
          hiddenOut(room - TEN, miner20, miner.base, 'send'),
          hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
        ],
      });
      const paidRow = await sendAndMine({ ...payTen, used: pair });
      const paidHeight = store.tip().height;
      const ten = coinOf(paidRow.vout[0], wallet, TEN);
      coins.push(ten);
      for (let i = 0; i < DEPTH; i += 1) await mine(store, miner.dest);

      // The wallet holds one confirmed 10 SHE note and locks one π leaf (the GUI path).
      const lockView = await untilLive([ten]);
      const tenLive = lockView.coins.find((c) => c.commit.equals(ten.commit));
      assert.ok(tenLive, 'the 10 SHE note is in the anchor');
      const lockFixture = {
        seed: seedHex,
        tip: store.tip().height,
        anchor: lockView.anchor,
        notes: notesHex(lockView.live),
        lockEpoch: 0,
        input: {
          commit: ten.commit.toString('hex'),
          noteCommit: ten.noteCommit.toString('hex'),
          r: ten.r.toString('hex'),
          admitPub: ten.admitPub.toString('hex'),
          nanos: TEN,
          height: paidHeight,
        },
      };
      const lockPath = path.join(lockDir, 'pi-lock.json');
      fs.writeFileSync(lockPath, JSON.stringify({ ...lockFixture, ...heightsOf(store) }));
      const locked = runFlutter('test/emit_lock_spendable_test.dart', { SHEAR_LOCK_FIXTURE: lockPath, SHEAR_LOCK_PHASE: 'lock' });
      assert.equal(locked.before, TEN, 'Spendable is the 10 SHE note before the lock');
      const fee = Number(locked.fee);
      const changeNanos = Number(locked.changeNanos);
      assert.equal(changeNanos, TEN - PI_SHE_NANOS - fee, 'the change is 10 SHE less π less the fee');
      assert.equal(locked.after, 0, 'after posting, the spent note and the unconfirmed change are not Spendable');
      assert.equal(locked.pendingAfter, changeNanos, 'the change shows as Pending until it confirms');
      const tx = locked.tx;
      assert.equal(tx.kind, 'lock');
      assert.equal(Object.prototype.hasOwnProperty.call(tx, 'nanos'), false, 'no plaintext amount on the lock');
      resetFs1Tree();
      const lockQueued = store.queueTx(tx, { nowMs: lastStamp(store) });
      assert.equal(lockQueued.ok, true, `lock queue ${lockQueued.reason || ''}`);
      const { tpl: lockTpl } = await mine(store, miner.dest);
      assert.ok(lockTpl.txs.some((row) => row.id === tx.id), 'the lock confirms');
      const lockHeight = store.tip().height;
      spent.add(ten.commit.toString('hex'));
      for (let i = 0; i < DEPTH; i += 1) await mine(store, miner.dest);

      // A restarted wallet restores the notes it saved; at depth the change is
      // exactly Spendable, and the lock is not.
      const asWire = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && x.type === 'Buffer' && Array.isArray(x.data) ? Buffer.from(x.data).toString('hex') : x)));
      const confirmPath = path.join(lockDir, 'pi-confirm.json');
      fs.writeFileSync(confirmPath, JSON.stringify({ seed: seedHex, tip: store.tip().height, lockHeight, session: asWire(locked.session) }));
      const confirmed = runFlutter('test/emit_lock_spendable_test.dart', { SHEAR_LOCK_FIXTURE: confirmPath, SHEAR_LOCK_PHASE: 'confirm' });
      assert.equal(confirmed.spendable, changeNanos, 'Spendable is exactly the change');
      assert.equal(confirmed.pending, 0, 'nothing is left pending');

      // What Spendable shows is what a send can use: the wallet spends the change.
      const changeCoin = {
        r: Buffer.from(asU8(locked.change.r)),
        v: changeNanos,
        commit: Buffer.from(asU8(locked.change.commit)),
      };
      const spendView = await untilLive([changeCoin], [changeCoin]);
      const changeCommit = Buffer.from(asU8(locked.change.commit));
      let at = -1;
      for (let i = 0; i < spendView.live.n; i += 1) {
        if (Buffer.from(asU8(spendView.live.commits[i])).equals(changeCommit)) at = i;
      }
      assert.ok(at >= 0, 'the change is in the anchor');
      const payNanos = changeNanos - 2 * 100_000_000;
      const spendPath = path.join(lockDir, 'pi-spend.json');
      fs.writeFileSync(spendPath, JSON.stringify({
        ...heightsOf(store),
        seed: seedHex,
        to: payer().dest,
        anchor: spendView.anchor,
        notes: notesHex(spendView.live),
        payNanos,
        note: {
          kind: 'send',
          commit: changeCommit.toString('hex'),
          noteCommit: wireHex(locked.change.noteCommit),
          r: wireHex(locked.change.r),
          admitPub: Buffer.from(asU8(spendView.live.pubs[at])).toString('hex'),
          nanos: changeNanos,
          spendSeed: wireHex(locked.changeSeed),
          changeSeed: wireHex(locked.changeSeed),
        },
      }));
      resetFs1Tree();
      const spendBody = runFlutter('test/emit_receipt_spend_test.dart', { SHEAR_SPEND_FIXTURE: spendPath });
      // The wallet posts a kindless send to /api/wallet/send, as in the
      // first test; the pool's wallet API is what names it for the node.
      assert.equal(spendBody.kind, undefined, 'the change send posts no kind');
      let sentId = '';
      const posted = handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', spendBody, {
        store,
        miners: new Map(),
        queueSend(draft, meta) {
          const id = draft.id || 'pi-change-send';
          const queued = { id, ...draft };
          const got = store.queueTx(queued, { ...(meta || {}), nowMs: lastStamp(store) });
          if (!got || got.ok === false) return got;
          sentId = id;
          return got.tx || queued;
        },
      });
      assert.equal(posted.status, 200, `change send queue ${posted.json?.reason || ''} ${posted.json?.state || ''}`);
      const { tpl: sendTpl } = await mine(store, miner.dest);
      assert.ok(sendTpl.txs.some((row) => row.id === sentId), 'the change send is mined');
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});
