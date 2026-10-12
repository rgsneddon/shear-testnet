/**
 * An honest byte-3 flow spend is accepted on queueTx, admitMempool, and
 * verifyBlock. The pay is whatever the spent note opened to, minus the fee
 * the weight levy actually requires. Dust keeps the remainder as change.
 * The proof is admitProveV3. A skipped verifier leaves the count at 0.
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
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import {
  admitProveV3,
  admitPub,
  admitScalarFromSeed,
  blindCommit,
  attachAdmitPub,
  jroot,
} from '../../crypto/admit.js';
import {
  asU8,
  kernelExcess,
  openedCoinbaseNanos,
  pointBytes,
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

const T0 = 1_700_000_000_000;
const PROGRESS = path.join(os.tmpdir(), 'shear-flow-v3-accept-progress.txt');

function progress(row) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...row });
  console.log(line);
  try { fs.appendFileSync(PROGRESS, `${line}\n`); } catch { /* a log miss is not a verdict */ }
}

function payer() {
  const id = newIdentity();
  const dest = encodeDest(Buffer.from(id.spendPub.subarray(0, 20)), id.admitBase);
  return { id, dest, spendSeed: id.spendSeed, base: id.admitBase };
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
  let opening = null;
  for (let i = 0; i < n; i += 1) {
    const now = T0 + i * 90_000;
    const { tpl } = store.template({ miner: dest, shareBits: 4, now });
    if (!opening) {
      const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
      opening = {
        r: Buffer.from(asU8(pot.r)),
        v: openedCoinbaseNanos(pot),
        commit: Buffer.from(asU8(pot.commit)),
      };
    }
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
  return opening;
}

function blockVerdict(store, dest, tx) {
  const tip = store.tip();
  const preview = store.template({ miner: dest, shareBits: 4, now: T0 + 16 * 90_000 });
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
  // The template root covers every parent block. Verifying against only the
  // previous block reports that mismatch as admit_membership. Above height 1
  // the supply check also needs the published tip state.
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

describe('v12 honest flow spend', () => {
  it('queue, mempool, and verify accept a byte-3 spend of any opened note', { timeout: 21_600_000 }, async () => {
    const who = payer();
    const payee = payer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-flow-v3-accept-'));
    const store = createStore(dir);
    resetFlowProofVerifies();
    try { fs.unlinkSync(PROGRESS); } catch { /* first run */ }
    try {
      const opening = await grow(store, who.dest, 16);
      const height = store.tip().height + 1;
      const anchor = walletAnchor(height);
      assert.equal(height, 17);
      assert.equal(anchor, 8);
      assert.ok(opening && opening.v > 1, String(opening && opening.v));
      const book = store.anchorNote(anchor);
      assert.ok(book && book.n >= 1 && book.pubs.length === book.n);
      assert.equal(book.commits.length, book.n);
      const stored = Buffer.from(asU8(book.jroot));
      const recomputed = Buffer.from(jroot({ pubs: book.pubs, commits: book.commits }));
      assert.ok(stored.equals(recomputed), 'anchor book is not the stored root');
      assert.ok(fundingJroot(book), 'point root');
      const pot = store.blocks[0].txs[0].vout.find((o) => o.kind === 'pot');
      const want = opening.commit;
      assert.ok(Buffer.from(asU8(pot.commit)).equals(want));
      let index = -1;
      for (let i = 0; i < book.commits.length; i += 1) {
        if (Buffer.from(asU8(book.commits[i])).equals(want)) index = i;
      }
      assert.ok(index >= 0, 'spent note is outside the anchor');
      const x = admitScalarFromSeed(who.spendSeed, pot);
      assert.ok(Buffer.from(asU8(pot.admitPub)).equals(Buffer.from(pointBytes(admitPub(x)))));
      const t = randomScalar();
      progress({ phase: 'probe-start', n: book.n, opened: opening.v, index });
      const tProbe = Date.now();
      const probe = admitProveV3({
        x,
        index,
        pubs: book.pubs,
        commits: book.commits,
        c: pot.commit,
        t,
        ctx: Buffer.alloc(64, 9),
      });
      assert.ok(probe && probe.blob && probe.blob[0] === 3, 'probe');
      assert.ok(Buffer.from(probe.cTilde).equals(Buffer.from(blindCommit(pot.commit, scalarBytes(t)))));
      progress({
        phase: 'probe',
        n: book.n,
        ms: Date.now() - tProbe,
        blob: probe.blob.length,
        opened: opening.v,
      });

      const pay20 = hash20FromAddress(payee.dest);
      const change20 = hash20FromAddress(who.dest);
      const dummy20 = Buffer.alloc(20, 4);
      const spendCases = [
        { kind: 'transfer', payOf: (room) => 1, seal: false },
        { kind: 'send', payOf: (room) => room, seal: true },
      ];

      function rangeSlack(tx) {
        let bytes = 0;
        for (const o of tx.vout || []) {
          if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
        }
        // A reseal draws new range proofs of this same length. Decimal JSON
        // can grow by two characters per byte. The fee stays under the cap.
        return Math.ceil((bytes * 2) / 2048) + 8;
      }

      function settle(kind, payOf) {
        let fee = LEVY_FLOOR_UNITS;
        let tx = null;
        let pay = 0;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const room = opening.v - fee;
          assert.ok(room >= 1, `fee consumes the note ${opening.v} ${fee}`);
          pay = payOf(room);
          assert.ok(pay >= 1 && pay <= room, `pay ${pay} room ${room}`);
          const change = room - pay;
          const outs = [hiddenOut(pay, pay20, payee.base, kind)];
          if (change > 0) outs.push(hiddenOut(change, change20, who.base, 'send'));
          outs.push(hiddenOut(0, dummy20, null, 'dummy'));
          const excess = kernelExcess(outs, [{ r: opening.r, t: scalarBytes(t) }]);
          assert.ok(excess, 'excess');
          tx = compactTx({
            id: `${kind}-${pay}`,
            kind,
            anchor,
            fee,
            vin: [{ commit: Buffer.from(probe.cTilde) }],
            vout: outs,
            admit_proof: probe,
            spendTag: Buffer.from(probe.spendTag),
            excess,
          });
          const worst = {
            ...tx,
            admit_proof: { ...tx.admit_proof, blob: Buffer.alloc(probe.blob.length, 255) },
          };
          const need = levyNeed(worst);
          if (fee >= need && fee <= LEVY_CAP_NANOS) return { tx, pay };
          const next = need + rangeSlack(tx);
          assert.ok(next > fee && next <= LEVY_CAP_NANOS, `levy ${need} slack fee ${fee}`);
          fee = next;
        }
        assert.fail('fee did not cover the worst-case weight');
        return { tx, pay };
      }

      const opts = {
        height,
        noteAtAnchor: (got) => store.anchorNote(got),
        blocks: store.blocks,
      };
      let sealedTx = null;
      const seenPays = [];
      for (const spec of spendCases) {
        const settled = settle(spec.kind, spec.payOf);
        const draft = settled.tx;
        seenPays.push(settled.pay);
        const digest = txDigestV3(draft, MAGIC_TESTNET);
        const ctx = admitV3Context({
          magic: MAGIC_TESTNET,
          anchor,
          root: fundingJroot(book),
          n: book.n,
          digest,
        });
        progress({ phase: 'prove-start', kind: spec.kind, pay: settled.pay, fee: draft.fee });
        const tReal = Date.now();
        const real = admitProveV3({
          x,
          index,
          pubs: book.pubs,
          commits: book.commits,
          c: pot.commit,
          t,
          ctx,
        });
        assert.ok(real && real.blob && real.blob[0] === 3, `${spec.kind} prove`);
        progress({ phase: 'prove', kind: spec.kind, ms: Date.now() - tReal, blob: real.blob.length });
        assert.ok(Buffer.from(real.spendTag).equals(Buffer.from(probe.spendTag)));
        assert.ok(Buffer.from(real.cTilde).equals(Buffer.from(probe.cTilde)));
        const tx = {
          ...draft,
          admit_proof: {
            admit_proof: true,
            v: 3,
            spendTag: Buffer.from(real.spendTag),
            blob: real.blob,
            cTilde: Buffer.from(real.cTilde),
          },
          vin: [{ commit: Buffer.from(real.cTilde) }],
          spendTag: Buffer.from(real.spendTag),
        };
        const need = levyNeed(tx);
        assert.ok(tx.fee >= need && tx.fee <= LEVY_CAP_NANOS, `${spec.kind} levy ${need} fee ${tx.fee}`);
        const beforeMem = flowProofVerifyCount();
        const parked = admitMempool(emptyMempool(), tx, opts);
        assert.equal(parked.ok, true, `${spec.kind} mempool ${parked.reason}`);
        assert.ok(flowProofVerifyCount() > beforeMem, `${spec.kind} mempool skipped admitVerifyV3`);
        const beforeBlock = flowProofVerifyCount();
        const verdict = await Promise.resolve(blockVerdict(store, who.dest, tx));
        assert.equal(verdict.ok, true, `${spec.kind} verify ${verdict.reason}`);
        assert.ok(flowProofVerifyCount() > beforeBlock, `${spec.kind} verify skipped admitVerifyV3`);
        if (spec.seal) sealedTx = tx;
      }
      assert.equal(seenPays[0], 1);
      assert.ok(seenPays[1] > seenPays[0], String(seenPays[1]));
      assert.ok(sealedTx, 'full spend');
      const beforeQueue = flowProofVerifyCount();
      const queued = store.queueTx(sealedTx);
      assert.equal(queued.ok, true, `queue ${queued.reason}`);
      assert.ok(flowProofVerifyCount() > beforeQueue, 'queue skipped admitVerifyV3');
      const tip = store.tip();
      const now = Number(decodeHeader(Buffer.from(tip.header)).timestamp) + 90_000;
      const { tpl } = store.template({ miner: who.dest, shareBits: 4, now });
      assert.ok(tpl.txs.some((row) => row.id === sealedTx.id), 'mempool spend was not templated');
      const beforeAppend = flowProofVerifyCount();
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
      assert.ok(flowProofVerifyCount() > beforeAppend, 'append skipped admitVerifyV3');
      const sealed = store.blocks[store.blocks.length - 1].txs.find((row) => row.id === sealedTx.id);
      assert.ok(sealed, 'spend is not in the block');
      const tag = Buffer.from(asU8(sealed.admit_proof.blob).subarray(1, 33)).toString('hex');
      assert.equal(store.fluxset().spendTags.has(tag), true);
      progress({ phase: 'sealed', height: store.tip().height, verifies: flowProofVerifyCount() });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
