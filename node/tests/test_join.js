import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printConfig } from '../src/node.js';
import { createStore } from '../src/store.js';
import { JOIN_PROGRAM, JOIN_KIND_GENESIS, extraMintAllowed } from '../../crypto/asert.js';
import { encodeDest } from '../../crypto/address.js';
import { decodeHeader } from '../../crypto/header.js';
import { buildTemplate, mineTemplate, GENESIS_PREV, verifyBlock } from '../src/chain.js';

function destMiner() {
  return encodeDest(Buffer.alloc(20, 9));
}

function mineOne(store, dest, bits = 1) {
  const parent = store.tip();
  const now = parent
    ? Number(decodeHeader(Buffer.from(parent.header)).timestamp) + 90_000
    : Date.now();
  const { tpl } = store.template({ miner: dest, bits, shareBits: bits, now });
  const found = mineTemplate({ ...tpl, bits }, { maxTries: 3_000_000, shareBits: bits });
  assert.ok(found && found.block, 'need pow');
  return store.append({
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    miner: dest,
  });
}

describe('node extra-mint snapshot path is gone', () => {
  it('printConfig does not advertise a claim window; extraMintAllowed is false', () => {
    const c = printConfig();
    assert.equal(c.joinRemoved, undefined);
    assert.equal(c.extraMintJoinGenesis, false);
    assert.equal(c.joinProgram, undefined);
    assert.equal(c.joinWindowDays, undefined);
    assert.equal(c.mainnet, false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), false);
  });

  it('verifyBlock and append refuse a mined join-genesis extra-mint', () => {
    const dest = destMiner();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-join-gone-'));
    const store = createStore(dir);
    assert.equal(store.joinVault, undefined);
    const gen = {
      id: 'join-genesis-forbidden',
      programId: JOIN_PROGRAM,
      kind: JOIN_KIND_GENESIS,
      mint: true,
      fee: 8,
      vout: [{ address: dest, nanos: 1, kind: JOIN_KIND_GENESIS }],
    };
    const tpl = buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 1,
      now: Date.now(),
      txs: [gen],
    });
    const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
    assert.ok(found && found.block, 'need pow');
    const block = {
      header: found.header,
      txs: tpl.txs,
      samples: tpl.samples,
      miner: dest,
    };
    const check = verifyBlock(block, null, {});
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'join_removed');
    const got = store.append(block);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'join_removed');
  });

  it('adopt of a valid fork rebuilds without throwing after snapshot vault removal', () => {
    const dest = destMiner();
    const local = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-join-reorg-a-')));
    const peer = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-join-reorg-b-')));
    assert.equal(mineOne(peer, dest).ok, true);
    const got = local.adopt(peer.blocks);
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.reorg, true);
    assert.equal(local.tip().height, 1);
    assert.equal(
      Buffer.from(local.tip().hash).equals(Buffer.from(peer.tip().hash)),
      true,
    );
  });
});
