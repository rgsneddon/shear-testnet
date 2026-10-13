/**
 * The wallet seals an interim testnet membership proof (byte 3, one anchor).
 * queueTx, the mempool, and verifyBlock accept a send, a transfer, and an
 * 8-input send. FS-1 replaces the statement. This is not full-set hiding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildTemplate, verifyBlock, GENESIS_PREV } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { levyNeed, LEVY_CAP_NANOS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { signSpendTx } from '../../crypto/spend.js';
import { admitScalarFromSeed, attachAdmitPub } from '../../crypto/admit.js';
import { sealFlowMembership } from '../../crypto/flow_membership.js';
import {
  asU8,
  kernelExcess,
  openedCoinbaseNanos,
  randomScalar,
  scalarBytes,
  sealNote,
} from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import { fundingJroot, walletAnchor } from '../../crypto/admit_v3.js';

const T0 = 1_700_000_000_000;
const PROGRESS = path.join(os.tmpdir(), 'wallet-v12-send-progress.txt');
process.env.SHEAR_MEMBERSHIP_PROGRESS = PROGRESS;

function progress(row) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...row });
  console.error(line);
  try { fs.appendFileSync(PROGRESS, `${line}\n`); } catch { /* a log miss is not a verdict */ }
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, base: id.admitBase, key: id.privateKey };
}

function hiddenOut(nanos, dest20, admitBase, kind) {
  let note = attachAdmitPub(
    sealNote(nanos, { dest20, kind }),
    admitBase ? { admitBase } : {},
  );
  note = {
    ...note,
    kind,
    dest20: Buffer.from(dest20),
    viewTag: viewTagOf(note.noteCommit),
  };
  if (kind !== 'dummy') delete note.valueProof;
  return note;
}

async function grow(store, dest, n) {
  const openings = [];
  for (let i = 0; i < n; i += 1) {
    const now = T0 + i * 90_000;
    const { tpl } = store.template({ miner: dest, shareBits: 4, now });
    const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
    openings.push({
      r: Buffer.from(asU8(pot.r)),
      v: openedCoinbaseNanos(pot),
      commit: Buffer.from(asU8(pot.commit)),
    });
    const got = await Promise.resolve(store.append({
      header: tpl.header,
      height: tpl.height,
      txs: tpl.txs,
      samples: tpl.samples,
      shareBatch: tpl.shareBatch || [],
      miner: dest,
      aLeaves: tpl.aLeaves,
      bLeaves: tpl.bLeaves,
      rootA: tpl.rootA,
      rootB: tpl.rootB,
      weight: tpl.weight,
    }, { trustedPowHash: Buffer.alloc(32), skipSharePow: true }));
    assert.equal(got.ok, true, `height ${i + 1} ${got.reason || ''}`);
  }
  return openings;
}

function noteByCommit(store, commit) {
  for (const block of store.blocks || []) {
    for (const tx of block.txs || []) {
      for (const o of tx.vout || []) {
        if (o?.commit && Buffer.from(asU8(o.commit)).equals(commit)) return o;
      }
    }
  }
  return null;
}

function blockVerdict(store, dest, tx) {
  const tip = store.tip();
  const preview = store.template({ miner: dest, shareBits: 4, now: T0 + 20 * 90_000 });
  const stamp = Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp);
  const built = buildTemplate({
    prev: tip ? tip.hash : GENESIS_PREV,
    prevHeader: tip ? tip.header : undefined,
    prevBlock: tip || null,
    height: (tip?.height || 0) + 1,
    miner: dest,
    bits: preview.tpl.bits,
    now: stamp,
    txs: [tx],
    parentBlocks: store.blocks,
  });
  assert.ok(built.txs.some((row) => row.id === tx.id), 'template dropped the spend');
  let genesisMs = 0;
  try {
    const g = store.blocks[0];
    if (g?.header) genesisMs = Number(decodeHeader(Buffer.from(g.header)).timestamp) || 0;
  } catch { /* a missing genesis clock stays 0 */ }
  const parentSupply = typeof store.supplyState === 'function' ? store.supplyState() : null;
  return verifyBlock({
    header: built.header,
    height: built.height,
    txs: built.txs,
    samples: built.samples,
    shareBatch: built.shareBatch || [],
    miner: dest,
    aLeaves: built.aLeaves,
    bLeaves: built.bLeaves,
    rootA: built.rootA,
    rootB: built.rootB,
    weight: built.weight,
  }, tip, {
    trustedPowHash: Buffer.alloc(32),
    skipSharePow: true,
    noteAtAnchor: (anchor) => store.anchorNote(anchor),
    evmHistory: store.blocks,
    genesisMs,
    magic: MAGIC_TESTNET,
    ...(parentSupply ? { parentSupply } : {}),
  });
}

function sealSpend({ kind, rows, book, anchor, who, payee, payNanos }) {
  const pay20 = hash20FromAddress(payee.dest);
  const change20 = hash20FromAddress(who.dest);
  const dummy20 = Buffer.alloc(20, 4);
  let fee = 20000;
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const sum = rows.reduce((n, row) => n + row.v, 0);
    const room = sum - fee;
    assert.ok(room > 1, `fee consumes the notes ${sum} ${fee}`);
    const pay = Math.min(payNanos, room - 1);
    const change = room - pay;
    const outs = [hiddenOut(pay, pay20, payee.base, kind)];
    if (change > 0) outs.push(hiddenOut(change, change20, who.base, 'send'));
    outs.push(hiddenOut(0, dummy20, null, 'dummy'));
    const excess = kernelExcess(outs, rows.map((row) => ({ r: row.r, t: scalarBytes(row.t) })));
    assert.ok(excess, 'excess');
    const sealed = sealFlowMembership({
      id: `${kind}-${rows.length}-${attempt}`,
      kind,
      anchor,
      fee,
      maxLevy: fee,
      vout: outs,
      excess,
    }, {
      inputs: rows.map((row) => ({ x: row.x, index: row.index, c: row.c, t: row.t })),
      pubs: book.pubs,
      commits: book.commits,
      n: book.n,
      root: fundingJroot(book),
    });
    assert.ok(sealed, `${kind} seal ${attempt}`);
    const posted = compactTx(sealed);
    signSpendTx(posted, who.key);
    const need = levyNeed(posted);
    last = posted;
    if (posted.fee >= need && posted.fee <= LEVY_CAP_NANOS) return posted;
    fee = need + 128;
  }
  assert.fail(`${kind} fee did not cover ${last && levyNeed(last)}`);
  return last;
}

describe('wallet v12 send', () => {
  it('seals a send, a transfer, and an 8-input spend the node accepts', { timeout: 14 * 60 * 60 * 1000 }, async () => {
    const who = payer();
    const payee = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wallet-v12-send-'));
    const store = createStore(dir);
    try {
      progress({ phase: 'grow-start' });
      const openings = await grow(store, who.dest, 16);
      progress({ phase: 'grow-done', height: store.tip().height });
      const height = store.tip().height + 1;
      const anchor = walletAnchor(height);
      assert.equal(anchor, 8);
      const book = store.anchorNote(anchor);
      assert.ok(book && book.n >= 8, `anchor set ${book && book.n}`);
      const rows = [];
      for (let i = 0; i < 8; i += 1) {
        const open = openings[i];
        const note = noteByCommit(store, open.commit);
        assert.ok(note, `pot ${i}`);
        let index = -1;
        for (let j = 0; j < book.commits.length; j += 1) {
          if (Buffer.from(asU8(book.commits[j])).equals(open.commit)) index = j;
        }
        assert.ok(index >= 0, `index ${i}`);
        rows.push({
          x: admitScalarFromSeed(who.spendSeed, note),
          index,
          c: note.commit,
          t: randomScalar(),
          r: open.r,
          v: open.v,
        });
      }

      const opts = {
        height,
        noteAtAnchor: (got) => store.anchorNote(got),
        blocks: store.blocks,
      };

      progress({ phase: 'seal-start', kind: 'send', inputs: 1 });
      const send = sealSpend({
        kind: 'send',
        rows: [rows[0]],
        book,
        anchor,
        who,
        payee,
        payNanos: 1,
      });
      progress({ phase: 'seal-done', kind: 'send', inputs: 1, fee: send.fee });
      assert.equal(send.admit_proof.blob[0], 3);
      assert.equal(send.anchor, 8);
      const parked = admitMempool(emptyMempool(), send, opts);
      assert.equal(parked.ok, true, `send mempool ${parked.reason}`);
      const verdict = await Promise.resolve(blockVerdict(store, who.dest, send));
      assert.equal(verdict.ok, true, `send verify ${verdict.reason}`);
      progress({ phase: 'send-accepted' });

      progress({ phase: 'seal-start', kind: 'transfer', inputs: 1 });
      const transfer = sealSpend({
        kind: 'transfer',
        rows: [rows[1]],
        book,
        anchor,
        who,
        payee,
        payNanos: 1,
      });
      progress({ phase: 'seal-done', kind: 'transfer', inputs: 1, fee: transfer.fee });
      assert.equal(transfer.admit_proof.blob[0], 3);
      assert.equal(transfer.admit_proofs, undefined);
      const parkedTransfer = admitMempool(emptyMempool(), transfer, opts);
      assert.equal(parkedTransfer.ok, true, `transfer mempool ${parkedTransfer.reason}`);
      const transferBlock = await Promise.resolve(blockVerdict(store, who.dest, transfer));
      assert.equal(transferBlock.ok, true, `transfer verify ${transferBlock.reason}`);
      progress({ phase: 'transfer-accepted' });

      progress({ phase: 'seal-start', kind: 'send', inputs: 8 });
      const multi = sealSpend({
        kind: 'send',
        rows,
        book,
        anchor,
        who,
        payee,
        payNanos: 8,
      });
      progress({ phase: 'seal-done', kind: 'send', inputs: 8, fee: multi.fee });
      assert.equal(multi.admit_proof, undefined);
      assert.equal(multi.admit_proofs.length, 8);
      assert.equal(multi.admit_proofs[0].blob[0], 3);
      assert.equal(multi.anchor, anchor);
      const parkedMulti = admitMempool(emptyMempool(), multi, opts);
      assert.equal(parkedMulti.ok, true, `8-input mempool ${parkedMulti.reason}`);
      const multiBlock = await Promise.resolve(blockVerdict(store, who.dest, multi));
      assert.equal(multiBlock.ok, true, `8-input verify ${multiBlock.reason}`);
      progress({ phase: 'multi-accepted' });
      const queued = store.queueTx(send);
      assert.equal(queued.ok, true, `send queue ${queued.reason}`);
      const tip = store.tip();
      const now = Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000;
      const { tpl } = store.template({ miner: who.dest, shareBits: 4, now });
      assert.ok(tpl.txs.some((row) => row.id === send.id), 'mempool spend was not templated');
      const appended = await Promise.resolve(store.append({
        header: tpl.header,
        height: tpl.height,
        txs: tpl.txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: who.dest,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        rootA: tpl.rootA,
        rootB: tpl.rootB,
        weight: tpl.weight,
      }, { trustedPowHash: Buffer.alloc(32), skipSharePow: true }));
      assert.equal(appended.ok, true, `append ${appended.reason}`);
      const landed = store.blocks[store.blocks.length - 1].txs.find((row) => row.id === send.id);
      assert.ok(landed, 'send is not in the block');
      assert.equal(Buffer.from(asU8(landed.admit_proof.blob))[0], 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
