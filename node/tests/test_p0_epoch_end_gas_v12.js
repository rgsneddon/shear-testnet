/**
 * P0 repro. With N stakers of π, the epoch-end block's commitRewards walks
 * every portal inside the reserve call's 8_000_000 gas. Enact stays flat.
 * commitRewards is about 235_000 gas per portal: N=24 fits (~5.56M), N=34
 * still fits (~7.91M), N=35 returns "out of gas", and N=40 needs ~9.33M.
 * JS still builds the reward root. verifyBlockEvm rejects the block, so the
 * tip never passes the first epoch end.
 *
 * The assertion is that the epoch-end block is accepted and a child extends
 * it. N=40 fails that assertion on the pinned bytecode.
 *
 * The node listens on 127.0.0.1 at ephemeral ports. It does not dial seeds.
 * The epoch-end block is mined and submitted through the RPC submitblock
 * handler (store.submitHeader). The tip is read back with HTTP getheader.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress, encodeDest } from '../../crypto/address.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { decodeHeader } from '../../crypto/header.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import {
  MTP_FUTURE_MS,
  MTP_WINDOW,
  PI_SHE_NANOS,
  RESERVE_EPOCH_MS,
  RESERVE_PROGRAM,
} from '../../crypto/asert.js';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { bindWeightFee } from '../../crypto/levy.js';
import { portalIdFromDest } from '../../crypto/reserve_vault.js';
import { mineTemplate } from '../src/chain.js';
import { createP2p, P2P_PORT } from '../src/p2p.js';
import { createRpc, RPC_PORT } from '../src/rpc.js';
import { createRegtestStore } from './regtest_store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const EPOCH_END = T0 + RESERVE_EPOCH_MS;
const STEP_MS = 20 * 60 * 1000;

function median(nums) {
  const s = nums.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.floor((s.length - 1) / 2)];
}

function tipTime(store) {
  const tip = store.tip();
  if (!tip?.header) return 0;
  return Number(decodeHeader(Buffer.from(tip.header)).timestamp);
}

function mtpOf(store) {
  const rows = store.blocks.slice(-MTP_WINDOW).map((b) => {
    try { return Number(decodeHeader(Buffer.from(b.header)).timestamp); } catch { return 0; }
  });
  return median(rows);
}

function nextStamp(store, target) {
  const parent = tipTime(store);
  const cap = mtpOf(store) + MTP_FUTURE_MS;
  let stamp = Math.min(target, parent + STEP_MS, cap);
  if (!(stamp > parent)) stamp = parent + 1;
  return { stamp, cap, parent, ok: stamp <= cap };
}

function makeLock(vault, id) {
  const d20 = Buffer.from(hash20FromAddress(vault));
  const lock = {
    id,
    programId: RESERVE_PROGRAM,
    kind: 'lock',
    to: vault,
    nanos: PI_SHE_NANOS,
    portalId: portalIdFromDest(vault),
    payoutPortalId: portalIdFromDest(vault),
    vin: [{ dest20: d20 }],
    vout: [{ kind: 'lock', address: vault, dest20: d20, valueProof: { v: PI_SHE_NANOS } }],
  };
  bindWeightFee(lock);
  lock.maxLevy = lock.fee;
  return lock;
}

async function rpcCall(port, method, params) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

async function mineAt(store, dest, now) {
  const { tpl, job } = store.template({
    miner: dest,
    bits: regtestBitsOverride(MAGIC_REGTEST),
    shareBits: 4,
    now,
  });
  const found = mineTemplate(tpl, { maxTries: 2_000_000, blockOnly: true });
  if (!found?.block) return { ok: false, reason: 'pow', bits: tpl.bits, now };
  return { ok: true, tpl, job, found };
}

async function appendMined(store, mined, dest) {
  return Promise.resolve(store.append({
    header: mined.found.header,
    txs: mined.tpl.txs,
    samples: mined.tpl.samples,
    shareBatch: mined.tpl.shareBatch || [],
    miner: dest,
    aLeaves: mined.tpl.aLeaves,
    bLeaves: mined.tpl.bLeaves,
    rootA: mined.tpl.rootA,
    rootB: mined.tpl.rootB,
    weight: mined.tpl.weight,
  }));
}

async function submitMined(rpc, mined, dest) {
  return Promise.resolve(rpc.dispatch('submitblock', {
    jobId: mined.job.jobId,
    nonce: mined.found.nonce.toString(),
    miner: dest,
  }));
}

function explain(row) {
  return [
    `n=${row.n}`,
    `listen=${row.rpcHost}:${row.rpcPort}`,
    `p2p=${row.p2pHost}:${row.p2pPort}`,
    `peers=${row.peers}`,
    `portals=${row.portals}`,
    `locked=${row.locked}`,
    `jsRoot=${row.jsRootPresent}`,
    `height ${row.heightBefore} -> ${row.heightAfter} -> ${row.heightNext}`,
    `httpHeader=${row.headerHeight}`,
    `accepted=${row.accepted}`,
    `reason=${row.reason || ''}`,
    `error=${row.error || ''}`,
    `continued=${row.continued}`,
    `continueReason=${row.continueReason || ''}`,
  ].join(' ');
}

async function runEpoch(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-p0-epoch-'));
  const store = createRegtestStore(dir, { bits: 4 });
  const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: store.magic });
  const rpc = createRpc({ store, p2p, port: 0, host: '127.0.0.1' });
  const bound = await p2p.listen();
  const rpcBound = await rpc.listen();
  const dest = encodeDest(Buffer.alloc(20, 9));
  const t0 = Date.now();
  try {
    assert.equal(bound.host, '127.0.0.1');
    assert.equal(rpcBound.host, '127.0.0.1');
    assert.notEqual(rpcBound.port, RPC_PORT);
    assert.notEqual(bound.port, P2P_PORT);
    assert.equal(p2p.peers.size, 0);

    let mined = await mineAt(store, dest, T0);
    assert.equal(mined.ok, true, mined.reason || 'genesis pow');
    let got = await appendMined(store, mined, dest);
    assert.equal(got.ok, true, `genesis ${got.reason || ''} ${got.error || ''}`);

    const vaults = [];
    for (let i = 0; i < n; i += 1) {
      const id = newIdentity();
      vaults.push(vaultDest(id.address, { viewKey: id.viewKey }));
    }
    let queued = 0;
    while (queued < n) {
      const q = await Promise.resolve(store.queueTx(makeLock(vaults[queued], `lock-${queued}`)));
      if (!q.ok) {
        if (queued === 0) throw new Error(`lock queue ${q.reason}`);
        const now = tipTime(store) + 1;
        mined = await mineAt(store, dest, now);
        assert.equal(mined.ok, true, 'lock-block pow');
        got = await appendMined(store, mined, dest);
        assert.equal(got.ok, true, `lock block ${got.reason || ''} ${got.error || ''}`);
        continue;
      }
      queued += 1;
    }
    let flushes = 0;
    while (store.mempool?.length) {
      const pending = store.mempool.length;
      const now = tipTime(store) + 1;
      mined = await mineAt(store, dest, now);
      assert.equal(mined.ok, true, 'flush pow');
      got = await appendMined(store, mined, dest);
      assert.equal(got.ok, true, `lock flush ${got.reason || ''} ${got.error || ''}`);
      if ((store.mempool?.length || 0) >= pending) {
        throw new Error(`lock flush stuck at ${store.mempool.length}`);
      }
      flushes += 1;
      if (flushes > 20) throw new Error('lock flush runaway');
    }

    let steps = 0;
    while (tipTime(store) < EPOCH_END) {
      const nxt = nextStamp(store, EPOCH_END);
      if (!nxt.ok) throw new Error(`mtp stall parent=${nxt.parent} cap=${nxt.cap}`);
      mined = await mineAt(store, dest, nxt.stamp);
      assert.equal(mined.ok, true, `walk pow stamp=${nxt.stamp}`);
      if (nxt.stamp >= EPOCH_END) {
        const before = await rpcCall(rpcBound.port, 'getheader', { height: store.tip().height });
        assert.equal(before.body?.ok, true, 'listener getheader before the epoch block');
        const heightBefore = Number(store.tip().height);
        const locked = Number(store.reserveVault.totalLockedNanos);
        const portals = Object.keys(store.reserveVault.portals || {}).length;
        const jsRoot = String(mined.tpl.txs[0]?.rewardRoot || '');
        const submitted = await submitMined(rpc, mined, dest);
        const heightAfter = Number(store.tip().height);
        const header = await rpcCall(rpcBound.port, 'getheader', { height: heightAfter });
        const accepted = submitted?.ok === true && heightAfter === heightBefore + 1
          && Number(header.body?.height) === heightAfter;
        let heightNext = heightAfter;
        let continued = false;
        let continueReason = '';
        if (accepted) {
          const after = nextStamp(store, EPOCH_END + 90_000);
          const more = await mineAt(store, dest, after.stamp);
          assert.equal(more.ok, true, 'continuation pow');
          const again = await submitMined(rpc, more, dest);
          heightNext = Number(store.tip().height);
          const nextHeader = await rpcCall(rpcBound.port, 'getheader', { height: heightNext });
          continued = again?.ok === true && heightNext === heightAfter + 1
            && Number(nextHeader.body?.height) === heightNext;
          continueReason = again?.reason || again?.error || '';
        }
        return {
          n,
          rpcHost: rpcBound.host,
          rpcPort: rpcBound.port,
          p2pHost: bound.host,
          p2pPort: bound.port,
          peers: p2p.peers.size,
          portals,
          locked,
          jsRootPresent: jsRoot.length === 64,
          heightBefore,
          heightAfter,
          heightNext,
          headerHeight: Number(header.body?.height || 0),
          accepted,
          reason: submitted?.reason || '',
          error: submitted?.error || '',
          continued,
          continueReason,
          steps,
          walkMs: Date.now() - t0,
        };
      }
      got = await appendMined(store, mined, dest);
      assert.equal(got.ok, true, `walk ${got.reason || ''} ${got.error || ''} stamp=${nxt.stamp}`);
      steps += 1;
      if (steps % 48 === 0) {
        console.error(`epoch walk n=${n} height=${store.tip().height} stamp=${nxt.stamp}`);
      }
      if (steps > 5000) throw new Error('walk runaway');
    }
    throw new Error('missed epoch end');
  } finally {
    try { p2p.close(); } catch { /* already closed */ }
    try { await rpc.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

describe('epoch-end reward root gas', () => {
  it('24 stakers of π: the epoch-end block is accepted and the next block extends the tip', { timeout: 600_000 }, async () => {
    const row = await runEpoch(24);
    console.error(`epoch-end result ${explain(row)} walkMs=${row.walkMs}`);
    assert.equal(row.portals, 24);
    assert.equal(row.locked, 24 * PI_SHE_NANOS);
    assert.equal(row.jsRootPresent, true);
    assert.equal(row.accepted, true, explain(row));
    assert.equal(row.continued, true, explain(row));
  });

  it('40 stakers of π: the epoch-end block is accepted and the next block extends the tip', { timeout: 600_000 }, async () => {
    const row = await runEpoch(40);
    console.error(`epoch-end result ${explain(row)} walkMs=${row.walkMs}`);
    assert.equal(row.portals, 40);
    assert.equal(row.locked, 40 * PI_SHE_NANOS);
    assert.equal(row.jsRootPresent, true);
    assert.equal(row.accepted, true, explain(row));
    assert.equal(row.continued, true, explain(row));
  });
});
