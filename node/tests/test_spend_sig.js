import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity, destOpeningFromView, payoutDest } from '../../crypto/address.js';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { levyNanos } from '../../crypto/levy.js';
import {
  verifyFundedBody,
  signSpendTx,
  verifySpendSig,
  spendPackDigest,
  flowSendNeedsOpen,
} from '../../crypto/spend.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';
import { SHEWALL_FILE } from '../../crypto/shewall_bin.js';

function signedSend(id, { nanos, to, fee } = {}) {
  const from = payoutDest(id.paymentCode);
  const open = destOpeningFromView(id.viewKey, id.spendPub, 0);
  const amount = nanos ?? NANOS_PER_SHE;
  const paid = fee ?? levyNanos(amount);
  const dest = to || from;
  const tx = {
    kind: 'send',
    from,
    to: dest,
    nanos: amount,
    fee: paid,
    open,
    vin: [{ address: from }],
    vout: [{ address: dest, nanos: amount, kind: 'send' }],
  };
  signSpendTx(tx, id.privateKey);
  return { tx, from, open };
}

describe('Flow spend is an Ed25519 signature', () => {
  it('accepts a valid spend signed on the spend seed', () => {
    const id = newIdentity();
    const { tx, from } = signedSend(id);
    assert.equal(flowSendNeedsOpen(tx), true);
    assert.equal(verifySpendSig(tx), true);
    const got = verifyFundedBody([tx], (addr) => (addr === from ? 2 * NANOS_PER_SHE : 0));
    assert.equal(got.ok, true, got.reason);
  });

  it('rejects replay of the same signed body', () => {
    const id = newIdentity();
    const { tx, from } = signedSend(id);
    const copy = { ...tx, id: 'copy' };
    const got = verifyFundedBody([tx, copy], (addr) => (addr === from ? 10 * NANOS_PER_SHE : 0));
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'replay');
    assert.equal(spendPackDigest(tx).equals(spendPackDigest(copy)), true);
  });

  it('fails if the amount is mutated after signing', () => {
    const id = newIdentity();
    const { tx, from } = signedSend(id);
    tx.vout[0].nanos = tx.vout[0].nanos + 1;
    tx.nanos = tx.vout[0].nanos;
    assert.equal(verifySpendSig(tx), false);
    const got = verifyFundedBody([tx], (addr) => (addr === from ? 2 * NANOS_PER_SHE : 0));
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'unsigned');
  });

  it('rejects an opening without a signature', () => {
    const id = newIdentity();
    const { tx, from } = signedSend(id);
    delete tx.sig;
    assert.equal(verifySpendSig(tx), false);
    const got = verifyFundedBody([tx], (addr) => (addr === from ? 2 * NANOS_PER_SHE : 0));
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'unsigned');
  });

  it('rejects a foreign spend key', () => {
    const id = newIdentity();
    const other = newIdentity();
    const { tx, from } = signedSend(id);
    signSpendTx(tx, other.privateKey);
    assert.equal(verifySpendSig(tx), false);
    const got = verifyFundedBody([tx], (addr) => (addr === from ? 2 * NANOS_PER_SHE : 0));
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'unsigned');
  });
});

describe('wallet send path', () => {
  it('never POSTs V / rest-frame and refuses opening-only send', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const api = fs.readFileSync(path.join(here, '../../pool/src/wallet_api.js'), 'utf8');
    assert.match(api, /body\.viewKey/);
    assert.match(api, /reason: 'rest_frame'/);
    assert.match(api, /verifySpendSig/);
    assert.equal(SHEWALL_FILE, 'shewall.bin');

    const id = newIdentity();
    const { tx, from, open } = signedSend(id, { nanos: Math.round(0.4 * NANOS_PER_SHE) });
    const rows = [{
      from: 'coinbase', to: from, nanos: 2 * NANOS_PER_SHE, height: 1, kind: 'coinbase',
    }];
    const store = {
      blocks: [],
      historyFor: (addr) => rows.filter((r) => r.to === addr || r.from === addr),
      tip: () => ({ height: 20 }),
      mempool: [],
    };
    const run = (body) => handleWalletApi(new URL('http://127.0.0.1/api/wallet/send'), 'POST', body, {
      store,
      miners: new Map(),
      queueSend: (t) => ({ id: 'ok', ...t }),
    });
    const leaked = run({
      from, to: from, amount: 0.4, open, viewKey: id.viewKey,
    });
    assert.equal(leaked.status, 400);
    assert.equal(leaked.json.reason, 'rest_frame');

    const unsigned = run({ from, to: from, amount: 0.4, open });
    assert.equal(unsigned.status, 403);
    assert.equal(unsigned.json.reason, 'unsigned');

    const ok = run({ from, to: from, amount: 0.4, open, sig: tx.sig });
    assert.equal(ok.status, 200, ok.json.reason);
    assert.equal(ok.json.ok, true);
  });
});
