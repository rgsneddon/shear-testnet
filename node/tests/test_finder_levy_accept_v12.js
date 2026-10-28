/**
 * A fee body is a byte-3 send. Stage 0 rejects that proof before
 * admitProveV3. A coinbase flag and a stripped body are not this path. The
 * fee is the weight levy of the sealed proof. Under R28 (as built, Russell
 * 28 Oct) the template that seats it pays the finder levy with the draw, or
 * in an empty round with the fee key or the reserve note: never a public
 * finder-fee note for a named finder, so there is nothing to aim. The spent
 * note is the payer's own solo option (b) pot, found with its scan key.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { createRegtestStore } from './regtest_store.js';
import { closeMineWorkers, mineHeaderParallel } from './mine_worker.mjs';
import {
  buildTemplate,
  verifyBlock,
  templateForFinder,
  digestTx,
  GENESIS_PREV,
} from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { newIdentity, encodeDest, hash20FromAddress } from '../../crypto/address.js';
import {
  FEE_SPLIT_FINDER_BPS,
  LEVY_CAP_NANOS,
  LEVY_FLOOR_UNITS,
  levyNeed,
  reserveFeeDest,
  splitLevy,
} from '../../crypto/levy.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { compactTx } from '../../crypto/chronoflux.js';
import {
  admitPub,
  blindCommit,
  attachAdmitPub,
  jroot,
} from '../../crypto/admit.js';
import {
  asU8,
  kernelExcess,
  openedCoinbaseNanos,
  pointBytes,
  pointFrom,
  randomScalar,
  scalarBytes,
  sealNote,
} from '../../crypto/note.js';
import { viewTagOf } from '../../crypto/dummy.js';
import {
  admitV3Context,
  flowProofVerifyCount,
  fundingJroot,
  resetFlowProofVerifies,
  txDigestV3,
  walletAnchor,
} from '../../crypto/admit_v3.js';
import { bluWallet, soloCoin, soloPay } from './support/blunote_mine.js';

const T0 = 1_700_000_000_000;
const PROOF_CAP = 40354;
const PROGRESS = path.join(os.tmpdir(), 'shear-finder-levy-accept-progress.txt');

function progress(row) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...row });
  console.log(line);
  try { fs.appendFileSync(PROGRESS, `${line}\n`); } catch { /* a log miss is not a verdict */ }
}

/** The prover stores (hp(P) * x). hp is SHA-512("shear-admit-Hp" || P) and the ristretto one-way map. spendTag() is a different point, so a digest that uses it cannot verify. */
function nativeSpendTag(x) {
  const pBytes = Buffer.from(pointBytes(admitPub(x)));
  const wide = createHash('sha512').update(Buffer.from('shear-admit-Hp')).update(pBytes).digest();
  return Buffer.from(pointBytes(RistrettoPoint.hashToCurve(wide).multiply(x)));
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, base: id.admitBase, blu: bluWallet(id.spendSeed) };
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

function dest20(addr) {
  return Buffer.from(hash20FromAddress(addr));
}

function same20(note, addr) {
  return !!(note?.dest20 && Buffer.from(note.dest20).equals(dest20(addr)));
}

function byteSort(rows) {
  return rows.slice().sort((a, b) => dest20(a.dest).compare(dest20(b.dest)));
}

// Regtest work (bits 4, about 16 hashes). Every block carries a real nonce
// and is stored under its own ShearHash, with no trusted hash.
async function sealHeader(header, bits) {
  const found = await mineHeaderParallel(header, bits, 8_192, 1);
  assert.ok(found && found.block, 'regtest pow');
  return found.header;
}

// The first block is the miner's solo option (b) round: its pot is paid to
// a one-time key of `who`, which only `who` recognises.
async function grow(store, who, n) {
  let opening = null;
  const dest = who.dest;
  for (let i = 0; i < n; i += 1) {
    const now = T0 + i * 90_000;
    const { tpl } = store.template({ miner: dest, shareBits: 4, now, ...(i === 0 ? soloPay(who.blu) : {}) });
    const got = await Promise.resolve(store.append({
      header: await sealHeader(tpl.header, tpl.bits),
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
    }));
    assert.equal(got.ok, true, `height ${i + 1} ${got.reason || ''}`);
    if (i === 0) {
      opening = soloCoin(who.blu, store.tip());
      assert.ok(opening, 'the solo round paid its pot to the miner's key');
    }
  }
  return opening;
}

function coinbaseOnly(tpl) {
  const cb = tpl.txs[0];
  const decoded = decodeHeader(Buffer.from(tpl.header));
  const header = encodeHeader({
    version: decoded.version,
    prevBlockHash: decoded.prevBlockHash,
    merkleRoot: merkleRoot([digestTx(cb)]),
    continuityRoot: decoded.continuityRoot,
    timestamp: decoded.timestamp,
    bits: decoded.bits,
    nonce: 0n,
    baseFee: decoded.baseFee,
  });
  return { ...tpl, header, txs: [cb], merkleRoot: merkleRoot([digestTx(cb)]) };
}

function blockOf(tpl) {
  return {
    header: tpl.header,
    height: tpl.height,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

describe('accepted finder levy', () => {
  after(() => closeMineWorkers());

  it('a template seating a fee body pays its levy as built, and a byte-3 stand-in is gated before any proof', { timeout: 7_200_000 }, async () => {
    const who = payer();
    const payee = payer();
    const feeTo = payer();
    const prepared = [];
    for (let i = 0; i < 7; i += 1) prepared.push(payer());
    const sorted = byteSort(prepared);
    const templateMiner = sorted[0].dest;
    const finders = [sorted[0], sorted[3], sorted[6]];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-finder-levy-accept-'));
    const store = createRegtestStore(dir, { bits: 4 });
    resetFlowProofVerifies();
    try { fs.unlinkSync(PROGRESS); } catch { /* first run */ }
    try {
      const opening = await grow(store, who, 16);
      const height = store.tip().height + 1;
      const anchor = walletAnchor(height);
      assert.equal(height, 17);
      assert.equal(anchor, 8);
      assert.ok(opening && opening.v > LEVY_CAP_NANOS, String(opening && opening.v));
      const book = store.anchorNote(anchor);
      assert.ok(book && book.n >= 1 && book.pubs.length === book.n);
      const stored = Buffer.from(asU8(book.jroot));
      const recomputed = Buffer.from(jroot({ pubs: book.pubs, commits: book.commits }));
      assert.ok(stored.equals(recomputed), 'anchor book is not the stored root');
      const root = fundingJroot(book);
      assert.ok(root, 'point root');
      let index = -1;
      for (let i = 0; i < book.commits.length; i += 1) {
        if (Buffer.from(asU8(book.commits[i])).equals(opening.commit)) index = i;
      }
      assert.ok(index >= 0, 'spent note is outside the anchor');
      const x = opening.x;
      assert.ok(opening.admitPub.equals(Buffer.from(pointBytes(admitPub(x)))), 'x opens the paid key');
      assert.ok(Buffer.from(asU8(book.pubs[index])).equals(opening.admitPub), 'the anchor leaf is the paid key');
      const t = randomScalar();
      const tag = nativeSpendTag(x);
      const cTilde = Buffer.from(blindCommit(opening.commit, scalarBytes(t)));
      // compactTx replaces a posted tag with bytes 1..33 of a version-3 blob.
      // A filler that does not carry this tag seals the wrong point into the digest.
      const standBlob = Buffer.alloc(PROOF_CAP, 3);
      tag.copy(standBlob, 1);
      const standIn = {
        admit_proof: true,
        v: 3,
        spendTag: Buffer.from(tag),
        blob: standBlob,
        cTilde,
      };

      const pay20 = hash20FromAddress(payee.dest);
      const change20 = hash20FromAddress(who.dest);
      const dummy20 = Buffer.alloc(20, 4);

      function rangeSlack(tx) {
        let bytes = 0;
        for (const o of tx.vout || []) {
          if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
        }
        return Math.ceil((bytes * 2) / 2048) + 8;
      }

      let fee = LEVY_FLOOR_UNITS;
      let draft = null;
      let pay = 0;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const room = opening.v - fee;
        assert.ok(room > 1, `fee consumes the note ${opening.v} ${fee}`);
        pay = 1;
        const change = room - pay;
        const outs = [
          hiddenOut(pay, pay20, payee.base, 'send'),
          hiddenOut(change, change20, who.base, 'send'),
          hiddenOut(0, dummy20, null, 'dummy'),
        ];
        const excess = kernelExcess(outs, [{ r: opening.r, t: scalarBytes(t) }]);
        assert.ok(excess, 'excess');
        draft = compactTx({
          id: `send-${fee}`,
          kind: 'send',
          anchor,
          fee,
          vin: [{ commit: cTilde }],
          vout: outs,
          admit_proof: standIn,
          spendTag: Buffer.from(tag),
          excess,
        });
        const worst = {
          ...draft,
          admit_proof: { ...draft.admit_proof, blob: Buffer.alloc(PROOF_CAP, 255) },
        };
        const need = levyNeed(worst);
        if (fee >= need && fee <= LEVY_CAP_NANOS) break;
        const next = need + rangeSlack(draft);
        assert.ok(next > fee && next <= LEVY_CAP_NANOS, `levy ${need} slack fee ${fee}`);
        fee = next;
        draft = null;
      }
      assert.ok(draft, 'fee did not cover the proof cap');
      assert.equal(draft.coinbase, undefined);
      assert.equal(draft.kind, 'send');
      assert.ok(Buffer.from(asU8(draft.spendTag)).equals(tag), 'compact rewrote the spend tag');
      assert.ok(Buffer.from(asU8(draft.admit_proof.spendTag)).equals(tag), 'compact rewrote the proof tag');
      const tx = draft;
      const need = levyNeed(tx);
      assert.ok(tx.fee >= need && tx.fee <= LEVY_CAP_NANOS, `levy ${need} fee ${tx.fee}`);
      const split = splitLevy(tx.fee);
      assert.equal(FEE_SPLIT_FINDER_BPS, 10000);
      assert.equal(split.finder, Math.floor(tx.fee * FEE_SPLIT_FINDER_BPS / 10000));
      assert.equal(split.finder, tx.fee);
      assert.equal(split.reserve, 0);
      assert.equal(split.finder + split.reserve, tx.fee);
      const parked = admitMempool(emptyMempool(), tx, {
        magic: store.magic,
        height,
        noteAtAnchor: (got) => store.anchorNote(got),
        blocks: store.blocks,
      });
      assert.equal(parked.ok, false, parked.reason);
      assert.equal(parked.reason, 'send_unavailable');
      assert.equal(flowProofVerifyCount(), 0);
      assert.equal(store.queueTx(tx).reason, 'send_unavailable');
      assert.equal(store.mempool.some((row) => row.id === tx.id), false);

      const tip = store.tip();
      const preview = store.template({ miner: templateMiner, shareBits: 4, now: T0 + 16 * 90_000 });
      assert.equal(preview.tpl.txs.some((row) => row.id === tx.id), false);
      const stamp = Number(decodeHeader(Buffer.from(preview.tpl.header)).timestamp);
      let genesisMs = 0;
      try {
        genesisMs = Number(decodeHeader(Buffer.from(store.blocks[0].header)).timestamp) || 0;
      } catch { /* missing genesis clock stays 0 */ }
      const parentSupply = typeof store.supplyState === 'function' ? store.supplyState() : null;
      const verifyOpts = {
        noteAtAnchor: (got) => store.anchorNote(got),
        evmHistory: store.blocks,
        genesisMs,
        magic: store.magic,
        ...(parentSupply ? { parentSupply } : {}),
      };

      function aimedTemplate(finderDest) {
        return buildTemplate({
          prev: tip.hash,
          prevHeader: tip.header,
          prevBlock: tip,
          height,
          miner: templateMiner,
          finderDest,
          poolDest: feeTo.dest,
          feeDest: feeTo.dest,
          bits: preview.tpl.bits,
          now: stamp,
          txs: [tx],
          parentBlocks: store.blocks,
        });
      }

      // As built: an empty round with no fee key pays the whole finder levy
      // with the reserve note. No prepared dest, finder or pool is paid a
      // public note, and there is nothing for a pool to aim.
      function assertPays(tpl, label) {
        assert.ok(tpl.txs.some((row) => row.id === tx.id), `${label} dropped the spend`);
        assert.equal(tpl.txs.slice(1).some((row) => row && row.coinbase), false);
        const cb = tpl.txs[0];
        assert.equal((cb.vout || []).some((o) => o.kind === 'finder-fee'), false, label);
        const reserveNotes = (cb.vout || []).filter((o) => o.kind === 'reserve-fee');
        assert.equal(reserveNotes.length, 1, label);
        assert.equal(openedCoinbaseNanos(reserveNotes[0]), split.finder + split.reserve, label);
        assert.equal(same20(reserveNotes[0], reserveFeeDest()), true, label);
        for (const other of [...prepared, feeTo, who]) assert.equal(same20(reserveNotes[0], other.dest), false, label);
        assert.equal(templateForFinder(tpl, finders[1].dest), tpl, `${label}: nothing to aim`);
      }

      const built = aimedTemplate(finders[0].dest);
      assertPays(built, 'template');
      assertPays(aimedTemplate(finders[2].dest), 'another named finder');
      const aimed = { ...built, header: await sealHeader(built.header, built.bits) };
      const verdict = verifyBlock(blockOf(aimed), tip, verifyOpts);
      assert.equal(verdict.ok, false, verdict.reason);
      assert.equal(verdict.reason, 'send_unavailable');
      assert.equal(flowProofVerifyCount(), 0);
      const appended = await Promise.resolve(store.append(blockOf(aimed)));
      assert.equal(appended.ok, false, appended.reason);
      assert.equal(appended.reason, 'send_unavailable');
      assert.equal(store.tip().height, height - 1);
      assert.equal(flowProofVerifyCount(), 0);
      progress({ phase: 'gated', fee: tx.fee, finder: split.finder, reserve: split.reserve });
    } finally {
      try { store.close?.(); } catch { /* temp dir */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
