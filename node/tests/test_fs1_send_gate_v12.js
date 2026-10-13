/**
 * Stage 0. v3 bucket send proofs are rejected on mempool, template, block,
 * load, fork, P2P, and snap. The 43490 byte cap and the 2^23 hide are not
 * consensus constants. Display copy does not call the bucket proof ADMIT.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { verifyLoadedChain } from '../src/chain.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { createP2p } from '../src/p2p.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { consensusFingerprint } from '../../crypto/asert.js';
import {
  flowProofVerifyCount,
  resetFlowProofVerifies,
  v12FlowVersionRejected,
} from '../../crypto/admit_v3.js';
import { FS1_SEND_ERROR, FS1_SEND_REASON, chainV3BucketSendRejected } from '../../crypto/fs1_send_gate.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = 1_700_000_000_000;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function flowTx(id = 'gated-send') {
  const blob = Buffer.alloc(160, 9);
  blob[0] = 3;
  const tag = Buffer.from(blob.subarray(1, 33));
  const cTilde = Buffer.alloc(32, 5);
  return {
    id,
    kind: 'send',
    nanos: 1,
    fee: 0,
    anchor: 8,
    vin: [{ commit: cTilde }],
    vout: [{ kind: 'send', nanos: 1 }],
    admit_proof: { v: 3, blob, spendTag: tag, cTilde },
    spendTag: tag,
  };
}

describe('FS-1 stage 0 send gate', () => {
  it('does not put the bucket cap or the hide bound into the consensus fingerprint', () => {
    const fp = consensusFingerprint();
    const asert = fs.readFileSync(path.join(root, 'crypto/asert.js'), 'utf8');
    assert.equal(fp.includes('43490'), false);
    assert.equal(fp.includes('8388608'), false);
    assert.equal(/2\^23/.test(fp), false);
    assert.equal(asert.includes('43490'), false);
    assert.equal(asert.includes('8388608'), false);
    assert.equal(FS1_SEND_ERROR.includes('ADMIT'), false);
    assert.equal(FS1_SEND_REASON, 'send_unavailable');
  });

  it('display text does not call the bucket proof ADMIT', () => {
    const files = [
      'wallet/lib/main.dart',
      'wallet/lib/shear_cli.dart',
      'wallet/lib/shear_admit.dart',
      'pool/public/index.html',
      'pool/public/explorer.html',
      'site/whitepaper/index.html',
    ];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.equal(/bucket-32[^.\n]{0,80}ADMIT/i.test(text), false, rel);
      assert.equal(/ADMIT[^.\n]{0,80}bucket-32/i.test(text), false, rel);
    }
    const admit = fs.readFileSync(path.join(root, 'wallet/lib/shear_admit.dart'), 'utf8');
    assert.match(admit, /send unavailable until FS-1/);
  });

  it('rejects a v3 bucket send on mempool, template, block, load, fork, P2P, and snap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fs1-gate-'));
    const store = createStore(dir);
    const dest = minerDest();
    resetFlowProofVerifies();
    const tx = flowTx();
    try {
      const queued = store.queueTx(tx);
      assert.equal(queued.ok, false);
      assert.equal(queued.reason, 'send_unavailable');
      assert.equal(store.mempool.some((row) => row.id === tx.id), false);
      const parked = admitMempool(emptyMempool(), tx, { height: 1 });
      assert.equal(parked.reason, 'send_unavailable');
      const { tpl } = store.template({ miner: dest, shareBits: 4, now: T0 });
      assert.equal(tpl.txs.some((row) => row.id === tx.id), false);

      const block = { txs: [tx], header: Buffer.alloc(80), hash: Buffer.alloc(32) };
      const loaded = verifyLoadedChain([block]);
      assert.equal(loaded.ok, false);
      assert.equal(loaded.reason, 'send_unavailable');
      assert.equal(chainV3BucketSendRejected([block]).reason, 'send_unavailable');
      const forked = verifyLoadedChain([block, block]);
      assert.equal(forked.reason, 'send_unavailable');
      assert.equal(v12FlowVersionRejected(tx).reason, 'send_unavailable');

      const p2p = createP2p({ store, port: 0 });
      p2p.ingestRemoteTx(tx, { destroy() {} });
      assert.equal(store.mempool.some((row) => row.id === tx.id), false);
      p2p.close();
      assert.equal(flowProofVerifyCount(), 0);

      const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fs1-snap-'));
      fs.writeFileSync(path.join(snapDir, 'chain.jsonl'), `${JSON.stringify({
        header: Buffer.alloc(80, 1).toString('hex'),
        hash: Buffer.alloc(32, 2).toString('hex'),
        height: 1,
        txs: [tx],
      })}\n`);
      assert.throws(() => createStore(snapDir), /send_unavailable/);
      fs.rmSync(snapDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a byte-2 flow proof is still admit_version, and a lock is not this gate', () => {
    const v2 = flowTx('v2');
    v2.admit_proof.v = 2;
    v2.admit_proof.blob[0] = 2;
    const loaded = verifyLoadedChain([{ txs: [v2], header: Buffer.alloc(80), hash: Buffer.alloc(32) }]);
    assert.notEqual(loaded.reason, 'send_unavailable');
    const lock = flowTx('lock');
    lock.kind = 'lock';
    assert.equal(chainV3BucketSendRejected([{ txs: [lock] }]), null);
    });
});
