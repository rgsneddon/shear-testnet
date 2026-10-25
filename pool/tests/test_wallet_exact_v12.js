/**
 * Continuum 0.72 send amounts, withdraw, vote levy, and vortex sums.
 * Drives handleWalletApi. Any integer nanos, not one fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { admitBaseFromAddress, encodeDest, hash20FromAddress, newIdentity, spendDestOf } from '../../crypto/address.js';
import { admitBaseScalar } from '../../crypto/admit.js';
import { NANOS_PER_SHE, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { bindWeightFee, levyNeed, levyNanos, LEVY_CAP_NANOS } from '../../crypto/levy.js';
import { noteU64, openNoteAmount, sealHiddenNote, sealNote } from '../../crypto/note.js';
import { buildFundedWithdraw, emptyVault, portalIdFromDest, portalIdFromDest20, portalOwnerKey, signWithdrawReward, voteTx, vortexSums, withdrawTx } from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { handleWalletApi } from '../src/wallet_api.js';
import { txDigestV3 } from '../../crypto/admit_v3.js';
import { txBodyDigestFs1 } from '../../crypto/fs1_spend.js';

const SCALE = BigInt(NANOS_PER_SHE);

function url(path) {
  return new URL(`http://127.0.0.1${path}`);
}

function sheString(nanos) {
  const v = nanos < 0n ? -nanos : nanos;
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(11, '0').replace(/0+$/, '');
  const body = frac ? `${whole.toString()}.${frac}` : whole.toString();
  return nanos < 0n ? `-${body}` : body;
}

function store() {
  return {
    blocks: [],
    historyFor: () => [],
    tip: () => ({ height: 20 }),
    mempool: [],
    reserveVault: emptyVault(),
    vortice: { issued: Object.create(null) },
  };
}

// The Dart wallet's FS-1 withdraw (wallet/lib/shear_withdraw.dart): no from,
// to, payoutPortalId, spendPub, or spend sig (325b50f5). It pays dest20 and is
// authorised by the SAL plus the portal owner's rewardSig.
function fundedWithdraw(alice, nanos, id, nonce) {
  const blob = Buffer.alloc(321, 7);
  blob[0] = 0xf1;
  const fs1 = Buffer.alloc(41, 1);
  fs1[0] = 0xf1;
  const commit = Buffer.alloc(32, 3);
  // The payout is a one-time dest20, as the wallet derives it
  // (withdrawPayoutDest20 from the spend seed, portal and a random nonce):
  // never a hash of the identity address, which would link the withdraw.
  const dest20 = randomBytes(20);
  const portalId = portalIdFromDest20(randomBytes(20));
  const shown = nanos <= 9007199254740991n ? Number(nanos) : nanos.toString();
  let fee = levyNanos(0);
  let built = null;
  for (let i = 0; i < 4; i += 1) {
    built = buildFundedWithdraw({
      nanos: nanos.toString(),
      id,
      withdrawNonce: nonce,
      portalId,
      anchor: 16,
      excess: Buffer.alloc(32, 4),
      fs1,
      fee,
      vin: [{ commit }],
      admit_proofs: [{ blob, cTilde: commit, spendTag: Buffer.alloc(32, 5) }],
      retireProof: Buffer.alloc(12, 1),
      principalProof: { R: Buffer.alloc(32, 2), z: Buffer.alloc(32, 3) },
      dest20,
      vout: [{
        kind: 'withdraw',
        commit,
        valueProof: { v: shown, R: Buffer.alloc(32, 6), z: Buffer.alloc(32, 7) },
      }],
    });
    assert.ok(built, `${id} build`);
    // Sign before weighing: the levy covers the posted rewardSig and ownerPub.
    signWithdrawReward(built, portalOwnerKey(alice.spendSeed, portalId), {
      portalId,
      nanos,
      dest: dest20.toString('hex'),
      state: emptyVault(),
      nowMs: 0,
    });
    const need = levyNeed(built);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    fee = need;
  }
  assert.ok(built.rewardSig && built.ownerPub, `${id} rewardSig`);
  assert.equal(built.spendPub, undefined);
  assert.equal(built.sig, undefined);
  return built;
}

/** The body the Dart wallet posts for an FS-1 withdraw. */
function wirePost(built, nanos) {
  return {
    kind: 'withdraw',
    programId: RESERVE_PROGRAM,
    amount: sheString(nanos),
    nanos: nanos.toString(),
    id: built.id,
    portalId: built.portalId,
    anchor: built.anchor,
    excess: built.excess,
    fs1: built.fs1,
    fee: built.fee,
    vin: built.vin,
    admit_proofs: built.admit_proofs,
    retireProof: built.retireProof,
    principalProof: built.principalProof,
    ownerPub: built.ownerPub,
    rewardSig: built.rewardSig,
    dest20: built.dest20,
    vout: built.vout,
  };
}

function queue() {
  const posted = [];
  const raw = [];
  // As pool.js queueSend does: a body with no id, or an empty one, gets a
  // fresh id on the queued copy; a posted id is kept.
  const queueSend = (t) => {
    raw.push(t);
    const tx = { ...t, id: t.id || `tx-${posted.length + 1}` };
    posted.push(tx);
    return tx;
  };
  return { posted, raw, queueSend };
}

/** Canonical bytes of a posted body: sorted keys, Buffers as hex. */
function bodyBytes(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return JSON.stringify({ $hex: Buffer.from(v).toString('hex') });
  if (typeof v === 'bigint') return JSON.stringify({ $big: v.toString() });
  if (Array.isArray(v)) return `[${v.map(bodyBytes).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${bodyBytes(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

describe('continuum 0.72 wallet amounts, withdraw, levy, vortex', () => {
  it('keeps any posted nanos exact above 2^53 and rejects a rounded JS number', () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const dest20 = hash20FromAddress(spendDestOf(bob.spendPub));
    // AL-3 / AL-7. amtCt is encrypted to a dest that carries an admit base.
    // The posted body is the sealed tx only: no from, to, amount, or nanos.
    const to = encodeDest(dest20, bob.admitBase);
    assert.ok(admitBaseFromAddress(to));
    const x = admitBaseScalar(bob.spendSeed);
    const samples = [1n, (1n << 40n) + 7n, (1n << 53n) - 1n, (1n << 53n) + 1n, (1n << 53n) + 3n, (1n << 60n) + 17n];
    for (const n of samples) {
      const pay = sealHiddenNote(n, { dest20, kind: 'send', admitBase: bob.admitBase });
      delete pay.r;
      const dummy = sealNote(0, { dest20: Buffer.alloc(20, 2), kind: 'dummy' });
      delete dummy.r;
      const draft = {
        kind: 'send',
        fee: levyNanos(0),
        maxLevy: levyNanos(0),
        vin: [{ dest20: hash20FromAddress(spendDestOf(alice.spendPub)) }],
        vout: [pay, dummy],
        admit_proof: {
          admit_proof: true,
          spendTag: Buffer.alloc(32, 4),
          c0: Buffer.alloc(32, 5),
          r: [Buffer.alloc(32, 6)],
        },
      };
      signSpendTx(draft, alice.privateKey);
      bindWeightFee(draft);
      const { posted, queueSend } = queue();
      const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
        fee: draft.fee,
        sig: draft.sig,
        spendPub: draft.spendPub,
        vin: draft.vin,
        vout: draft.vout,
        admit_proof: draft.admit_proof,
      }, { store: store(), miners: new Map(), queueSend });
      assert.equal(ok.status, 200, `${n} ${ok.json && ok.json.reason}`);
      assert.equal(posted[0].nanos, undefined);
      assert.equal(posted[0].amount, undefined);
      assert.equal(posted[0].from, undefined);
      assert.equal(posted[0].to, undefined);
      const out = posted[0].vout[0];
      assert.ok(out.amtCt && out.rEph && out.rCt);
      assert.equal(out.nanos, undefined);
      assert.equal(out.amount, undefined);
      const opened = openNoteAmount(out, x);
      assert.equal(opened && opened.v, n);
      if (n > (1n << 53n)) {
        const rounded = Number(n.toString());
        assert.equal(noteU64(rounded), null);
        assert.notEqual(opened.v, BigInt(Math.trunc(rounded)));
        assert.throws(() => sealHiddenNote(rounded, { dest20, kind: 'send', admitBase: bob.admitBase }));
        const { posted: lostPosted, queueSend: queueRounded } = queue();
        const lost = handleWalletApi(url('/api/wallet/send'), 'POST', {
          amount: rounded,
          fee: draft.fee,
          sig: draft.sig,
          spendPub: draft.spendPub,
          vin: draft.vin,
          vout: draft.vout,
          admit_proof: draft.admit_proof,
        }, { store: store(), miners: new Map(), queueSend: queueRounded });
        assert.equal(lost.status, 400, `number ${n} must not be accepted`);
        assert.equal(lost.json.reason, 'send_hint');
        assert.equal(lost.json.field, 'amount');
        assert.equal(lostPosted.length, 0);
      }
    }
  });

  it('refuses a plaintext withdraw and posts one funded by an FS-1 spend', () => {
    const alice = newIdentity();
    const from = spendDestOf(alice.spendPub);
    const to = spendDestOf(newIdentity().spendPub);
    const samples = [1n, SCALE, (1n << 53n) + 1n, (1n << 58n) + 9n];
    for (const n of samples) {
      const draft = withdrawTx({ from, to, nanos: n.toString(), id: `withdraw-${n}` });
      signSpendTx(draft, alice.privateKey);
      const { posted, queueSend } = queue();
      const got = handleWalletApi(url('/api/wallet/send'), 'POST', {
        from,
        to,
        kind: 'withdraw',
        programId: RESERVE_PROGRAM,
        amount: sheString(n),
        nanos: n.toString(),
        id: draft.id,
        withdrawNonce: draft.withdrawNonce,
        sig: draft.sig,
        spendPub: draft.spendPub,
        vout: draft.vout,
        vin: draft.vin,
      }, { store: store(), miners: new Map(), queueSend });
      assert.equal(got.status, 400, `${n} ${got.json && got.json.reason}`);
      assert.equal(got.json.reason, 'withdraw_funding');
      assert.equal(posted.length, 0);
    }
    const big = (1n << 58n) + 9n;
    const built = fundedWithdraw(alice, big, 'funded-wd');
    // The same FS-1 withdraw with the identity spend key on it is vote_leak at
    // the node (withdrawLeakRejected). The pool refuses it before relaying.
    const leaked = queue();
    const leakedGot = handleWalletApi(url('/api/wallet/send'), 'POST', {
      ...wirePost(built, big),
      spendPub: Buffer.from(alice.spendPub).toString('hex'),
      sig: 'aa'.repeat(64),
    }, { store: store(), miners: new Map(), queueSend: leaked.queueSend });
    assert.equal(leakedGot.status, 400, leakedGot.json && leakedGot.json.reason);
    assert.equal(leakedGot.json.reason, 'vote_leak');
    assert.equal(leaked.posted.length, 0);
    // No rewardSig is unsigned.
    const bare = queue();
    const bareBody = wirePost(built, big);
    delete bareBody.rewardSig;
    const bareGot = handleWalletApi(url('/api/wallet/send'), 'POST', bareBody, { store: store(), miners: new Map(), queueSend: bare.queueSend });
    assert.equal(bareGot.status, 403, bareGot.json && bareGot.json.reason);
    assert.equal(bareGot.json.reason, 'unsigned');
    assert.equal(bare.posted.length, 0);
    const { posted, queueSend } = queue();
    const got = handleWalletApi(url('/api/wallet/send'), 'POST', wirePost(built, big), { store: store(), miners: new Map(), queueSend });
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(got.json.tx.kind, 'withdraw');
    assert.equal(posted[0].kind, 'withdraw');
    assert.equal(posted[0].from, undefined);
    assert.equal(posted[0].to, undefined);
    assert.equal(posted[0].spendPub, undefined);
    assert.equal(posted[0].rewardSig, built.rewardSig);
    assert.equal(posted[0].programId, RESERVE_PROGRAM);
    assert.equal(String(posted[0].nanos), big.toString());
    assert.ok(posted[0].retireProof);
    assert.ok(posted[0].principalProof);
    assert.equal(posted[0].fs1[0], 0xf1);
  });

  it('relays an FS-1 withdraw with every bound byte as the wallet signed it', () => {
    const alice = newIdentity();
    const nanos = 5000n;
    const built = fundedWithdraw(alice, nanos, 'wd-untouched');
    const { posted, queueSend } = queue();
    const got = handleWalletApi(url('/api/wallet/send'), 'POST', wirePost(built, nanos), { store: store(), miners: new Map(), queueSend });
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(posted.length, 1);
    const relayed = posted[0];
    // The proofs and the owner signature bind these digests. A pool that
    // rebuilt any bound field would break them.
    assert.ok(Buffer.from(txDigestV3(relayed)).equals(Buffer.from(txDigestV3(built))), 'txDigestV3');
    assert.ok(Buffer.from(txBodyDigestFs1(relayed)).equals(Buffer.from(txBodyDigestFs1(built))), 'FS-1 body digest');
    const hex = (v) => Buffer.from(v).toString('hex');
    assert.equal(relayed.rewardSig, built.rewardSig);
    assert.equal(relayed.ownerPub, built.ownerPub);
    assert.equal(hex(relayed.fs1), hex(built.fs1));
    assert.equal(hex(relayed.dest20), hex(built.dest20));
    assert.equal(hex(relayed.retireProof), hex(built.retireProof));
    assert.deepEqual(relayed.principalProof, built.principalProof);
    assert.deepEqual(relayed.admit_proofs, built.admit_proofs);
    assert.deepEqual(relayed.vin, built.vin);
    assert.deepEqual(relayed.vout, built.vout);
    assert.equal(String(relayed.fee), String(built.fee));
    assert.equal(String(relayed.nanos), String(built.nanos));
    assert.equal(relayed.portalId, built.portalId);
    assert.equal(relayed.anchor, built.anchor);
  });

  it('relays the posted FS-1 withdraw body itself, byte for byte, and stamps nothing', () => {
    const alice = newIdentity();
    const nanos = 5000n;
    const built = fundedWithdraw(alice, nanos, 'wd-verbatim');
    const body = { ...wirePost(built, nanos), memoH: Buffer.alloc(32, 0x5a), maxLevy: built.fee };
    const before = bodyBytes(body);
    const { raw, queueSend } = queue();
    const got = handleWalletApi(url('/api/wallet/send'), 'POST', body, { store: store(), miners: new Map(), queueSend });
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(raw.length, 1);
    // The node gets the object the wallet posted, every byte as posted:
    // bound fields the pool does not know (memoH, maxLevy) are kept, nothing
    // is added. Old code rebuilt the body from a whitelist and failed this.
    assert.equal(raw[0], body, 'the posted body is what is relayed');
    assert.equal(bodyBytes(raw[0]), before, 'byte for byte');
    assert.ok(Buffer.from(raw[0].memoH).equals(Buffer.alloc(32, 0x5a)), 'memoH kept');
  });

  it('refuses an FS-1 withdraw with no fee or an opened hidden value instead of stamping or stripping', () => {
    const alice = newIdentity();
    const built = fundedWithdraw(alice, 5000n, 'wd-no-stamp');
    const noFee = { ...wirePost(built, 5000n) };
    delete noFee.fee;
    const a = queue();
    const refusedFee = handleWalletApi(url('/api/wallet/send'), 'POST', noFee, { store: store(), miners: new Map(), queueSend: a.queueSend });
    assert.equal(refusedFee.status, 400);
    assert.equal(refusedFee.json.reason, 'levy');
    assert.equal(a.raw.length, 0, 'nothing queued');
    // A hidden output that carries its value opening: old code stripped the
    // opening and relayed a changed body; now it is refused as posted.
    const opened = { ...wirePost(built, 5000n) };
    opened.vout = [...built.vout, { kind: 'send', commit: Buffer.alloc(32, 8), valueProof: { v: 1, R: Buffer.alloc(32, 1), z: Buffer.alloc(32, 2) } }];
    const b = queue();
    const refusedOpen = handleWalletApi(url('/api/wallet/send'), 'POST', opened, { store: store(), miners: new Map(), queueSend: b.queueSend });
    assert.equal(refusedOpen.status, 400);
    assert.equal(refusedOpen.json.reason, 'value_open');
    assert.equal(b.raw.length, 0, 'nothing queued');
  });

  it('refuses an FS-1 withdraw posted with no id, since the withdraw signs its id', () => {
    const alice = newIdentity();
    const built = fundedWithdraw(alice, 5000n, 'wd-signed-id');
    for (const id of [undefined, null, '']) {
      const body = { ...wirePost(built, 5000n) };
      if (id === undefined) delete body.id;
      else body.id = id;
      const q = queue();
      const got = handleWalletApi(url('/api/wallet/send'), 'POST', body, { store: store(), miners: new Map(), queueSend: q.queueSend });
      assert.equal(got.status, 400, `id ${String(id)}`);
      assert.equal(got.json.reason, 'withdraw_id', `id ${String(id)}`);
      assert.equal(q.raw.length, 0, `id ${String(id)} queued`);
    }
    // The posted id is the id the wallet signed: queueSend keeps it, so the
    // digest the proofs bind is unchanged.
    const q = queue();
    const got = handleWalletApi(url('/api/wallet/send'), 'POST', wirePost(built, 5000n), { store: store(), miners: new Map(), queueSend: q.queueSend });
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(q.posted[0].id, 'wd-signed-id');
    assert.ok(Buffer.from(txDigestV3(q.posted[0])).equals(Buffer.from(txDigestV3(built))), 'txDigestV3 with the signed id');
  });

  it('relays an FS-1 withdraw whose hidden output carries an empty valueProof, as the node takes it', () => {
    const alice = newIdentity();
    const built = fundedWithdraw(alice, 5000n, 'wd-empty-open');
    // The node's rule (valueOpenRejected) reads null, '', false and {} as no
    // opening. The pool judges a posted withdraw by that rule and does not
    // strip, so each is relayed as posted.
    for (const empty of [null, '', false, {}]) {
      const body = { ...wirePost(built, 5000n) };
      body.vout = [...built.vout, { kind: 'send', commit: Buffer.alloc(32, 8), valueProof: empty }];
      const before = bodyBytes(body);
      const q = queue();
      const got = handleWalletApi(url('/api/wallet/send'), 'POST', body, { store: store(), miners: new Map(), queueSend: q.queueSend });
      assert.equal(got.status, 200, `${JSON.stringify(empty)} ${got.json && got.json.reason}`);
      assert.equal(q.raw[0], body, `${JSON.stringify(empty)} relayed as posted`);
      assert.equal(bodyBytes(q.raw[0]), before, `${JSON.stringify(empty)} byte for byte`);
    }
  });

  it('opens the rewardSig path to an FS-1 withdraw only', () => {
    const alice = newIdentity();
    const built = fundedWithdraw(alice, 5000n, 'wd-only');
    const base = wirePost(built, 5000n);
    const post = (body) => {
      const { posted, queueSend } = queue();
      const got = handleWalletApi(url('/api/wallet/send'), 'POST', body, { store: store(), miners: new Map(), queueSend });
      return { status: got.status, reason: got.json && got.json.reason, queued: posted.length };
    };
    const bare = (body) => {
      const copy = { ...body };
      delete copy.rewardSig;
      delete copy.ownerPub;
      return copy;
    };
    // The same shape under every other kind, and a withdraw that is not the
    // Reserve program. A rewardSig and ownerPub change nothing for any of them,
    // so the relaxed path opens for no kind but the FS-1 withdraw.
    const others = [
      { kind: 'send', programId: '' },
      { kind: 'lock', programId: RESERVE_PROGRAM },
      { kind: 'vote', programId: RESERVE_PROGRAM },
      { kind: 'leaf-vote', programId: RESERVE_PROGRAM },
      { kind: 'withdraw', programId: '' },
    ];
    for (const shape of others) {
      const label = `${shape.kind}/${shape.programId || 'none'}`;
      const signed = post({ ...base, ...shape });
      assert.deepEqual(signed, post(bare({ ...base, ...shape })), `${label} rewardSig changed the verdict`);
      if (shape.kind === 'lock') {
        // A body with a portal, dest20, FS-1 blob and a sealed output is the
        // wallet's compact lock. It is relayed unchanged for the node to judge,
        // with or without a rewardSig; the pool is not its verifier.
        assert.equal(signed.status, 200, label);
        assert.equal(signed.queued, 1, label);
        continue;
      }
      assert.notEqual(signed.status, 200, `${label} relayed`);
      assert.equal(signed.queued, 0, `${label} queued`);
    }
    // The withdraw itself needs its rewardSig, and its FS-1 blob.
    assert.equal(post(base).status, 200);
    const unsigned = post(bare(base));
    assert.equal(unsigned.status, 403);
    assert.equal(unsigned.reason, 'unsigned');
    assert.equal(unsigned.queued, 0);
    const noBlob = { ...base };
    delete noBlob.fs1;
    const blobless = post(noBlob);
    assert.notEqual(blobless.status, 200, 'withdraw without fs1 relayed');
    assert.equal(blobless.queued, 0);
  });

  it('keeps a posted withdraw id and nonce on the queued tx', () => {
    const alice = newIdentity();
    const nonce = Buffer.alloc(32, 9).toString('hex');
    const ident = 'wd-posted-nonce';
    const built = fundedWithdraw(alice, 1000n, ident, nonce);
    const { posted, queueSend } = queue();
    const got = handleWalletApi(url('/api/wallet/send'), 'POST', {
      ...wirePost(built, 1000n),
      withdrawNonce: nonce,
    }, { store: store(), miners: new Map(), queueSend });
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(posted[0].id, ident);
    // The posted hex nonce is relayed as posted. Its bytes, and so the digest
    // the proofs bind, are what the wallet signed.
    assert.equal(posted[0].withdrawNonce, nonce);
    assert.ok(Buffer.from(txDigestV3(posted[0])).equals(Buffer.from(txDigestV3(built))), 'txDigestV3 with nonce');
    assert.equal(posted[0].from, undefined);
    assert.equal(Buffer.from(posted[0].vout[0].commit).toString('hex'), Buffer.from(built.vout[0].commit).toString('hex'));
  });

  it('binds a vote fee to the sealed weight and does not rename other errors', () => {
    const alice = newIdentity();
    const from = spendDestOf(alice.spendPub);
    const to = vaultDest(alice.address, { viewKey: alice.viewKey });
    const rows = [{
      id: 'cb',
      from: 'coinbase',
      to: from,
      nanos: 10 * NANOS_PER_SHE,
      height: 1,
      kind: 'coinbase',
    }];
    const funded = {
      ...store(),
      historyFor: (addr) => rows.filter((r) => r.to === addr || r.from === addr),
    };
    const vote = voteTx({ from, dest: to, choice: 'hold', id: 'vote-exact' });
    vote.payer = from;
    bindWeightFee(vote);
    const bound = vote.fee;
    signSpendTx(vote, alice.privateKey);
    const { posted, queueSend } = queue();
    const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from,
      to,
      amount: 0,
      kind: 'vote',
      programId: RESERVE_PROGRAM,
      choice: 'hold',
      fee: bound,
      sig: vote.sig,
      spendPub: vote.spendPub,
      vout: vote.vout,
    }, { store: funded, miners: new Map(), queueSend });
    assert.equal(ok.status, 200, ok.json && ok.json.reason);
    assert.equal(posted[0].kind, 'vote');
    assert.equal(posted[0].fee, levyNeed(posted[0]));
    assert.ok(posted[0].fee >= levyNanos(0));

    const under = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from,
      to,
      amount: 0,
      kind: 'vote',
      programId: RESERVE_PROGRAM,
      choice: 'hold',
      fee: 1,
      sig: vote.sig,
      spendPub: vote.spendPub,
      vout: vote.vout,
    }, { store: funded, miners: new Map(), queueSend: () => ({ id: 'no' }) });
    assert.equal(under.status, 403);
    assert.equal(under.json.reason, 'unsigned');
    assert.equal(JSON.stringify(under.json).includes('spendable'), false);

    const other = handleWalletApi(url('/api/wallet/send'), 'POST', {
      from,
      to,
      amount: 1,
      kind: 'not-a-kind',
      programId: RESERVE_PROGRAM,
    }, { store: funded, miners: new Map(), queueSend: () => ({ id: 'no' }) });
    assert.equal(other.status, 400);
    assert.equal(other.json.reason, 'bad_kind');
    assert.equal(JSON.stringify(other.json).includes('vote'), false);
  });

  it('labels vortex your, overall, and flow from one reconstruct for any size', () => {
    const alice = newIdentity();
    const dest = spendDestOf(alice.spendPub);
    const samples = [0n, 1n, SCALE, (1n << 53n) + 11n, (1n << 57n) + 5n];
    for (const n of samples) {
      const vault = emptyVault();
      const id = portalIdFromDest(dest);
      vault.totalLockedNanos = n;
      vault.portals[id] = { staked: n, idle: 0n, redeemedNanos: 0n };
      const flow = n + 13n;
      const direct = vortexSums(vault, dest, flow.toString());
      assert.equal(direct.your.role, 'portal');
      assert.equal(direct.overall.role, 'program');
      assert.equal(direct.flow.role, 'continuum');
      assert.equal(String(direct.your.nanos), n.toString());
      assert.equal(String(direct.overall.nanos), n.toString());
      assert.equal(String(direct.flow.nanos), flow.toString());
      const got = handleWalletApi(
        url(`/api/vault/reserve?dest=${encodeURIComponent(dest)}&flow=${flow.toString()}`),
        'GET',
        {},
        { store: { ...store(), reserveVault: vault }, miners: new Map() },
      );
      assert.equal(got.status, 200);
      assert.deepEqual(got.json.sums.your, direct.your);
      assert.deepEqual(got.json.sums.overall, direct.overall);
      assert.deepEqual(got.json.sums.flow, direct.flow);
    }
  });
});
