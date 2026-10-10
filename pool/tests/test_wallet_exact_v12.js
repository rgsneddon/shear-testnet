/**
 * Continuum 0.72 send amounts, withdraw, vote levy, and vortex sums.
 * Drives handleWalletApi. Any integer nanos, not one fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, spendDestOf } from '../../crypto/address.js';
import { NANOS_PER_SHE, RESERVE_PROGRAM } from '../../crypto/asert.js';
import { bindWeightFee, levyNeed, levyNanos } from '../../crypto/levy.js';
import { emptyVault, portalIdFromDest, voteTx, vortexSums, withdrawTx } from '../../crypto/reserve_vault.js';
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
    const from = spendDestOf(alice.spendPub);
    const to = spendDestOf(newIdentity().spendPub);
    const samples = [1n, (1n << 40n) + 7n, (1n << 53n) - 1n, (1n << 53n) + 1n, (1n << 53n) + 3n, (1n << 60n) + 17n];
    for (const n of samples) {
      const draft = {
        kind: 'send',
        from,
        to,
        nanos: n.toString(),
        vin: [{ address: from }],
        vout: [
          { address: to, nanos: n.toString(), kind: 'send', commit: Buffer.alloc(32, 1) },
          { address: to, nanos: '0', kind: 'dummy', commit: Buffer.alloc(32, 2) },
        ],
      };
      signSpendTx(draft, alice.privateKey);
      const { posted, queueSend } = queue();
      const ok = handleWalletApi(url('/api/wallet/send'), 'POST', {
        from,
        to,
        amount: sheString(n),
        nanos: n.toString(),
        sig: draft.sig,
        spendPub: draft.spendPub,
        vin: draft.vin,
        vout: draft.vout,
        admit_proof: {
          admit_proof: true,
          spendTag: Buffer.alloc(32, 4),
          c0: Buffer.alloc(32, 5),
          r: [Buffer.alloc(32, 6)],
        },
      }, { store: store(), miners: new Map(), queueSend });
      assert.equal(ok.status, 200, `${n} ${ok.json && ok.json.reason}`);
      assert.equal(String(posted[0].nanos), n.toString());
      if (n > (1n << 53n)) {
        assert.notEqual(String(posted[0].nanos), String(Number(n.toString())));
        const { posted: rounded, queueSend: queueRounded } = queue();
        const lost = handleWalletApi(url('/api/wallet/send'), 'POST', {
          from,
          to,
          amount: Number(n.toString()),
          sig: draft.sig,
          spendPub: draft.spendPub,
          vin: draft.vin,
          vout: draft.vout,
          admit_proof: draft.admit_proof,
        }, { store: store(), miners: new Map(), queueSend: queueRounded });
        assert.equal(lost.status, 400, `number ${n} must not be accepted`);
        assert.equal(lost.json.reason, 'bad_send');
        assert.equal(rounded.length, 0);
      }
    }
  });

  it('posts a withdraw of any nanos as kind withdraw', () => {
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
        sig: draft.sig,
        spendPub: draft.spendPub,
        vout: draft.vout,
        vin: draft.vin,
      }, { store: store(), miners: new Map(), queueSend });
      assert.equal(got.status, 200, `${n} ${got.json && got.json.reason}`);
      assert.equal(got.json.tx.kind, 'withdraw');
      assert.equal(posted[0].kind, 'withdraw');
      assert.equal(posted[0].programId, RESERVE_PROGRAM);
      assert.equal(String(posted[0].nanos), n.toString());
      assert.equal(String(posted[0].vout[0].valueProof.v), n.toString());
      assert.notEqual(posted[0].kind, 'send');
    }
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
    assert.equal(under.status, 400);
    assert.equal(under.json.reason, 'levy');
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
