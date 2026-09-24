import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, destOpeningFromView, spendDestOf, hash20FromAddress } from '../../crypto/address.js';
import { noteCommitOfDest20, sealCoinbaseNote } from '../../crypto/note.js';
import { signSpendTx } from '../../crypto/spend.js';
import { levyNanos } from '../../crypto/levy.js';
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
import { handleWalletApi, reconstructOwner } from '../src/wallet_api.js';

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
    assert.equal(got.json.pubs, undefined);
    assert.equal(got.json.spendTags, undefined);
    const body = JSON.stringify(got.json);
    assert.equal(body.includes('viewKey'), false);
    assert.equal(body.includes('she1'), false);
    assert.equal(body.includes('"pubs"'), false);
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
