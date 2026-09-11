import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, payoutDest, encodeDest, hash20FromAddress, destOpeningFromView, aliasDestOfSilentId } from '../../crypto/address.js';
import { destForLogin, hasherPayoutDest, destAtIndex } from '../../crypto/flow_sheet.js';
import { NANOS_PER_SHE } from '../../crypto/asert.js';
import { verifyPoolWithdrawOffchain } from '../../crypto/levy.js';
import { signPoolWithdraw, ownerSecpPubFromSeed, ownerPubFromOpening, evmPrivFromSeed } from '../../crypto/eip712.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { handleWalletApi } from '../src/wallet_api.js';
import { createPool, publicMinerTag } from '../src/pool.js';
import { writePoolIdent, readPoolIdent, poolIdentLeaked } from '../src/pool_ident.js';
import { withdrawNonces, withdrawDigests } from '../src/withdraw_state.js';

function url(p) {
  return new URL(`http://127.0.0.1${p}`);
}

describe('PoolWithdraw is spend-bound EIP-712', () => {
  it('foreign secp + victim she1 is not_owner on both HTTP paths; replay and she1 dest fail', async () => {
    withdrawNonces.clear();
    withdrawDigests.clear();
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const sheDest = aliasDestOfSilentId(id.paymentCode);
    const ownerSeed = Buffer.from(id.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32));
    const nanos = Math.floor(0.05 * NANOS_PER_SHE);
    const now = Date.now();
    const fields = {
      seed: ownerSeed,
      login: id.paymentCode,
      dest,
      minerShe1: id.paymentCode,
      payoutSsa1: dest,
      nanos,
      height: 3,
      nonce: 1,
      deadline: now + 60_000,
    };
    const sig = signPoolWithdraw(fields);
    const ownerPub = ownerSecpPubFromSeed(ownerSeed);
    const ok = verifyPoolWithdrawOffchain({
      ...fields,
      sig,
      ownerPub,
      nowMs: now,
      nonceStore: withdrawNonces,
      seenDigests: withdrawDigests,
    });
    assert.equal(ok.ok, true, ok.reason);

    const foreignSeed = Buffer.alloc(32, 9);
    const foreignSig = signPoolWithdraw({ ...fields, seed: foreignSeed, nonce: 2 });
    const foreign = verifyPoolWithdrawOffchain({
      ...fields,
      sig: foreignSig,
      ownerPub,
      nowMs: now,
      nonce: 2,
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.reason, 'not_owner');

    const she1Dest = verifyPoolWithdrawOffchain({
      ...fields,
      dest: sheDest,
      payoutSsa1: sheDest,
      sig: signPoolWithdraw({ ...fields, dest: sheDest, payoutSsa1: sheDest, nonce: 3 }),
      ownerPub,
      nowMs: now,
      nonce: 3,
    });
    assert.equal(she1Dest.ok, false);
    assert.equal(she1Dest.reason, 'not_indexed');

    const replay = verifyPoolWithdrawOffchain({
      ...fields,
      sig,
      ownerPub,
      nowMs: now,
      nonceStore: withdrawNonces,
      seenDigests: withdrawDigests,
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'replay');

    const posted = [];
    const store = {
      blocks: [],
      historyFor: () => [],
      tip: () => ({ height: 20 }),
      mempool: [],
    };
    const open = destOpeningFromView(id.viewKey, id.spendPub, 0);
    const httpBody = {
      login: id.paymentCode,
      dest,
      nanos,
      sig: foreignSig,
      height: 3,
      nonce: 2,
      deadline: now + 60_000,
      open,
    };
    const pull = handleWalletApi(url('/api/pool/withdraw'), 'POST', httpBody, {
      store, miners: new Map(), queueSend: (t) => posted.push(t) && t, poolDest: dest,
    });
    assert.equal(pull.json.ok, false);
    assert.equal(pull.json.reason, 'not_owner');

    const tag = publicMinerTag(id.paymentCode);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-wd-http-'));
    const pool = createPool({
      dataDir: dir, stratumPort: 0, httpPort: 0, miner: dest, shareBits: 8, bits: 10,
    });
    await new Promise((resolve, reject) => {
      pool.httpServer.listen(0, '127.0.0.1', resolve);
      pool.httpServer.on('error', reject);
    });
    pool.store.tip = () => ({ height: 40 });
    pool.store.getpolicy = () => ({ operational: { pool_merchant: 6 } });
    assert.equal(pool.pullBook.creditRound([{ tag, dest, count: 10 }], { height: 1 }).ok, true);
    const r = await fetch(`http://127.0.0.1:${pool.httpServer.address().port}/api/miners/${encodeURIComponent(tag)}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(httpBody),
    });
    const minerJson = await r.json();
    assert.equal(minerJson.ok, false);
    assert.equal(minerJson.reason, 'not_owner');
    pool.close();
  });

  it('she1 hasher dest is destCommit(spendPub), never destAtIndex or encodeDest(hash20)', () => {
    const id = newIdentity();
    const she = id.paymentCode;
    const degenerate = aliasDestOfSilentId(she);
    const owned = destForLogin(id.address, { spendPub: id.spendPub });
    assert.equal(hasherPayoutDest(she, { height: 1 }), owned);
    const indexed = destAtIndex(id.address, { index: 0, viewKey: id.viewKey });
    assert.notEqual(owned, indexed);
    assert.equal(hasherPayoutDest(owned), owned);
    assert.equal(hasherPayoutDest(owned, { dest: owned }), owned);
    assert.equal(hasherPayoutDest(she, { dest: owned }), owned);
    assert.equal(hasherPayoutDest(she, { dest: degenerate }), null);
    assert.notEqual(owned, degenerate);
    assert.equal(ownerPubFromOpening(destOpeningFromView(id.viewKey, id.spendPub, 0)).length, 33);
  });

  it('after boot pool-miner.json has no viewKey/paymentCode/spend/open', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-'));
    const file = path.join(dir, 'pool-miner.json');
    const id = newIdentity();
    fs.writeFileSync(file, JSON.stringify({
      address: id.address,
      viewKey: id.viewKey,
      paymentCode: id.paymentCode,
      spend: 'leak',
      open: 'leak',
    }));
    assert.equal(poolIdentLeaked(JSON.parse(fs.readFileSync(file, 'utf8'))), true);
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    writePoolIdent(file, { dest20: hash20FromAddress(dest) });
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(disk.viewKey, undefined);
    assert.equal(disk.paymentCode, undefined);
    assert.equal(disk.spend, undefined);
    assert.equal(disk.open, undefined);
    assert.ok(disk.dest20);
    assert.equal(disk.enc, undefined);
    const loaded = readPoolIdent(file);
    assert.equal(loaded.leaked, false);
    void encodeDest;
    void evmPrivFromSeed;
    void secp256k1;
  });
});
