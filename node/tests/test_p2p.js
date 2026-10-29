import { describe, it, after } from 'node:test';
import { fileCapMs } from './slow_caps.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { destCommitFromSpendPub, ed25519PrivateFromSeed, ed25519RawPub, encodeDest, hash20FromAddress, newIdentity } from '../../crypto/address.js';
import { spendBox } from '../../tests/spend_box.js';
import { signSpendTx } from '../../crypto/spend.js';
import {
  consensusUnlockPeriod,
  lockUnlockOf,
  portalBlindFromSeed,
  portalIdFromDest20,
  portalsFromSeed,
  proveLockEquality,
} from '../../crypto/reserve_vault.js';
import { admitScalarFromSeed, attachAdmitPub } from '../../crypto/admit.js';
import { readyHeight, walletAnchor } from '../../crypto/admit_v3.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { proveLeafVote, vaultLockNote } from '../../crypto/vault_reward_fs1.js';
import { censusOf, censusRoot, proposalId } from '../../crypto/leaf_vote.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
  resetFs1Tree,
} from '../../crypto/fs1_spend.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { asU8, kernelExcess, openedCoinbaseNanos, proveRange, randomScalar, sealHiddenNote, sealNote } from '../../crypto/note.js';
import {
  MAGIC_TESTNET,
  RESERVE_EPOCH_MS,
  GENESIS_BITS_PACKED,
  MTP_WINDOW,
  PI_SHE_NANOS,
  PRODUCT_VERSION,
  RESERVE_PROGRAM,
  medianTimePast,
  templateStampMs,
} from '../../crypto/asert.js';
import { NODE_DISPLAY } from '../src/product.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
try { setHashBackend('jit'); } catch { /* interpreter */ }
import { decodeHeader } from '../../crypto/header.js';
import {
  P2P_PORT,
  P2P_MAX_FRAME,
  P2P_MAX_FRAME_DEFAULT,
  P2P_FAIL_DISCONNECT,
  noteExpensiveFail,
  ipv4Subnet24,
  inboundCountForSubnet,
  pickStemSocket,
  fluffDelayMs,
  FLUFF_MIN_MS,
  FLUFF_MAX_MS,
  STEM_MAX_HOPS,
  lineHasIpBesideIdentity,
  peerEventFields,
  isRoutablePeerAddr,
  createP2p,
  fingerprintHelloHash,
  HEADERS_PAGE,
  GETBLOCK_BATCH,
  GETBLOCK_WAIT_MS,
  TIP_NUDGE_MS,
  encodeWireBlock,
  decodeWireBlock,
  jsonWire,
  wireHash,
  selectHeadersAfterLocator,
  locatorHashes,
} from '../src/p2p.js';
import { DEFAULT_SEEDS } from '../src/node.js';
import { closeMineWorkers, lastMineAttempt, mineHeaderParallel } from './mine_worker.mjs';
import { printConfig, startNode, createStore } from '../src/node.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { createRpc } from '../src/rpc.js';
import { loadOracleSnapshot } from '../src/oracle_feed.js';
import { emptyVault } from '../../crypto/reserve_vault.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { createRegtestStore } from './regtest_store.js';
import { countSyncedOnline, countLiveOnline, isFinalIngestFail, recordIngestFail, requeuePrevHash, drainRetryPrev } from '../src/p2p.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 5));
}

function shareBitsOf(bits) {
  const n = Number(bits) || 0;
  return n >= 65536 ? Math.max(4, Math.floor(n / 65536)) : Math.max(4, n);
}

// Native jit-full on this host: 1 lane 264 H/s, 2 lanes 104 H/s, 4 lanes 81 H/s.
// One lane is the fast search. Bits stay 17 (2^17 tries). The wall is 3× that mean.
const MINE_LANES = 1;
const MINE_BACKEND = 'jit-full';
const MINE_HPS = 264;
const MINE_SLICE = 3_000_000;
const MINE_WALL_MS = Math.round((3 * (1 << 17) * 1000) / MINE_HPS);
after(() => closeMineWorkers());

async function mineOne(store, dest, bits = GENESIS_BITS_PACKED) {
  const packed = Number(bits) >= 65536 ? Number(bits) : GENESIS_BITS_PACKED;
  const sb = shareBitsOf(packed);
  const parent = store.tip();
  // parent+90s is past the 15s header-ahead cap once the search returns.
  // templateStampMs stays on the wall and still after the parent.
  const now = templateStampMs(parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp)
    : undefined);
  const { tpl } = store.template({ miner: dest, bits: packed, shareBits: sb, now });
  const wallStart = Date.now();
  let nonceBase = 0;
  let found = null;
  let tried = 0;
  while (Date.now() - wallStart < MINE_WALL_MS) {
    const left = MINE_WALL_MS - (Date.now() - wallStart);
    found = await mineHeaderParallel(
      tpl.header, packed, MINE_SLICE, MINE_LANES, left, nonceBase, MINE_BACKEND,
    );
    const attempt = lastMineAttempt();
    tried += attempt.tried;
    console.error(JSON.stringify({
      event: 'p2p_mine',
      backend: MINE_BACKEND,
      lanes: MINE_LANES,
      bits: packed,
      expectedTries: 1 << 17,
      nonceCap: MINE_SLICE,
      nonceBase,
      tried: attempt.tried,
      triedTotal: tried,
      status: attempt.status,
      hit: !!(found && found.block),
      ms: Date.now() - wallStart,
    }));
    if (found && found.block) break;
    if (attempt.status === 2) nonceBase += MINE_SLICE;
  }
  assert.ok(found && found.block, `need pow tried=${tried} bits=${packed}`);
  return store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  });
}

// Four-bit regtest work is about 16 hashes. A block mined here is stored
// under its own ShearHash, so a peer's hash_claim check passes on real data.
const REGTEST_TRIES = 8_192;

/** startNode on a regtest book. Same wiring, with no seeds and no stratum. */
async function startRegtestNode({ dataDir, p2pBind = '127.0.0.1', fluffDelayMs = null } = {}) {
  const store = createRegtestStore(dataDir, { bits: 4, yieldForeign: true });
  store.reserveVault = store.reserveVault || emptyVault();
  store.oracleSnapshot = loadOracleSnapshot({ dataDir });
  const p2p = createP2p({ store, port: 0, host: p2pBind, magic: store.magic, fluffDelayMs });
  const bound = await p2p.listen();
  const rpc = createRpc({ store, p2p, port: 0, host: '127.0.0.1' });
  const rpcBound = await rpc.listen();
  return { store, p2p, rpc, bound, rpcBound, magic: store.magic };
}

/** One regtest block with real proof of work, stored under its ShearHash. */
async function appendMined(store, dest, nowMs = null) {
  const parent = store.tip();
  const now = nowMs != null
    ? nowMs
    : (parent
      ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
      : 1_700_000_000_000);
  const want = regtestBitsOverride(MAGIC_REGTEST);
  const { tpl } = store.template({ miner: dest, bits: want, shareBits: 4, now });
  assert.equal(tpl.bits, want, 'template seals the regtest bits');
  const pot = (tpl.txs[0].vout || []).find((o) => o.kind === 'pot');
  const opening = pot && pot.r && pot.commit
    ? { r: Buffer.from(asU8(pot.r)), commit: Buffer.from(asU8(pot.commit)), v: openedCoinbaseNanos(pot) }
    : null;
  const found = await mineHeaderParallel(tpl.header, tpl.bits, REGTEST_TRIES, 1);
  assert.ok(found && found.block, 'regtest pow');
  const got = await Promise.resolve(store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }));
  assert.equal(got.ok, true, got.reason);
  return { tpl, opening, pot };
}

async function appendTrusted(store, dest, seq, nowMs = null) {
  const parent = store.tip();
  const now = nowMs != null
    ? nowMs
    : (parent
      ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
      : 1_700_000_000_000);
  const { tpl } = store.template({ miner: dest, bits: GENESIS_BITS_PACKED, shareBits: 4, now });
  const pot = (tpl.txs[0].vout || []).find((o) => o.kind === 'pot');
  const opening = pot && pot.r && pot.commit
    ? { r: Buffer.from(asU8(pot.r)), commit: Buffer.from(asU8(pot.commit)), v: openedCoinbaseNanos(pot) }
    : null;
  const pow = Buffer.alloc(32);
  pow.writeUInt32BE(seq >>> 0, 28);
  const got = await store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: pow, skipSharePow: true });
  assert.equal(got.ok, true, got.reason);
  return { tpl, opening, pot };
}

async function fundAnchor(store, id, { mined = false } = {}) {
  const box = spendBox(id);
  const minerDest = encodeDest(hash20FromAddress(box.dest), id.admitBase);
  const openings = [];
  const seal = (seq) => (mined ? appendMined(store, minerDest) : appendTrusted(store, minerDest, seq));
  const first = await seal(1);
  const born = first.opening;
  assert.ok(born && born.r && born.commit, 'pot opening');
  openings.push(born);
  const includeAt = readyHeight(1);
  let seq = 2;
  while (store.tip().height < includeAt - 1) {
    const next = await seal(seq);
    if (next.opening) openings.push(next.opening);
    seq += 1;
  }
  const anchor = walletAnchor(includeAt);
  const live = store.anchorNote(anchor);
  assert.ok(live && live.n >= 1, `anchor ${anchor}`);
  const coins = [];
  for (let b = 0; b < store.blocks.length && b < openings.length; b += 1) {
    const storedPot = (store.blocks[b].txs[0].vout || []).find((o) => o.kind === 'pot');
    const opening = openings[b];
    if (!storedPot?.commit || !opening?.r || !(opening.v > 0)) continue;
    const want = Buffer.from(asU8(storedPot.commit));
    let index = -1;
    for (let i = 0; i < live.n; i += 1) {
      if (Buffer.from(asU8(live.commits[i])).equals(want)) index = i;
    }
    if (index < 0) continue;
    coins.push({
      index,
      commit: Buffer.from(want),
      r: Buffer.from(opening.r),
      v: opening.v,
      x: admitScalarFromSeed(id.spendSeed, storedPot),
    });
  }
  assert.ok(coins.length >= 1, 'pot is inside the anchor');
  return {
    id,
    box,
    coin: coins[0],
    coins,
    anchor,
    live,
  };
}

function hiddenOut(nanos, dest20, admitBase, kind) {
  if (kind === 'dummy') {
    let note = sealNote(0, { dest20, kind: 'dummy' });
    note = attachAdmitPub(note, admitBase ? { admitBase } : {});
    return { ...note, kind: 'dummy', dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  }
  const sealed = admitBase
    ? sealHiddenNote(nanos, { dest20, kind, admitBase })
    : sealHiddenNote(nanos, { dest20, kind });
  let note = attachAdmitPub(sealed, admitBase ? { admitBase } : {});
  note = { ...note, kind, dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  delete note.valueProof;
  return note;
}

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function fs1Send({ id, coin, anchor, live, magic, outsOf }) {
  const ph = Buffer.alloc(fs1BlobLen(1), 255);
  ph[0] = FS1_WIRE;
  const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
  blob[0] = FS1_WIRE;
  const proofs = [{ admit_proof: true, v: 3, spendTag: Buffer.alloc(32, 255), blob, cTilde: Buffer.alloc(32, 255) }];
  let fee = LEVY_FLOOR_UNITS;
  let outs = null;
  let draft = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const room = coin.v - fee;
    if (room < 1) return null;
    outs = outsOf(room);
    draft = compactTx({
      id,
      kind: 'send',
      anchor,
      fee,
      vin: [{ commit: Buffer.alloc(32, 255) }],
      vout: outs,
      fs1: ph,
      admit_proofs: proofs,
      excess: Buffer.alloc(32, 255),
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    const next = need + rangeSlack(outs);
    if (!(next > fee && next <= LEVY_CAP_NANOS)) return null;
    fee = next;
    draft = null;
  }
  if (!draft) return null;
  const proven = fs1ProveSpend({
    live,
    anchor,
    indices: [coin.index],
    xs: [coin.x],
    tx: draft,
    magic,
  });
  if (!proven) return null;
  const excess = kernelExcess(outs, [{ r: coin.r, t: proven.t[0] }]);
  if (!excess) return null;
  return compactTx({
    id,
    kind: 'send',
    anchor,
    fee: draft.fee,
    vin: [{ commit: Buffer.from(proven.proofs[0].cTilde) }],
    vout: outs,
    fs1: proven.fs1,
    admit_proofs: proven.proofs,
    excess,
  });
}

function fs1Lock({ id, coins, anchor, live, magic, dest20, bodyDest20, portalId, admitBase, ownerPub, stamp, proveHeight }) {
  const use = [];
  let total = 0;
  for (const coin of coins) {
    use.push(coin);
    total += coin.v;
    if (use.length >= 4 && total > PI_SHE_NANOS + LEVY_CAP_NANOS) break;
  }
  if (!(total > PI_SHE_NANOS + LEVY_FLOOR_UNITS)) return null;
  const k = use.length;
  const ph = Buffer.alloc(fs1BlobLen(k), 255);
  ph[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < k; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({ admit_proof: true, v: FS1_WIRE, spendTag: Buffer.alloc(32, 255), blob, cTilde: Buffer.alloc(32, 255) });
  }
  let fee = LEVY_FLOOR_UNITS;
  let outs = null;
  let draft = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const room = total - fee;
    if (room <= PI_SHE_NANOS) return null;
    // A published amount makes the lock opened:false, and the vault trial
    // refuses that as stake_reward. The leaf is exactly π, with the range
    // proof and no valueProof. Change stays hidden.
    const lockNote = sealNote(PI_SHE_NANOS, { dest20, kind: 'lock' });
    delete lockNote.valueProof;
    outs = [
      {
        ...lockNote,
        kind: 'lock',
        dest20: Buffer.from(dest20),
        unlockAtMs: stamp.unlockAtMs,
        lockEpoch: stamp.epoch,
        viewTag: viewTagOf(lockNote.noteCommit),
      },
      hiddenOut(room - PI_SHE_NANOS, dest20, admitBase, 'send'),
    ];
    draft = compactTx({
      id,
      kind: 'lock',
      anchor,
      fee,
      programId: RESERVE_PROGRAM,
      portalId,
      ownerPub,
      vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })),
      vout: outs,
      fs1: ph,
      admit_proofs: proofs,
      excess: Buffer.alloc(32, 255),
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    const next = need + rangeSlack(outs);
    if (!(next > fee && next <= LEVY_CAP_NANOS)) return null;
    fee = next;
    draft = null;
  }
  if (!draft) return null;
  const lockBlindEarly = outs[0].r;
  const piProof = proveRange(0n, lockBlindEarly);
  if (!piProof) return null;
  draft.piProof = piProof;
  const proven = fs1ProveSpend({
    live,
    anchor,
    indices: use.map((c) => c.index),
    xs: use.map((c) => c.x),
    tx: draft,
    magic,
  });
  if (!proven) return null;
  const excess = kernelExcess(outs, use.map((c, i) => ({ r: c.r, t: proven.t[i] })));
  if (!excess) return null;
  const tx = compactTx({
    id,
    kind: 'lock',
    anchor,
    fee: draft.fee,
    programId: RESERVE_PROGRAM,
    portalId,
    ownerPub,
    vin: proven.proofs.map((p) => ({ commit: Buffer.from(p.cTilde) })),
    vout: outs,
    fs1: proven.fs1,
    admit_proofs: proven.proofs,
    excess,
    piProof,
  });
  const spend20 = bodyDest20 || dest20;
  tx.dest20 = Buffer.from(spend20);
  const scalar = randomScalar();
  const lockBlind = outs[0].r;
  const lockRow = tx.vout.find((row) => String(row?.kind || '') === 'lock');
  const unlock = consensusUnlockPeriod(stamp.epoch);
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, lockBlind, unlock);
  if (!leaf || !lockRow || lockBlind == null) return null;
  tx.vaultLockNote = leaf.note;
  const fund = proveLockEquality(lockRow.commit, PI_SHE_NANOS, lockBlind, tx, magic, proveHeight);
  if (!tx.piProof || !fund) return null;
  lockRow.fundProof = fund;
  return { tx, scalar, blind: lockBlind, unlock };
}

function bindCoins(store, rows) {
  const height = store.tip().height + 1;
  const anchor = walletAnchor(height);
  const live = store.anchorNote(anchor);
  const at = new Map();
  if (live) {
    for (let i = 0; i < live.n; i += 1) {
      at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
    }
  }
  const coins = [];
  for (const row of rows) {
    const key = Buffer.from(asU8(row.commit)).toString('hex');
    if (!at.has(key)) continue;
    coins.push({ ...row, index: at.get(key) });
  }
  return { anchor, live, coins };
}

function fs1LeafVote({ id, coin, anchor, live, magic, voteProof }) {
  const ph = Buffer.alloc(fs1BlobLen(1), 255);
  ph[0] = FS1_WIRE;
  const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
  blob[0] = FS1_WIRE;
  const proofs = [{ blob, cTilde: Buffer.alloc(32, 255), spendTag: Buffer.alloc(32, 255) }];
  const d20 = Buffer.from(asU8(voteProof.dest20));
  let fee = LEVY_FLOOR_UNITS;
  let outs = null;
  let draft = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const changeN = coin.v - fee;
    if (changeN <= 0) return null;
    outs = [hiddenOut(changeN, d20, null, 'send')];
    draft = compactTx({
      id,
      kind: 'leaf-vote',
      anchor,
      fee,
      programId: RESERVE_PROGRAM,
      voteProof: voteProof.blob,
      voteOutput: voteProof.note,
      choice: 1,
      voteSeq: 1,
      voteParam: 'hb',
      earnEpoch: 1,
      vin: [{ commit: Buffer.alloc(32, 255) }],
      vout: outs,
      fs1: ph,
      admit_proofs: proofs,
      excess: Buffer.alloc(32, 255),
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    const next = need + rangeSlack(outs);
    if (!(next > fee && next <= LEVY_CAP_NANOS)) return null;
    fee = next;
    draft = null;
  }
  if (!draft) return null;
  const proven = fs1ProveSpend({
    live,
    anchor,
    indices: [coin.index],
    xs: [coin.x],
    tx: draft,
    magic,
  });
  if (!proven) return null;
  const excess = kernelExcess(outs, [{ r: coin.r, t: proven.t[0] }]);
  if (!excess) return null;
  return compactTx({
    id,
    kind: 'leaf-vote',
    anchor,
    fee: draft.fee,
    programId: RESERVE_PROGRAM,
    voteProof: voteProof.blob,
    voteOutput: voteProof.note,
    choice: 1,
    voteSeq: 1,
    voteParam: 'hb',
    earnEpoch: 1,
    vin: [{ commit: Buffer.from(proven.proofs[0].cTilde) }],
    vout: outs,
    fs1: proven.fs1,
    admit_proofs: proven.proofs,
    excess,
  });
}

function fs1GossipSend({ id, store, funded, payee }) {
  const pay20 = hash20FromAddress(spendBox(payee).dest);
  const change20 = hash20FromAddress(funded.box.dest);
  return fs1Send({
    id,
    coin: funded.coin,
    anchor: funded.anchor,
    live: funded.live,
    magic: store.magic,
    outsOf: (room) => {
      const pay = Math.max(1, Math.floor(room / 3));
      return [
        hiddenOut(pay, pay20, payee.admitBase, 'send'),
        hiddenOut(room - pay, change20, funded.id.admitBase, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ];
    },
  });
}

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe('p2p gossip', { timeout: fileCapMs(import.meta.url) }, () => {
  it('two loopback nodes converge on the same most-work tip', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      const mined = await mineOne(a.store, dest);
      assert.equal(mined.ok, true, mined.reason);
      a.p2p.announce();
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const synced = await waitFor(() => {
        const ta = a.store.tip();
        const tb = b.store.tip();
        if (!ta || !tb) return false;
        return ta.height === tb.height
          && Buffer.from(ta.hash).equals(Buffer.from(tb.hash));
      });
      assert.equal(synced, true);
      assert.equal(a.store.tip().height, 1);
      assert.equal(b.store.tip().height, 1);
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });

  it('retries prev misses and does not blacklist them as final', () => {
    assert.equal(isFinalIngestFail('prev'), false);
    assert.equal(isFinalIngestFail('hash_bonus'), false);
    assert.equal(isFinalIngestFail('native_missing'), false);
    assert.equal(isFinalIngestFail('ShearHash-v3 native addon missing and ShearK-Miner not built'), false);
    assert.equal(isFinalIngestFail('merkle'), true);
    const recBan = { expensiveFails: 0 };
    for (let i = 0; i < P2P_FAIL_DISCONNECT + 2; i += 1) {
      assert.equal(recordIngestFail(recBan, 'prev'), false);
    }
    assert.equal(recBan.expensiveFails, 0);
    assert.equal(isFinalIngestFail('pow'), true);
    assert.equal(isFinalIngestFail(''), true);
    const rec = { want: [], pending: new Set(['parent']), retryPrev: [] };
    requeuePrevHash(rec, 'child');
    assert.deepEqual(rec.retryPrev, ['child']);
    drainRetryPrev(rec);
    assert.deepEqual(rec.retryPrev, ['child']);
    rec.pending = new Set();
    drainRetryPrev(rec);
    assert.deepEqual(rec.want, ['child']);
    assert.deepEqual(rec.retryPrev, []);
    const mk = fs.readFileSync(new URL('../../crypto/native/Makefile', import.meta.url), 'utf8');
    assert.match(mk, /-z,noexecstack/);
  });

  it('counts currently seen synced remotes, not historical uniques', () => {
    const local = 'abc';
    const live = [
      { remote: '1.1.1.1', hash: 'abc', id: 1 },
      { remote: '2.2.2.2', hash: 'abc', id: 2 },
      { remote: '3.3.3.3', hash: 'old', id: 3 },
    ];
    assert.equal(countSyncedOnline({ localHash: local, peers: live }), 3);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: live.filter((p) => p.remote !== '2.2.2.2'),
    }), 2);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: [
        { remote: '1.1.1.1', hash: 'abc', id: 1 },
        { remote: '1.1.1.1', hash: 'abc', id: 9 },
      ],
    }), 2);
    assert.equal(countSyncedOnline({ localHash: local, peers: [] }), 1);
    assert.equal(countLiveOnline({ peers: live }), 4);
    assert.equal(countLiveOnline({ peers: live.filter((p) => p.hash === 'old') }), 2);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: [{ remote: '1.1.1.1', hash: 'abc', nodeId: 'aa' }],
      heard: [{ nodeId: 'bb', host: '9.9.9.9', remote: '9.9.9.9', hash: 'abc' }],
    }), 3);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: [{ remote: '1.1.1.1', hash: 'abc', nodeId: 'aa' }],
      heard: [{ nodeId: 'aa', host: '1.1.1.1', remote: '1.1.1.1', hash: 'abc' }],
    }), 2);
    assert.equal(countSyncedOnline({
      localHash: local,
      peers: [],
      heard: [{ nodeId: 'bb', host: '9.9.9.9', remote: '9.9.9.9', hash: 'old' }],
    }), 1);
  });

  it('two connected empty nodes each see the other as online, then drop on close', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-on-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-on-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      assert.equal(a.p2p.syncedOnline(), 1);
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const both = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2);
      assert.equal(both, true);
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
    assert.equal(a.p2p.syncedOnline(), 1);
  });

  it('counts a synced node that dialed a peer of ours, not only a direct socket', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-hop-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-hop-b-'));
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-hop-c-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const c = await startNode({ dataDir: dirC, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      await c.p2p.connect('127.0.0.1', b.bound.port);
      const seen = await waitFor(
        () => a.p2p.syncedOnline() >= 3 && c.p2p.syncedOnline() >= 3 && b.p2p.syncedOnline() >= 3,
        8000,
      );
      assert.equal(seen, true, `a=${a.p2p.syncedOnline()} b=${b.p2p.syncedOnline()} c=${c.p2p.syncedOnline()}`);
    } finally {
      a.p2p.close();
      b.p2p.close();
      c.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
      await c.rpc?.close?.();
    }
  });

  it('forwards a newer miner round across a two-hop line and does not loop an equal count', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-hop-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-hop-b-'));
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-hop-c-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const c = await startNode({ dataDir: dirC, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      await c.p2p.connect('127.0.0.1', b.bound.port);
      const linked = await waitFor(() => a.p2p.syncedOnline() === 2 && c.p2p.syncedOnline() === 2, 8000);
      assert.equal(linked, true, 'line A-B-C did not finish the handshakes');
      const tag = 'mdeadbeef';
      a.p2p.publishWork([{ tag, count: 42, dest: 'ssa1qshouldnottravel', hashrate: 99999 }]);
      const heard = await waitFor(() => (
        c.store.openRoundRows().some((r) => r.tag === tag && Number(r.count) === 42)
      ), 8000);
      assert.equal(heard, true, 'two-hop node never stored the proven round');
      assert.doesNotMatch(JSON.stringify(c.store.openRoundRows()), /ssa1|hashrate|shouldnottravel/);
      a.p2p.publishWork([{ tag, count: 42 }]);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(c.store.openRoundRows().filter((r) => r.tag === tag).length, 1);
      assert.equal(c.store.openRoundRows().find((r) => r.tag === tag).count, 42);
      a.p2p.publishWork([{ tag, count: 50 }]);
      const higher = await waitFor(() => (
        c.store.openRoundRows().some((r) => r.tag === tag && Number(r.count) === 50)
      ), 8000);
      assert.equal(higher, true, 'a higher proven count did not cross the hop');
    } finally {
      a.p2p.close();
      b.p2p.close();
      c.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
      await c.rpc?.close?.();
    }
  });

  it('gossips pending sends and open-round miner rows onto a peer lattice', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-mem-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p2p-mem-b-'));
    // Regtest funding blocks are stored under their own ShearHash, so B
    // syncs them through the real claim and work checks.
    const a = await startRegtestNode({ dataDir: dirA, fluffDelayMs: 0 });
    const b = await startRegtestNode({ dataDir: dirB, fluffDelayMs: 0 });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const linked = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2);
      assert.equal(linked, true);
      const payer = newIdentity();
      const funded = await fundAnchor(a.store, payer, { mined: true });
      const synced = await waitFor(() => Number(b.store.tip()?.height || 0) >= a.store.tip().height, 20000);
      assert.equal(synced, true, 'peer did not sync mined block');
      const tx = fs1GossipSend({ id: 'net-send-1', store: a.store, funded, payee: newIdentity() });
      assert.ok(tx, 'net-send-1 proof');
      const queued = a.store.queueTx(tx);
      assert.equal(queued.ok, true, queued.reason);
      const tag = 'mcafef00d';
      let lastPub = 0;
      const saw = await waitFor(() => {
        if (Date.now() - lastPub > 200) {
          a.p2p.publishWork([{ tag, count: 42 }]);
          lastPub = Date.now();
        }
        const tx = (b.store.mempool || []).some((t) => String(t.id) === 'net-send-1');
        const work = typeof b.store.openRoundRows === 'function'
          && b.store.openRoundRows().some((r) => r.tag === tag && Number(r.count) === 42);
        return tx && work;
      }, 15000);
      assert.equal(saw, true, 'peer book never received send or miner row');
      const { mempoolLattice } = await import('../../pool/src/wallet_api.js');
      const out = mempoolLattice(b.store, {
        miners: new Map(),
        lastJob: { height: 1, jobId: 'peer' },
        nodesOnline: b.p2p.syncedOnline(),
      });
      assert.equal(out.scope, 'network');
      assert.equal(out.pending.some((t) => t.id === 'net-send-1'), true);
      const row = out.pendingBlock.txs.find((t) => t.tag === tag);
      assert.ok(row, 'lattice payload missing peer miner row');
      assert.equal(row.count, 42);
      assert.equal(row.kind, 'hash');
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });

  it('default getblock batch is a small window so IBD overlaps RTT; wire bytes are hex', () => {
    assert.equal(GETBLOCK_BATCH, 16);
    assert.ok(GETBLOCK_BATCH <= 64);
    const commit = Buffer.alloc(32, 9);
    const wire = encodeWireBlock({
      header: Buffer.alloc(128, 1),
      hash: Buffer.alloc(32, 2),
      height: 3,
      txs: [{ coinbase: true, height: 3, vout: [{ kind: 'pot', commit }] }],
      shareBatch: [],
    });
    const blob = jsonWire(wire);
    assert.doesNotMatch(blob, /"type":"Buffer"/);
    assert.match(blob, /\$hex/);
    const back = decodeWireBlock(JSON.parse(blob));
    assert.equal(Buffer.from(back.txs[0].vout[0].commit).equals(commit), true);
  });

  it('wireHash and decodeWireBlock accept hex, $hex, and Buffer JSON so genesis getblock matches', () => {
    const hex = `00${'ab'.repeat(31)}`;
    assert.equal(wireHash(hex), hex);
    assert.equal(wireHash({ $hex: hex }), hex);
    assert.equal(wireHash({ type: 'Buffer', data: [...Buffer.from(hex, 'hex')] }), hex);
    assert.equal(wireHash({}), '');
    assert.equal(wireHash('[object Object]'), '');
    const header = Buffer.alloc(128, 3);
    const hash = Buffer.from(hex, 'hex');
    const wrapped = decodeWireBlock({
      header: { $hex: header.toString('hex') },
      hash: { $hex: hex },
      height: 1,
      txs: [],
      shareBatch: [],
    });
    assert.equal(Buffer.from(wrapped.header).equals(header), true);
    assert.equal(Buffer.from(wrapped.hash).equals(hash), true);
    const fromBuf = decodeWireBlock({
      header: { type: 'Buffer', data: [...header] },
      hash: { type: 'Buffer', data: [...hash] },
      height: 1,
      txs: [],
    });
    assert.equal(Buffer.from(fromBuf.header).equals(header), true);
    assert.equal(Buffer.from(fromBuf.hash).equals(hash), true);
  });

  it('printConfig pins p2p 30303, testnet magic, not mainnet', () => {
    const cfg = printConfig();
    assert.equal(cfg.p2p, P2P_PORT);
    assert.equal(cfg.p2p, 30303);
    assert.equal(cfg.magic, MAGIC_TESTNET);
    assert.equal(cfg.version, PRODUCT_VERSION);
    assert.equal(cfg.display, NODE_DISPLAY);
    assert.equal(NODE_DISPLAY, `Shear Sentinel v${PRODUCT_VERSION.split('.')[0]}`);
    assert.equal(cfg.name, 'Shear Sentinel');
    assert.equal(cfg.mainnet, false);
    assert.equal(cfg.phaseBGate, true);
    assert.equal(cfg.rpc, 18332);
    assert.equal(cfg.admit, 'ADMITv3');
    assert.equal(cfg.hashTxLive, 1);
    assert.equal(cfg.archival, true);
    assert.equal(cfg.fastSync, false);
  });

  it('default datadir is archival; --fast-sync only skips share POW, not sealed txs', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-arch-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fast-'));
    const a = createStore(dirA);
    const b = createStore(dirB, { fastSync: true });
    assert.equal(a.archival, true);
    assert.equal(a.fastSync, false);
    assert.equal(b.archival, false);
    assert.equal(b.fastSync, true);
  });

  it('pickStemSocket returns one peer; fluff delay is 1–3 s; no IP beside dest in logs', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    const picked = pickStemSocket(new Set([a, b, c]), a, () => 0);
    assert.equal(picked === b || picked === c, true);
    assert.notEqual(picked, a);
    assert.equal(pickStemSocket(new Set([a]), a), null);
    const d = fluffDelayMs(() => 0);
    const e = fluffDelayMs(() => 0.999);
    assert.ok(d >= FLUFF_MIN_MS && d <= FLUFF_MAX_MS);
    assert.ok(e >= FLUFF_MIN_MS && e <= FLUFF_MAX_MS);
    assert.equal(STEM_MAX_HOPS, 3);
    assert.equal(lineHasIpBesideIdentity('remoteAddress 1.2.3.4 dest ssa1abc'), true);
    assert.equal(lineHasIpBesideIdentity('tx net-send-1 queued'), false);
    const note = peerEventFields({ event: 'stem', remote: '1.2.3.4' });
    assert.equal(note.remote, 'peer');
    assert.equal(JSON.stringify(note).includes('1.2.3.4'), false);
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    for (const line of src.split('\n')) {
      if (!/console\.(log|info|warn|error)/.test(line)) continue;
      assert.equal(lineHasIpBesideIdentity(line), false, line);
    }
  });

  it('originator first inv set size is 1, then fluff reaches a 3-node graph', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stem-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stem-b-'));
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-stem-c-'));
    const a = await startRegtestNode({ dataDir: dirA, fluffDelayMs: 40 });
    const b = await startRegtestNode({ dataDir: dirB, fluffDelayMs: 40 });
    const c = await startRegtestNode({ dataDir: dirC, fluffDelayMs: 40 });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      await a.p2p.connect('127.0.0.1', c.bound.port);
      const linked = await waitFor(() => a.p2p.syncedOnline() >= 2);
      assert.equal(linked, true);
      const payer = newIdentity();
      const funded = await fundAnchor(a.store, payer, { mined: true });
      const synced = await waitFor(() => (
        Number(b.store.tip()?.height || 0) >= a.store.tip().height
        && Number(c.store.tip()?.height || 0) >= a.store.tip().height
      ), 20000);
      assert.equal(synced, true, 'peer did not sync mined block');
      const tx = fs1GossipSend({ id: 'stem-send-1', store: a.store, funded, payee: newIdentity() });
      assert.ok(tx, 'stem-send-1 proof');
      const queued = a.store.queueTx(tx);
      assert.equal(queued.ok, true, queued.reason);
      assert.equal(JSON.stringify(queued.tx || queued).includes('remoteAddress'), false);
      assert.equal(a.p2p.originInvSetSize('stem-send-1'), 1);
      const has = (node) => (node.store.mempool || []).some((t) => String(t.id) === 'stem-send-1');
      const fluffed = await waitFor(() => has(b) && has(c), 3000);
      assert.equal(fluffed, true, 'fluff did not reach both peers');
    } finally {
      a.p2p.close();
      b.p2p.close();
      c.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
      await c.rpc?.close?.();
    }
  });

  it('lock and vote still paint (pending) after fluff', { timeout: 600_000 }, async () => {
    const id = newIdentity();
    const box = spendBox(id);
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fluff-lock-seed-'));
    const seeded = createStore(seedDir);
    const funded = await fundAnchor(seeded, id);
    const minerDest = encodeDest(hash20FromAddress(box.dest), id.admitBase);
    const tipMs = (store) => Number(decodeHeader(Buffer.from(store.tip().header)).timestamp);
    const portals = portalsFromSeed(id.spendSeed, 2);
    assert.equal(portals.length, 2, 'two portals');
    assert.notEqual(portals[0].portalId, portals[1].portalId, 'one portal per lock');
    // dest20 is the portal spend key. portalOwnerKey does not match that dest20.
    const ownerKey = ed25519PrivateFromSeed(portals[0].spendSeed);
    const ownerPub = ed25519RawPub(ownerKey).toString('hex');
    const genesis = seeded.blocks.find((b) => Number(b.height) === 1) || seeded.blocks[0];
    const genesisMs = Number(decodeHeader(Buffer.from(genesis.header)).timestamp);
    const stamp = lockUnlockOf({ genesisMs, magic: seeded.magic }, tipMs(seeded));
    const minedCoins = funded.coins.slice(0, 4);
    assert.equal(minedCoins.length, 4, 'seed lock inputs');
    const mined = fs1Lock({
      id: 'lock-seed',
      coins: minedCoins,
      anchor: funded.anchor,
      live: funded.live,
      magic: seeded.magic,
      dest20: portals[0].dest20,
      bodyDest20: destCommitFromSpendPub(ed25519RawPub(ownerKey)),
      portalId: portals[0].portalId,
      admitBase: id.admitBase,
      ownerPub,
      stamp,
      proveHeight: seeded.tip().height + 1,
    });
    assert.ok(mined, 'fs1 lock');
    signSpendTx(mined.tx, ownerKey, { magic: 'shear-testnet-v12' });
    delete mined.tx.spendPub;
    delete mined.tx.sig;
    delete mined.tx.signature;
    assert.equal(mined.tx.spendPub, undefined, 'seed spendPub');
    assert.equal(mined.tx.sig, undefined, 'seed sig');
    assert.equal(mined.tx.signature, undefined, 'seed signature');
    resetFs1Tree();
    const qSeed = seeded.queueTx(mined.tx);
    assert.equal(qSeed.ok, true, `seed lock ${qSeed.reason}`);
    let seq = 1000;
    const sealed = await appendTrusted(seeded, minerDest, seq);
    seq += 1;
    assert.ok(sealed.tpl.txs.some((row) => row.id === 'lock-seed'), 'seed lock mined');
    while (seeded.tip().height < 240) {
      await appendTrusted(seeded, minerDest, seq);
      seq += 1;
    }
    assert.equal(String(seeded.reserveVault.epochStartRoots?.['1'] || ''), seeded.reserveVault.vaultLockRoot, 'period root');
    const target = genesisMs + RESERVE_EPOCH_MS;
    // Pots from the funding anchor fall out of the 64-block window during
    // this walk. Keep the recent coinbases; the pending lock spends those.
    const recent = [];
    const keepPot = (built) => {
      if (!built?.opening || !built?.pot) return;
      recent.push({ opening: built.opening, pot: built.pot });
      if (recent.length > 48) recent.shift();
    };
    let guard = 0;
    while (tipMs(seeded) < target) {
      guard += 1;
      assert.ok(guard < 2000, 'clock');
      keepPot(await appendTrusted(seeded, minerDest, seq, Math.min(target, tipMs(seeded) + 15 * 60_000)));
      seq += 1;
    }
    // The boundary block enacts the empty ballot and stays on epoch 0.
    // The next block opens epoch 1 and writes that epoch's census.
    keepPot(await appendTrusted(seeded, minerDest, seq, tipMs(seeded) + 90_000));
    seq += 1;
    assert.equal(seeded.reserveVault.currentEpoch, 1, 'epoch rolled');
    const census = censusOf(seeded.reserveVault, 1);
    assert.ok(census && census.leafCount >= 1, 'census');
    const voteProof = proveLeafVote({
      locks: [{
        amount: PI_SHE_NANOS,
        scalar: mined.scalar,
        blind: mined.blind,
        unlockEpoch: mined.unlock,
      }],
      which: 0,
      epoch: 1,
      choice: 1,
      seq: 1,
      proposalId: proposalId(1, 'hb'),
      dest20: hash20FromAddress(box.dest),
    });
    assert.ok(voteProof, 'vote proof');
    assert.equal(voteProof.rootHex, censusRoot(seeded.reserveVault, 1), 'vote root is the epoch-1 census root');
    const late = bindCoins(seeded, recent.map((row) => ({
      commit: row.opening.commit,
      r: row.opening.r,
      v: row.opening.v,
      x: admitScalarFromSeed(id.spendSeed, row.pot),
    })));
    assert.ok(late.coins.length >= 5, `late coins ${late.coins.length}`);
    const pendingKey = ed25519PrivateFromSeed(portals[1].spendSeed);
    const pendingPub = ed25519RawPub(pendingKey).toString('hex');
    const lateStamp = lockUnlockOf(seeded.reserveVault, tipMs(seeded));
    resetFs1Tree();
    const pending = fs1Lock({
      id: 'lock-fluff',
      coins: late.coins.slice(0, 4),
      anchor: late.anchor,
      live: late.live,
      magic: seeded.magic,
      dest20: portals[1].dest20,
      bodyDest20: destCommitFromSpendPub(ed25519RawPub(pendingKey)),
      portalId: portals[1].portalId,
      admitBase: id.admitBase,
      ownerPub: pendingPub,
      stamp: lateStamp,
      proveHeight: seeded.tip().height + 1,
    });
    assert.ok(pending, 'pending lock');
    signSpendTx(pending.tx, pendingKey, { magic: 'shear-testnet-v12' });
    delete pending.tx.spendPub;
    delete pending.tx.sig;
    delete pending.tx.signature;
    assert.equal(pending.tx.spendPub, undefined, 'pending spendPub');
    assert.equal(pending.tx.sig, undefined, 'pending sig');
    assert.equal(pending.tx.signature, undefined, 'pending signature');
    resetFs1Tree();
    const vote = fs1LeafVote({
      id: 'vote-fluff',
      coin: late.coins[4],
      anchor: late.anchor,
      live: late.live,
      magic: seeded.magic,
      voteProof,
    });
    assert.ok(vote, 'leaf vote');
    assert.equal(vote.kind, 'leaf-vote');
    assert.equal(vote.to, undefined);
    assert.equal(vote.portalId, undefined);
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fluff-lock-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fluff-lock-b-'));
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fluff-lock-c-'));
    // startNode applies the datadir ACL. Copying a sealed book into a fresh
    // directory makes the second icacls fail, so open the empty dirs first.
    const warm = async (dir) => {
      const node = await startNode({ dataDir: dir, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
      node.p2p.close();
      await node.rpc?.close?.();
    };
    await warm(dirA);
    await warm(dirB);
    await warm(dirC);
    const copyLoose = (src, dst) => {
      for (const name of fs.readdirSync(src)) {
        const from = path.join(src, name);
        const to = path.join(dst, name);
        if (fs.statSync(from).isDirectory()) {
          fs.mkdirSync(to, { recursive: true });
          copyLoose(from, to);
        } else {
          fs.writeFileSync(to, fs.readFileSync(from));
        }
      }
    };
    for (const dir of [dirA, dirB, dirC]) {
      copyLoose(seedDir, dir);
      fs.copyFileSync(bookSealKeyPath(seedDir), bookSealKeyPath(dir));
    }
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    const c = await startNode({ dataDir: dirC, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [], fluffDelayMs: 40 });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      await a.p2p.connect('127.0.0.1', c.bound.port);
      await waitFor(() => a.p2p.syncedOnline() >= 2);
      // Stage 3b. The pending lock and the FS-1 leaf vote both gossip.
      // A kind:vote body is vote_retired and does not paint.
      const qLock = a.store.queueTx(pending.tx);
      const qVote = a.store.queueTx(vote);
      assert.equal(qLock.ok, true, qLock.reason);
      assert.equal(qVote.ok, true, qVote.reason);
      assert.notEqual(qVote.reason, 'vote_retired');
      assert.equal(a.p2p.originInvSetSize('lock-fluff'), 1);
      assert.equal(a.p2p.originInvSetSize('vote-fluff'), 1);
      const { explorerRecentTxs, publicPayloadLeaksIdentity } = await import('../../pool/src/wallet_api.js');
      const painted = await waitFor(() => {
        const rows = explorerRecentTxs(c.store, 30);
        const lockRow = rows.find((t) => t.id === 'lock-fluff');
        const voteRow = rows.find((t) => t.id === 'vote-fluff');
        return lockRow?.pending === true && voteRow?.pending === true
          && lockRow.kind === 'lock' && voteRow.kind === 'leaf-vote';
      }, 8000);
      assert.equal(painted, true);
      const rows = explorerRecentTxs(c.store, 30);
      const lockRow = rows.find((t) => t.id === 'lock-fluff');
      const voteRow = rows.find((t) => t.id === 'vote-fluff');
      assert.equal(lockRow.to, '');
      assert.equal(voteRow.to, '');
      assert.equal(publicPayloadLeaksIdentity(lockRow), false);
      assert.equal(publicPayloadLeaksIdentity(voteRow), false);
      assert.equal(lockRow.memoPlain, undefined);
    } finally {
      a?.p2p?.close();
      b?.p2p?.close();
      c?.p2p?.close();
      await a?.rpc?.close?.();
      await b?.rpc?.close?.();
      await c?.rpc?.close?.();
    }
  });

  it('drops metadata/RFC1918 addrs and getblocks; seeds include the public P2P node', () => {
    assert.equal(isRoutablePeerAddr('169.254.169.254'), false);
    assert.equal(isRoutablePeerAddr('10.0.0.1'), false);
    assert.equal(isRoutablePeerAddr('192.168.1.1'), false);
    assert.equal(isRoutablePeerAddr('127.0.0.1'), false);
    assert.equal(isRoutablePeerAddr('1.1.1.1'), true);
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    assert.match(src, /getblocks/);
    assert.match(src, /sock\.destroy\(\)/);
    assert.equal(src.includes('seenTx.clear()'), false);
    const storeSrc = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    assert.doesNotMatch(storeSrc, /skipSharePow: !!verifyOpts\.skipSharePow \|\| archiveFast/);
    assert.match(storeSrc, /allowTrust = verifyOpts\?\.trusted === true/);
    assert.match(storeSrc, /skipSharePow: !!okHash/);
    assert.doesNotMatch(storeSrc, /skipSharePow: !!params\.skipSharePow/);
    const nodeSrc = fs.readFileSync(new URL('../src/node.js', import.meta.url), 'utf8');
    assert.match(nodeSrc, /skip archival bodies \(not share PoW/);

    assert.ok(DEFAULT_SEEDS.includes('p2p.shear.digital:30303'));
    assert.ok(DEFAULT_SEEDS.includes('r2r.shear.digital:30303'));
    assert.ok(DEFAULT_SEEDS.includes('b2b.shear.digital:30303'));
    assert.equal(DEFAULT_SEEDS.length >= 2, true);
    assert.equal(DEFAULT_SEEDS.some((s) => String(s).includes('46.224.132.83')), false);
    assert.equal(DEFAULT_SEEDS.some((s) => String(s).includes('77.42.91.84')), false);
    assert.equal(DEFAULT_SEEDS.some((s) => String(s).includes('157.180.70.110')), false);
    assert.equal(DEFAULT_SEEDS.some((s) => String(s).includes('157.180.70.100')), false);
    assert.equal(DEFAULT_SEEDS.some((s) => String(s).includes('2.28.8.89')), false);
    assert.equal(DEFAULT_SEEDS.some((s) => String(s).includes('178.105.187.178')), false);
    assert.equal(DEFAULT_SEEDS.some((s) => String(s).includes('178.156.222.223')), false);
    assert.equal(DEFAULT_SEEDS.includes('shear.digital:30303'), false);
    assert.equal(DEFAULT_SEEDS.some((s) => /^shear\.digital:/.test(s)), false);
    assert.equal(GETBLOCK_BATCH, 16);
    assert.equal(HEADERS_PAGE, 2000);
    assert.match(src, /requestHeaders/);
    assert.match(src, /dialSeeds/);
    assert.equal(P2P_MAX_FRAME_DEFAULT, 16 * 1024 * 1024);
    assert.ok(P2P_MAX_FRAME >= 8 * 1024 * 1024);
    assert.equal(ipv4Subnet24('1.2.3.4'), '1.2.3.0');
    const rec = { expensiveFails: 0 };
    for (let i = 0; i < P2P_FAIL_DISCONNECT - 1; i += 1) {
      assert.equal(noteExpensiveFail(rec), false);
    }
    assert.equal(noteExpensiveFail(rec), true);
    const fakePeers = new Map();
    fakePeers.set(1, { inbound: true, remote: '10.1.2.9' });
    fakePeers.set(2, { inbound: true, remote: '10.1.2.8' });
    fakePeers.set(3, { inbound: false, remote: '10.1.2.7' });
    assert.equal(inboundCountForSubnet(fakePeers, '10.1.2.0'), 2);
    assert.equal(src.includes('hdrs.slice(-2000)'), false);
    assert.match(src, /function ibdBusy/);
    assert.match(src, /if \(ibdBusy\(\)\) return;/);
    assert.match(src, /function peerTipAhead/);
    assert.match(src, /function peerTipAheadOf/);
    assert.match(src, /peerH > localH/);
    assert.doesNotMatch(src, /hashAhead/);
    assert.doesNotMatch(src, /peerHash !== local/);
    assert.match(src, /maxPeers/);
    assert.match(src, /SHEAR_MAX_PEERS/);
  });

  it('max-peers disconnects extra inbound sockets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-maxpeer-'));
    const store = createStore(dir);
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET, maxPeers: 1 });
    const bound = await p2p.listen();
    const first = net.connect(bound.port, '127.0.0.1');
    await new Promise((r) => first.once('connect', r));
    await new Promise((r) => setTimeout(r, 80));
    const second = net.connect(bound.port, '127.0.0.1');
    const dropped = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      second.once('close', () => { clearTimeout(t); resolve(true); });
      second.once('error', () => { clearTimeout(t); resolve(true); });
    });
    try { first.destroy(); } catch { /* ignore */ }
    try { second.destroy(); } catch { /* ignore */ }
    p2p.close();
    assert.equal(dropped, true);
  });
});

function fakeBlocks(n) {
  const blocks = [];
  for (let i = 1; i <= n; i += 1) {
    const hash = Buffer.alloc(32);
    hash.writeUInt32BE(i, 28);
    const header = Buffer.alloc(128);
    header.writeUInt32BE(i, 0);
    blocks.push({ header, hash, height: i });
  }
  return blocks;
}

function fakeHash(n) {
  const hash = Buffer.alloc(32);
  hash.writeUInt32BE(n, 28);
  return hash.toString('hex');
}

async function mineChainOne(store, dest) {
  const got = await mineOne(store, dest, GENESIS_BITS_PACKED);
  assert.equal(got.ok, true, got.reason);
  return got;
}

function copyBlocks(blocks) {
  return (blocks || []).map((b) => ({
    ...b,
    header: Buffer.from(b.header),
    hash: Buffer.from(b.hash),
  }));
}

function tipsEqual(a, b) {
  const ta = a.store.tip();
  const tb = b.store.tip();
  if (!ta || !tb) return false;
  return ta.height === tb.height && Buffer.from(ta.hash).equals(Buffer.from(tb.hash));
}

async function greet(sock) {
  sock.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET, fingerprint: fingerprintHelloHash(MAGIC_TESTNET) })}\n`);
  await readJsonLines(sock, 3, 2000);
}

async function readJsonLines(sock, want, ms = 3000) {
  const lines = [];
  let buf = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { continue; }
        if (lines.length >= want) {
          clearTimeout(t);
          sock.off('data', onData);
          resolve();
        }
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
  return lines;
}

describe('p2p IBD catch-up', { timeout: fileCapMs(import.meta.url) }, () => {
  it('serves headers after locator and paginates past 2000 without a last-N dump', () => {
    const blocks = fakeBlocks(2500);
    const loc = locatorHashes(blocks);
    assert.equal(loc[0], fakeHash(2500));
    assert.ok(loc.length >= 1);

    const page = selectHeadersAfterLocator(blocks, {
      locator: [fakeHash(100)],
      stopHash: fakeHash(2500),
    });
    assert.equal(page.length, HEADERS_PAGE);
    assert.equal(page[0].height, 101);
    assert.equal(page[page.length - 1].height, 2100);

    const next = selectHeadersAfterLocator(blocks, {
      locator: [fakeHash(2100)],
      stopHash: fakeHash(2500),
    });
    assert.equal(next[0].height, 2101);
    assert.equal(next[next.length - 1].height, 2500);
    assert.equal(next.length, 400);

    const ibd = selectHeadersAfterLocator(blocks, { locator: [], stopHash: fakeHash(2500) });
    assert.equal(ibd[0].height, 1);
    assert.equal(ibd.length, HEADERS_PAGE);
    assert.equal(ibd[ibd.length - 1].height, 2000);

    const legacy = selectHeadersAfterLocator(blocks, { stopHash: fakeHash(16) });
    assert.equal(legacy[0].height, 17);
    assert.ok(legacy.length > 16);
  });

  it('re-requests getheaders from a drained want window while a live peer tip is still ahead', async () => {
    const blocks = fakeBlocks(71);
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = net.connect(bound.port, '127.0.0.1');
    try {
      await readJsonLines(sock, 2, 2000);
      await greet(sock);
      sock.write(`${JSON.stringify({
        type: 'tip',
        magic: MAGIC_TESTNET,
        height: 95,
        hash: fakeHash(95),
      })}\n`);
      const first = await readJsonLines(sock, 1, 2000);
      assert.ok(first.some((m) => m.type === 'getheaders'), 'expected initial getheaders after taller tip');
      sock.write(`${JSON.stringify({
        type: 'headers',
        magic: MAGIC_TESTNET,
        headers: [
          { hash: fakeHash(70), height: 70 },
          { hash: fakeHash(71), height: 71 },
        ],
      })}\n`);
      const second = await readJsonLines(sock, 1, 2000);
      assert.ok(
        second.some((m) => m.type === 'getheaders'),
        'expected getheaders re-request while behind peer tip with drained want',
      );
    } finally {
      sock.destroy();
      p2p.close();
    }
  });

  it('shipped getheaders honors locator/stop and continues to the next page', async () => {
    const blocks = fakeBlocks(2500);
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = net.connect(bound.port, '127.0.0.1');
    try {
      await readJsonLines(sock, 2, 2000);
      await greet(sock);
      sock.write(`${JSON.stringify({
        type: 'getheaders',
        magic: MAGIC_TESTNET,
        locator: [fakeHash(100)],
        stopHash: fakeHash(2500),
      })}\n`);
      const first = await readJsonLines(sock, 1, 2000);
      const hdrs = first.find((m) => m.type === 'headers');
      assert.ok(hdrs, 'expected headers');
      assert.equal(hdrs.headers[0].height, 101);
      assert.equal(hdrs.headers.length, HEADERS_PAGE);
      assert.equal(hdrs.headers[hdrs.headers.length - 1].height, 2100);

      sock.write(`${JSON.stringify({
        type: 'getheaders',
        magic: MAGIC_TESTNET,
        locator: [fakeHash(2100)],
        stopHash: fakeHash(2500),
      })}\n`);
      const second = await readJsonLines(sock, 1, 2000);
      const more = second.find((m) => m.type === 'headers');
      assert.ok(more, 'expected continuation headers');
      assert.equal(more.headers[0].height, 2101);
      assert.equal(more.headers[more.headers.length - 1].height, 2500);
    } finally {
      sock.destroy();
      p2p.close();
    }
  });

  it('dialSeeds reconnects after the peer socket drops', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-redial-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-redial-b-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      const linked = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2);
      assert.equal(linked, true);
      const before = a.p2p.sockets.size;
      await a.p2p.dialSeeds([`127.0.0.1:${b.bound.port}`]);
      await a.p2p.dialSeeds([`127.0.0.1:${b.bound.port}`]);
      assert.equal(a.p2p.sockets.size, before);
      for (const s of [...a.p2p.sockets]) s.destroy();
      const dropped = await waitFor(() => a.p2p.syncedOnline() === 1, 4000);
      assert.equal(dropped, true);
      await a.p2p.dialSeeds([`127.0.0.1:${b.bound.port}`]);
      const back = await waitFor(() => a.p2p.syncedOnline() === 2 && b.p2p.syncedOnline() === 2, 5000);
      assert.equal(back, true);
    } finally {
      a.p2p.close();
      b.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
    }
  });

  it('one headers page queues only the next sequential hash; IBD does not refetch headers each height', async () => {
    const dest = destMiner();
    const want = 3;
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hdrq-a-'));
    // Regtest blocks are stored under their own ShearHash. B checks each
    // claim and each header's work for real; nothing is trusted.
    const a = await startRegtestNode({ dataDir: dirA });
    try {
      for (let i = 0; i < want; i += 1) await appendMined(a.store, dest);
      assert.equal(a.store.tip().height, want);
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-hdrq-b-'));
      const b = await startRegtestNode({ dataDir: dirB });
      const pages = [];
      const orig = console.error;
      console.error = (...args) => {
        const s = String(args[0] || '');
        try {
          const ev = JSON.parse(s);
          if (ev.event === 'p2p_headers') pages.push(ev);
        } catch { /* ignore */ }
        orig.apply(console, args);
      };
      try {
        await b.p2p.connect('127.0.0.1', a.bound.port);
        const ok = await waitFor(() => tipsEqual(a, b), 15_000);
        assert.equal(ok, true, `queued IBD stuck at ${b.store.tip()?.height || 0}`);
        assert.equal(b.store.tip().height, want);
        assert.ok(pages.length >= 1, 'need a headers page');
        assert.ok(pages.length <= want + 1, `refetched headers every block (${pages.length})`);
        assert.equal(pages[0].missing, 1);
        assert.equal(pages[0].next, 1);
      } finally {
        console.error = orig;
        b.p2p.close();
        await b.rpc?.close?.();
      }
    } finally {
      a.p2p.close();
      await a.rpc?.close?.();
    }
  });

  // Two bits-17 blocks. Batch 1 makes the second block the next getblock page.
  // Ceiling is 3× the two-block mean at the measured jit-full rate, plus connect time.
  it('empty, lagging-prefix, and later third nodes fully catch up past one getblock batch', { timeout: (2 * MINE_WALL_MS) + (5 * 60 * 1000) }, async () => {
    const dest = destMiner();
    const prevBatch = process.env.SHEAR_GETBLOCK_BATCH;
    process.env.SHEAR_GETBLOCK_BATCH = '1';
    const want = 2;
    assert.ok(want > Number(process.env.SHEAR_GETBLOCK_BATCH));
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-a-'));
    const a = await startNode({ dataDir: dirA, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
    try {
      for (let i = 0; i < want; i += 1) await mineChainOne(a.store, dest);
      assert.equal(a.store.tip().height, want);

      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-b-'));
      const b = await startNode({ dataDir: dirB, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
      try {
        assert.equal(b.store.tip(), null);
        await a.p2p.connect('127.0.0.1', b.bound.port);
        const emptyOk = await waitFor(() => tipsEqual(a, b), 30_000);
        assert.equal(emptyOk, true, `empty B stuck at ${b.store.tip()?.height || 0} want ${want}`);
        assert.equal(b.store.tip().height, want);
        assert.equal(Buffer.from(b.store.tip().hash).equals(Buffer.from(a.store.tip().hash)), true);

        const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-c-'));
        const c = await startNode({ dataDir: dirC, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
        try {
          const prefixLen = 1;
          const prefix = copyBlocks(a.store.blocks.slice(0, prefixLen));
          const ingested = await Promise.resolve(c.store.ingest(prefix));
          assert.equal(ingested.ok, true, ingested.reason);
          assert.equal(c.store.tip().height, prefixLen);
          assert.ok(c.store.tip().height > 0 && c.store.tip().height < want);
          await c.p2p.connect('127.0.0.1', a.bound.port);
          const lagOk = await waitFor(() => tipsEqual(a, c), 30_000);
          assert.equal(lagOk, true, `lagging C stuck at ${c.store.tip()?.height || 0} want ${want}`);
          assert.equal(c.store.tip().height, want);
          assert.equal(Buffer.from(c.store.tip().hash).equals(Buffer.from(a.store.tip().hash)), true);

          const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ibd-d-'));
          const d = await startNode({ dataDir: dirD, p2pPort: 0, rpcPort: 0, p2pBind: '127.0.0.1', seeds: [] });
          try {
            await d.p2p.connect('127.0.0.1', a.bound.port);
            const laterOk = await waitFor(() => tipsEqual(a, d), 30_000);
            assert.equal(laterOk, true, `later D stuck at ${d.store.tip()?.height || 0} want ${want}`);
            assert.equal(d.store.tip().height, a.store.tip().height);
            assert.equal(Buffer.from(d.store.tip().hash).equals(Buffer.from(a.store.tip().hash)), true);
          } finally {
            d.p2p.close();
            await d.rpc?.close?.();
          }
        } finally {
          c.p2p.close();
          await c.rpc?.close?.();
        }
      } finally {
        b.p2p.close();
        await b.rpc?.close?.();
      }
    } finally {
      if (prevBatch === undefined) delete process.env.SHEAR_GETBLOCK_BATCH;
      else process.env.SHEAR_GETBLOCK_BATCH = prevBatch;
      a.p2p.close();
      await a.rpc?.close?.();
    }
  });

  it('forwards a one-block tip before ingest and asks for that block immediately', async () => {
    assert.ok(GETBLOCK_WAIT_MS <= 250);
    assert.ok(TIP_NUDGE_MS <= 100);
    const blocks = fakeBlocks(10);
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const announcer = net.connect(bound.port, '127.0.0.1');
    const next = net.connect(bound.port, '127.0.0.1');
    try {
      await readJsonLines(announcer, 2, 2000);
      await readJsonLines(next, 2, 2000);
      await greet(announcer);
      await greet(next);
      const hash = fakeHash(11);
      const t0 = Date.now();
      announcer.write(`${JSON.stringify({
        type: 'tip',
        magic: MAGIC_TESTNET,
        height: 11,
        hash,
        work: '0x10',
      })}\n`);
      const [asked, heard] = await Promise.all([
        readJsonLines(announcer, 1, 500),
        readJsonLines(next, 1, 500),
      ]);
      assert.ok(Date.now() - t0 < 500, 'one-block tip did not move in milliseconds');
      assert.equal(asked[0]?.type, 'getblock');
      assert.equal(String(asked[0]?.hash || '').toLowerCase(), hash);
      assert.equal(asked.some((m) => m.type === 'getheaders'), false);
      assert.equal(heard[0]?.type, 'tip');
      assert.equal(String(heard[0]?.hash || '').toLowerCase(), hash);
      assert.equal(heard[0]?.height, 11);
    } finally {
      announcer.destroy();
      next.destroy();
      p2p.close();
    }
  });

  it('does not forward a same-height tip', async () => {
    const blocks = fakeBlocks(10);
    const store = {
      blocks,
      tip: () => blocks[blocks.length - 1],
      ingest: () => ({ ok: false, reason: 'fake' }),
    };
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const announcer = net.connect(bound.port, '127.0.0.1');
    const next = net.connect(bound.port, '127.0.0.1');
    try {
      await readJsonLines(announcer, 2, 2000);
      await readJsonLines(next, 2, 2000);
      await greet(announcer);
      await greet(next);
      const foreign = fakeHash(99);
      announcer.write(`${JSON.stringify({
        type: 'tip',
        magic: MAGIC_TESTNET,
        height: 10,
        hash: foreign,
        work: '0x1',
      })}\n`);
      const heard = await readJsonLines(next, 1, 250);
      assert.equal(heard.some((m) => String(m.hash || '').toLowerCase() === foreign), false);
    } finally {
      announcer.destroy();
      next.destroy();
      p2p.close();
    }
  });

  it('a one-block tip reaches a two-hop line in milliseconds', async () => {
    const dest = destMiner();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tipms-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tipms-b-'));
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-tipms-c-'));
    // Regtest work. The relayed block is stored under its own ShearHash, and
    // B and C check its claim and work for real.
    const a = await startRegtestNode({ dataDir: dirA });
    const b = await startRegtestNode({ dataDir: dirB });
    const c = await startRegtestNode({ dataDir: dirC });
    try {
      await a.p2p.connect('127.0.0.1', b.bound.port);
      await c.p2p.connect('127.0.0.1', b.bound.port);
      // Census (2s) can count the far node before the first poll. Exact === 2 then never lands.
      await new Promise((r) => setTimeout(r, 4500));
      const linked = await waitFor(() => a.p2p.syncedOnline() >= 2 && c.p2p.syncedOnline() >= 2, 30_000);
      assert.equal(
        linked,
        true,
        `line A-B-C did not finish the handshakes a=${a.p2p.syncedOnline()} b=${b.p2p.syncedOnline()} c=${c.p2p.syncedOnline()}`,
      );
      await appendMined(a.store, dest);
      const t0 = Date.now();
      const caught = await waitFor(() => tipsEqual(a, c), 2000);
      const elapsed = Date.now() - t0;
      assert.equal(caught, true, `two-hop tip stuck at ${c.store.tip()?.height || 0} after ${elapsed}ms`);
      assert.ok(elapsed < 2000, `two-hop tip took ${elapsed}ms`);
      assert.equal(c.store.tip().height, a.store.tip().height);
      assert.equal(Buffer.from(c.store.tip().hash).equals(Buffer.from(a.store.tip().hash)), true);
    } finally {
      a.p2p.close();
      b.p2p.close();
      c.p2p.close();
      await a.rpc?.close?.();
      await b.rpc?.close?.();
      await c.rpc?.close?.();
    }
  });
});
