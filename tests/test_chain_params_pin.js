import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CHAIN_PARAMS,
  chainParams,
  clockFor,
  canonicalParamsJson,
  isTableMagic,
} from '../crypto/chain_params.js';
import {
  consensusFingerprint,
  mainnetFingerprint,
  TARGET_BLOCK_INTERVAL_MS,
  ASERT_HALFLIFE_MS,
  HEADER_AHEAD_MS,
  GENESIS_BITS,
} from '../crypto/asert.js';
import { RESERVE_BOOKS } from '../crypto/reserve_books.js';
import { epochMs, epochDays, joinCutoffMs, POT_START_NANOS, POT_STEP_NANOS } from '../crypto/pot_sched.js';
import { windowBlocksFor } from '../crypto/reserve_oracle.js';
import { PAYOUT_SWEEP_MS, payoutSweepFor, createPool } from '../pool/src/pool.js';
import { applyVerifiedIpcBlock } from '../node/src/p2p_ipc.js';
import { resolveListenPorts } from '../node/src/node.js';
import { P2P_PORT } from '../node/src/p2p.js';
import { SOLO_STRATUM_PORT } from '../node/src/solo_stratum.js';
import { feeTauMs } from '../crypto/levy.js';
import { confirmPolicy } from '../crypto/confirm_policy.js';
import { bootReserveEvm, callReserve, selector } from '../crypto/reserve_evm.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const V12_FINGERPRINT_SHA = '2bdb41abb54d1f1b805aaafe1e9fbdf2ce02605af9ecdbc0d8588502e2c19a86';
const MAINNET_FINGERPRINT_SHA = 'c7caeb8252e45213e0cac036a9c48de89d12bb68b976e32113830285d6d415c8';
const RESERVE_JSON_SHA = 'f0f4a4397510319bfe5fe7d292e1c914c516b45848d4e79b8b6b0eea108ef3e1';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

describe('chain param table', () => {
  it('has exactly three frozen rows and rejects every other key', () => {
    assert.deepEqual(Object.keys(CHAIN_PARAMS).sort(), ['shear-dev', 'shear-testnet-v12', 'shear-v1']);
    for (const magic of Object.keys(CHAIN_PARAMS)) {
      assert.equal(Object.isFrozen(chainParams(magic)), true);
      assert.equal(chainParams(magic).magic, magic);
    }
    for (const bad of ['', 'shear-regtest', 'shear-testnet-v13', 'shear-dev ', 'shear-testnet-v11']) {
      assert.equal(isTableMagic(bad), false);
      assert.throws(() => chainParams(bad), (err) => err.code === 'unknown_magic' || /unknown_magic/.test(err.message));
    }
  });

  it('pins v12 and mainnet numbers as literals', () => {
    const v12 = chainParams('shear-testnet-v12');
    const main = chainParams('shear-v1');
    assert.equal(v12.targetBlockMs, 90000);
    assert.equal(v12.asertTauMs, 7200000);
    assert.equal(v12.headerAheadMs, 15000);
    assert.equal(v12.epochMs, 345600000);
    assert.equal(v12.epochDays, 4);
    assert.equal(v12.evmChainId, 2701);
    assert.equal(v12.genesisBits, 17);
    assert.equal(v12.rpcPort, 18332);
    assert.equal(v12.ipcPort, 30313);
    assert.equal(Object.hasOwn(v12, 'p2pPort'), false);
    assert.equal(Object.hasOwn(v12, 'stratumPort'), false);
    assert.equal(v12.datadirLeaf, 'testnet-v11');
    assert.deepEqual(v12.defaultSeeds, [
      'p2p.shear.digital:30303',
      'r2r.shear.digital:30303',
      'b2b.shear.digital:30303',
    ]);
    assert.equal(main.epochDays, 400);
    assert.equal(main.epochMs, 34560000000);
    assert.equal(main.hardenMax, 6);
    assert.equal(main.easeMax, 1);
    assert.equal(main.joinCutoffMs, 99 * 86400000);
    assert.equal(main.oracleWindowBlocks, 6720);
    assert.equal(main.evmChainId, 2701);
    assert.equal(TARGET_BLOCK_INTERVAL_MS, 90000);
    assert.equal(ASERT_HALFLIFE_MS, 7200000);
    assert.equal(HEADER_AHEAD_MS, 15000);
    assert.equal(GENESIS_BITS, 17);
    assert.equal(epochDays('shear-testnet-v12'), 4);
    assert.equal(epochDays('shear-v1'), 400);
    assert.equal(epochMs('shear-testnet-v12'), 4 * 86400000);
    assert.equal(joinCutoffMs('shear-testnet-v12'), 86400000);
  });

  it('pins the shear-dev S2 row', () => {
    const dev = chainParams('shear-dev');
    assert.equal(dev.targetBlockMs, 9000);
    assert.equal(dev.asertTauMs, 720000);
    assert.equal(dev.headerAheadMs, 5000);
    assert.equal(dev.epochMs, 288000);
    assert.equal(dev.epochBlocks, 32);
    assert.equal(dev.joinCutoffMs, 72000);
    assert.equal(dev.withdrawSlots, 64);
    assert.equal(dev.voteCloseBlock, 24);
    assert.equal(dev.p2pBanMs, 60000);
    assert.equal(dev.evmChainId, 2799);
    assert.deepEqual(dev.defaultSeeds, []);
    assert.equal(dev.datadirLeaf, 'shear-dev');
    assert.equal(dev.rpcPort, 18432);
    assert.equal(dev.ipcPort, 31313);
    assert.equal(Object.hasOwn(dev, 'p2pPort'), false);
    assert.equal(Object.hasOwn(dev, 'stratumPort'), false);
    assert.equal(canonicalParamsJson('shear-dev').includes('p2pPort'), false);
    assert.equal(canonicalParamsJson('shear-dev').includes('stratumPort'), false);
    assert.equal(dev.jobRestampMs, 2000);
    assert.equal(dev.prevJobGraceMs, 1200);
    assert.equal(dev.headerHoldMs, 18000);
    assert.equal(dev.tipStallMs, 90000);
    assert.equal(dev.vardiffTargetMs, 2000);
    assert.equal(dev.vardiffRetargetShares, 8);
    assert.equal(dev.vardiffRetargetMs, 20000);
    assert.equal(dev.payoutSweepMs, 120000);
    assert.equal(dev.payoutSweepFloorMs, 0);
    assert.equal(dev.oracleWindowBlocks, 1);
    assert.equal(dev.genesisBits, 17);
    assert.equal(epochMs('shear-dev'), 288000);
    assert.equal(windowBlocksFor('shear-dev'), 1);
    assert.equal(windowBlocksFor('shear-testnet-v12'), 67);
    assert.equal(feeTauMs('shear-dev'), 9000);
    assert.equal(feeTauMs('shear-testnet-v12'), 90000);
    assert.equal(confirmPolicy('shear-dev').spendable, 9);
    assert.equal(confirmPolicy('shear-testnet-v12').merchant, 12);
    assert.equal(RESERVE_BOOKS.some((b) => b.magic === 'shear-dev'), false);
  });

  it('clockFor sends regtest and closed books to the v12 row', () => {
    const v12 = chainParams('shear-testnet-v12');
    assert.equal(clockFor(''), v12);
    assert.equal(clockFor('shear-regtest'), v12);
    assert.equal(clockFor('shear-testnet-v11'), v12);
    assert.equal(clockFor('shear-dev').targetBlockMs, 9000);
    assert.throws(() => clockFor('shear-testnet-v13'), /unknown_magic/);
  });

  it('ignores env and has no process.env in the table module', () => {
    const before = canonicalParamsJson('shear-testnet-v12');
    const prev = process.env.SHEAR_TARGET_BLOCK_MS;
    process.env.SHEAR_TARGET_BLOCK_MS = '1';
    process.env.SHEAR_EPOCH_MS = '1';
    process.env.SHEAR_FUZZ_NOT_A_REAL_KNOB = '9';
    assert.equal(canonicalParamsJson('shear-testnet-v12'), before);
    assert.equal(chainParams('shear-testnet-v12').targetBlockMs, 90000);
    if (prev == null) delete process.env.SHEAR_TARGET_BLOCK_MS;
    else process.env.SHEAR_TARGET_BLOCK_MS = prev;
    delete process.env.SHEAR_EPOCH_MS;
    delete process.env.SHEAR_FUZZ_NOT_A_REAL_KNOB;
    const src = fs.readFileSync(path.join(root, 'crypto/chain_params.js'), 'utf8');
    assert.equal(src.includes('process.env'), false);
  });

  it('pins v12 and mainnet fingerprints and Reserve.json', () => {
    const v12 = consensusFingerprint('shear-testnet-v12');
    assert.equal(v12.length, 2421);
    assert.equal(sha256(v12), V12_FINGERPRINT_SHA);
    assert.equal(sha256(consensusFingerprint()), V12_FINGERPRINT_SHA);
    assert.equal(v12.includes('PARAMS='), false);
    assert.equal(v12.includes('NETWORK=shear-testnet-v12'), true);
    assert.equal(sha256(mainnetFingerprint()), MAINNET_FINGERPRINT_SHA);
    const reserve = fs.readFileSync(path.join(root, 'contracts/Reserve.json'));
    assert.equal(sha256(reserve), RESERVE_JSON_SHA);
    const dev = consensusFingerprint('shear-dev');
    assert.notEqual(dev, v12);
    assert.equal(dev.includes('NETWORK=shear-dev'), true);
    assert.match(dev, /PARAMS=[0-9a-f]{64}$/);
    assert.equal(dev.includes('HISTORICAL_TIP='), false);
    assert.equal(consensusFingerprint('shear-testnet-v11').includes('HISTORICAL_TIP='), true);
    const pot0 = POT_START_NANOS;
    const pot1 = pot0 - POT_STEP_NANOS;
    assert.equal(pot1, 99_000_000_000);
    assert.equal(POT_STEP_NANOS, 1_000_000_000);
  });

  it('matches the generated Dart twin', () => {
    const dart = fs.readFileSync(path.join(root, 'wallet/lib/shear_chain_params.dart'), 'utf8');
    const begin = dart.indexOf('// CHAIN_PARAMS_JSON_BEGIN\n');
    const end = dart.indexOf('\n// CHAIN_PARAMS_JSON_END');
    assert.ok(begin >= 0 && end > begin);
    const body = dart.slice(begin + '// CHAIN_PARAMS_JSON_BEGIN\n'.length, end);
    const lines = body.split('\n');
    assert.equal(lines.length, 3);
    for (const magic of ['shear-dev', 'shear-testnet-v12', 'shear-v1']) {
      assert.ok(lines.includes(canonicalParamsJson(magic)), magic);
    }
    assert.match(dart, new RegExp(V12_FINGERPRINT_SHA));
    assert.match(dart, new RegExp(MAINNET_FINGERPRINT_SHA));
    assert.equal(/nextBits|ASERT_|bitsForBlock|asertHarden|asertEase|SHEAR_BITS/.test(dart), false);
  });

  it('keeps dev literals out of the v12 sources', () => {
    const allow = new Set([
      'crypto/chain_params.js',
      'wallet/lib/shear_chain_params.dart',
      'wallet/lib/shear_book_dev.dart',
      'wallet/lib/main_dev.dart',
      'wallet/lib/shear_session.dart',
      'pool/src/main_dev.js',
    ]);
    const roots = ['crypto', 'node/src', 'pool/src', 'wallet/lib'];
    const tokens = ['shear-dev', '288000', '2799', '31303'];
    const hits = [];
    for (const rel of roots) {
      const dir = path.join(root, rel);
      const walk = (d) => {
        for (const name of fs.readdirSync(d)) {
          const abs = path.join(d, name);
          const st = fs.statSync(abs);
          if (st.isDirectory()) walk(abs);
          else if (/\.(js|dart)$/.test(name)) {
            const file = path.relative(root, abs);
            if (allow.has(file)) continue;
            const text = fs.readFileSync(abs, 'utf8');
            for (const token of tokens) {
              const hit = token === '2799'
                ? /(?<![0-9A-Fa-f])2799(?![0-9A-Fa-f])/.test(text)
                : text.includes(token);
              if (hit) hits.push(`${file}:${token}`);
            }
          }
        }
      };
      walk(dir);
    }
    assert.deepEqual(hits, []);
  });

  it('release wallet targets do not import the dev book', () => {
    const release = ['wallet/lib/main.dart', 'wallet/bin/shear.dart'];
    const seen = new Set();
    const queue = release.map((rel) => path.join(root, rel));
    while (queue.length) {
      const abs = queue.pop();
      if (seen.has(abs) || !fs.existsSync(abs)) continue;
      seen.add(abs);
      const text = fs.readFileSync(abs, 'utf8');
      assert.equal(text.includes('shear_book_dev.dart'), false, abs);
      assert.equal(text.includes("fromEnvironment('SHEAR"), false, abs);
      const imports = text.match(/import ['"]([^'"]+)['"]/g) || [];
      for (const line of imports) {
        const spec = line.match(/['"]([^'"]+)['"]/)[1];
        if (!spec.endsWith('.dart')) continue;
        if (spec.startsWith('package:shear_wallet/')) {
          queue.push(path.join(root, 'wallet/lib', spec.slice('package:shear_wallet/'.length)));
        } else if (spec.startsWith('.')) {
          queue.push(path.resolve(path.dirname(abs), spec));
        }
      }
    }
    const devEntry = fs.readFileSync(path.join(root, 'wallet/lib/main_dev.dart'), 'utf8');
    const devCli = fs.readFileSync(path.join(root, 'wallet/bin/shear_dev.dart'), 'utf8');
    assert.match(devEntry, /kReleaseMode/);
    assert.match(devEntry, /kProfileMode/);
    assert.match(devCli, /dart\.vm\.product/);
    assert.match(devEntry, /shear_book_dev\.dart/);
    assert.match(devCli, /shear_book_dev\.dart/);
  });

  it('IPC and the dev pool refuse the other magic and the live fee dest', () => {
    const pow = 'ab'.repeat(32);
    const block = { header: '00', txs: [] };
    const devStore = { magic: 'shear-dev', tip() { return { height: 0 }; } };
    const v12Store = { magic: 'shear-testnet-v12', tip() { return { height: 0 }; } };
    const v12msg = { type: 'ipc_block', magic: 'shear-testnet-v12', block, powHash: pow };
    const devmsg = { type: 'ipc_block', magic: 'shear-dev', block, powHash: pow };
    assert.equal(applyVerifiedIpcBlock(devStore, v12msg).reason, 'magic');
    assert.equal(applyVerifiedIpcBlock(v12Store, devmsg).reason, 'magic');
    assert.equal(payoutSweepFor('shear-testnet-v12'), PAYOUT_SWEEP_MS);
    const prev = process.env.SHEAR_PAYOUT_SWEEP_MS;
    process.env.SHEAR_PAYOUT_SWEEP_MS = '1000';
    assert.equal(payoutSweepFor('shear-dev'), 120000);
    process.env.SHEAR_PAYOUT_SWEEP_MS = '200000';
    assert.equal(payoutSweepFor('shear-dev'), 200000);
    if (prev == null) delete process.env.SHEAR_PAYOUT_SWEEP_MS;
    else process.env.SHEAR_PAYOUT_SWEEP_MS = prev;
    assert.throws(() => createPool({ dataDir: os.tmpdir(), network: 'not-a-book' }), /unknown_magic/);
    assert.throws(() => createPool({ dataDir: os.tmpdir(), network: 'shear-dev' }), /live_fee_dest/);
  });

  it('JS epoch width matches the booted Reserve artifact', async () => {
    const word = (buf) => {
      const b = Buffer.from(buf);
      assert.equal(b.length, 32);
      return Number(BigInt(`0x${b.toString('hex')}`));
    };
    const dev = await bootReserveEvm({ network: 'shear-dev' });
    assert.equal(dev.epochMs, 288000);
    const devEpoch = await callReserve(dev, selector('epochLengthMs()'), { staticCall: true });
    const devCut = await callReserve(dev, selector('cutoffLengthMs()'), { staticCall: true });
    assert.equal(devEpoch.ok, true, devEpoch.reason);
    assert.equal(devCut.ok, true, devCut.reason);
    assert.equal(word(devEpoch.returnValue), 288000);
    assert.equal(word(devCut.returnValue), 72000);
    const v12 = await bootReserveEvm({ network: 'shear-testnet-v12' });
    assert.equal(v12.epochMs, 4 * 86_400_000);
    const v12Epoch = await callReserve(v12, selector('epochLengthMs()'), { staticCall: true });
    const v12Cut = await callReserve(v12, selector('cutoffLengthMs()'), { staticCall: true });
    assert.equal(v12Epoch.ok, true, v12Epoch.reason);
    assert.equal(v12Cut.ok, true, v12Cut.reason);
    assert.equal(word(v12Epoch.returnValue), 4 * 86_400_000);
    assert.equal(word(v12Cut.returnValue), 86_400_000);
  });

  it('dev P2P and stratum use the v12 env flags and the open ports', () => {
    const dev = resolveListenPorts('shear-dev', {});
    const v12 = resolveListenPorts('shear-testnet-v12', {});
    assert.equal(dev.p2pPort, P2P_PORT);
    assert.equal(dev.stratumPort, SOLO_STRATUM_PORT);
    assert.equal(dev.p2pPort, 30303);
    assert.equal(dev.stratumPort, 1111);
    assert.equal(v12.p2pPort, 30303);
    assert.equal(v12.stratumPort, 1111);
    assert.equal(dev.rpcPort, 18432);
    assert.equal(v12.rpcPort, 18332);
    const flagged = resolveListenPorts('shear-dev', {
      SHEAR_P2P_PORT: '30303',
      SHEAR_STRATUM: '1111',
    });
    assert.equal(flagged.p2pPort, 30303);
    assert.equal(flagged.stratumPort, 1111);
    const alt = resolveListenPorts('shear-dev', { SHEAR_STRATUM_PORT: '1111' });
    assert.equal(alt.stratumPort, 1111);
    const explicit = resolveListenPorts('shear-dev', { SHEAR_P2P_PORT: '9' }, { p2pPort: 0, stratumPort: 0 });
    assert.equal(explicit.p2pPort, 0);
    assert.equal(explicit.stratumPort, 0);
    const book = fs.readFileSync(path.join(root, 'wallet/lib/shear_book_dev.dart'), 'utf8');
    assert.equal(book.includes("'SHEAR_P2P_PORT'"), false);
    assert.equal(book.includes("'SHEAR_STRATUM'"), false);
    const poolDev = fs.readFileSync(path.join(root, 'pool/src/main_dev.js'), 'utf8');
    assert.match(poolDev, /SHEAR_STRATUM \|\| 1111/);
    assert.equal(poolDev.includes('11211'), false);
  });
});
