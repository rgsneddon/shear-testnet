import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { PI_SHE_NANOS } from '../../crypto/asert.js';
import { buildAutoPayoutTx } from '../src/auto_payout.js';
import { publicMinerTag, createPool } from '../src/pool.js';
import { spendBox } from '../../tests/spend_box.js';
import { verifyPoolWithdrawBound, signSpendTx } from '../../crypto/spend.js';
import { compactTx } from '../../crypto/chronoflux.js';
import {
  bootPoolOperator,
  writeOperatorSpendSeed,
  POOL_SPEND_SEED_FILE,
} from '../src/pool_ident.js';
import { poolWithdrawTx } from '../../crypto/levy.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function ssa1() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function walkCommittedRel() {
  const r = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(r.status, 0, String(r.stderr || ''));
  const out = r.stdout || Buffer.alloc(0);
  return out.toString('utf8').split('\0').filter(Boolean);
}

describe('bootPoolOperator matching spend seed', () => {
  it('empty datadir writes dest + pool-spend.seed 0600 and signed=true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-boot-'));
    const boot = bootPoolOperator({ dataDir: dir });
    assert.equal(boot.signed, true);
    assert.ok(boot.operatorSpendKey);
    assert.match(String(boot.miner || ''), /^ssa1/);
    const seedPath = path.join(dir, POOL_SPEND_SEED_FILE);
    const identPath = path.join(dir, 'pool-miner.json');
    assert.equal(fs.existsSync(seedPath), true);
    assert.equal(fs.existsSync(identPath), true);
    const seedSt = fs.statSync(seedPath);
    if (process.platform !== 'win32') {
      assert.equal(seedSt.mode & 0o777, 0o600);
    }
    const identSrc = fs.readFileSync(path.join(root, 'pool/src/pool_ident.js'), 'utf8');
    assert.match(identSrc, /mode: 0o600/);
    const token = fs.readFileSync(seedPath, 'utf8').trim().split(/\s+/)[0];
    assert.equal(token.length, 64);
    assert.equal(/^[0-9a-f]+$/i.test(token), true);
    const ident = JSON.parse(fs.readFileSync(identPath, 'utf8'));
    assert.equal(Object.keys(ident).join(','), 'dest20');
    assert.equal(String(ident.dest20 || '').length, 40);
    const again = bootPoolOperator({ dataDir: dir });
    assert.equal(again.signed, true);
    assert.equal(again.miner, boot.miner);
  });

  it('mismatched seed is signed=false and auto-pay stays need_spend_key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-mismatch-'));
    const boot = bootPoolOperator({ dataDir: dir });
    assert.equal(boot.signed, true);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-other-'));
    const other = bootPoolOperator({ dataDir: otherDir });
    assert.equal(other.signed, true);
    assert.notEqual(other.miner, boot.miner);
    fs.copyFileSync(path.join(otherDir, POOL_SPEND_SEED_FILE), path.join(dir, POOL_SPEND_SEED_FILE));
    const mismatched = bootPoolOperator({ dataDir: dir });
    assert.equal(mismatched.signed, false);
    assert.equal(mismatched.operatorSpendKey, null);
    assert.equal(mismatched.miner, boot.miner);
    const dest = ssa1();
    const skipped = buildAutoPayoutTx({
      from: boot.miner,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      spendKey: mismatched.operatorSpendKey,
    });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, 'need_spend_key');
    const pool = createPool({
      dataDir: dir,
      miner: boot.miner,
      operatorSpendKey: null,
      stratumPort: 0,
      httpPort: 0,
    });
    const tag = publicMinerTag(dest);
    pool.pullBook.creditRound(
      [{ tag, dest, count: 10 }],
      { height: 1, nanos: PI_SHE_NANOS, hashByDest: new Map() },
    );
    pool.store.tip = () => ({ height: 40 });
    const bound = [];
    pool.store.queueTx = (tx) => {
      bound.push(verifyPoolWithdrawBound(tx).ok === true);
      return { ok: true, tx };
    };
    assert.equal((await pool.runAutoPayoutSweep()).length, 0);
    assert.deepEqual(bound, []);
    const err = pool.publicStats().autoPayoutLastError;
    assert.equal(err?.reason, 'unsigned');
    assert.equal(pool.publicStats().bootPoolOperator.signed, false);
    pool.close();
  });

  it('publicStats.bootPoolOperator.signed is true only with a matching key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-stats-'));
    const boot = bootPoolOperator({ dataDir: dir });
    const signedPool = createPool({
      dataDir: dir,
      miner: boot.miner,
      operatorSpendKey: boot.operatorSpendKey,
      stratumPort: 0,
      httpPort: 0,
    });
    const stats = signedPool.publicStats();
    assert.equal(stats.bootPoolOperator.signed, true);
    assert.equal(JSON.stringify(stats.bootPoolOperator).includes(boot.miner), false);
    signedPool.close();
    const unsignedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-stats-u-'));
    const unsignedPool = createPool({
      dataDir: unsignedDir,
      miner: boot.miner,
      operatorSpendKey: null,
      stratumPort: 0,
      httpPort: 0,
    });
    assert.equal(unsignedPool.publicStats().bootPoolOperator.signed, false);
    unsignedPool.close();
  });

  it('verifyPoolWithdrawBound still refuses unsigned and stolen withdraws', () => {
    const dest = ssa1();
    const poolBox = spendBox(newIdentity());
    const unsigned = poolWithdrawTx({
      from: poolBox.dest,
      to: dest.split('.')[0],
      nanos: PI_SHE_NANOS,
      fee: 100,
    });
    assert.equal(verifyPoolWithdrawBound(unsigned).ok, false);
    assert.equal(verifyPoolWithdrawBound(unsigned).reason, 'unsigned');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-bound-'));
    const boot = bootPoolOperator({ dataDir: dir });
    const built = buildAutoPayoutTx({
      from: boot.miner,
      to: dest,
      nanos: PI_SHE_NANOS,
      fee: 100,
      spendKey: boot.operatorSpendKey,
    });
    assert.equal(built.ok, true, built.reason);
    const sealed = compactTx(built.tx);
    assert.equal(verifyPoolWithdrawBound(sealed).ok, true);
    const stolen = { ...sealed, spendPub: undefined, sig: undefined, vin: sealed.vin.map((v) => ({ ...v })) };
    signSpendTx(stolen, spendBox(newIdentity()).key);
    assert.equal(verifyPoolWithdrawBound(stolen).ok, false);
    assert.equal(verifyPoolWithdrawBound(stolen).reason, 'unsigned');
  });

  it('HANDOFF_OPS.md documents restore (paths, 0600, restart, signed=true) without seed hex', () => {
    const handoff = fs.readFileSync(path.join(root, 'HANDOFF_OPS.md'), 'utf8');
    assert.match(handoff, /pool-spend\.seed/);
    assert.match(handoff, /pool-miner\.json/);
    assert.match(handoff, /0600/);
    assert.match(handoff, /shear-pool\.service/);
    assert.match(handoff, /\/var\/lib\/shear\/testnet-v4/);
    assert.match(handoff, /bootPoolOperator\.signed/);
    assert.match(handoff, /signed=true|signed: true/);
    assert.match(handoff, /SHEAR-SECRETS/);
    assert.match(handoff, /need_spend_key/);
    assert.doesNotMatch(handoff, /SHEAR_POOL_SPEND_SEED\s*=\s*[0-9a-fA-F]{64}/);
    const restore = handoff.slice(handoff.indexOf('## 8)'));
    assert.match(restore, /chmod 600/);
    assert.match(restore, /systemctl restart shear-pool/);
  });

  it('committed tree has no pool-spend.seed and units have no hex spend env', () => {
    const files = walkCommittedRel();
    const seedFiles = files.filter((f) => /(^|\/)pool-spend\.seed$/i.test(f.replace(/\\/g, '/')));
    assert.deepEqual(seedFiles, [], `seed file committed: ${seedFiles.join(', ')}`);
    const unitHits = [];
    for (const rel of files) {
      if (!/\.(service|conf|env)$/i.test(rel) && !rel.includes('deploy/')) continue;
      let text;
      try {
        text = fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        continue;
      }
      if (/SHEAR_POOL_SPEND_SEED\s*=\s*[0-9a-fA-F]{64}/.test(text)) unitHits.push(rel);
    }
    assert.deepEqual(unitHits, [], `spend hex in unit: ${unitHits.join(', ')}`);
    const identSrc = fs.readFileSync(path.join(root, 'pool/src/pool_ident.js'), 'utf8');
    assert.match(identSrc, /writeOperatorSpendSeed/);
    assert.match(identSrc, /bootPoolOperator/);
    const main = fs.readFileSync(path.join(root, 'pool/src/main.js'), 'utf8');
    assert.match(main, /pool_operator_unsigned/);
    assert.match(main, /bootPoolOperator/);
  });

  it('writeOperatorSpendSeed keeps 32-byte seed on disk without changing dest match', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ident-write-'));
    const first = bootPoolOperator({ dataDir: dir });
    const seedPath = path.join(dir, POOL_SPEND_SEED_FILE);
    const raw = randomBytes(32);
    writeOperatorSpendSeed(seedPath, raw);
    const after = bootPoolOperator({ dataDir: dir });
    assert.equal(after.signed, false);
    assert.equal(after.miner, first.miner);
  });
});
