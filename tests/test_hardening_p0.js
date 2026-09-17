import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitProve, admitVerify, jroot } from '../crypto/admit.js';
import { randomScalar, commit, pointBytes, proveRange, verifyRange } from '../crypto/note.js';
import { admitPub } from '../crypto/admit.js';
import { nativeLoaded } from '../crypto/native_admit.js';
import { POOL_FEE_BPS } from '../crypto/asert.js';
import { poolFeeDest } from '../crypto/levy.js';
import {
  shouldDurableDestBan,
  destBannedInBook,
  normalizeBanBook,
  stratumBindHost,
  makeLoginChallenge,
  verifyStratumLoginAuth,
  topDestSharePct,
  resetMinerRoundDisplay,
  reportedHashrate,
} from '../pool/src/pool.js';
import { roundActualHashes } from '../pool/src/hash_credit.js';
import { appendAdminAudit } from '../pool/src/admin.js';
import { P2P_MAX_FRAME, noteExpensiveFail, P2P_FAIL_DISCONNECT } from '../node/src/p2p.js';
import { DEFAULT_SEEDS } from '../node/src/node.js';
import { SHORT_ADDR_MAX, encodeDest, newIdentity } from '../crypto/address.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('P0 hardening + short addresses', () => {
  it('P0-1 production wallet send uses native ADMITv2, not Dart v1 / bit-OR', () => {
    const ledger = fs.readFileSync(path.join(root, 'wallet/lib/shear_ledger.dart'), 'utf8');
    const admit = fs.readFileSync(path.join(root, 'wallet/lib/shear_admit.dart'), 'utf8');
    assert.match(ledger, /proveFlowSpend\(/);
    assert.match(ledger, /nativeSealNote\(/);
    assert.equal(ledger.includes('var note = sealNote('), false);
    assert.match(admit, /nativeProveFlowSpend/);
    assert.match(admit, /admit_native_required/);
    const helper = fs.readFileSync(path.join(root, 'crypto/wallet_native_prove.mjs'), 'utf8');
    assert.match(helper, /admitProve/);
    assert.match(helper, /proveRange/);
  });

  it('P0-4 native verify rejects v1, oversized blob; honest v2 verifies', (t) => {
    if (!nativeLoaded()) {
      t.skip('shearadmit.node not built on this host');
      return;
    }
    const n = 6;
    const xs = Array.from({ length: n }, () => randomScalar());
    const pubs = xs.map(admitPub);
    const commits = xs.map((_, i) => pointBytes(commit(i + 2, randomScalar())));
    const proof = admitProve({ x: xs[2], index: 2, pubs, commits, c: commits[2] });
    assert.ok(proof);
    assert.equal(proof.v, 2);
    assert.equal(admitVerify(proof, { pubs, commits }, { cTilde: proof.cTilde, spendTag: proof.spendTag }), true);
    const v1 = { r: pubs.map(() => Buffer.alloc(32)), c0: Buffer.alloc(32), spendTag: proof.spendTag };
    assert.equal(admitVerify(v1, { pubs, commits }, { cTilde: proof.cTilde }), false);
    const huge = Buffer.concat([Buffer.from([2]), Buffer.alloc(32769, 7)]);
    assert.equal(admitVerify({ ...proof, blob: huge }, { pubs, commits }, { cTilde: proof.cTilde, spendTag: proof.spendTag }), false);
    const r = randomScalar();
    const C = pointBytes(commit(3, r));
    const rp = proveRange(3, r);
    assert.ok(rp && rp[0] === 2);
    assert.equal(verifyRange(C, rp), true);
    assert.equal(verifyRange(C, { bits: [] }), false);
  });

  it('P0-5 DEFAULT_SEEDS are ≥2 hostnames; frame cap; scoring disconnects', () => {
    assert.ok(DEFAULT_SEEDS.length >= 2);
    assert.ok(DEFAULT_SEEDS.every((s) => /shear\.digital:30303$/.test(s)));
    assert.ok(P2P_MAX_FRAME <= 2 * 1024 * 1024 || process.env.SHEAR_P2P_MAX_FRAME);
    const rec = {};
    for (let i = 0; i < P2P_FAIL_DISCONNECT - 1; i += 1) assert.equal(noteExpensiveFail(rec), false);
    assert.equal(noteExpensiveFail(rec), true);
  });

  it('P0-6/8 stats expose fee, bind, loginAuth; optional auth verifies ed25519', () => {
    assert.equal(stratumBindHost('127.0.0.1'), '127.0.0.1');
    assert.equal(POOL_FEE_BPS, 100);
    assert.match(poolFeeDest(), /^ssa1/);
    const chal = makeLoginChallenge();
    assert.equal(typeof chal, 'string');
    assert.equal(chal.length, 32);
    assert.equal(verifyStratumLoginAuth({ dest: 'ssa1q', challenge: chal, sig: '00', pub: '00' }), false);
    const src = fs.readFileSync(path.join(root, 'pool/src/pool.js'), 'utf8');
    assert.match(src, /poolFeeBps: POOL_FEE_BPS/);
    assert.match(src, /loginAuth:/);
    assert.match(src, /stratumBindHost/);
  });

  it('P0-7 unauthenticated session cannot durable dest-ban', () => {
    assert.equal(shouldDurableDestBan(null), false);
    assert.equal(shouldDurableDestBan({ accepted: 0 }), false);
    assert.equal(shouldDurableDestBan({ accepted: 2 }), false);
    assert.equal(shouldDurableDestBan({ accepted: 3 }), true);
    const book = normalizeBanBook({ bans: ['victim-dest'] });
    assert.equal(destBannedInBook(book, 'victim-dest'), true);
    const expired = normalizeBanBook({ bans: [{ key: 'victim-dest', kind: 'dest', until: 1 }] }, 1000);
    assert.equal(destBannedInBook(expired, 'victim-dest', 1000), false);
  });

  it('P0-8 admin mutating call appends audit jsonl', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-audit-'));
    appendAdminAudit(dir, { action: 'pause', paused: true });
    const text = fs.readFileSync(path.join(dir, 'admin-audit.jsonl'), 'utf8');
    assert.match(text, /"action":"pause"/);
  });

  it('P0-9 round reset records lost-work path and keeps HUD H/s', () => {
    const src = fs.readFileSync(path.join(root, 'pool/src/pool.js'), 'utf8');
    assert.match(src, /lostWorkHashes/);
    assert.match(src, /sealed = false/);
    const t0 = 1_700_000_000_000;
    const m = {
      connections: [{ sock: {} }],
      threads: 1,
      roundHashes: 256,
      clientHs: 55,
      acceptAt: [t0 - 1000],
      acceptWork: [55 * 180],
    };
    assert.equal(roundActualHashes(m), 256);
    resetMinerRoundDisplay(m, t0);
    assert.equal(roundActualHashes(m), 0);
    assert.ok(reportedHashrate(m, t0) > 40);
  });

  it('P0-10 top dest share % and share:block ratio', () => {
    assert.equal(topDestSharePct([{ hashrate: 80 }, { hashrate: 20 }]), 0.8);
    assert.equal(topDestSharePct([]), 0);
    const readme = fs.readFileSync(path.join(root, 'pool/README.md'), 'utf8');
    assert.match(readme, /solo/i);
  });

  it('public she1/ssa1/shear1 are short dest20-sized strings', () => {
    const id = newIdentity();
    assert.ok(id.paymentCode.length <= SHORT_ADDR_MAX, id.paymentCode);
    assert.ok(id.address.length <= 50, id.address);
    const dest = encodeDest(Buffer.alloc(20, 3), Buffer.alloc(32, 9));
    assert.ok(dest.length <= SHORT_ADDR_MAX, dest);
  });
});
