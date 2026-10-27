// R28: a note paid by the draw is a real, spendable FS-1 note. A wallet
// finds it from the block's record with its scan key, and spends it with
// x = x_base + delta and the public blinding rho, through mempool admit,
// block verify and append, on a regtest chain whose every block and share
// is real ShearHash-v3 work.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import { MAGIC_REGTEST, regtestBitsOverride } from '../../crypto/regtest_bits.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { decodeHeader } from '../../crypto/header.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import { asU8, scalarBytes } from '../../crypto/note.js';
import { walletAnchor } from '../../crypto/admit_v3.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import { buildSend, hiddenOut } from './fs1_send_kit.js';
import { bluWallet, mineBluShares, ownBluNotes } from './support/blunote_mine.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const T0 = 1_700_000_000_000;
const regtestBits = () => regtestBitsOverride(MAGIC_REGTEST);

function lastStamp(store) {
  const tip = store.tip();
  return tip ? Number(decodeHeader(Buffer.from(tip.header)).timestamp) : T0;
}

async function mine(store, miner, shareBatch = []) {
  const now = Math.max(T0, lastStamp(store) + 90_000);
  const { tpl } = store.template({ miner, bits: regtestBits(), now, shareBatch });
  const found = await mineHeaderParallel(tpl.header, tpl.bits, 8_192, 1);
  assert.ok(found && found.block, 'regtest pow');
  const got = await Promise.resolve(store.append({
    header: found.header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }));
  assert.equal(got.ok, true, `append ${got.reason || ''}`);
  return tpl;
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { dest, base: id.admitBase };
}

describe('R28 winner notes are spendable', { concurrency: false }, () => {
  let dir;
  after(() => {
    closeMineWorkers();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a miner finds its winner note and spends it through mempool, verify and append', async () => {
    assert.ok(fs1NativeLoaded(), 'needs the native FS-1 addon');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-r28-spend-'));
    const store = createRegtestStore(dir, { bits: 4 });
    const host = payer();
    const who = bluWallet();
    await mine(store, host.dest);
    // Block 2 seats the miner's own shares, hashed on block 1's header.
    const shares = mineBluShares(who, store.tip().header, 2);
    await mine(store, host.dest, shares);
    const paidBlock = store.tip();
    assert.equal(paidBlock.height, 2);
    const notes = ownBluNotes(who, paidBlock.blunoteRecord);
    assert.ok(notes.length >= 1, 'the miner was paid');
    // A stranger finds none of them.
    assert.equal(ownBluNotes(bluWallet(), paidBlock.blunoteRecord).length, 0);
    // Mature: the spend anchor must cover block 2.
    while (walletAnchor(store.tip().height + 1) == null || walletAnchor(store.tip().height + 1) < 2) {
      await mine(store, host.dest);
    }
    const height = store.tip().height + 1;
    const anchor = walletAnchor(height);
    const live = store.anchorNote(anchor);
    assert.ok(live && live.n >= 1, `anchor ${anchor}`);
    const note = notes[0];
    let index = -1;
    for (let i = 0; i < live.n; i += 1) {
      if (Buffer.from(asU8(live.commits[i])).equals(note.commit)) { index = i; break; }
    }
    assert.ok(index >= 0, 'the winner note is a leaf at the anchor');
    const payee = payer();
    const built = buildSend({
      id: 'r28-winner-spend',
      coins: [{ index, x: note.x, r: scalarBytes(note.rho), v: Number(note.v), commit: note.commit }],
      anchor,
      live,
      outsOf: (room) => [
        hiddenOut(room, hash20FromAddress(payee.dest), payee.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    });
    const { tx } = built;
    const parked = admitMempool(emptyMempool(), tx, {
      magic: store.magic,
      height,
      noteAtAnchor: (a) => store.anchorNote(a),
      blocks: store.blocks,
    });
    assert.equal(parked.ok, true, `mempool ${parked.reason}`);
    const queued = store.queueTx(tx);
    assert.equal(queued.ok, true, `queue ${queued.reason}`);
    const tpl = await mine(store, host.dest);
    assert.ok(tpl.txs.some((row) => row.id === tx.id), 'the spend was sealed');
    const tags = store.fluxset().spendTags;
    for (const p of built.proven.proofs) {
      assert.equal(tags.has(Buffer.from(p.spendTag).toString('hex')), true, 'the spend tag joined the chain');
    }
    // The same note cannot be spent twice.
    const again = buildSend({
      id: 'r28-winner-spend-again',
      coins: [{ index, x: note.x, r: scalarBytes(note.rho), v: Number(note.v), commit: note.commit }],
      anchor: walletAnchor(store.tip().height + 1),
      live: store.anchorNote(walletAnchor(store.tip().height + 1)),
      outsOf: (room) => [
        hiddenOut(room, hash20FromAddress(payee.dest), payee.base, 'send'),
        hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
      ],
    });
    const twice = store.queueTx(again.tx);
    assert.equal(twice.ok, false, 'a spent winner note was queued again');
  });
});
