import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { decodeHeader } from '../../crypto/header.js';
import { openedCoinbaseNanos } from '../../crypto/note.js';
import { POT_START_NANOS, POT_STEP_NANOS, potSubsidyAt } from '../../crypto/pot_sched.js';
import { createStore } from '../src/node.js';

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
      assert.equal(header.bits, GENESIS_BITS_PACKED);
      const want = potSubsidyAt({ nowMs: stamp, genesisMs: genesis, magic: 'shear-dev' });
      const expect = h <= 32 ? POT_START_NANOS : POT_START_NANOS - POT_STEP_NANOS;
      assert.equal(want, expect, `schedule ${h}`);
      const gotPot = potOf(tip);
      if (gotPot > 0) assert.equal(gotPot, expect, `coinbase ${h}`);
      prevPot = expect;
    }
    assert.equal(store.tip().height, 40);
    assert.equal(prevPot, POT_START_NANOS - POT_STEP_NANOS);
    assert.equal(POT_STEP_NANOS, 1_000_000_000);
  });
});
