import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { packBits } from '../../crypto/asert.js';
import { chainParams } from '../../crypto/chain_params.js';
import { decodeHeader } from '../../crypto/header.js';
import { openedCoinbaseNanos } from '../../crypto/note.js';
import { POT_START_NANOS, POT_STEP_NANOS, potSubsidyAt } from '../../crypto/pot_sched.js';
import { createStore } from '../src/node.js';
import { networkSupplySettled } from '../../pool/src/wallet_api.js';
import { auditCirculatingSupply, foldSupply } from '../src/supply.js';

function easyPowHash(tag) {
  const h = Buffer.alloc(32);
  h[4] = tag & 0xff;
  h[5] = (tag >> 8) & 0xff;
  h[6] = (tag >> 16) & 0xff;
  return h;
}

function potOf(block) {
  let sum = 0;
  for (const o of block?.txs?.[0]?.vout || []) {
    if (String(o?.kind || '') !== 'pot') continue;
    const n = openedCoinbaseNanos(o);
    if (n == null) continue;
    sum += n;
  }
  return sum;
}

describe('shear-dev S2 epoch', () => {
  it('mines 40 blocks at 9s, crosses the epoch, and drops the pot by one step', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-dev-s2-'));
    const store = createStore(dir, { network: 'shear-dev' });
    assert.equal(store.magic, 'shear-dev');
    const dest = encodeDest(Buffer.alloc(20, 5));
    const genesis = 1_700_000_000_000;
    const seed = packBits(chainParams('shear-dev').genesisBits);
    assert.equal(seed, 12 * 65536);
    let prevPot = null;
    for (let h = 1; h <= 40; h += 1) {
      const stamp = genesis + (h - 1) * 9000;
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: stamp });
      const got = store.append({
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
      }, { trustedPowHash: easyPowHash(h), skipSharePow: true });
      assert.equal(got.ok, true, got.reason || `height ${h}`);
      const tip = store.tip();
      const header = decodeHeader(Buffer.from(tip.header));
      assert.equal(Number(header.timestamp), stamp);
      assert.equal(header.bits, seed);
      const want = potSubsidyAt({ nowMs: stamp, genesisMs: genesis, magic: 'shear-dev' });
      const expect = h <= 32 ? POT_START_NANOS : POT_START_NANOS - POT_STEP_NANOS;
      assert.equal(want, expect, `schedule ${h}`);
      const gotPot = potOf(tip);
      assert.ok(gotPot > 0, `missing pot ${h}`);
      assert.equal(gotPot, expect, `coinbase ${h}`);
      prevPot = expect;
    }
    assert.equal(store.tip().height, 40);
    assert.equal(prevPot, POT_START_NANOS - POT_STEP_NANOS);
    assert.equal(POT_STEP_NANOS, 1_000_000_000);
    const onTime = genesis + 40 * 9000;
    const { tpl: onTpl } = store.template({ miner: dest, shareBits: 4, now: onTime });
    assert.equal(decodeHeader(Buffer.from(onTpl.header)).bits, seed);
    const late = genesis + 40 * 9000 + chainParams('shear-dev').asertTauMs;
    const { tpl: lateTpl } = store.template({ miner: dest, shareBits: 4, now: late });
    const lateBits = decodeHeader(Buffer.from(lateTpl.header)).bits;
    assert.ok(lateBits < seed, `late bits ${lateBits}`);
    assert.ok(lateBits > seed - 2 * 65536, `late bits ${lateBits}`);
  });

  async function mineGap(label, gapMs, count, flipAt, resume) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `shear-dev-${label}-`));
    const store = createStore(dir, { network: 'shear-dev' });
    const dest = encodeDest(Buffer.alloc(20, 5));
    const genesis = 1_700_000_000_000;
    const epochMs = chainParams('shear-dev').epochMs;
    for (let h = 1; h <= count; h += 1) {
      const stamp = genesis + (h - 1) * gapMs;
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: stamp });
      assert.equal(Number(decodeHeader(Buffer.from(tpl.header)).timestamp), stamp, `${label} template ${h}`);
      const got = store.append({
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
      }, { trustedPowHash: easyPowHash(h), skipSharePow: true });
      assert.equal(got.ok, true, `${label} ${got.reason || ''} height ${h}`);
      const tip = store.tip();
      const header = decodeHeader(Buffer.from(tip.header));
      assert.equal(Number(header.timestamp), stamp, `${label} tip ${h}`);
      const want = potSubsidyAt({ nowMs: stamp, genesisMs: genesis, magic: 'shear-dev' });
      const epoch = Math.floor((stamp - genesis) / epochMs);
      const expect = POT_START_NANOS - epoch * POT_STEP_NANOS;
      assert.equal(want, expect, `${label} schedule ${h}`);
      assert.equal(potOf(tip), expect, `${label} coinbase ${h}`);
      if (h === flipAt - 1) assert.equal(epoch, 0, `${label} still epoch 0 at ${h}`);
      if (h === flipAt) assert.equal(epoch, 1, `${label} epoch 1 at ${h}`);
    }
    assert.equal(store.tip().height, count);
    const folded = foldSupply(store.blocks, { magic: 'shear-dev' });
    assert.equal(folded.ok, true, `${label} fold ${folded.reason}`);
    const audit = auditCirculatingSupply(store.blocks, { magic: 'shear-dev' });
    assert.equal(audit.status, 'verified', `${label} ${audit.reason}`);
    const v12 = foldSupply(store.blocks, { magic: 'shear-testnet-v12' });
    assert.equal(v12.ok, false, `${label} v12 clock must disagree`);
    assert.throws(() => foldSupply(store.blocks, {}), /unknown_magic/);
    assert.throws(() => foldSupply(store.blocks, { magic: '' }), /unknown_magic/);
    if (resume) {
      const again = createStore(dir, { network: 'shear-dev' });
      assert.equal(again.magic, 'shear-dev');
      assert.equal(again.tip().height, count);
      const reloaded = foldSupply(again.blocks, { magic: 'shear-dev' });
      assert.equal(reloaded.ok, true, `${label} resume ${reloaded.reason}`);
      const reaudit = auditCirculatingSupply(again.blocks, { magic: 'shear-dev' });
      assert.equal(reaudit.status, 'verified', `${label} resume audit ${reaudit.reason}`);
      const snap = path.join(dir, 'book.snap');
      if (fs.existsSync(snap)) fs.unlinkSync(snap);
      const pending = createStore(dir, { network: 'shear-dev', yieldForeign: true });
      assert.equal(pending instanceof Promise, true, `${label} resume token`);
      const tokened = await pending;
      assert.equal(tokened.magic, 'shear-dev');
      assert.equal(tokened.tip().height, count);
      const tokenFold = foldSupply(tokened.blocks, { magic: 'shear-dev' });
      assert.equal(tokenFold.ok, true, `${label} token fold ${tokenFold.reason}`);
      const wrongClock = foldSupply(tokened.blocks, { magic: 'shear-testnet-v12' });
      assert.equal(wrongClock.ok, false, `${label} token path must not accept the v12 clock`);
      assert.throws(() => foldSupply(tokened.blocks, {}), /unknown_magic/);
      assert.throws(
        () => createStore(dir, { network: 'shear-testnet-v12', yieldForeign: true }),
        /datadir_magic/,
      );
      const epochs = tokened.blocks.map((block) => {
        const stamp = Number(decodeHeader(Buffer.from(block.header)).timestamp);
        return Math.floor((stamp - genesis) / epochMs);
      });
      const schedule = epochs.reduce(
        (sum, epoch) => sum + (POT_START_NANOS - epoch * POT_STEP_NANOS),
        0,
      );
      const view = {
        blocks: tokened.blocks,
        magic: 'shear-dev',
        reserveVault: { magic: 'shear-dev' },
        tip() { return this.blocks.at(-1); },
      };
      const settled = await networkSupplySettled(view);
      assert.equal(settled.supplyStatus, 'verified', settled.supplyReason);
      assert.equal(settled.schedulePotNanos, schedule);
      const v12Audit = auditCirculatingSupply(tokened.blocks, { magic: 'shear-testnet-v12' });
      assert.notEqual(v12Audit.status, 'verified');
      const bare = {
        blocks: tokened.blocks,
        reserveVault: { magic: 'shear-dev' },
        tip() { return this.blocks.at(-1); },
      };
      const missed = await networkSupplySettled(bare);
      assert.notEqual(missed.supplyStatus, 'verified');
      assert.equal(missed.supplyReason, 'audit_worker');
    }
  }

  it('validates off a 9s cadence, including gaps that cross an epoch', async () => {
    await mineGap('12s', 12_000, 28, 25, true);
    await mineGap('30s', 30_000, 14, 11, false);
    await mineGap('5s', 5_000, 62, 59, false);
  });
});
