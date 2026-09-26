import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, destOpeningFromView, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import { noteCommitOfDest20, sealCoinbaseNote } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNanos, poolFeeDest } from '../../crypto/levy.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { lockTx, voteTx } from '../../crypto/reserve_vault.js';
import {
  extraMintAllowed,
  RESERVE_PROGRAM,
  JOIN_PROGRAM,
  JOIN_KIND_GENESIS,
  NANOS_PER_SHE,
  PI_SHE_NANOS,
  POOL_FEE_BPS,
  SPENDABLE_CONFIRMATIONS,
} from '../../crypto/asert.js';
import { emptyVault } from '../../crypto/reserve_vault.js';
import { isPinnedProgram, listPublicVortices, mintVorticeDeployKey } from '../../crypto/vortex.js';
import { handleWalletApi, paintedSpendableNanos, reconstructOwner } from '../src/wallet_api.js';
import { sealedExplorerRows } from '../../crypto/chronoflux.js';
import { writeChainBin } from '../../crypto/chainbin.js';
import { createStore } from '../../node/src/store.js';

function url(path) {
  return new URL(`http://127.0.0.1${path}`);
}

function spendSig({ from, to, amount, open, identity, kind = 'send', choice = 'hold' }) {
  const nanos = kind === 'vote' ? 0 : Math.round(amount * NANOS_PER_SHE);
  const fee = levyNanos(nanos, { depth: 0 });
  let tx = {
    kind,
    from,
    to,
    nanos,
    fee,
    vin: [{ address: from }],
    vout: [{ address: to, nanos, kind }],
  };
  if (kind === 'send') tx = attachDummyOuts(tx);
  if (kind === 'lock') tx = { ...lockTx({ from, to, nanos, id: 'lock-sig' }), fee, amount };
  if (kind === 'vote') tx = { ...voteTx({ from, dest: to, choice, id: 'vote-sig' }), fee, amount: 0, payer: from };
  if (kind === 'send') {
    tx.admit_proof = {
      admit_proof: true,
      spendTag: Buffer.alloc(32, 7),
      c0: Buffer.alloc(32, 8),
      r: [Buffer.alloc(32, 9)],
    };
  }
  signSpendTx(tx, identity.privateKey);
  return {
    sig: tx.sig,
    spendPub: tx.spendPub,
    vout: tx.vout,
    vin: tx.vin,
    excess: tx.excess,
    nanos: tx.nanos,
    admit_proof: tx.admit_proof,
  };
}

function storeWith({ rows = [], reserveVault, issued } = {}) {
  return {
    blocks: [],
    historyFor: (addr) => rows.filter((r) => r.to === addr || r.from === addr),
    tip: () => ({ height: 20 }),
    mempool: [],
    reserveVault: reserveVault || emptyVault(),
    vortice: { issued: issued || Object.create(null) },
  };
}

describe('wallet fluxset RPC', () => {
  it('serves current jroot and fluxset without viewKey or she1', () => {
    const root = Buffer.alloc(32, 2);
    const store = {
      ...storeWith(),
      fluxset: () => ({
        pubs: [Buffer.alloc(32, 1)],
        commits: [Buffer.alloc(32, 7)],
        spendTags: new Set(['aa']),
        jroot: root,
      }),
      jroot: () => root,
    };
    const got = handleWalletApi(url('/api/wallet/fluxset'), 'GET', {}, { store });
    assert.equal(got.status, 200);
    assert.equal(got.json.ok, true);
    assert.equal(got.json.jroot, root.toString('hex'));
    assert.equal(got.json.noteCount, 1);
    assert.equal(got.json.spendTagCount, 1);
    assert.deepEqual(got.json.pubs, [Buffer.alloc(32, 1).toString('hex')]);
    assert.deepEqual(got.json.commits, [Buffer.alloc(32, 7).toString('hex')]);
    assert.equal(got.json.commits.length, got.json.pubs.length);
    assert.equal(got.json.spendTags, undefined);
    const body = JSON.stringify(got.json);
    assert.equal(body.includes('viewKey'), false);
    assert.equal(body.includes('she1'), false);
    assert.equal(body.includes('"spendTags"'), false);
    assert.equal(body.includes('aa'), false);
    const jr = handleWalletApi(url('/api/wallet/jroot'), 'GET', {}, { store });
    assert.equal(jr.status, 200);
    assert.equal(jr.json.jroot, got.json.jroot);
  });

  it('serves compacted notes matching dest noteCommit without viewKey', () => {
    const alice = newIdentity();
    const dest = spendDestOf(alice.spendPub);
    const nc = Buffer.alloc(32, 9);
    const want = noteCommitOfDest20(hash20FromAddress(dest));
    const store = storeWith();
    store.blocks = [{
      height: 2,
      hash: Buffer.alloc(32, 3),
      txs: [{
        coinbase: true,
        vout: [{
          kind: 'pot',
          noteCommit: want,
          commit: Buffer.alloc(32, 4),
          rEph: Buffer.alloc(32, 5),
          rCt: Buffer.alloc(32, 6),
          admitPub: Buffer.alloc(32, 7),
        }, {
          kind: 'hash',
          noteCommit: nc,
          commit: Buffer.alloc(32, 8),
        }],
      }],
    }];
    const got = handleWalletApi(url(`/api/wallet/notes?address=${dest}`), 'GET', {}, { store });
    assert.equal(got.status, 200);
    assert.equal(got.json.ok, true);
    assert.equal(got.json.notes.length, 1);
    assert.equal(got.json.notes[0].rEph, Buffer.alloc(32, 5).toString('hex'));
    assert.equal(got.json.notes[0].index, 0);
    assert.equal(got.json.notes[0].prev, Buffer.alloc(32, 3).toString('hex'));
    assert.equal(got.json.notes[0].r, undefined);
    assert.equal(JSON.stringify(got.json).includes('viewKey'), false);
  });

  it('reconstructOwner recovers dest spendable from noteCommit when explorer to is empty', () => {
    const alice = newIdentity();
    const dest = spendDestOf(alice.spendPub);
    const want = noteCommitOfDest20(hash20FromAddress(dest));
    const store = storeWith({
      rows: [{ id: 'x', to: '', from: 'coinbase', nanos: 0, height: 2, kind: 'coinbase' }],
    });
    store.blocks = [{
      height: 2,
      hash: Buffer.alloc(32, 1),
      txs: [{
        coinbase: true,
        vout: [{ kind: 'pot', noteCommit: want, nanos: 2 * NANOS_PER_SHE }],
      }],
    }];
    const rec = reconstructOwner(store, dest);
    assert.ok(rec.spendableNanos >= 2 * NANOS_PER_SHE, JSON.stringify(rec));
  });

  it('custody reconstruct pays the hasher hash only; pool holds the pot; match-miss invent is 0', () => {
    const poolDest = spendDestOf(newIdentity().spendPub);
    const hasher = spendDestOf(newIdentity().spendPub);
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const hashNanos = 256;
    const potVout = sealCoinbaseNote(rest, { dest20: hash20FromAddress(poolDest), kind: 'pot' });
    const hashVout = sealCoinbaseNote(hashNanos, { dest20: hash20FromAddress(hasher), kind: 'hash' });
    const matureTip = 2 + SPENDABLE_CONFIRMATIONS;
    const store = {
      blocks: [{
        height: 2,
        hash: Buffer.alloc(32, 0x61),
        miner: poolDest,
        poolDest,
        shareBatch: [{ dest: hasher, dest20: hash20FromAddress(hasher), nonce: 1n, lz: 8 }],
        aLeaves: [{ noteCommit: noteCommitOfDest20(hash20FromAddress(hasher)), count: hashNanos }],
        txs: [{ coinbase: true, vout: [potVout, hashVout] }],
      }],
      tip: () => ({ height: matureTip }),
      mempool: [],
    };
    const hasherRec = reconstructOwner(store, hasher);
    const poolRec = reconstructOwner(store, poolDest);
    assert.equal(hasherRec.spendableNanos, hashNanos);
    assert.equal(poolRec.spendableNanos, rest);
    assert.ok(hasherRec.spendableNanos < rest);

    const want = noteCommitOfDest20(hash20FromAddress(hasher));
    const missBlocks = Array.from({ length: 8 }, (_, i) => ({
      height: i + 1,
      hash: Buffer.alloc(32, 0x70 + i),
      miner: hasher,
      poolDest,
      aLeaves: [{ noteCommit: Buffer.alloc(32, 9), count: 256 }],
      txs: [{
        coinbase: true,
        vout: [{ kind: 'pot', noteCommit: want, nanos: 0, commit: Buffer.alloc(32, 3) }],
      }],
    }));
    const miss = reconstructOwner({
      blocks: missBlocks,
      tip: () => ({ height: 8 + SPENDABLE_CONFIRMATIONS }),
      mempool: [],
    }, hasher);
    assert.equal(miss.spendableNanos, 0);
    assert.notEqual(miss.spendableNanos, rest * 8);
  });

  it('custody hasher reconstruct stays Σ hash notes as blocks accrue, with poolDest absent', () => {
    const pool = spendDestOf(newIdentity().spendPub);
    const hasher = spendDestOf(newIdentity().spendPub);
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const hashNanos = 256;
    const feeDest = poolFeeDest();
    // chain.bin, compactChainBlock, and the wire drop poolDest. Share dests remain
    // on the in-memory block that indexSealed sees. That is the shape #37 missed.
    const blocksFor = (n, salt = 1) => Array.from({ length: n }, (_, i) => ({
      height: i + 1,
      hash: Buffer.from([salt, i + 1, ...Buffer.alloc(30)]),
      miner: hasher,
      shareBatch: [{ dest: hasher, dest20: hash20FromAddress(hasher), nonce: BigInt(i + 1), lz: 8 }],
      aLeaves: [{
        noteCommit: noteCommitOfDest20(hash20FromAddress(hasher)),
        dest20: hash20FromAddress(hasher),
        count: hashNanos,
      }],
      txs: [{
        coinbase: true,
        vout: [
          sealCoinbaseNote(rest, { dest20: hash20FromAddress(pool), kind: 'pot' }),
          sealCoinbaseNote(Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000), {
            dest20: hash20FromAddress(feeDest),
            kind: 'pool-fee',
          }),
          sealCoinbaseNote(hashNanos, { dest20: hash20FromAddress(hasher), kind: 'hash' }),
        ],
      }],
    }));
    const storeFor = (n) => {
      const found = blocksFor(n, n);
      const tipH = n + SPENDABLE_CONFIRMATIONS;
      return {
        blocks: [...found, { height: tipH, hash: Buffer.alloc(32, 0xee), txs: [] }],
        tip: () => ({ height: tipH }),
        mempool: [],
      };
    };
    for (const n of [4, 12]) {
      const rec = reconstructOwner(storeFor(n), hasher);
      const poolRec = reconstructOwner(storeFor(n), pool);
      assert.equal(rec.spendableNanos, n * hashNanos, `N=${n} hasher`);
      assert.equal(poolRec.spendableNanos, n * rest, `N=${n} pool`);
      assert.notEqual(rec.spendableNanos, n * rest);
      assert.ok(rec.spendableNanos < rest);
    }

    const n = 12;
    const found = blocksFor(n, 0x3c);
    const tipH = n + SPENDABLE_CONFIRMATIONS;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-invent-'));
    const store = createStore(dir);
    store.blocks.push(...found, { height: tipH, hash: Buffer.alloc(32, 0xef), txs: [] });
    // Pre-fix index: pot row `to` painted onto the hasher, sealed dest20 still the pool.
    for (const b of found) {
      for (const r of sealedExplorerRows(b)) {
        const painted = r.kind !== 'hash' && r.nanos === rest ? { ...r, to: hasher } : r;
        store.explorer.push(painted);
      }
    }
    const live = reconstructOwner(store, hasher);
    assert.equal(live.spendableNanos, n * hashNanos);
    assert.notEqual(live.spendableNanos, rest * n);
    assert.equal(reconstructOwner(store, pool).spendableNanos, n * rest);

    // Already-indexed poison: `to` painted, sealed noteCommit still the pool,
    // and toDest20 either missing (legacy explorer) or overwritten to the hasher.
    for (const paintDest20 of [null, hash20FromAddress(hasher)]) {
      store.explorer.length = 0;
      for (const b of found) {
        for (const r of sealedExplorerRows(b)) {
          if (r.kind !== 'hash' && r.nanos === rest) {
            const row = { ...r, to: hasher };
            if (paintDest20) row.toDest20 = paintDest20;
            else delete row.toDest20;
            store.explorer.push(row);
          } else {
            store.explorer.push(r);
          }
        }
      }
      const poisoned = reconstructOwner(store, hasher);
      assert.equal(poisoned.spendableNanos, n * hashNanos, `paintDest20=${paintDest20 ? 'hasher' : 'absent'}`);
      assert.notEqual(poisoned.spendableNanos, rest * n);
      assert.equal(reconstructOwner(store, pool).spendableNanos, n * rest);
    }
    fs.rmSync(dir, { recursive: true, force: true });

    // chain.bin boot: no poolDest, no miner, share dests stripped, aLeaves are dest20+count.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-invent-bin-'));
    const packed = found.map((b) => ({
      ...b,
      header: Buffer.alloc(128, b.height),
    }));
    packed.push({
      height: tipH,
      hash: Buffer.alloc(32, 0xef),
      header: Buffer.alloc(128, 9),
      txs: [{ coinbase: true, vout: [] }],
    });
    writeChainBin(path.join(binDir, 'chain.bin'), packed);
    const booted = createStore(binDir);
    assert.equal(reconstructOwner(booted, hasher).spendableNanos, n * hashNanos);
    assert.equal(reconstructOwner(booted, pool).spendableNanos, n * rest);
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('invent cannot return as height grows when custody misses and mature explorer is already painted', () => {
    const pool = spendDestOf(newIdentity().spendPub);
    const hasher = spendDestOf(newIdentity().spendPub);
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const hashNanos = 256;
    const leafNc = noteCommitOfDest20(hash20FromAddress(hasher));
    // No poolDest, empty shareBatch, pot dest20 stripped: sealedPotIsCustody misses
    // and paysFromALeaves would PROP pot-after-fee onto the hasher leaf.
    const propBlock = (i) => {
      const pot = sealCoinbaseNote(rest, { dest20: hash20FromAddress(pool), kind: 'pot' });
      delete pot.dest20;
      return {
        height: i + 1,
        hash: Buffer.from([0x71, i + 1, ...Buffer.alloc(30)]),
        miner: hasher,
        shareBatch: [],
        aLeaves: [{ noteCommit: leafNc, dest20: hash20FromAddress(hasher), count: hashNanos }],
        txs: [{
          coinbase: true,
          vout: [
            pot,
            sealCoinbaseNote(hashNanos, { dest20: hash20FromAddress(hasher), kind: 'hash' }),
          ],
        }],
      };
    };
    const one = sealedExplorerRows(propBlock(0));
    assert.equal(one.some((r) => r.to === hasher && r.nanos === rest), false);
    for (let n = 1; n <= 12; n += 1) {
      const found = Array.from({ length: n }, (_, i) => propBlock(i));
      const tipH = n + SPENDABLE_CONFIRMATIONS;
      const rec = reconstructOwner({
        blocks: [...found, { height: tipH, hash: Buffer.alloc(32, 0x72), txs: [] }],
        tip: () => ({ height: tipH }),
        mempool: [],
      }, hasher);
      assert.equal(rec.spendableNanos, n * hashNanos, `prop N=${n}`);
      assert.notEqual(rec.spendableNanos, n * rest);
      assert.ok(rec.spendableNanos < rest);
      assert.equal(reconstructOwner({
        blocks: [...found, { height: tipH, hash: Buffer.alloc(32, 0x72), txs: [] }],
        tip: () => ({ height: tipH }),
        mempool: [],
      }, pool).spendableNanos, n * rest);
    }

    // Painted `to` with nanos = 0.99 and no noteCommit: matureSpendable > 0, which
    // used to skip the custodial walk. Balance must stay Σ hash notes as N grows.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-invent-grow-'));
    const store = createStore(dir);
    for (let n = 1; n <= 12; n += 1) {
      const b = propBlock(n + 20);
      b.height = n;
      store.blocks.push(b);
      for (const r of sealedExplorerRows(b)) {
        if (r.nanos === rest) {
          const painted = { ...r, to: hasher, height: n };
          delete painted.noteCommit;
          delete painted.toDest20;
          store.explorer.push(painted);
        } else {
          store.explorer.push({ ...r, height: n });
        }
      }
      const tipH = n + SPENDABLE_CONFIRMATIONS;
      store.blocks.push({ height: tipH, hash: Buffer.alloc(32, 0x73), txs: [] });
      const got = reconstructOwner(store, hasher);
      assert.equal(got.spendableNanos, n * hashNanos, `painted grow N=${n}`);
      assert.notEqual(got.spendableNanos, n * rest);
      assert.equal(reconstructOwner(store, pool).spendableNanos, n * rest);
      store.blocks.pop();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('solo reconstruct still props a sealed pot onto the miner', () => {
    const hasher = spendDestOf(newIdentity().spendPub);
    const potVout = sealCoinbaseNote(NANOS_PER_SHE, { dest20: hash20FromAddress(hasher), kind: 'pot' });
    const store = {
      blocks: [{
        height: 2,
        hash: Buffer.alloc(32, 0x62),
        miner: hasher,
        shareBatch: [{ dest: hasher, dest20: hash20FromAddress(hasher), nonce: 1n, lz: 8 }],
        txs: [{ coinbase: true, vout: [potVout] }],
      }],
      tip: () => ({ height: 2 + SPENDABLE_CONFIRMATIONS }),
      mempool: [],
    };
    assert.equal(reconstructOwner(store, hasher).spendableNanos, NANOS_PER_SHE);
  });

  it('eight pot-after-fee misses do not raise a positive hash reconstruction', () => {
    const hasher = spendDestOf(newIdentity().spendPub);
    const pool = spendDestOf(newIdentity().spendPub);
    const hashNanos = 256;
    const rest = NANOS_PER_SHE - Math.floor(NANOS_PER_SHE * POOL_FEE_BPS / 10000);
    const want = noteCommitOfDest20(hash20FromAddress(hasher));
    const blocks = Array.from({ length: 8 }, (_, i) => ({
      height: i + 1,
      hash: Buffer.alloc(32, 0x30 + i),
      miner: hasher,
      poolDest: pool,
      aLeaves: [{ noteCommit: Buffer.alloc(32, 9), count: 256 }],
      txs: [{
        coinbase: true,
        vout: [{ kind: 'pot', noteCommit: want, nanos: 0, commit: Buffer.alloc(32, 4) }],
      }],
    }));
    const rec = reconstructOwner({
      historyFor: () => [{
        id: 'hash-1', to: hasher, from: 'coinbase', nanos: hashNanos, height: 2, kind: 'hash',
      }],
      blocks,
      tip: () => ({ height: 8 + SPENDABLE_CONFIRMATIONS }),
      mempool: [],
    }, hasher);
    assert.equal(rec.spendableNanos, hashNanos);
    assert.notEqual(rec.spendableNanos, rest * 8);
  });
});

describe('pool send reconstruct and Join vault', () => {
  it('refuses send when reconstructed spendable is below amount and accepts when dest holds credits', () => {
    const alice = newIdentity();
    const silent = spendDestOf(alice.spendPub);
    const bobId = newIdentity();
    const bob = spendDestOf(bobId.spendPub);
    const rows = [{
      id: 'cb-1',
      from: 'coinbase',
      to: silent,
      nanos: 1.5 * NANOS_PER_SHE,
      height: 10,
      kind: 'coinbase',
    }];
    const store = storeWith({ rows });
    const posted = [];
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const deny = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: destForLogin(alice.address, { viewKey: alice.viewKey, height: 99 }),
      to: bob,
      amount: 0.4,
      open,
    }, { store, miners: new Map(), queueSend: (t) => posted.push(t) && t });
    assert.equal(deny.status, 400);
    assert.equal(deny.json.reason, 'insufficient');

    const pasted = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: alice.paymentCode,
      amount: 0.4,
    }, { store, miners: new Map(), queueSend: () => ({ id: 'nope' }) });
    assert.equal(pasted.status, 400);
    assert.equal(pasted.json.reason, 'need_dest');

    const unsignedDraft = attachDummyOuts({
      kind: 'send',
      from: silent,
      to: bob,
      nanos: Math.round(0.4 * NANOS_PER_SHE),
      vin: [{ address: silent }],
      vout: [{ address: bob, nanos: Math.round(0.4 * NANOS_PER_SHE) }],
    });
    const unsigned = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: bob,
      amount: 0.4,
      vout: unsignedDraft.vout,
      vin: unsignedDraft.vin,
      admit_proof: {
        admit_proof: true,
        spendTag: Buffer.alloc(32, 1),
        c0: Buffer.alloc(32, 2),
        r: [Buffer.alloc(32, 3)],
      },
    }, { store, miners: new Map(), queueSend: () => ({ id: 'nope' }) });
    assert.equal(unsigned.status, 403);
    assert.equal(unsigned.json.reason, 'unsigned');

    const signed = spendSig({ from: silent, to: bob, amount: 0.4, identity: alice });
    const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: bob,
      amount: 0.4,
      sig: signed.sig,
      spendPub: signed.spendPub,
      vout: signed.vout,
      vin: signed.vin,
      excess: signed.excess,
      admit_proof: signed.admit_proof,
    }, { store, miners: new Map(), queueSend: (t) => {
      const tx = { id: 'send-1', ...t };
      posted.push(tx);
      return tx;
    } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.tx.from, silent);
    assert.ok(ok.json.fromBalance < 1.5);
    assert.equal(SPENDABLE_CONFIRMATIONS, 6);
  });

  it('Reserve lock spends spendable Continuum and refuses when spendable is short', () => {
    const alice = newIdentity();
    const silent = spendDestOf(alice.spendPub);
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const open = destOpeningFromView(alice.viewKey, alice.spendPub, 0);
    const she = PI_SHE_NANOS / NANOS_PER_SHE;
    const rows = [{
      id: 'cb-1',
      from: 'coinbase',
      to: silent,
      nanos: 10 * NANOS_PER_SHE,
      height: 10,
      kind: 'coinbase',
    }];
    const store = storeWith({ rows });
    const posted = [];
    const deny = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 11,
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      open,
    }, { store, miners: new Map(), queueSend: (t) => posted.push(t) && t });
    assert.equal(deny.status, 400);
    assert.equal(deny.json.reason, 'insufficient');
    assert.equal(posted.length, 0);

    const signedLock = spendSig({ from: silent, to: vault, amount: she, identity: alice, kind: 'lock' });
    const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: she,
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      sig: signedLock.sig,
      spendPub: signedLock.spendPub,
      vout: signedLock.vout,
    }, { store, miners: new Map(), queueSend: (t) => {
      const tx = { id: 'lock-1', ...t };
      posted.push(tx);
      return tx;
    } });
    assert.equal(ok.status, 200, ok.json.reason);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.tx.kind, 'lock');
    assert.equal(ok.json.tx.programId, RESERVE_PROGRAM);
    assert.equal(posted[0].kind, 'lock');
    assert.equal(posted[0].programId, RESERVE_PROGRAM);
    assert.equal(Number(posted[0].nanos), PI_SHE_NANOS);
    assert.ok(ok.json.fromBalance < 10);

    const skipLevy = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 0.1,
      kind: 'lock',
      open,
    }, { store, miners: new Map(), queueSend: (t) => posted.push(t) && t });
    assert.equal(skipLevy.status, 400);
    assert.equal(skipLevy.json.reason, 'bad_kind');
  });

  it('painted Continuum lock and send post when chain notes do not cover', () => {
    const alice = newIdentity();
    const silent = spendDestOf(alice.spendPub);
    const bob = spendDestOf(newIdentity().spendPub);
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const chainNanos = Math.round(0.02 * NANOS_PER_SHE);
    const rows = [{
      id: 'cb-thin',
      from: 'coinbase',
      to: silent,
      nanos: chainNanos,
      height: 10,
      kind: 'coinbase',
    }];
    const store = storeWith({ rows });
    const posted = [];
    const queueSend = (t) => {
      const tx = { id: `painted-${posted.length + 1}`, ...t };
      posted.push(tx);
      return tx;
    };
    const thinBook = {
      viewByDest() {
        return { pendingNanos: Math.round(0.01 * NANOS_PER_SHE) };
      },
    };
    const shortSend = spendSig({ from: silent, to: bob, amount: 1, identity: alice });
    const denySend = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: bob,
      amount: 1,
      sig: shortSend.sig,
      spendPub: shortSend.spendPub,
      vout: shortSend.vout,
      vin: shortSend.vin,
    }, { store, miners: new Map(), queueSend, pullBook: thinBook });
    assert.equal(denySend.status, 400);
    assert.equal(denySend.json.reason, 'insufficient');
    assert.equal(posted.length, 0);

    const pullBook = {
      viewByDest() {
        return { pendingNanos: Math.round(22.58 * NANOS_PER_SHE) };
      },
    };
    const ctx = { store, miners: new Map(), queueSend, pullBook };
    const signedLock = spendSig({ from: silent, to: vault, amount: 3.2, identity: alice, kind: 'lock' });
    const lock = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 3.2,
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      sig: signedLock.sig,
      spendPub: signedLock.spendPub,
      vout: signedLock.vout,
    }, ctx);
    assert.equal(lock.status, 200, lock.json.reason);
    assert.equal(lock.json.ok, true);
    assert.equal(lock.json.tx.kind, 'lock');
    assert.equal(lock.json.tx.programId, RESERVE_PROGRAM);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].kind, 'lock');
    assert.ok(lock.json.fromBalance >= 0);
    assert.ok(lock.json.fromBalance < 0.02);

    const rec = reconstructOwner(store, silent);
    const needNanos = Math.round(1 * NANOS_PER_SHE);
    const fee = levyNanos(needNanos, { depth: 0 });
    const painted = paintedSpendableNanos(store, pullBook, silent, rec.spendableNanos);
    assert.ok(rec.spendableNanos < needNanos + fee);
    assert.ok(painted >= needNanos + fee);
    const signed = spendSig({ from: silent, to: bob, amount: 1, identity: alice });
    const send = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: bob,
      amount: 1,
      sig: signed.sig,
      spendPub: signed.spendPub,
      vout: signed.vout,
      vin: signed.vin,
      excess: signed.excess,
    }, ctx);
    assert.equal(send.status, 200, send.json.reason);
    assert.equal(send.json.ok, true);
    assert.equal(send.json.tx.kind, 'send');
    assert.equal(posted.length, 2);
    assert.equal(posted[1].admit_proof, undefined);
    assert.ok(send.json.fromBalance >= 0);
  });

  it('painted lock and send are admitted by queueTx and stay out of the block', () => {
    const alice = newIdentity();
    const silent = spendDestOf(alice.spendPub);
    const bob = spendDestOf(newIdentity().spendPub);
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const chainNanos = Math.round(0.02 * NANOS_PER_SHE);
    const owed = Math.round(4 * NANOS_PER_SHE);
    const rows = [{
      id: 'cb-thin',
      from: 'coinbase',
      to: silent,
      nanos: chainNanos,
      height: 10,
      kind: 'coinbase',
    }];
    const apiStore = storeWith({ rows });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-painted-queue-'));
    const chain = createStore(dir);
    const pullBook = {
      viewByDest() {
        return { pendingNanos: owed };
      },
    };
    const queueSend = (draft, meta) => {
      const owedRaw = Number(meta && meta.paintedOwedNanos);
      const paintedOwedNanos = Number.isFinite(owedRaw) && owedRaw > 0 ? Math.floor(owedRaw) : 0;
      const tx = { ...draft, id: draft.id || `tx-${chain.mempool.length + 1}` };
      const got = chain.queueTx(tx, paintedOwedNanos > 0 ? { paintedOwedNanos } : {});
      if (!got || got.ok === false) return got;
      return got.tx || tx;
    };
    const ctx = { store: apiStore, miners: new Map(), queueSend, pullBook };

    const bare = lockTx({ from: silent, to: vault, nanos: Math.round(3.2 * NANOS_PER_SHE), id: 'bare-lock' });
    bare.fee = levyNanos(bare.nanos);
    signSpendTx(bare, alice.privateKey);
    const noOwed = chain.queueTx(bare);
    assert.equal(noOwed.ok, false);
    assert.equal(noOwed.reason, 'insufficient');
    assert.equal(chain.mempool.length, 0);

    const boundNanos = Math.round(0.2 * NANOS_PER_SHE);
    const bound = {
      id: 'note-bound-painted',
      kind: 'send',
      from: silent,
      to: bob,
      nanos: boundNanos,
      fee: levyNanos(boundNanos),
      vin: [{ address: silent, commit: Buffer.alloc(32, 4) }],
      vout: [
        { ...sealCoinbaseNote(boundNanos, { dest20: hash20FromAddress(bob), kind: 'send' }), address: bob },
        sealCoinbaseNote(0, { dest20: Buffer.alloc(20, 8), kind: 'dummy' }),
      ],
    };
    signSpendTx(bound, alice.privateKey);
    const noteMiss = chain.queueTx(bound, { paintedOwedNanos: Math.round(100 * NANOS_PER_SHE) });
    assert.equal(noteMiss.ok, false);
    assert.equal(noteMiss.reason, 'admit_membership');
    assert.equal(chain.mempool.length, 0);

    const signedLock = spendSig({ from: silent, to: vault, amount: 3.2, identity: alice, kind: 'lock' });
    const lock = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 3.2,
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      sig: signedLock.sig,
      spendPub: signedLock.spendPub,
      vout: signedLock.vout,
    }, ctx);
    assert.equal(lock.status, 200, lock.json.reason);
    assert.equal(lock.json.tx.kind, 'lock');
    assert.equal(chain.mempool.filter((m) => m.kind === 'lock').length, 1);

    const sendNanos = Math.round(0.2 * NANOS_PER_SHE);
    const sendBody = {
      kind: 'send',
      from: silent,
      to: bob,
      nanos: sendNanos,
      fee: levyNanos(sendNanos),
      amount: 0.2,
      vin: [{ address: silent }],
      vout: [
        { ...sealCoinbaseNote(sendNanos, { dest20: hash20FromAddress(bob), kind: 'send' }), address: bob },
        sealCoinbaseNote(0, { dest20: Buffer.alloc(20, 9), kind: 'dummy' }),
      ],
    };
    signSpendTx(sendBody, alice.privateKey);
    const send = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: bob,
      amount: 0.2,
      sig: sendBody.sig,
      spendPub: sendBody.spendPub,
      vin: sendBody.vin,
      vout: sendBody.vout,
    }, ctx);
    assert.equal(send.status, 200, send.json.reason);
    assert.equal(send.json.tx.kind, 'send');
    assert.equal(send.json.tx.id.startsWith('tx-'), true);
    assert.equal(chain.mempool.filter((m) => m.kind === 'send').length, 1);
    assert.equal(chain.mempool.some((m) => m.admit_proof), false);

    const { tpl } = chain.template({ miner: silent });
    const packed = new Set((tpl.txs || []).map((t) => t.id));
    for (const m of chain.mempool) {
      assert.equal(packed.has(m.id), false, m.id);
    }
    assert.equal(chain.mempool.length, 2);

    const again = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 3.2,
      kind: 'lock',
      programId: RESERVE_PROGRAM,
      sig: signedLock.sig,
      spendPub: signedLock.spendPub,
      vout: signedLock.vout,
    }, ctx);
    assert.equal(again.status, 400);
    assert.equal(again.json.reason, 'insufficient');
    assert.equal(chain.mempool.filter((m) => m.kind === 'lock').length, 1);
  });

  it('Reserve vote accepts a signed hold and refuses unsigned', () => {
    const alice = newIdentity();
    const silent = spendDestOf(alice.spendPub);
    const vault = vaultDest(alice.address, { viewKey: alice.viewKey });
    const rows = [{
      id: 'cb-1',
      from: 'coinbase',
      to: silent,
      nanos: 10 * NANOS_PER_SHE,
      height: 10,
      kind: 'coinbase',
    }];
    const store = storeWith({ rows });
    const posted = [];
    const unsigned = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 0,
      kind: 'vote',
      programId: RESERVE_PROGRAM,
      choice: 'hold',
    }, { store, miners: new Map(), queueSend: (t) => posted.push(t) && t });
    assert.equal(unsigned.status, 403);
    assert.equal(unsigned.json.reason, 'unsigned');
    assert.equal(posted.length, 0);

    const signedVote = spendSig({ from: silent, to: vault, amount: 0, identity: alice, kind: 'vote', choice: 'hold' });
    const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from: silent,
      to: vault,
      amount: 0,
      kind: 'vote',
      programId: RESERVE_PROGRAM,
      choice: 'hold',
      sig: signedVote.sig,
      spendPub: signedVote.spendPub,
      vout: signedVote.vout,
    }, { store, miners: new Map(), queueSend: (t) => {
      const tx = { id: 'vote-1', ...t };
      posted.push(tx);
      return tx;
    } });
    assert.equal(ok.status, 200, ok.json.reason);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.tx.kind, 'vote');
    assert.equal(posted[0].kind, 'vote');
    assert.equal(posted[0].choice, 'hold');
    assert.ok(posted[0].sig);
    assert.ok(posted[0].vout?.[0]?.address);
  });

  it('Join HTTP is gone; extra-mint of join-genesis is refused', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: 'claim' }), false);
    assert.equal(extraMintAllowed('other-vortice'), false);

    const claim = handleWalletApi(url('/api/join/claim'), 'POST', {
      key: 'join1.dead',
      payout: 'ssa1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    }, { store: storeWith(), miners: new Map(), queueSend: () => ({}) });
    assert.equal(claim.status, 404);
    assert.equal(claim.json.reason, 'not_found');

    const vault = handleWalletApi(url('/api/vault/join'), 'GET', {}, {
      store: storeWith(),
      miners: new Map(),
      queueSend: () => ({}),
    });
    assert.equal(vault.status, 404);
    assert.equal(vault.json.reason, 'not_found');
  });

  it('Reserve and Join program ids are not public vortices', () => {
    const key = mintVorticeDeployKey({
      programId: 'stake-pool-a',
      name: 'Stake Pool A',
      origin: 'https://dapp.example/a.json',
      source: '{}',
    });
    assert.ok(key);
    const issued = {
      'stake-pool-a': { id: 'stake-pool-a', name: 'Stake Pool A' },
      [RESERVE_PROGRAM]: { id: RESERVE_PROGRAM, name: 'The Reserve' },
      [JOIN_PROGRAM]: { id: JOIN_PROGRAM, name: 'The Join' },
    };
    const pub = listPublicVortices(issued);
    assert.equal(pub.some((v) => v.id === RESERVE_PROGRAM), false);
    assert.equal(pub.some((v) => v.id === JOIN_PROGRAM), false);
    assert.equal(isPinnedProgram(RESERVE_PROGRAM), true);
    assert.equal(extraMintAllowed('stake-pool-a'), false);
    const store = storeWith({ issued });
    const out = handleWalletApi(url('/api/vortex/list'), 'GET', {}, {
      store,
      miners: new Map(),
      queueSend: () => ({}),
    });
    assert.equal(out.status, 200);
    assert.equal(out.json.vortices.some((v) => v.id === RESERVE_PROGRAM), false);
    assert.equal(out.json.vortices.some((v) => v.id === JOIN_PROGRAM), false);
  });
});
