/**
 * Continuum 0.72 send amounts, withdraw, vote levy, and vortex sums.
 * Drives handleWalletApi. Any integer nanos, not one fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admitBaseFromAddress, encodeDest, hash20FromAddress, newIdentity, spendDestOf } from '../../crypto/address.js';
import { admitBaseScalar } from '../../crypto/admit.js';
import { NANOS_PER_SHE, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { bindWeightFee, levyNeed, levyNanos, LEVY_CAP_NANOS } from '../../crypto/levy.js';
import { noteU64, openNoteAmount, sealHiddenNote, sealNote } from '../../crypto/note.js';
import { buildFundedWithdraw, emptyVault, portalIdFromDest, voteTx, vortexSums, withdrawTx } from '../../crypto/reserve_vault.js';
import { signSpendTx } from '../../crypto/spend.js';
import { vaultDest } from '../../crypto/flow_sheet.js';
import { handleWalletApi } from '../src/wallet_api.js';

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

function fundedWithdraw(alice, to, nanos, id, nonce) {
  const blob = Buffer.alloc(321, 7);
  blob[0] = 0xf1;
  const fs1 = Buffer.alloc(41, 1);
  fs1[0] = 0xf1;
  const commit = Buffer.alloc(32, 3);
  const payer = spendDestOf(alice.spendPub);
  const shown = nanos <= 9007199254740991n ? Number(nanos) : nanos.toString();
  let fee = levyNanos(0);
  let built = null;
  for (let i = 0; i < 4; i += 1) {
    built = buildFundedWithdraw({
      to,
      nanos: nanos.toString(),
      id,
      withdrawNonce: nonce,
      portalId: portalIdFromDest(to),
      anchor: 16,
      excess: Buffer.alloc(32, 4),
      fs1,
      fee,
      vin: [{ commit }],
      admit_proofs: [{ blob, cTilde: commit, spendTag: Buffer.alloc(32, 5) }],
      retireProof: Buffer.alloc(12, 1),
      principalProof: { R: Buffer.alloc(32, 2), z: Buffer.alloc(32, 3) },
      ownerPub: Buffer.from(alice.spendPub).toString('hex'),
      dest20: Buffer.from(hash20FromAddress(payer)),
      vout: [{
        kind: 'withdraw',
        commit,
        valueProof: { v: shown, R: Buffer.alloc(32, 6), z: Buffer.alloc(32, 7) },
      }],
    });
    assert.ok(built, `${id} build`);
    const need = levyNeed(built);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    fee = need;
  }
  signSpendTx(built, alice.privateKey);
  return built;
}

function queue() {
  const posted = [];
  const queueSend = (t) => {
    const tx = { id: `tx-${posted.length + 1}`, ...t };
    posted.push(tx);
    return tx;
  };
  return { posted, queueSend };
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
    const built = fundedWithdraw(alice, to, big, 'funded-wd');
    const { posted, queueSend } = queue();
    const got = handleWalletApi(url('/api/wallet/send'), 'POST', {
      to,
      kind: 'withdraw',
      programId: RESERVE_PROGRAM,
      amount: sheString(big),
      nanos: big.toString(),
      id: built.id,
      portalId: built.portalId,
      payoutPortalId: built.payoutPortalId,
      anchor: built.anchor,
      excess: built.excess,
      fs1: built.fs1,
      fee: built.fee,
      vin: built.vin,
      admit_proofs: built.admit_proofs,
      retireProof: built.retireProof,
      principalProof: built.principalProof,
      ownerPub: built.ownerPub,
      dest20: built.dest20,
      sig: built.sig,
      spendPub: built.spendPub,
      vout: built.vout,
    }, { store: store(), miners: new Map(), queueSend });
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(got.json.tx.kind, 'withdraw');
    assert.equal(posted[0].kind, 'withdraw');
    assert.equal(posted[0].from, undefined);
    assert.equal(posted[0].programId, RESERVE_PROGRAM);
    assert.equal(String(posted[0].nanos), big.toString());
    assert.ok(posted[0].retireProof);
    assert.ok(posted[0].principalProof);
    assert.equal(posted[0].fs1[0], 0xf1);
  });

  it('keeps a posted withdraw id and nonce on the queued tx', () => {
    const alice = newIdentity();
    const to = spendDestOf(newIdentity().spendPub);
    const nonce = Buffer.alloc(32, 9).toString('hex');
    const ident = 'wd-posted-nonce';
    const built = fundedWithdraw(alice, to, 1000n, ident, nonce);
    const { posted, queueSend } = queue();
    const got = handleWalletApi(url('/api/wallet/send'), 'POST', {
      to,
      kind: 'withdraw',
      programId: RESERVE_PROGRAM,
      amount: sheString(1000n),
      nanos: '1000',
      id: ident,
      portalId: built.portalId,
      payoutPortalId: built.payoutPortalId,
      withdrawNonce: nonce,
      anchor: built.anchor,
      excess: built.excess,
      fs1: built.fs1,
      fee: built.fee,
      vin: built.vin,
      admit_proofs: built.admit_proofs,
      retireProof: built.retireProof,
      principalProof: built.principalProof,
      ownerPub: built.ownerPub,
      dest20: built.dest20,
      sig: built.sig,
      spendPub: built.spendPub,
      vout: built.vout,
    }, { store: store(), miners: new Map(), queueSend });
    assert.equal(got.status, 200, got.json && got.json.reason);
    assert.equal(posted[0].id, ident);
    assert.equal(posted[0].withdrawNonce, nonce);
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
