/**
 * N-39. A template trials k reserve txs against one carried vault.
 * Full-vault clone bytes stay O(V), not O(k·V), for any portal count and
 * any reserve-tx count. A failed in-place trial restores the vault it was
 * handed. A trial that does not ask to mutate leaves the caller's vault.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createStore } from '../src/store.js';
import { decodeHeader } from '../../crypto/header.js';
import { TARGET_BLOCK_INTERVAL_MS, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import {
  asU8,
  kernelExcess,
  sealCoinbaseNote,
  randomScalar,
  hideVin,
  reviveTx,
} from '../../crypto/note.js';
import {
  emptyVault,
  lockTx,
  portalIdFromDest,
  trialReserveApply,
  voteTx,
  VOTE_HOLD,
} from '../../crypto/reserve_vault.js';
import { levyNeed } from '../../crypto/levy.js';
import { rememberFundVerdict } from '../../crypto/fund_verdict.js';
import { walletAnchor, readyHeight } from '../../crypto/admit_v3.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const STEP = TARGET_BLOCK_INTERVAL_MS;
const VS = [1_000, 10_000, 100_000];
const KS = [1, 4, 16];
const AMOUNTS = [1, 2 ** 20, 2 ** 40];

let powTag = 1;
let destN = 1;

function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  powTag += 1;
  return h;
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest };
}

function nextDest() {
  const raw = Buffer.alloc(20);
  raw.writeUInt32BE(destN >>> 0, 16);
  destN += 1;
  return encodeDest(raw);
}

function synthId(i) {
  return `e${(i >>> 0).toString(16).padStart(63, '0')}`;
}

const SYNTH = new Set();

function fillPortals(vault, n) {
  for (const id of SYNTH) delete vault.portals[id];
  SYNTH.clear();
  for (let i = 0; i < n; i += 1) {
    const id = synthId(i);
    SYNTH.add(id);
    vault.portals[id] = {
      id,
      staked: 0n,
      idle: 1n,
      vote: null,
      joined: false,
      voteEpoch: 0,
    };
  }
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function blockFrom(tpl, hash) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    shareBatch: tpl.shareBatch || [],
    hash,
  };
}

function asTemplated(tx, height) {
  const m = reviveTx(tx);
  const dest = destForLogin(m.to, { height }) || m.to;
  return {
    ...m,
    to: dest,
    bFlag: m.kind === 'b-spend' || m.bFlag,
    vin: m.vin || [{ address: m.from }],
    vout: m.vout || [{ address: dest, nanos: m.nanos, kind: m.kind }],
  };
}

function rootHex(jroot) {
  const b = Buffer.from(asU8(jroot));
  assert.equal(b.length, 32);
  return b.toString('hex');
}

function userTxs(tpl) {
  return (tpl.txs || []).filter((tx) => tx && !tx.coinbase);
}

/** Count JSON clones of a vault. cloneVault is the only replacer walk. */
function watchClones(fn) {
  const orig = JSON.stringify;
  let clones = 0;
  let bytes = 0;
  JSON.stringify = function stringify(value, replacer, space) {
    const out = orig.call(JSON, value, replacer, space);
    if (value && typeof value === 'object'
      && value.portals && value.mintedIds
      && typeof replacer === 'function') {
      clones += 1;
      bytes += Buffer.byteLength(out);
    }
    return out;
  };
  try {
    const result = fn();
    return { result, clones, bytes };
  } finally {
    JSON.stringify = orig;
  }
}

function cheapLock({ to, nanos, id, anchor, height }) {
  let fee = 0;
  let tx = null;
  const tag = randomBytes(32);
  const spendPub = randomBytes(32).toString('hex');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const d20 = hash20FromAddress(to);
    assert.ok(d20, 'dest20');
    const spent = sealCoinbaseNote(nanos + fee, { dest20: d20, kind: 'lock' });
    const out = sealCoinbaseNote(nanos, { dest20: d20, kind: 'lock' });
    out.kind = 'lock';
    out.address = to;
    out.dest20 = d20;
    out.portalId = portalIdFromDest(to);
    let vin = null;
    for (let spin = 0; spin < 4 && !vin?.commit; spin += 1) {
      vin = hideVin({}, spent, randomScalar());
    }
    assert.ok(vin?.commit, 'vin commit');
    const excess = kernelExcess([out], [{ r: spent.r, t: vin.t }]);
    assert.ok(excess, 'excess');
    const blob = Buffer.alloc(129);
    blob[0] = 3;
    tag.copy(blob, 1);
    tx = {
      id,
      programId: RESERVE_PROGRAM,
      kind: 'lock',
      to,
      nanos,
      fee,
      portalId: portalIdFromDest(to),
      payoutPortalId: portalIdFromDest(to),
      anchor,
      excess,
      spendPub,
      vin: [{ commit: Buffer.from(vin.commit) }],
      vout: [out],
      admit_proof: {
        v: 3,
        blob,
        cTilde: Buffer.from(vin.commit),
        spendTag: Buffer.from(tag),
      },
    };
    const need = levyNeed(tx);
    if (need === fee) break;
    fee = need;
    tx = null;
  }
  assert.ok(tx, `levy did not settle for ${id}`);
  assert.ok(tx.nanos > 0);
  const view = asTemplated(tx, height);
  return { tx, view, tag: tag.toString('hex') };
}

describe('v12 vault trial does not clone per reserve tx', () => {
  it('template clone bytes stay with the portal count, not the tx count', { timeout: 300_000 }, async () => {
    assert.ok(VS.length >= 3);
    assert.ok(KS.length >= 3);
    assert.equal(KS[0], 1);
    assert.ok(KS[KS.length - 1] >= 8);
    assert.ok(VS[0] >= 1_000 && VS[VS.length - 1] >= 100_000);
    assert.ok(new Set(AMOUNTS).size === AMOUNTS.length);
    const who = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vault-undo-'));
    const store = createStore(dir);
    try {
      const includeAt = readyHeight(1);
      assert.equal(Number.isInteger(includeAt), true);
      while ((store.tip()?.height || 0) + 1 < includeAt) {
        const tip = store.tip();
        const now = tip ? headerTime(tip) + STEP : T0;
        const { tpl } = store.template({ miner: who.dest, now });
        const pow = easyPow();
        const got = await store.append(blockFrom(tpl, pow), { trustedPowHash: pow, skipSharePow: true });
        assert.equal(got.ok, true, `${got.reason || 'seal'} at ${(tip?.height || 0) + 1}`);
      }
      assert.equal(store.tip().height + 1, includeAt);
      const anchor = walletAnchor(includeAt);
      assert.equal(typeof anchor, 'number');
      const liveRoot = rootHex(store.anchorNote(anchor)?.jroot);
      const rows = [];
      for (const V of VS) {
        fillPortals(store.reserveVault, V);
        assert.equal(Object.keys(store.reserveVault.portals).length, V);
        for (const k of KS) {
          store.mempool.length = 0;
          const built = [];
          for (let i = 0; i < k; i += 1) {
            const nanos = AMOUNTS[i % AMOUNTS.length];
            const one = cheapLock({
              to: nextDest(),
              nanos,
              id: `lock-${V}-${k}-${i}`,
              anchor,
              height: includeAt,
            });
            const remembered = rememberFundVerdict(one.view, store.tip(), anchor, liveRoot, [one.tag]);
            assert.equal(remembered, true, `verdict V=${V} k=${k} i=${i}`);
            built.push(one.tx);
          }
          const amounts = new Set(built.map((tx) => tx.nanos));
          if (k > 1) assert.ok(amounts.size > 1, `k=${k} amounts collapsed`);
          store.mempool.push(...built);
          const portalsBefore = Object.keys(store.reserveVault.portals).length;
          const lockedBefore = store.reserveVault.totalLockedNanos;
          const stamp = headerTime(store.tip()) + STEP;
          const watched = watchClones(() => store.template({ miner: who.dest, now: stamp }));
          const kept = userTxs(watched.result.tpl).length;
          const row = { V, k, clones: watched.clones, bytes: watched.bytes, kept };
          rows.push(row);
          console.log(JSON.stringify({ event: 'vault_clone', ...row }));
          assert.equal(kept, k, `template kept ${kept} of ${k} at V=${V}`);
          assert.equal(Object.keys(store.reserveVault.portals).length, portalsBefore);
          assert.equal(store.reserveVault.totalLockedNanos, lockedBefore);
        }
      }
      const at1 = new Map();
      for (const row of rows) {
        if (row.k === 1) at1.set(row.V, row);
      }
      assert.equal(at1.size, VS.length);
      let prevBytes = 0;
      for (const V of VS) {
        const base = at1.get(V);
        assert.ok(base.bytes > prevBytes, `clone bytes did not grow with V at ${V}`);
        prevBytes = base.bytes;
        const one = Math.floor(base.bytes / base.clones);
        assert.ok(one > 0);
        for (const row of rows) {
          if (row.V !== V) continue;
          assert.equal(row.clones, base.clones, `clones ${row.clones} at V=${V} k=${row.k}`);
          assert.ok(row.bytes <= one * 2, `clone bytes ${row.bytes} at V=${V} k=${row.k}`);
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an in-place trial undoes a miss and keeps a hit on the same vault', () => {
    const vault = emptyVault();
    fillPortals(vault, 1_000);
    const n0 = Object.keys(vault.portals).length;
    const locked0 = vault.totalLockedNanos;
    const vote = voteTx({
      from: nextDest(),
      dest: nextDest(),
      choice: VOTE_HOLD,
      id: 'vote-miss',
    });
    const missed = watchClones(() => trialReserveApply({
      state: vault,
      txs: [vote],
      nowMs: 1,
      inPlace: true,
    }));
    assert.equal(missed.result.ok, false, missed.result.reason || 'vote');
    assert.equal(missed.clones, 0, `failed trial cloned ${missed.clones}`);
    assert.equal(Object.keys(vault.portals).length, n0);
    assert.equal(vault.totalLockedNanos, locked0);

    let expect = 0n;
    for (let i = 0; i < AMOUNTS.length; i += 1) {
      const nanos = AMOUNTS[i];
      const to = nextDest();
      const tx = lockTx({ from: to, to, nanos, id: `lock-hit-${i}` });
      const hit = watchClones(() => trialReserveApply({
        state: vault,
        txs: [tx],
        nowMs: 1,
        inPlace: true,
      }));
      assert.equal(hit.clones, 0, `hit cloned ${hit.clones}`);
      assert.equal(hit.result.ok, true, hit.result.reason || 'lock');
      assert.equal(hit.result.state, vault);
      expect += BigInt(nanos);
    }
    assert.equal(vault.totalLockedNanos, expect);
    assert.equal(Object.keys(vault.portals).length, n0 + AMOUNTS.length);

    const live = emptyVault();
    fillPortals(live, 64);
    const liveLocked = live.totalLockedNanos;
    const livePorts = Object.keys(live.portals).length;
    const tx = lockTx({ from: nextDest(), to: nextDest(), nanos: AMOUNTS[0], id: 'lock-live' });
    const once = watchClones(() => trialReserveApply({
      state: live,
      txs: [tx],
      nowMs: 1,
    }));
    assert.equal(once.result.ok, true, once.result.reason || 'live');
    assert.notEqual(once.result.state, live);
    assert.equal(once.clones, 1);
    assert.equal(live.totalLockedNanos, liveLocked);
    assert.equal(Object.keys(live.portals).length, livePorts);
  });
});
