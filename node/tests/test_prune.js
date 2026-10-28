import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, freshStealthDest, hash20FromAddress, encodeDest } from '../../crypto/address.js';
import { spendBox } from '../../tests/spend_box.js';
import { HASH_BONUS_NANOS, SAMPLE_PRUNE_CONFIRMATIONS, GENESIS_BITS_PACKED } from '../../crypto/asert.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { admitScalarFromSeed, attachAdmitPub } from '../../crypto/admit.js';
import { asU8, kernelExcess, openedCoinbaseNanos, sealHiddenNote, sealNote } from '../../crypto/note.js';
import { readyHeight, walletAnchor } from '../../crypto/admit_v3.js';
import {
  FS1_RECORD_BYTES,
  FS1_WIRE,
  fs1BlobLen,
  fs1ProveSpend,
} from '../../crypto/fs1_spend.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { createStore } from '../src/store.js';
import { reconstructOwner } from '../../pool/src/wallet_api.js';
import { readChainSegments } from '../../crypto/chainbin.js';
import { decodeHeader } from '../../crypto/header.js';
import { bluWallet, soloCoin, soloPay } from './support/blunote_mine.js';

let powTag = 1;
function mine(tpl) {
  const pow = Buffer.alloc(32, 0);
  pow[31] = powTag;
  powTag += 1;
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
    trustedPowHash: pow,
  };
}
function trust(block) {
  return { trustedPowHash: block.trustedPowHash || block.hash, skipSharePow: true };
}

function hiddenOut(nanos, dest20, admitBase, kind) {
  // A dummy is publicly zero. The flow check opens that proof. Pay and change stay hidden.
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

/** One FS-1 send. Byte-2 admit blobs are rejected, so the sealed id has to be a real proof. */
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

describe('node chain is lean, light, scalable, prunable', { timeout: 600_000 }, () => {
  it('collates hashes, prunes sample bodies, keeps sealed txs for explorer', async () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const aliceBox = spendBox(alice);
    const destA = aliceBox.dest;
    const destB = freshStealthDest(bob).dest;
    // Same dest20 as the history address, with Alice's admit base so the pot is spendable.
    const minerDest = encodeDest(hash20FromAddress(destA), alice.admitBase);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-prune-'));
    const store = createStore(dir, { pruneAfter: 2 });
    const fat = Array.from({ length: 250 }, (_, i) => ({
      miner: minerDest,
      nonce: String(i),
      tag: 'a',
      count: 1,
    }));
    const t0 = 1_700_000_000_000;

    // R28: the genesis round is Alice's solo option (b) round. Its pot is a
    // record coin of her wallet, which verify derives and her scan key finds.
    const aliceBlu = bluWallet(alice.spendSeed);
    const b1 = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: minerDest,
      bits: GENESIS_BITS_PACKED,
      now: t0,
      samples: fat,
      ...soloPay(aliceBlu),
    }));
    const a1 = await Promise.resolve(store.append(b1, trust(b1)));
    assert.equal(a1.ok, true, a1.reason);
    assert.equal(store.blocks[0].samples.length, 1);
    assert.equal(store.blocks[0].samples[0].count, 250);
    assert.equal(store.blocks[0].txs[0].samples, undefined);
    const storedPot = soloCoin(aliceBlu, store.blocks[0]);
    assert.ok(storedPot && storedPot.r && storedPot.commit, 'height-1 pot opening');
    const potR = storedPot.r;
    const potV = storedPot.v;
    assert.ok(potV > 0, 'pot value');

    const includeAt = readyHeight(1);
    while (store.tip().height < includeAt - 1) {
      const parent = store.tip();
      const parentH = decodeHeader(Buffer.from(parent.header));
      const nxt = mine(buildTemplate({
        prev: parent.hash,
        prevHeader: parent.header,
        prevBlock: parent,
        height: parent.height + 1,
        miner: minerDest,
        bits: GENESIS_BITS_PACKED,
        now: Number(parentH.timestamp) + 90_000,
      }));
      assert.equal((await Promise.resolve(store.append(nxt, trust(nxt)))).ok, true);
    }
    const anchor = walletAnchor(includeAt);
    const live = store.anchorNote(anchor);
    assert.ok(live && live.n >= 1, `anchor ${anchor}`);
    let index = -1;
    const wantCommit = Buffer.from(asU8(storedPot.commit));
    for (let i = 0; i < live.n; i += 1) {
      if (Buffer.from(asU8(live.commits[i])).equals(wantCommit)) index = i;
    }
    assert.ok(index >= 0, 'height-1 pot is inside the anchor');
    const pay20 = hash20FromAddress(destB);
    const change20 = hash20FromAddress(destA);
    const send = fs1Send({
      id: 'send-forever',
      coin: {
        index,
        r: potR,
        v: potV,
        x: storedPot.x,
      },
      anchor,
      live,
      magic: store.magic,
      outsOf: (room) => {
        const pay = Math.max(1, Math.floor(room / 3));
        return [
          hiddenOut(pay, pay20, bob.admitBase, 'send'),
          hiddenOut(room - pay, change20, alice.admitBase, 'send'),
          hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
        ];
      },
    });
    assert.ok(send, 'send-forever proof');
    const parentSend = store.tip();
    const parentSendH = decodeHeader(Buffer.from(parentSend.header));
    const sendBlock = mine(buildTemplate({
      prev: parentSend.hash,
      prevHeader: parentSend.header,
      prevBlock: parentSend,
      parentBlocks: store.blocks,
      height: parentSend.height + 1,
      miner: minerDest,
      bits: GENESIS_BITS_PACKED,
      now: Number(parentSendH.timestamp) + 90_000,
      txs: [send],
    }));
    const sendOk = await Promise.resolve(store.append(sendBlock, trust(sendBlock)));
    assert.equal(sendOk.ok, true, sendOk.reason);
    const sendHeight = store.tip().height;

    for (let i = 0; i < 2; i += 1) {
      const parent = store.tip();
      const parentH = decodeHeader(Buffer.from(parent.header));
      const nxt = mine(buildTemplate({
        prev: parent.hash,
        prevHeader: parent.header,
        prevBlock: parent,
        height: parent.height + 1,
        miner: destA,
        bits: GENESIS_BITS_PACKED,
        now: Number(parentH.timestamp) + 90_000,
      }));
      assert.equal((await Promise.resolve(store.append(nxt, trust(nxt)))).ok, true);
    }

    const buried = store.blocks.find((b) => Number(b.height) === sendHeight) || store.blocks[0];
    const genesis = store.blocks[0];
    assert.notEqual(genesis.samplesPruned, true);
    assert.ok((genesis.samples || []).length > 0);
    // The genesis round's payout key is its coinbase's, and its record stays.
    assert.ok(genesis.txs[0].blunote?.feeP, 'the genesis coinbase names its payout key');
    assert.ok(genesis.blunoteRecord, 'the genesis record is kept');
    assert.equal(HASH_BONUS_NANOS, 1);
    assert.ok(buried.txs.slice(1).some((t) => t.id === 'send-forever'));

    const segDir = path.join(dir, 'segments');
    assert.equal(fs.existsSync(path.join(segDir, 'seg-000000.bin')), true);
    const epochs = readChainSegments(segDir);
    assert.ok(epochs.length >= 1);
    assert.equal(epochs[0].samplesPruned, false);
    assert.ok(Buffer.from(epochs[0].txs[0].blunote.feeP).equals(Buffer.from(genesis.txs[0].blunote.feeP)), 'the chainbin keeps the genesis payout key');
    const sendEpoch = epochs.find((e) => (e.txs || []).some((t) => t.id === 'send-forever'));
    assert.ok(sendEpoch, 'send-forever stays in the pruned chainbin');
    assert.ok(sendEpoch.txs.slice(1).some((t) => t.id === 'send-forever'));
    const buriedBin = verifyBlock({
      ...epochs[0],
      samples: [],
      shareBatch: [],
      samplesPruned: true,
      height: epochs[0].height || 1,
    }, null, { tipHeight: SAMPLE_PRUNE_CONFIRMATIONS + 1, trustedPowHash: epochs[0].hash, skipSharePow: true });
    assert.equal(buriedBin.ok, false);
    assert.equal(buriedBin.reason, 'samples_pruned');

    const histAlice = reconstructOwner(store, destA);
    const histBob = reconstructOwner(store, destB);
    assert.ok(histAlice.txs.some((t) => String(t.id).startsWith('send-forever')));
    assert.ok(histBob.txs.some((t) => String(t.id).startsWith('send-forever')));
    assert.ok(histAlice.txs.some((t) => t.kind === 'hash' || t.kind === 'coinbase'));

    const buriedCheck = verifyBlock(genesis, null, {
      tipHeight: SAMPLE_PRUNE_CONFIRMATIONS + Number(genesis.height || 1),
      ...trust(genesis),
    });
    assert.equal(buriedCheck.ok, true, buriedCheck.reason);

    const reopened = createStore(dir, { pruneAfter: 2 });
    const again = reconstructOwner(reopened, destB);
    assert.ok(again.txs.some((t) => String(t.id).startsWith('send-forever')));
  });
});
