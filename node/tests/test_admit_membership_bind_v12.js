/**
 * N-28: one proof per Flow vin, and no proof or spend tag on a kind that
 * does not verify membership. A distinct extra must not spend a note.
 * Amounts and vin counts come from the opened coinbase notes, not one fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { digestTx } from '../src/chain.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import {
  canonicalSpendTag,
  flowInputsBound,
  kernelExcess,
  openedCoinbaseNanos,
  scalarFrom,
  txSpendTags,
  verifyFlowConservation,
} from '../../crypto/note.js';
import { admitMempool, emptyMempool } from '../../crypto/mempool.js';
import { leanBlock } from '../../crypto/chronoflux.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { admitProve, admitScalarFromSeed, fluxsetIndexOf } from '../../crypto/admit.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNanos, LEVY_CAP_NANOS } from '../../crypto/levy.js';
import { newIdentity, freshStealthDest, ed25519SeedOf, stealthKey } from '../../crypto/address.js';

const T0 = 1_700_000_000_000;

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function identityDest() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  const spendSeed = id.spendSeed || ed25519SeedOf(id.privateKey);
  return {
    dest: pay.dest,
    spendSeed,
    key: stealthKey(pay.shared, spendSeed),
  };
}

function tagHex(proof) {
  const one = canonicalSpendTag(proof);
  assert.equal(one.ok, true, one.reason);
  return one.tag.toString('hex');
}

function asBlock(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples || [],
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

function withTxs(tpl, txs) {
  const decoded = decodeHeader(Buffer.from(tpl.header));
  decoded.merkleRoot = merkleRoot(txs.map((tx) => digestTx(tx)));
  return asBlock({ ...tpl, header: encodeHeader(decoded), txs });
}

describe('v12 membership proofs are bound 1:1', () => {
  it('rejects an extra proof and a carried tag for any opened amount and any vin count', async () => {
    const { dest, spendSeed, key } = identityDest();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n28-'));
    const store = createStore(dir);
    const notes = [];
    try {
      for (let i = 0; i < 4; i += 1) {
        const { tpl } = store.template({ miner: dest, shareBits: 4, now: T0 + i * 90_000 });
        const pot = (tpl.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
        const opened = openedCoinbaseNanos(pot);
        assert.ok(pot?.commit && pot.r && pot.noteCommit, `pot ${i} is a sealed note`);
        assert.equal(typeof opened, 'number');
        assert.ok(Number.isSafeInteger(opened) && opened > 1, `opened pot ${i}`);
        const got = await Promise.resolve(store.append(asBlock(tpl), {
          trustedPowHash: easyPowHash(),
          skipSharePow: true,
        }));
        assert.equal(got.ok, true, `${got.reason || 'seal'} ${got.error || ''}`);
        notes.push({ ...pot, opened });
      }
      assert.equal(store.fluxset().spendTags.size, 0);
      const flux = store.fluxset();
      assert.ok(flux.pubs.length >= notes.length, 'each pot entered J');
      const [n0, n1, n2, n3] = notes;

      const payOf = (input, fee, mode) => {
        const room = input - fee;
        assert.ok(room > 1, 'opened value covers a fee and a payment');
        if (mode === 'dust') return 1;
        if (mode === 'half') return Math.max(1, Math.floor(room / 2));
        return room;
      };

      const assemble = (spec) => {
        const input = spec.notes.reduce((sum, note) => sum + note.opened, 0);
        // The cap is the consensus ceiling. A template rewrite cannot push a
        // normal proof over it, and the payment is still the opened value minus this fee.
        const fee = LEVY_CAP_NANOS;
        const sendNanos = payOf(input, fee, spec.mode);
        const change = input - sendNanos - fee;
        const vout = [{ address: dest, nanos: sendNanos, kind: 'send' }];
        if (change > 0) vout.push({ address: dest, nanos: change, kind: 'send' });
        const tx = attachDummyOuts({
          id: spec.id,
          kind: 'send',
          from: dest,
          to: dest,
          nanos: sendNanos,
          fee,
          changeNanos: change,
          vin: spec.notes.map(() => ({ address: dest })),
          vout,
        }, { spent: spec.notes.length === 1 ? spec.notes[0] : spec.notes });
        const proofs = [];
        for (let i = 0; i < spec.notes.length; i += 1) {
          const note = spec.notes[i];
          const index = fluxsetIndexOf(flux.pubs, spendSeed, note);
          assert.ok(index >= 0, `${spec.id} owns note ${i}`);
          const proof = admitProve({
            x: admitScalarFromSeed(spendSeed, note),
            index,
            pubs: flux.pubs,
            commits: flux.commits,
            c: note.commit,
            t: scalarFrom(tx.vin[i].t),
          });
          assert.ok(proof?.blob && proof.cTilde, `${spec.id} prove ${i}`);
          const posted = Buffer.from(tx.vin[i].commit);
          const want = Buffer.from(proof.cTilde);
          if (!posted.equals(want)) {
            tx.vin[i] = { ...tx.vin[i], commit: proof.cTilde, t: proof.t, r: note.r };
          }
          proofs.push(proof);
        }
        tx.excess = kernelExcess(tx.vout, tx.vin);
        tx.spendTag = proofs[0].spendTag;
        if (proofs.length === 1 && !spec.alias && !spec.extra) {
          tx.admit_proof = proofs[0];
        } else {
          tx.admit_proofs = proofs.slice();
          if (spec.alias) {
            const src = proofs[0];
            tx.admit_proof = {
              admit_proof: true,
              v: src.v,
              spendTag: src.spendTag,
              blob: src.blob,
              cTilde: src.cTilde,
              t: src.t,
            };
          }
          if (spec.extra) tx.admit_proof = spec.extra;
        }
        const need = levyNanos(0, { tx });
        assert.ok(fee >= need && need <= LEVY_CAP_NANOS, spec.id);
        assert.ok(tx.excess, spec.id);
        assert.equal(verifyFlowConservation(tx), true, spec.id);
        return signSpendTx(tx, key);
      };

      const honest = [
        assemble({ id: 'hon-0', notes: [n0], mode: 'dust', alias: true }),
        assemble({ id: 'hon-m', notes: [n1, n2], mode: 'full' }),
        assemble({ id: 'hon-v', notes: [n3], mode: 'full' }),
      ];
      const victimProof = honest[2].admit_proof;
      const victim = tagHex(victimProof);
      const attacks = [
        assemble({
          id: 'atk-1',
          notes: [n0],
          mode: 'dust',
          extra: victimProof,
        }),
        assemble({
          id: 'atk-m',
          notes: [n1, n2],
          mode: 'half',
          extra: victimProof,
        }),
      ];
      assert.equal(attacks[0].vin.length, 1);
      assert.ok(attacks[1].vin.length > 1);
      assert.notEqual(attacks[0].nanos, attacks[1].nanos);

      const probe = async (block) => Promise.resolve(store.probeBlock(block));
      const tipBefore = store.tip().height;
      for (const tx of attacks) {
        assert.equal(txSpendTags(tx).tags.length, tx.vin.length + 1, tx.id);
        assert.equal(flowInputsBound(tx).reason, 'admit_membership', tx.id);
        const queued = store.queueTx(tx);
        assert.equal(queued.ok, false, tx.id);
        assert.equal(queued.reason, 'admit_membership', tx.id);
        const book = emptyMempool();
        const parked = admitMempool(book, tx, {
          baseFee: 1,
          fluxset: store.fluxset(),
          spendTags: store.fluxset().spendTags,
        });
        assert.equal(parked.reason, 'admit_membership', tx.id);
        assert.equal(book.txs.length, 0, tx.id);
        const { tpl } = store.template({ miner: dest, shareBits: 4, now: T0 + 4 * 90_000 });
        assert.ok(!(tpl.txs || []).some((row) => row && row.id === tx.id), tx.id);
        const block = withTxs(tpl, tpl.txs.concat([tx]));
        const raw = await probe(block);
        assert.equal(raw.ok, false, tx.id);
        assert.equal(raw.reason, 'admit_membership', `${tx.id} ${raw.reason}`);
        const lean = await probe(withTxs(block, leanBlock(block).txs));
        assert.equal(lean.ok, raw.ok, tx.id);
        assert.equal(lean.reason, raw.reason, `${tx.id} lean ${lean.reason}`);
      }
      assert.equal(store.tip().height, tipBefore);
      assert.equal(store.fluxset().spendTags.has(victim), false);
      assert.equal(store.mempool.length, 0);

      const shapes = [
        (proof) => ({ admit_proof: proof }),
        (proof) => ({ admit_proofs: [proof] }),
        (proof) => ({ spendTag: proof.spendTag }),
      ];
      const kinds = ['b-spend', 'vortice-register', 'evm-value', 'coinbase'];
      for (const kind of kinds) {
        for (let s = 0; s < shapes.length; s += 1) {
          const tx = {
            id: `carry-${kind}-${s}`,
            kind,
            ...shapes[s](victimProof),
          };
          if (kind === 'coinbase') tx.coinbase = true;
          const queued = store.queueTx(tx);
          assert.equal(queued.reason, 'admit_membership', tx.id);
          const parked = admitMempool(emptyMempool(), tx, {
            baseFee: 1,
            fluxset: store.fluxset(),
          });
          assert.equal(parked.reason, 'admit_membership', tx.id);
        }
      }
      for (const kind of ['b-spend', 'vortice-register', 'evm-value']) {
        const tx = { id: `body-${kind}`, kind, admit_proof: victimProof };
        const { tpl } = store.template({ miner: dest, shareBits: 4, now: T0 + 4 * 90_000 });
        const raw = await probe(withTxs(tpl, tpl.txs.concat([tx])));
        assert.equal(raw.reason, 'admit_membership', `${kind} ${raw.reason}`);
        const lean = await probe(withTxs(tpl, leanBlock({ ...asBlock(tpl), txs: tpl.txs.concat([tx]) }).txs));
        assert.equal(lean.reason, raw.reason, kind);
      }
      const { tpl: coinTpl } = store.template({ miner: dest, shareBits: 4, now: T0 + 4 * 90_000 });
      assert.equal(coinTpl.txs[0].coinbase, true);
      for (let s = 0; s < shapes.length; s += 1) {
        const txs = coinTpl.txs.map((tx, i) => (i === 0 ? { ...tx, ...shapes[s](victimProof) } : tx));
        const raw = await probe(withTxs(coinTpl, txs));
        assert.equal(raw.reason, 'admit_membership', `coinbase ${s} ${raw.reason}`);
        const stripped = leanBlock(withTxs(coinTpl, txs)).txs[0];
        assert.equal(txSpendTags(stripped).tags.length, 0, 'compact coinbase drops an unverified carry');
      }
      assert.equal(store.fluxset().spendTags.has(victim), false);
      assert.equal(store.tip().height, tipBefore);

      assert.equal(honest[0].vin.length, 1);
      assert.ok(honest[1].vin.length > 1);
      assert.equal(honest[2].vin.length, 1);
      assert.ok(honest[0].nanos < honest[1].nanos);
      assert.notEqual(honest[1].nanos, honest[2].nanos);
      assert.equal(flowInputsBound(honest[0]).ok, true);
      assert.equal(txSpendTags(honest[0]).tags.length, 1);
      const verified = new Set();
      for (const tx of honest) {
        const queued = store.queueTx(tx);
        assert.equal(queued.ok, true, `${tx.id} ${queued.reason || ''}`);
        for (const tag of txSpendTags(tx).tags) verified.add(tag.toString('hex'));
      }
      assert.equal(verified.has(victim), true);
      assert.equal(verified.size, notes.length);
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: T0 + 5 * 90_000 });
      const ids = new Set((tpl.txs || []).map((tx) => tx && tx.id).filter(Boolean));
      for (const tx of honest) assert.equal(ids.has(tx.id), true, tx.id);
      for (const tx of attacks) assert.equal(ids.has(tx.id), false, tx.id);
      const honestBlock = asBlock(tpl);
      const rawOk = await probe(honestBlock);
      assert.equal(rawOk.ok, true, rawOk.reason);
      const leanOk = await probe(withTxs(honestBlock, leanBlock(honestBlock).txs));
      assert.equal(leanOk.ok, true, leanOk.reason || 'lean');
      const sealed = await Promise.resolve(store.append(honestBlock, {
        trustedPowHash: easyPowHash(),
        skipSharePow: true,
      }));
      assert.equal(sealed.ok, true, `${sealed.reason || 'append'} ${sealed.error || ''}`);
      const persisted = store.fluxset().spendTags;
      assert.equal(persisted.size, verified.size);
      for (const tag of verified) assert.equal(persisted.has(tag), true, tag);
      const again = createStore(dir);
      const reloaded = again.fluxset().spendTags;
      assert.equal(reloaded.size, verified.size);
      for (const tag of verified) assert.equal(reloaded.has(tag), true, tag);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
