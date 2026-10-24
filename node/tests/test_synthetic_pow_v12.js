import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET, MAGIC_TESTNET_V12 } from '../../crypto/asert.js';
import { decodeHeader, setNonce } from '../../crypto/header.js';
import { meetsTarget, shearHash } from '../../crypto/shear_hash.js';
import { verifyBlock } from '../src/chain.js';
import { encodeWireBlock } from '../src/p2p.js';
import { applyVerifiedIpcBlock } from '../src/p2p_ipc.js';
import { createRpc } from '../src/rpc.js';
import { createStore } from '../src/store.js';

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function standIn() {
  const pow = Buffer.alloc(32, 0);
  pow[31] = 1;
  return pow;
}

describe('v12 rejects a synthetic digest on the real chain', () => {
  it('verify, submit, RPC, ingest, and IPC hash the header', { timeout: 60_000 }, async () => {
    assert.equal(MAGIC_TESTNET, MAGIC_TESTNET_V12);
    assert.equal(MAGIC_TESTNET_V12, 'shear-testnet-v12');
    const miner = encodeDest(Buffer.alloc(20, 7));
    const now = 1_700_000_000_000;
    const pow = standIn();
    const sealed = createStore(tmp('shear-syn-seal-'));
    const { job } = sealed.template({ miner, now });
    const trusted = sealed.submitHeader({
      jobId: job.jobId,
      nonce: 0n,
      miner,
      powHash: pow.toString('hex'),
      trustedPowHash: pow.toString('hex'),
      skipSharePow: true,
    }, { trusted: true });
    assert.equal(trusted.ok, true, trusted.reason);
    const tip = sealed.tip();
    const header = Buffer.from(tip.header);
    const decoded = decodeHeader(header);
    assert.equal(decoded.bits, GENESIS_BITS_PACKED);
    assert.equal(meetsTarget(pow, decoded.bits), true);
    assert.equal(Buffer.from(tip.hash).equals(pow), true);
    const real = shearHash(header);
    assert.equal(real.equals(pow), false);
    assert.equal(meetsTarget(real, decoded.bits), false);

    const bare = await Promise.resolve(verifyBlock(tip, null, {}));
    assert.equal(bare.ok, false);
    assert.equal(bare.reason, 'pow');
    const tagged = await Promise.resolve(verifyBlock({ ...tip, trustedPowHash: pow }, null, {}));
    assert.equal(tagged.ok, false);
    assert.equal(tagged.reason, 'pow');

    // A claimed id that is not the header's ShearHash is hash_claim before any
    // target check (store.append). The same header under its own ShearHash is
    // then judged on pow.
    const fresh = createStore(tmp('shear-syn-fresh-'));
    const issued = fresh.template({ miner, now });
    assert.equal(Buffer.from(setNonce(issued.tpl.header, 0n)).equals(header), true);
    const direct = await Promise.resolve(fresh.submitHeader({
      jobId: issued.job.jobId,
      nonce: 0n,
      miner,
      powHash: pow.toString('hex'),
      trustedPowHash: pow.toString('hex'),
      skipSharePow: true,
    }));
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, 'hash_claim');
    assert.equal(fresh.tip(), null);
    const own = await Promise.resolve(fresh.submitHeader({
      jobId: issued.job.jobId,
      nonce: 0n,
      miner,
      powHash: real.toString('hex'),
      trustedPowHash: pow.toString('hex'),
      skipSharePow: true,
    }));
    assert.equal(own.ok, false);
    assert.equal(own.reason, 'pow');
    assert.equal(fresh.tip(), null);

    const rpcStore = createStore(tmp('shear-syn-rpc-'));
    const rpcJob = rpcStore.template({ miner, now });
    const rpc = createRpc({ store: rpcStore, port: 0, host: '127.0.0.1' });
    try {
      for (const method of ['submitblock', 'submitHeader']) {
        for (const [claim, want] of [[pow, 'hash_claim'], [real, 'pow']]) {
          const got = await Promise.resolve(rpc.dispatch(method, {
            jobId: rpcJob.job.jobId,
            nonce: '0',
            miner,
            powHash: claim.toString('hex'),
            trustedPowHash: pow.toString('hex'),
            skipSharePow: true,
          }));
          assert.equal(got.ok, false, method);
          assert.equal(got.reason, want, `${method} ${got.reason}`);
          assert.equal(rpcStore.tip(), null);
        }
      }
    } finally {
      await rpc.close();
    }

    const ingested = await Promise.resolve(createStore(tmp('shear-syn-ingest-')).ingest([{
      ...tip,
      trustedPowHash: pow,
    }]));
    assert.equal(ingested.ok, false);
    assert.equal(ingested.reason, 'hash_claim');
    const ingestedOwn = await Promise.resolve(createStore(tmp('shear-syn-ingest-own-')).ingest([{
      ...tip,
      hash: real,
      trustedPowHash: pow,
    }]));
    assert.equal(ingestedOwn.ok, false);
    assert.equal(ingestedOwn.reason, 'pow');
    // The off-loop gate hashes the header and checks its target first.
    for (const block of [tip, { ...tip, hash: real }]) {
      const p2p = await Promise.resolve(createStore(tmp('shear-syn-p2p-')).ingest([block], {
        offLoopPow: true,
      }));
      assert.equal(p2p.ok, false);
      assert.equal(p2p.reason, 'pow');
    }

    for (const [claim, want] of [[pow, 'hash_claim'], [real, 'pow']]) {
      const ipc = await Promise.resolve(applyVerifiedIpcBlock(createStore(tmp('shear-syn-ipc-')), {
        type: 'ipc_block',
        magic: MAGIC_TESTNET,
        block: { ...encodeWireBlock({ ...tip, hash: claim }), trustedPowHash: pow.toString('hex') },
        powHash: claim.toString('hex'),
        trustedPowHash: pow.toString('hex'),
      }));
      assert.equal(ipc.ok, false);
      assert.equal(ipc.reason, want);
    }
  });
});
