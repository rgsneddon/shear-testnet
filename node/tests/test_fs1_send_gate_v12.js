/**
 * Stage 0. v3 bucket proofs on a send, transfer, lock, vote, or withdraw are
 * rejected on mempool, template, block, load, fork, P2P, and snap before any
 * proof work. No consensus module calls the bucket verifier, so its 43490 byte
 * cap and its 2^23 pad are not consensus rules. Display copy does not call the
 * bucket proof ADMIT. ADMITv3 names the full-set FS-1 proof, so the name is
 * allowed and only bucket wording beside ADMIT is banned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { verifyLoadedChain, verifyBlock } from '../src/chain.js';
import { emptyMempool, admitMempool } from '../../crypto/mempool.js';
import { createP2p } from '../src/p2p.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { consensusFingerprint } from '../../crypto/asert.js';
import { setHashBackend } from '../../crypto/shear_hash.js';
import {
  flowProofVerifyCount,
  resetFlowProofVerifies,
  resetTypedProofVerifies,
  typedAdmitStructure,
  typedProofVerifyCount,
  v12FlowVersionRejected,
  verifyFlowAdmitV3,
  verifyTypedAdmitFunding,
} from '../../crypto/admit_v3.js';
import {
  FS1_SEND_ERROR,
  FS1_SEND_REASON,
  FS1_VAULT_ERROR,
  FS1_VAULT_REASON,
  chainStage0Rejected,
} from '../../crypto/fs1_send_gate.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const BUCKET_WORDS = /bucket|\b32[\s_-]*(?:notes?|members?|leaf|leaves|inputs?|outputs?|set|ring)\b|set of 32|ring of 32|anonymity set|v3 (?:membership )?proof/i;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T0 = 1_700_000_000_000;

const TRUST = { trustBlockHash: true, skipSharePow: true };

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag, 4);
  powTag += 1;
  return h;
}

async function mineOne(store, miner, now) {
  const { tpl } = store.template({ miner, shareBits: 4, now });
  return Promise.resolve(store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: easyPow(), skipSharePow: true }));
}

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
      ...fs.readdirSync(path.join(root, 'wallet/lib'))
        .filter((name) => name.endsWith('.dart'))
        .map((name) => `wallet/lib/${name}`),
      ...fs.readdirSync(path.join(root, 'pool/public'))
        .filter((name) => name.endsWith('.html'))
        .map((name) => `pool/public/${name}`),
      'site/whitepaper/index.html',
    ];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      for (const sentence of text.split(/[.!?\n]/)) {
        if (!/\bADMIT/.test(sentence)) continue;
        assert.equal(BUCKET_WORDS.test(sentence), false, `${rel}: ${sentence.trim()}`);
      }
    }
    for (const probe of [
      'ADMIT proves a bucket-32 spend',
      'the bucket proof is ADMIT',
      'ADMIT hides you in a bucket of 32',
      'ADMIT covers 32 notes',
      'ADMIT picks your note from a set of 32',
      'ADMIT is a ring of 32',
    ]) {
      assert.equal(BUCKET_WORDS.test(probe), true, probe);
    }
    for (const probe of [
      'ADMITv3 membership proves the note is in the full set',
      'Sends wait for the ADMITv3 full-set proof',
    ]) {
      assert.equal(BUCKET_WORDS.test(probe), false, probe);
    }
    const admit = fs.readFileSync(path.join(root, 'wallet/lib/shear_admit.dart'), 'utf8');
    assert.match(admit, /send unavailable until FS-1/);
  });

  it('rejects a v3 bucket send on mempool, template, block, load, P2P, and snap', () => {
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
      assert.equal(chainStage0Rejected([block]).reason, 'send_unavailable');
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

  it('a byte-2 flow proof is still admit_version', () => {
    const v2 = flowTx('v2');
    v2.admit_proof.v = 2;
    v2.admit_proof.blob[0] = 2;
    const loaded = verifyLoadedChain([{ txs: [v2], header: Buffer.alloc(80), hash: Buffer.alloc(32) }]);
    assert.notEqual(loaded.reason, 'send_unavailable');
    assert.equal(chainStage0Rejected([{ txs: [v2] }]), null);
  });
});

// The largest blob the native verifier would read. Verifying one takes minutes.
const FULL_BLOB = 43_490;

function vaultTx(kind, { id = `gated-${kind}`, inputs = 1, blobBytes = FULL_BLOB } = {}) {
  const proofs = [];
  const vin = [];
  for (let i = 0; i < inputs; i += 1) {
    const blob = Buffer.alloc(blobBytes, 0x5a + i);
    blob[0] = 3;
    const cTilde = Buffer.alloc(32, 0x20 + i);
    proofs.push({ v: 3, blob, spendTag: Buffer.from(blob.subarray(1, 33)), cTilde });
    vin.push({ commit: cTilde, anchor: 8 });
  }
  return {
    id,
    kind,
    fee: 0,
    anchor: 8,
    vin,
    vout: [{ kind, dest20: Buffer.alloc(20, 7), valueProof: { v: 1 } }],
    admit_proof: proofs[0],
    ...(inputs > 1 ? { admit_proofs: proofs } : {}),
    spendTag: proofs[0].spendTag,
  };
}

function quick(label, fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 250, `${label} took ${ms} ms`);
  return out;
}

const CONSENSUS_SOURCES = [
  'crypto/admit_v3.js',
  'crypto/mempool.js',
  'crypto/spend.js',
  'crypto/fund_verdict.js',
  'crypto/reserve_vault.js',
  'crypto/block_budget.js',
  'crypto/fs1_send_gate.js',
  'crypto/asert.js',
  'node/src/chain.js',
  'node/src/store.js',
  'node/src/p2p.js',
  'node/src/bootstrap.js',
  'node/src/book_snap.js',
];

describe('FS-1 stage 0 vault gate', () => {
  it('no consensus module calls the bucket verifier or carries its cap or pad', () => {
    for (const rel of CONSENSUS_SOURCES) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.equal(/admitVerifyV3|nativeVerifyV3|\.verifyV3\(|admitProveV3/.test(text), false, rel);
      assert.equal(/43[_,]?490|40[_,]?354|MAX_PROOF_V3/.test(text), false, rel);
      assert.equal(/1\s*<<\s*23|2\s*\*\*\s*23/.test(text), false, rel);
    }
    assert.equal(FS1_VAULT_ERROR.includes('ADMIT'), false);
    assert.equal(FS1_VAULT_REASON, 'vault_unavailable');
  });

  it('lock, vote, and withdraw with 1 to 8 bucket inputs are rejected before proof work', () => {
    resetTypedProofVerifies();
    resetFlowProofVerifies();
    for (const kind of ['lock', 'vote', 'withdraw']) {
      for (const inputs of [1, 2, 4, 8]) {
        const tx = vaultTx(kind, { inputs });
        const label = `${kind} x${inputs}`;
        assert.equal(quick(label, () => typedAdmitStructure(tx)).reason, 'vault_unavailable', label);
        const funded = quick(label, () => verifyTypedAdmitFunding(tx, {
          height: 16,
          blocks: [],
          noteAtAnchor: () => { throw new Error(`${label} read the anchor book`); },
        }));
        assert.equal(funded.reason, 'vault_unavailable', label);
        assert.equal(quick(label, () => chainStage0Rejected([{ txs: [tx] }])).reason, 'vault_unavailable', label);
        const parked = quick(label, () => admitMempool(emptyMempool(), tx, {
          height: 16,
          noteAtAnchor: () => { throw new Error(`${label} read the anchor book`); },
        }));
        assert.equal(parked.reason, 'vault_unavailable', label);
      }
    }
    assert.equal(typedProofVerifyCount(), 0);
    assert.equal(flowProofVerifyCount(), 0);
  });

  it('a send or transfer is rejected the same way by the flow verifier', () => {
    for (const kind of ['send', 'transfer']) {
      const tx = flowTx(`flow-${kind}`);
      tx.kind = kind;
      tx.vout = [{ kind, nanos: 1 }];
      const got = quick(kind, () => verifyFlowAdmitV3(tx, {
        height: 16,
        noteAtAnchor: () => { throw new Error(`${kind} read the anchor book`); },
      }));
      assert.equal(got.reason, 'send_unavailable', kind);
    }
  });

  it('rejects a vault bucket proof on queue, template, block, load, P2P, and snap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fs1-vault-'));
    const store = createStore(dir);
    const dest = minerDest();
    resetTypedProofVerifies();
    try {
      for (const kind of ['lock', 'vote', 'withdraw']) {
        const tx = vaultTx(kind);
        const queued = quick(`${kind} queue`, () => store.queueTx(tx));
        assert.equal(queued.ok, false);
        assert.equal(queued.reason, 'vault_unavailable', kind);
        assert.equal(store.mempool.some((row) => row.id === tx.id), false);

        const p2p = createP2p({ store, port: 0 });
        quick(`${kind} p2p`, () => p2p.ingestRemoteTx(tx, { destroy() {} }));
        assert.equal(store.mempool.some((row) => row.id === tx.id), false);
        p2p.close();

        const { tpl } = store.template({ miner: dest, shareBits: 4, now: T0 });
        assert.equal(tpl.txs.some((row) => row.id === tx.id), false);

        const block = {
          header: tpl.header,
          height: tpl.height,
          txs: [...tpl.txs, tx],
          samples: tpl.samples,
          shareBatch: tpl.shareBatch || [],
          miner: dest,
          hash: Buffer.alloc(32),
        };
        const verdict = await Promise.resolve(quick(`${kind} block`, () => verifyBlock(block, null, {
          trustedPowHash: Buffer.alloc(32),
          skipSharePow: true,
          noteAtAnchor: () => { throw new Error(`${kind} read the anchor book`); },
        })));
        assert.equal(verdict.ok, false);
        assert.equal(verdict.reason, 'vault_unavailable', kind);
        const appended = await Promise.resolve(store.append(block, {
          trustedPowHash: Buffer.alloc(32),
          skipSharePow: true,
        }));
        assert.equal(appended.ok, false);
        assert.equal(appended.reason, 'vault_unavailable', kind);
        assert.equal(store.blocks.length, 0);

        const loaded = quick(`${kind} load`, () => verifyLoadedChain([block]));
        assert.equal(loaded.reason, 'vault_unavailable', kind);

        const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fs1-vault-snap-'));
        fs.writeFileSync(path.join(snapDir, 'chain.jsonl'), `${JSON.stringify({
          header: Buffer.alloc(80, 1).toString('hex'),
          hash: Buffer.alloc(32, 2).toString('hex'),
          height: 1,
          txs: [tx],
        })}\n`);
        assert.throws(() => createStore(snapDir), /vault_unavailable/);
        fs.rmSync(snapDir, { recursive: true, force: true });
      }
      assert.equal(typedProofVerifyCount(), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a heavier fork that carries a gated tx does not reorg the tip', { timeout: 600_000 }, async () => {
    const dest = minerDest();
    const other = minerDest();
    const dirs = [];
    const fresh = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-fs1-reorg-'));
      dirs.push(dir);
      return createStore(dir);
    };
    try {
      const local = fresh();
      for (let i = 0; i < 2; i += 1) {
        assert.equal((await mineOne(local, dest, T0 + i * 90_000)).ok, true);
      }
      const peer = fresh();
      const control = fresh();
      for (const store of [peer, control]) {
        const got = await Promise.resolve(store.ingest(local.blocks.slice(), TRUST));
        assert.equal(got.ok, true, got.reason);
        assert.equal(store.blocks.length, 2);
      }
      assert.equal((await mineOne(local, dest, T0 + 2 * 90_000)).ok, true);
      assert.equal((await mineOne(control, dest, T0 + 2 * 90_000)).ok, true);
      for (let i = 2; i < 5; i += 1) {
        assert.equal((await mineOne(peer, other, T0 + i * 90_000 + 7_000)).ok, true);
      }
      const forkRoot = local.blocks[1].hash;
      assert.ok(Buffer.from(peer.blocks[1].hash).equals(Buffer.from(forkRoot)));
      assert.ok(!Buffer.from(peer.blocks[2].hash).equals(Buffer.from(local.blocks[2].hash)));

      const reorged = await Promise.resolve(control.ingest(peer.blocks.slice(), TRUST));
      assert.equal(reorged.ok, true, reorged.reason);
      assert.equal(control.blocks.length, 5);
      assert.ok(Buffer.from(control.tip().hash).equals(Buffer.from(peer.tip().hash)));

      const localTip = Buffer.from(local.tip().hash);
      const cases = [
        ['send bucket', flowTx('reorg-send'), 'send_unavailable'],
        ['send no proof', { ...flowTx('reorg-bare'), admit_proof: undefined, spendTag: undefined }, 'send_unavailable'],
        ['lock bucket', vaultTx('lock', { id: 'reorg-lock' }), 'vault_unavailable'],
        ['withdraw bucket', vaultTx('withdraw', { id: 'reorg-withdraw', inputs: 8 }), 'vault_unavailable'],
      ];
      resetTypedProofVerifies();
      for (const [label, tx, reason] of cases) {
        const poisoned = peer.blocks.map((b, i) => (i !== 3 ? b : { ...b, txs: [...b.txs, tx] }));
        const refused = await Promise.resolve(local.ingest(poisoned, TRUST));
        assert.equal(refused.ok, false, label);
        assert.equal(refused.reason, reason, label);
        assert.equal(local.blocks.length, 3, label);
        assert.ok(Buffer.from(local.tip().hash).equals(localTip), label);
      }
      assert.equal(typedProofVerifyCount(), 0);
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a v12 send or transfer with no proof is not accepted in a block', () => {
    for (const kind of ['send', 'transfer']) {
      const tx = { ...flowTx(`bare-${kind}`), kind, admit_proof: undefined, spendTag: undefined };
      const block = { txs: [{ coinbase: true, kind: 'coinbase', vout: [] }, tx], header: Buffer.alloc(80), hash: Buffer.alloc(32) };
      assert.equal(quick(kind, () => chainStage0Rejected([block])).reason, 'send_unavailable', kind);
      assert.equal(verifyLoadedChain([block]).reason, 'send_unavailable', kind);
      assert.equal(verifyBlock(block, null, { trustedPowHash: Buffer.alloc(32), skipSharePow: true }).reason, 'send_unavailable', kind);
    }
  });

  it('a public reserve receipt with no proof is not this gate', () => {
    const tx = {
      kind: 'lock',
      vin: [{ dest20: Buffer.alloc(20, 1) }],
      vout: [{ kind: 'lock', dest20: Buffer.alloc(20, 2), valueProof: { v: 5 } }],
    };
    assert.equal(chainStage0Rejected([{ txs: [tx] }]), null);
    assert.equal(typedAdmitStructure(tx).skip, true);
  });
});
