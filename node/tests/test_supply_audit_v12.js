/**
 * The pool publish reads the consensus supply. It does not re-verify historical
 * coinbase range proofs, and it does not run that work on the caller turn.
 * A fresh process after a snap reload is the cold cache. Any height and any
 * coinbase output count must publish in one step of the new blocks only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { potSubsidyNanos } from '../../crypto/pot_sched.js';
import { TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { excessOf } from '../../crypto/note.js';
import { encodeHeader } from '../../crypto/header.js';
import { coinbaseTx } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { networkSupply, networkSupplySettled } from '../../pool/src/wallet_api.js';
import {
  auditCirculatingSupply,
  coinbaseRangeVerifies,
  rangeVerifiedInserts,
} from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const HEIGHTS = [1, 2, 3, 4];
const OUTPUT_COUNTS = [1, 3, 7];
const PUBLISH_MS = 50;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function coinbaseOutputs(block) {
  return (block?.txs?.[0]?.vout || []).filter((row) => row?.rangeProof && row.rangeProof.length).length;
}

function splitSum(total, n) {
  const count = Math.max(1, Math.floor(n));
  const base = Math.floor(total / count);
  const parts = Array.from({ length: count }, () => base);
  let rem = total - base * count;
  for (let i = 0; rem > 0; i += 1, rem -= 1) parts[i % count] += 1;
  return parts;
}

function potBlock(ts, height, miner, notes) {
  const shares = notes.map((n) => ({
    address: miner,
    nanos: n.nanos,
    kind: n.kind || 'pot',
  }));
  const tx = coinbaseTx({
    height,
    miner,
    potShares: shares,
    potNanos: shares.reduce((a, s) => a + s.nanos, 0),
    carryNanos: 0,
    shareBatch: [],
  });
  tx.vout = (tx.vout || []).filter((o) => String(o?.kind || '') !== 'hash');
  tx.excess = excessOf(tx.vout);
  const hash = Buffer.alloc(32);
  hash.writeUInt32BE(height, 28);
  return {
    header: encodeHeader({
      prevBlockHash: Buffer.alloc(32),
      merkleRoot: Buffer.alloc(32),
      continuityRoot: Buffer.alloc(32),
      timestamp: ts,
      bits: 16,
    }),
    txs: [tx],
    shareBatch: [],
    height,
    hash,
  };
}

async function grow(store, who, heights) {
  const counts = [];
  for (const h of heights) {
    const now = GENESIS + (h - 1) * TARGET_BLOCK_INTERVAL_MS;
    const { tpl } = store.template({ miner: who, shareBits: 4, now });
    const pow = Buffer.alloc(32);
    pow.writeUInt32BE(h, 28);
    const appended = await Promise.resolve(store.append({
      header: tpl.header,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: who,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, { trustedPowHash: pow, skipSharePow: true }));
    assert.equal(appended.ok, true, appended.reason);
    counts.push(coinbaseOutputs(store.tip()));
  }
  return counts;
}

async function runChild() {
  const dir = process.env.SHEAR_AUDIT_DIR;
  const who = process.env.SHEAR_AUDIT_MINER;
  const store = createStore(dir);
  const loaded = store.blocks.reduce((n, block) => n + coinbaseOutputs(block), 0);
  const before = coinbaseRangeVerifies();
  const t0 = process.hrtime.bigint();
  const pub = networkSupply(store);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const first = coinbaseRangeVerifies() - before;
  const counts = await grow(store, who, [store.tip().height + 1]);
  const before2 = coinbaseRangeVerifies();
  const pub2 = networkSupply(store);
  const second = coinbaseRangeVerifies() - before2;
  process.stdout.write(`${JSON.stringify({
    loadMode: store.loadMode,
    height: store.tip().height,
    outputs: loaded,
    newOutputs: counts[0],
    first,
    second,
    ms,
    status: pub.supplyStatus,
    status2: pub2.supplyStatus,
    circulating: pub.circulatingNanos,
  })}\n`);
}

if (process.env.SHEAR_AUDIT_FORK === '1') {
  await runChild();
  process.exit(0);
}

describe('v12 pool supply publish', () => {
  it('publishes consensus supply without re-verifying history', { timeout: 180_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-supply-audit-'));
    try {
      const who = minerDest();
      const store = createStore(dir);
      const counts = await grow(store, who, HEIGHTS);
      assert.equal(store.tip().height, HEIGHTS.length);
      assert.equal(counts.length, HEIGHTS.length);
      assert.ok(counts.every((n) => n >= 1));
      process.stderr.write(`supply-audit grew ${counts.join(',')}\n`);

      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: {
          ...process.env,
          SHEAR_AUDIT_FORK: '1',
          SHEAR_AUDIT_DIR: dir,
          SHEAR_AUDIT_MINER: who,
        },
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const line = String(child.stdout || '').trim().split(/\r?\n/).filter((row) => row.startsWith('{')).at(-1);
      const report = JSON.parse(line);
      process.stderr.write(`supply-audit cold ${JSON.stringify(report)}\n`);
      assert.equal(report.loadMode, 'snap');
      assert.equal(report.status, 'verified');
      assert.equal(report.status2, 'verified');
      assert.equal(report.first, 0);
      assert.equal(report.second, 0);
      assert.ok(report.outputs >= 1);
      assert.ok(report.newOutputs >= 1);
      assert.ok(report.ms < PUBLISH_MS, `publish ${report.ms} ms`);
      assert.equal(report.height, HEIGHTS.length + 1);

      const miner = minerDest();
      const blocks = OUTPUT_COUNTS.map((count, i) => {
        const subsidy = potSubsidyNanos(0);
        const parts = splitSum(subsidy, count);
        assert.equal(parts.reduce((a, n) => a + n, 0), subsidy);
        return potBlock(
          GENESIS + i * TARGET_BLOCK_INTERVAL_MS,
          i + 1,
          miner,
          parts.map((nanos) => ({ nanos, kind: 'pot' })),
        );
      });
      const outputs = blocks.reduce((n, block) => n + coinbaseOutputs(block), 0);
      assert.equal(outputs, OUTPUT_COUNTS.reduce((a, n) => a + n, 0));
      const audited = auditCirculatingSupply(blocks);
      assert.equal(audited.status, 'verified', audited.reason);
      const inserts = rangeVerifiedInserts();
      const before = coinbaseRangeVerifies();
      const raw = { blocks, tip: () => blocks[blocks.length - 1], reserveVault: {} };
      const t0 = process.hrtime.bigint();
      const pending = networkSupply(raw);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.equal(pending.supplyStatus, 'pending');
      assert.ok(ms < PUBLISH_MS, `raw publish ${ms} ms`);
      assert.equal(coinbaseRangeVerifies(), before);
      assert.equal(rangeVerifiedInserts(), inserts);
      let yielded = false;
      setImmediate(() => { yielded = true; });
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(yielded, true);
      const settled = await networkSupplySettled(raw);
      assert.equal(settled.supplyStatus, 'verified', settled.supplyReason);
      assert.equal(settled.circulatingNanos, audited.circulatingNanos);
      assert.equal(settled.differenceNanos, 0);
      assert.equal(coinbaseRangeVerifies(), before);
      assert.equal(rangeVerifiedInserts(), inserts);

      const inflated = blocks.slice();
      const bumped = splitSum(potSubsidyNanos(0) + 1, OUTPUT_COUNTS[0]);
      inflated[0] = potBlock(
        GENESIS,
        1,
        miner,
        bumped.map((nanos) => ({ nanos, kind: 'pot' })),
      );
      const driftAudit = auditCirculatingSupply(inflated);
      assert.equal(driftAudit.status, 'mismatch');
      const driftBefore = coinbaseRangeVerifies();
      const driftInserts = rangeVerifiedInserts();
      const drift = await networkSupplySettled({
        blocks: inflated,
        tip: () => inflated[inflated.length - 1],
        reserveVault: {},
      });
      assert.equal(drift.supplyStatus, 'mismatch');
      assert.notEqual(drift.differenceNanos, 0);
      assert.equal(coinbaseRangeVerifies(), driftBefore);
      assert.equal(rangeVerifiedInserts(), driftInserts);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
