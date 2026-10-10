/**
 * N-58: a malformed B leaf is stateless invalid.
 * bindBSpend and spendB return reason leaf. They do not throw.
 * queueTx and a P2P tx of the same leaf do not throw.
 * Any amount. Mature and immature tips.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { bindBSpend, bProof, buildDualTree, spendB } from '../../crypto/clearing.js';
import { encodeHeader } from '../../crypto/header.js';
import { EMPTY_ROOT } from '../../crypto/merkle.js';
import { MAGIC_TESTNET, SPENDABLE_CONFIRMATIONS } from '../../crypto/asert.js';
import { openedCoinbaseNanos, sealNote } from '../../crypto/note.js';
import { hash20FromAddress, freshStealthDest, newIdentity, ed25519SeedOf, admitBaseFromAddress } from '../../crypto/address.js';
import { attachAdmitPub } from '../../crypto/admit.js';
import { createStore } from '../src/store.js';
import { createP2p } from '../src/p2p.js';

const AMOUNTS = [1, 2 ** 20, 2 ** 40];
const TIPS = [
  SPENDABLE_CONFIRMATIONS - 1,
  SPENDABLE_CONFIRMATIONS,
  SPENDABLE_CONFIRMATIONS + 11,
];

function payDest() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  return { dest: pay.dest, spendSeed: id.spendSeed || ed25519SeedOf(id.privateKey) };
}

function sealOut(amount, dest) {
  const d20 = hash20FromAddress(dest);
  let note = sealNote(amount, { dest20: Buffer.from(d20), kind: 'b-spend' });
  note.address = dest;
  note = attachAdmitPub(note, { admitBase: admitBaseFromAddress(dest) });
  assert.equal(openedCoinbaseNanos(note), amount);
  return note;
}

function honestLeaf(dest20, amount) {
  return {
    dest20: Buffer.from(dest20),
    unit: amount,
    nonce: 3,
    memoH: Buffer.alloc(32),
    tag: 'b-extra',
  };
}

function badLeaves(dest20, amount) {
  const good = Buffer.from(dest20);
  return [
    { name: 'dest20', leaf: { dest20: 'zz', unit: amount, nonce: 1, memoH: Buffer.alloc(32), tag: 'b' } },
    { name: 'short', leaf: { dest20: Buffer.alloc(19, 1), unit: amount, nonce: 1, memoH: Buffer.alloc(32), tag: 'b' } },
    { name: 'long', leaf: { dest20: Buffer.alloc(21, 2), unit: amount, nonce: 1, memoH: Buffer.alloc(32), tag: 'b' } },
    { name: 'unit', leaf: { dest20: good, unit: `${amount}.0`, nonce: 1, memoH: Buffer.alloc(32), tag: 'b' } },
    { name: 'nonce', leaf: { dest20: good, unit: amount, nonce: -1, memoH: Buffer.alloc(32), tag: 'b' } },
    { name: 'memo', leaf: { dest20: good, unit: amount, nonce: 1, memoH: Buffer.alloc(31), tag: 'b' } },
    { name: 'tag', leaf: { dest20: good, unit: amount, nonce: 1, memoH: Buffer.alloc(32), tag: 'abcdefghi' } },
    { name: 'ascii', leaf: { dest20: good, unit: amount, nonce: 1, memoH: Buffer.alloc(32), tag: 'caf\u00e9' } },
  ];
}

function headerFor(leaf) {
  const tree = buildDualTree({ aLeaves: [], bLeaves: [leaf] });
  const header = encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: EMPTY_ROOT,
    continuityRoot: tree.continuityRoot,
    timestamp: 1_700_000_000_000,
    bits: 14,
    nonce: 0n,
    baseFee: 1n,
  });
  return {
    tree,
    block: { height: 1, header, rootA: tree.rootA, rootB: tree.rootB },
  };
}

function spendTx(leaf, dest, amount, id) {
  return {
    id,
    kind: 'b-spend',
    from: dest,
    to: dest,
    fee: 0,
    commitHeight: 1,
    index: 0,
    leaf,
    proof: [],
    vin: [{ address: dest }],
    vout: [{ kind: 'b-spend' }],
  };
}

describe('v12 b-spend leaf is canonical', () => {
  it('rejects a malformed leaf on bindBSpend, spendB, and queueTx for any amount', async () => {
    assert.ok(AMOUNTS.length >= 3);
    assert.ok(AMOUNTS.every((n) => Number.isSafeInteger(n) && n > 0));
    assert.ok(new Set(AMOUNTS).size === AMOUNTS.length);
    assert.ok(TIPS.some((t) => t < SPENDABLE_CONFIRMATIONS));
    assert.ok(TIPS.some((t) => t >= SPENDABLE_CONFIRMATIONS));
    const { dest } = payDest();
    const dest20 = hash20FromAddress(dest);
    assert.equal(Buffer.from(dest20).length, 20);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n58-'));
    const store = createStore(dir);
    try {
      for (const amount of AMOUNTS) {
        const good = honestLeaf(dest20, amount);
        const packed = headerFor(good);
        const opened = sealOut(amount, dest);
        const honest = {
          id: `honest-${amount}`,
          kind: 'b-spend',
          from: dest,
          to: dest,
          fee: 0,
          commitHeight: 1,
          index: 0,
          leaf: good,
          proof: bProof([good], 0),
          vin: [{ address: dest }],
          vout: [opened],
        };
        const accepted = bindBSpend(honest, {
          history: [packed.block],
          tipHeight: SPENDABLE_CONFIRMATIONS + amount,
          spent: new Set(),
        });
        assert.equal(accepted.ok, true, `${amount} ${accepted.reason}`);
        const direct = spendB({
          leaf: good,
          proof: bProof([good], 0),
          header: packed.block.header,
          rootA: packed.block.rootA,
          rootB: packed.block.rootB,
          height: 1,
          index: 0,
          tipHeight: SPENDABLE_CONFIRMATIONS + amount,
          spent: new Set(),
        });
        assert.equal(direct.ok, true, `${amount} ${direct.reason}`);

        for (const tipHeight of TIPS) {
          for (const row of badLeaves(dest20, amount)) {
            const tx = {
              ...spendTx(row.leaf, dest, amount, `bad-${row.name}-${amount}-${tipHeight}`),
              vout: [opened],
              proof: bProof([good], 0),
            };
            let bound;
            assert.doesNotThrow(() => {
              bound = bindBSpend(tx, {
                history: [packed.block],
                tipHeight,
                spent: new Set(),
              });
            }, `${row.name} ${amount} tip ${tipHeight}`);
            assert.equal(bound.ok, false, `${row.name} ${amount}`);
            assert.equal(bound.reason, 'leaf', `${row.name} ${amount} tip ${tipHeight} ${bound.reason}`);
            let spent;
            assert.doesNotThrow(() => {
              spent = spendB({
                leaf: row.leaf,
                proof: bProof([good], 0),
                header: packed.block.header,
                rootA: packed.block.rootA,
                rootB: packed.block.rootB,
                height: 1,
                index: 0,
                tipHeight,
                spent: new Set(),
              });
            }, `spendB ${row.name} ${amount}`);
            assert.equal(spent.ok, false);
            assert.equal(spent.reason, 'leaf', `spendB ${row.name} ${spent.reason}`);
          }
        }

        for (const row of badLeaves(dest20, amount)) {
          const bare = spendTx(row.leaf, dest, amount, `q-${row.name}-${amount}`);
          let queued;
          assert.doesNotThrow(() => {
            queued = store.queueTx(bare);
          }, `queue ${row.name} ${amount}`);
          assert.equal(queued.ok, false, `${row.name} ${amount}`);
          assert.equal(queued.reason, 'leaf', `${row.name} ${amount} ${queued.reason}`);
          assert.equal(store.mempool.some((m) => m.id === bare.id), false);
          const sealed = {
            ...bare,
            id: `qs-${row.name}-${amount}`,
            vout: [opened],
          };
          let sealedGot;
          assert.doesNotThrow(() => {
            sealedGot = store.queueTx(sealed);
          }, `queue sealed ${row.name}`);
          assert.equal(sealedGot.ok, false);
          assert.ok(
            sealedGot.reason === 'leaf' || sealedGot.reason === 'value_open',
            sealedGot.reason,
          );
        }
      }
    } finally {
      try { store.close?.(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a P2P tx with a malformed leaf does not kill the node', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-n58-p2p-'));
    const store = createStore(dir);
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    let sock;
    try {
      const bound = await p2p.listen();
      sock = net.connect(bound.port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
      const lines = [];
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const raw = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!raw) continue;
          try { lines.push(JSON.parse(raw)); } catch { /* ignore */ }
        }
      });
      const waitFor = (pred, ms) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('p2p timeout')), ms);
        const tick = () => {
          if (pred()) {
            clearTimeout(t);
            resolve();
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
      await waitFor(() => lines.some((m) => m.type === 'hello' || m.type === 'tip'), 3000);
      const bodies = [
        { id: 'p2p-zz', kind: 'b-spend', commitHeight: 1, fee: 0, leaf: { dest20: 'zz', unit: 1, nonce: 1, tag: 'b' }, vout: [{ kind: 'b-spend' }] },
        { id: 'p2p-unit', kind: 'b-spend', commitHeight: 1, fee: 0, leaf: { dest20: '11'.repeat(20), unit: '5.0', nonce: 1, tag: 'b' }, vout: [{ kind: 'b-spend' }] },
        { id: 'p2p-nonce', kind: 'b-spend', commitHeight: 1, fee: 0, leaf: { dest20: '11'.repeat(20), unit: 1, nonce: -1, tag: 'b' }, vout: [{ kind: 'b-spend' }] },
        { id: 'p2p-memo', kind: 'b-spend', commitHeight: 1, fee: 0, leaf: { dest20: '11'.repeat(20), unit: 1, nonce: 1, memoH: 'aa'.repeat(31), tag: 'b' }, vout: [{ kind: 'b-spend' }] },
      ];
      for (const tx of bodies) {
        sock.write(`${JSON.stringify({ type: 'tx', magic: MAGIC_TESTNET, tx })}\n`);
      }
      sock.write(`${JSON.stringify({ type: 'getmempool', magic: MAGIC_TESTNET })}\n`);
      await waitFor(() => lines.some((m) => m.type === 'mempool'), 3000);
      assert.equal(sock.destroyed, false);
      const mem = lines.find((m) => m.type === 'mempool');
      const ids = new Set((mem.txs || []).map((tx) => tx.id));
      for (const tx of bodies) assert.equal(ids.has(tx.id), false, tx.id);
      assert.ok(p2p.peers.size >= 1);
    } finally {
      try { sock?.destroy(); } catch { /* ignore */ }
      try { p2p.close(); } catch { /* ignore */ }
      try { store.close?.(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
