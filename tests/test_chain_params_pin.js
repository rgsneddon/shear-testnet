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
import { applyVerifiedIpcBlock, attachPoolIpc, attachSidecarIpc } from '../node/src/p2p_ipc.js';
import { resolveListenPorts, defaultSidecarIpc, DEV_P2P_PORT, DEV_STRATUM_PORT } from '../node/src/node.js';
import { P2P_PORT } from '../node/src/p2p.js';
import { SOLO_STRATUM_PORT } from '../node/src/solo_stratum.js';
import { feeTauMs, verifyPoolWithdrawOffchain } from '../crypto/levy.js';
import { confirmPolicy } from '../crypto/confirm_policy.js';
import { bootReserveEvm, callReserve, selector } from '../crypto/reserve_evm.js';
import {
  devClockFromRow,
  withdrawSlotOpen,
  statedMagic,
} from '../crypto/chain_params.js';
import {
  genesisSeedPacked,
  GENESIS_BITS_PACKED,
  packBits,
} from '../crypto/asert.js';
import { potSubsidyAt } from '../crypto/pot_sched.js';
import { buildTemplate } from '../node/src/chain.js';
import { encodeDest, newIdentity, ed25519PrivateFromSeed, ed25519RawPub, hash20FromAddress } from '../crypto/address.js';
import { destForLogin } from '../crypto/flow_sheet.js';
import { signPoolWithdraw, verifyPoolWithdrawSig, poolWithdrawMagic, poolWithdrawDigest } from '../crypto/eip712.js';
import { verifyWalletPoolWithdraw, handleWalletApi } from '../pool/src/wallet_api.js';
import { auditCirculatingSupply } from '../node/src/supply.js';
import { packShewall, sealShewallBin, openShewallBin, unpackShewall } from '../crypto/shewall_bin.js';
import {
  portalIdFromDest,
  vote,
  VOTE_HOLD,
  withdraw,
  withdrawChainId,
  withdrawOwnerMessage,
  reserveMagicBytes,
  signRewardAuth,
  verifyRewardAuth,
  WITHDRAW_CHAIN_ID,
} from '../crypto/reserve_vault.js';
import { PI_SHE_NANOS } from '../crypto/asert.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const V12_FINGERPRINT_SHA = '2bdb41abb54d1f1b805aaafe1e9fbdf2ce02605af9ecdbc0d8588502e2c19a86';
const MAINNET_FINGERPRINT_SHA = 'c7caeb8252e45213e0cac036a9c48de89d12bb68b976e32113830285d6d415c8';
const DEV_FINGERPRINT_SHA = '6d7e52a1dd260cdb3453c4b25cc9d4f6732926a453a662eda374b286aed2e54c';
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
    assert.equal(dev.withdrawSlots, 31);
    assert.equal(dev.withdrawPeriodSlots, 15);
    assert.equal(32 * dev.withdrawSlotMs, dev.epochMs);
    assert.equal(16 * dev.periodMs, dev.epochMs);
    assert.equal(Object.hasOwn(chainParams('shear-testnet-v12'), 'withdrawPeriodSlots'), false);
    assert.equal(Object.hasOwn(chainParams('shear-v1'), 'withdrawPeriodSlots'), false);
    assert.equal(dev.voteCloseBlock, 24);
    assert.equal(dev.p2pBanMs, 60000);
    assert.equal(dev.evmChainId, 2799);
    assert.deepEqual(dev.defaultSeeds, []);
    assert.equal(dev.datadirLeaf, 'shear-dev');
    assert.equal(dev.rpcPort, 18432);
    assert.equal(Object.hasOwn(dev, 'ipcPort'), false);
    assert.equal(canonicalParamsJson('shear-dev').includes('ipcPort'), false);
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
    assert.equal(dev.genesisBits, 12);
    assert.equal(dev.poolIpcPort, 31314);
    assert.equal(Object.hasOwn(chainParams('shear-testnet-v12'), 'poolIpcPort'), false);
    assert.equal(Object.hasOwn(chainParams('shear-v1'), 'poolIpcPort'), false);
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
    assert.throws(() => clockFor(''), /unknown_magic/);
    assert.throws(() => clockFor(null), /unknown_magic/);
    assert.equal(statedMagic(null), 'shear-testnet-v12');
    assert.equal(statedMagic(undefined), 'shear-testnet-v12');
    assert.throws(() => statedMagic(''), /unknown_magic/);
    assert.equal(clockFor('shear-regtest'), v12);
    assert.equal(clockFor('shear-testnet-v11'), v12);
    assert.equal(clockFor('shear-dev').targetBlockMs, 9000);
    assert.throws(() => clockFor('shear-testnet-v13'), /unknown_magic/);
    assert.throws(() => consensusFingerprint(''), /unknown_magic/);
    assert.throws(() => consensusFingerprint('nope'), /unknown_magic/);
    assert.throws(() => epochMs(''), /unknown_magic/);
    assert.throws(() => epochMs('nope'), /unknown_magic/);
    assert.throws(() => epochDays(''), /unknown_magic/);
    assert.throws(() => epochDays('no-such-book'), /unknown_magic/);
    assert.equal(epochMs('shear-regtest'), 4 * 86400000);
    assert.equal(epochMs('shear-testnet-v11'), 4 * 86400000);
    assert.throws(() => genesisSeedPacked(''), /unknown_magic/);
    assert.throws(() => genesisSeedPacked('nope'), /unknown_magic/);
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
    assert.equal(dev.length, 2479);
    assert.equal(sha256(dev), DEV_FINGERPRINT_SHA);
    assert.notEqual(dev, v12);
    assert.equal(dev.includes('NETWORK=shear-dev'), true);
    assert.match(dev, /PARAMS=[0-9a-f]{64}$/);
    assert.equal(dev.split(':')[4], '12');
    assert.equal(v12.split(':')[4], '17');
    assert.equal(consensusFingerprint().split(':')[4], '17');
    assert.equal(mainnetFingerprint().split(':')[4], '17');
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
    assert.match(dart, new RegExp(DEV_FINGERPRINT_SHA));
    assert.match(dart, /final int\? withdrawPeriodSlots;/);
    assert.match(dart, /withdrawPeriodSlots: 15/);
    assert.match(dart, /withdrawPeriodSlots: null/);
    assert.equal(/nextBits|ASERT_|bitsForBlock|asertHarden|asertEase|SHEAR_BITS/.test(dart), false);
    assert.match(dart, /final int\? ipcPort;/);
    assert.match(dart, /final int\? poolIpcPort;/);
    assert.match(dart, /ipcPort: null/);
    assert.match(dart, /poolIpcPort: 31314/);
    assert.match(dart, /poolIpcPort: null/);
  });

  it('keeps dev literals out of the v12 sources', () => {
    const allow = new Set([
      'crypto/chain_params.js',
      'wallet/lib/shear_chain_params.dart',
      'wallet/lib/shear_book_dev.dart',
      'wallet/lib/main_dev.dart',
      'wallet/lib/shear_session.dart',
      'pool/src/main_dev.js',
      'node/src/node.js',
      'wallet/lib/shear_eip712.dart',
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
    assert.equal(payoutSweepFor('shear-dev'), 120000);
    assert.equal(payoutSweepFor('shear-dev', { SHEAR_PAYOUT_SWEEP_MS: '200000' }), 120000);
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

  it('dev P2P and stratum stay off the v12 ports unless the unit sets them', () => {
    const dev = resolveListenPorts('shear-dev', {});
    const v12 = resolveListenPorts('shear-testnet-v12', {});
    assert.equal(dev.p2pPort, DEV_P2P_PORT);
    assert.equal(dev.stratumPort, DEV_STRATUM_PORT);
    assert.equal(dev.p2pPort, 31303);
    assert.equal(dev.stratumPort, 11211);
    assert.equal(v12.p2pPort, P2P_PORT);
    assert.equal(v12.stratumPort, SOLO_STRATUM_PORT);
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
    assert.match(book, /127\.0\.0\.1:\$\{row\.poolIpcPort\}/);
    assert.equal(book.includes('31314'), false);
    const poolDev = fs.readFileSync(path.join(root, 'pool/src/main_dev.js'), 'utf8');
    assert.match(poolDev, /SHEAR_STRATUM \|\| process\.env\.SHEAR_STRATUM_PORT \|\| DEV_STRATUM_PORT/);
    assert.match(poolDev, /defaultSidecarIpc\(MAGIC_DEV\)/);
    assert.equal(poolDev.includes('|| 1111'), false);
    assert.equal(poolDev.includes('30303'), false);
  });

  it('reads the dev row into consensus, and a different row value changes the schedule', () => {
    const row = chainParams('shear-dev');
    const seed = packBits(row.genesisBits);
    assert.equal(row.genesisBits, 12);
    assert.equal(seed, 12 * 65536);
    assert.equal(genesisSeedPacked('shear-dev'), seed);
    assert.equal(genesisSeedPacked('shear-testnet-v12'), GENESIS_BITS_PACKED);
    assert.equal(genesisSeedPacked('shear-v1'), GENESIS_BITS_PACKED);
    assert.equal(genesisSeedPacked('shear-regtest'), GENESIS_BITS_PACKED);
    assert.equal(genesisSeedPacked(), GENESIS_BITS_PACKED);
    assert.notEqual(seed, GENESIS_BITS_PACKED);
    const miner = encodeDest(Buffer.alloc(20, 5));
    const devTpl = buildTemplate({
      height: 1,
      miner,
      magic: 'shear-dev',
      now: 1_700_000_000_000,
    });
    const v12Tpl = buildTemplate({
      height: 1,
      miner,
      magic: 'shear-testnet-v12',
      now: 1_700_000_000_000,
    });
    assert.equal(devTpl.bits, seed);
    assert.equal(v12Tpl.bits, GENESIS_BITS_PACKED);
    const genesis = 1_700_000_000_000;
    const target = row.targetBlockMs;
    assert.equal(
      potSubsidyAt({ nowMs: genesis + row.epochMs, genesisMs: genesis, magic: 'shear-dev' }),
      POT_START_NANOS - POT_STEP_NANOS,
    );
    assert.equal(
      potSubsidyAt({ nowMs: genesis + row.epochMs - 1, genesisMs: genesis, magic: 'shear-dev' }),
      POT_START_NANOS,
    );
    assert.equal(
      potSubsidyAt({ nowMs: genesis + row.epochMs, genesisMs: genesis, magic: 'shear-testnet-v12' }),
      POT_START_NANOS,
    );
    assert.equal(devClockFromRow(row.epochMs, row).epoch, 1);
    assert.equal(devClockFromRow(row.epochMs - 1, row).epoch, 0);
    assert.equal(devClockFromRow(row.epochMs, { ...row, epochMs: row.epochMs * 2 }).epoch, 0);
    assert.equal(devClockFromRow(target, { ...row, epochBlocks: 1 }).epoch, 0);
    assert.equal(devClockFromRow(row.dayMs, row).day, 1);
    assert.equal(devClockFromRow(row.dayMs, row).voteOpen, false);
    assert.equal(devClockFromRow(row.dayMs, { ...row, dayMs: row.dayMs * 2 }).day, 0);
    assert.equal(devClockFromRow(row.dayMs, { ...row, dayMs: row.dayMs * 2 }).voteOpen, true);
    assert.equal(devClockFromRow(target, { ...row, dayBlocks: 1 }).voteOpen, true);
    assert.equal(devClockFromRow(target, row).voteOpen, true);
    assert.equal(devClockFromRow(target, { ...row, stubBlocks: 2 }).voteOpen, false);
    assert.equal(devClockFromRow(target, { ...row, voteEdge: 5 }).voteOpen, false);
    assert.equal(devClockFromRow(2 * target, row).voteOpen, true);
    assert.equal(devClockFromRow(2 * target, { ...row, withdrawPeriodSlots: 1 }).voteOpen, false);
    assert.equal(devClockFromRow(2 * target + 1, row).voteOpen, true);
    assert.equal(devClockFromRow(2 * target, { ...row, voteSep: 3 }).voteOpen, false);
    assert.equal(devClockFromRow(2 * target + 1, { ...row, voteSep: 3 }).voteOpen, false);
    assert.equal(devClockFromRow(3 * target + 100, { ...row, voteSep: 3 }).voteOpen, true);
    assert.equal(devClockFromRow(2 * target, { ...row, voteGap: 3 }).voteOpen, false);
    assert.equal(devClockFromRow(2 * target + 1, { ...row, voteGap: 3 }).voteOpen, false);
    assert.equal(devClockFromRow(3 * target + 100, { ...row, voteGap: 3 }).voteOpen, true);
    assert.equal(devClockFromRow(25 * target, row).voteOpen, false);
    assert.equal(devClockFromRow(25 * target, { ...row, voteCloseBlock: 30 }).voteOpen, true);
    const lateVote = { ...row, voteCloseBlock: 40, withdrawPeriodSlots: 40 };
    assert.equal(devClockFromRow(30 * target, { ...row, voteCloseBlock: 40 }).voteOpen, false);
    assert.equal(devClockFromRow(30 * target, lateVote).voteOpen, true);
    assert.equal(devClockFromRow(30 * target, { ...lateVote, voteFinality: 3 }).voteOpen, false);
    const closedMs = 128 * target;
    assert.equal(devClockFromRow(closedMs, row).withdrawOpen, false);
    assert.equal(devClockFromRow(closedMs, { ...row, periodBlocks: 4 }).withdrawOpen, false);
    assert.equal(row.withdrawPeriodSlots, 15);
    assert.equal(row.withdrawSlots, 31);
    assert.ok(row.withdrawPeriodSlots * row.periodMs < row.epochMs);
    assert.ok(row.withdrawSlots * row.withdrawSlotMs < row.epochMs);
    assert.equal(devClockFromRow(row.withdrawPeriodSlots * row.periodMs, row).withdrawOpen, false);
    assert.equal(devClockFromRow((row.withdrawPeriodSlots - 1) * row.periodMs, row).withdrawOpen, true);
    assert.equal(devClockFromRow(row.epochMs - 1, row).withdrawOpen, false);
    assert.equal(devClockFromRow((row.withdrawPeriodSlots - 1) * row.periodMs, { ...row, withdrawPeriodSlots: row.withdrawPeriodSlots - 1 }).withdrawOpen, false);
    assert.equal(devClockFromRow(row.withdrawPeriodSlots * row.periodMs, { ...row, periodBlocks: 4 }).withdrawOpen, false);
    assert.equal(devClockFromRow((row.withdrawPeriodSlots - 1) * row.periodMs, { ...row, periodMs: row.periodMs * 2 }).withdrawOpen, true);
    assert.equal(withdrawSlotOpen(row.withdrawSlots * row.withdrawSlotMs, row), false);
    assert.equal(withdrawSlotOpen((row.withdrawSlots - 1) * row.withdrawSlotMs, row), true);
    assert.equal(withdrawSlotOpen((row.withdrawSlots - 1) * row.withdrawSlotMs, { ...row, withdrawSlots: row.withdrawSlots - 1 }), false);
    assert.equal(withdrawSlotOpen(row.epochMs - 1, row), false);
    const v12row = chainParams('shear-testnet-v12');
    assert.equal(withdrawSlotOpen(63 * v12row.withdrawSlotMs, v12row), true);
    assert.equal(withdrawSlotOpen(v12row.withdrawSlots * v12row.withdrawSlotMs, v12row), false);
    assert.equal(v12row.withdrawSlots, 7680);
    assert.equal(v12row.withdrawSlotMs, 90000);
    const clockSrc = fs.readFileSync(path.join(root, 'crypto/chain_params.js'), 'utf8');
    assert.equal(clockSrc.includes('slotsInsideEpoch'), false);
    assert.equal(devClockFromRow(0, row).genesisBits, 12);
    assert.equal(devClockFromRow(0, { ...row, genesisBits: 10 }).genesisBits, 10);
    assert.notEqual(packBits(10), seed);
    const start = 1_700_000_000_000;
    const closed = withdraw({
      state: { magic: 'shear-dev', epochStartMs: start, blankFork: false },
      nowMs: start + row.withdrawPeriodSlots * row.periodMs,
    });
    assert.equal(closed.reason, 'withdraw_closed');
    const inside = withdraw({
      state: { magic: 'shear-dev', epochStartMs: start, blankFork: false },
      nowMs: start + (row.withdrawPeriodSlots - 1) * row.periodMs,
    });
    assert.notEqual(inside.reason, 'withdraw_closed');
    const epochEdge = withdraw({
      state: { magic: 'shear-dev', genesisMs: start, epochStartMs: start, blankFork: false },
      nowMs: start + row.epochMs - 1,
    });
    assert.equal(epochEdge.reason, 'withdraw_closed');
    const open = withdraw({
      state: { magic: 'shear-dev', epochStartMs: start, blankFork: false },
      nowMs: start,
    });
    assert.notEqual(open.reason, 'withdraw_closed');
    const noStart = withdraw({
      state: { magic: 'shear-dev', blankFork: false },
      nowMs: start + row.epochMs,
    });
    assert.notEqual(noStart.reason, 'withdraw_closed');
    const noStartV12 = withdraw({
      state: { magic: 'shear-testnet-v12', blankFork: false },
      nowMs: start + epochMs('shear-testnet-v12'),
    });
    assert.notEqual(noStartV12.reason, 'withdraw_closed');
    const devEnact = withdraw({
      state: { magic: 'shear-dev', genesisMs: start, epochStartMs: start, blankFork: false },
      nowMs: start + row.epochMs,
    });
    assert.notEqual(devEnact.reason, 'withdraw_closed');
    const v12Enact = withdraw({
      state: { magic: 'shear-testnet-v12', genesisMs: start, epochStartMs: start, blankFork: false },
      nowMs: start + epochMs('shear-testnet-v12'),
    });
    assert.notEqual(v12Enact.reason, 'withdraw_closed');
    const v12wd = withdraw({
      state: { magic: 'shear-testnet-v12', epochStartMs: start, blankFork: false },
      nowMs: start + row.epochMs - 1,
    });
    assert.notEqual(v12wd.reason, 'withdraw_closed');
  });

  it('dev vote uses the chain epoch when the vault still stores the one that ended', () => {
    const row = chainParams('shear-dev');
    const start = 1_700_000_000_000;
    const dest = destForLogin(newIdentity().address, { viewKey: newIdentity().viewKey, height: 1 });
    const pid = portalIdFromDest(dest);
    const voter = (magic) => ({
      magic,
      genesisMs: start,
      epochStartMs: start,
      currentEpoch: 0,
      bonusEnacted: false,
      blankFork: false,
      votes: { increase: 0, decrease: 0, hold: 0 },
      liveHashBonusNanos: 1n,
      portals: {
        [pid]: {
          id: pid,
          staked: BigInt(PI_SHE_NANOS),
          idle: 0n,
          vote: null,
          joined: true,
          voteEpoch: 0,
        },
      },
    });
    const openedAt = start + row.epochMs + row.stubBlocks * row.targetBlockMs;
    const opened = vote({ state: voter('shear-dev'), dest, choice: VOTE_HOLD, nowMs: openedAt });
    assert.equal(opened.ok, true, opened.reason);
    const early = vote({ state: voter('shear-dev'), dest, choice: VOTE_HOLD, nowMs: openedAt - 1 });
    assert.equal(early.reason, 'vote_closed');
    const v12 = vote({
      state: voter('shear-testnet-v12'),
      dest,
      choice: VOTE_HOLD,
      nowMs: start + epochMs('shear-testnet-v12') + 1,
    });
    assert.equal(v12.ok, true, v12.reason);
    assert.notEqual(v12.reason, 'vote_closed');
  });

  it('a dev signature does not verify on v12', () => {
    assert.equal(WITHDRAW_CHAIN_ID, 2701n);
    assert.equal(withdrawChainId('shear-dev'), 2799n);
    assert.equal(withdrawChainId('shear-testnet-v12'), 2701n);
    assert.equal(withdrawChainId(), 2701n);
    assert.throws(() => withdrawChainId(''), /unknown_magic/);
    assert.throws(() => withdrawChainId('nope'), /unknown_magic/);
    assert.throws(() => reserveMagicBytes(''), /unknown_magic/);
    assert.throws(() => poolWithdrawMagic(''), /unknown_magic/);
    assert.throws(() => poolWithdrawMagic('nope'), /unknown_magic/);
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    const seed = Buffer.alloc(32, 7);
    const nanos = 5_000_000_000;
    const fields = { seed, login: id.paymentCode, dest, nanos };
    const books = ['shear-dev', 'shear-testnet-v12', 'shear-v1'];
    const sigs = Object.fromEntries(books.map((magic) => [magic, signPoolWithdraw({ ...fields, chainId: magic })]));
    for (const signed of books) {
      for (const checked of books) {
        assert.equal(
          verifyPoolWithdrawSig({ ...fields, sig: sigs[signed], chainId: checked }),
          signed === checked,
          `${signed} on ${checked}`,
        );
      }
    }
    assert.equal(verifyPoolWithdrawSig({ ...fields, sig: sigs['shear-dev'] }), false);
    assert.throws(() => poolWithdrawDigest({ login: id.paymentCode, dest, nanos }), /unknown_magic/);
    const devSig = sigs['shear-dev'];
    const v12Sig = sigs['shear-testnet-v12'];
    const mainSig = sigs['shear-v1'];
    const devOff = verifyPoolWithdrawOffchain({
      login: id.paymentCode, dest, nanos, sig: devSig, magic: 'shear-dev',
    });
    assert.equal(devOff.ok, true, devOff.reason);
    const omitted = verifyPoolWithdrawOffchain({
      login: id.paymentCode, dest, nanos, sig: devSig,
    });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.reason, 'unknown_magic');
    assert.equal(verifyPoolWithdrawOffchain({
      login: id.paymentCode, dest, nanos, sig: v12Sig,
    }).reason, 'unknown_magic');
    assert.equal(verifyPoolWithdrawOffchain({
      login: id.paymentCode, dest, nanos, sig: devSig, magic: 'shear-testnet-v12',
    }).ok, false);
    assert.equal(verifyPoolWithdrawOffchain({
      login: id.paymentCode, dest, nanos, sig: v12Sig, magic: 'shear-dev',
    }).ok, false);
    assert.equal(verifyPoolWithdrawOffchain({
      login: id.paymentCode, dest, nanos, sig: v12Sig, magic: 'shear-v1',
    }).ok, false);
    assert.equal(verifyPoolWithdrawOffchain({
      login: id.paymentCode, dest, nanos, sig: mainSig, magic: 'shear-testnet-v12',
    }).ok, false);
    assert.equal(verifyPoolWithdrawOffchain({
      login: id.paymentCode, dest, nanos, sig: mainSig, magic: 'shear-v1',
    }).ok, true);
    const seed32 = Buffer.alloc(32, 9);
    const packed = packShewall({ seed32, dest20: hash20FromAddress(dest) });
    const sealed = sealShewallBin(packed, 'v12-import');
    const opened = unpackShewall(openShewallBin(sealed, 'v12-import'));
    assert.equal(Buffer.from(opened.seed32).equals(seed32), true);
    const body = { login: id.paymentCode, dest, nanos };
    const importedDev = signPoolWithdraw({ ...body, seed: opened.seed32, chainId: 'shear-dev' });
    const importedV12 = signPoolWithdraw({ ...body, seed: opened.seed32, chainId: 'shear-testnet-v12' });
    const onDev = verifyWalletPoolWithdraw({ magic: 'shear-dev' }, { ...body, sig: importedDev });
    assert.equal(onDev.ok, true, onDev.reason);
    assert.equal(verifyWalletPoolWithdraw({ magic: 'shear-testnet-v12' }, { ...body, sig: importedDev }).ok, false);
    assert.equal(verifyWalletPoolWithdraw({ magic: 'shear-dev' }, { ...body, sig: importedV12 }).ok, false);
    const walletApi = fs.readFileSync(path.join(root, 'pool/src/wallet_api.js'), 'utf8');
    const helper = walletApi.slice(
      walletApi.indexOf('export function verifyWalletPoolWithdraw'),
      walletApi.indexOf('export function handleWalletApi'),
    );
    assert.match(helper, /magic:\s*store\?\.magic/);
    assert.equal(helper.includes('MAGIC_TESTNET'), false);
    const eip = fs.readFileSync(path.join(root, 'wallet/lib/shear_eip712.dart'), 'utf8');
    assert.equal(eip.includes("magic = 'shear-testnet-v12'"), false);
    assert.equal(eip.includes('shear-testnet-v12'), false);
    assert.match(eip, /required String magic/);
    assert.match(eip, /EIP712Domain\(string name,string version,string chainId,address verifyingContract\)/);
    assert.match(eip, /_hashString\(magic\)/);
    assert.equal(eip.includes("magic == 'shear-dev'"), false);
    const cli = fs.readFileSync(path.join(root, 'wallet/lib/shear_cli.dart'), 'utf8');
    assert.equal(cli.includes('signPoolWithdraw(seed: seed, login: id.paymentCode, dest: dest, nanos: nanos, magic: _cliBookMagic)'), true);
    assert.equal(cli.includes('magic: _cliBookMagic'), true);
    const ledger = fs.readFileSync(path.join(root, 'wallet/lib/shear_ledger.dart'), 'utf8');
    assert.equal(ledger.includes('signPoolWithdraw(seed: seed, login: login, dest: dest, nanos: nanos, magic: magic)'), true);
    assert.equal(ledger.includes('required String magic'), true);
    assert.equal(ledger.includes("magic = 'shear-testnet-v12'"), false);
    const nullifier = 'ab'.repeat(32);
    const tranche = 'cd'.repeat(32);
    const key = ed25519PrivateFromSeed(seed);
    const pub = ed25519RawPub(key).toString('hex');
    const messageFor = (magic) => withdrawOwnerMessage({
      nullifier,
      nanos: 1000n,
      dest: 'payout-dest',
      magic: reserveMagicBytes(magic),
      chainId: withdrawChainId(magic),
      epoch: 1n,
      trancheSet: Buffer.from(tranche, 'hex'),
    });
    const ownerBooks = ['shear-dev', 'shear-testnet-v12', 'shear-v1'];
    const ownerMsgs = Object.fromEntries(ownerBooks.map((magic) => [magic, messageFor(magic)]));
    for (const signed of ownerBooks) {
      const sig = signRewardAuth(ownerMsgs[signed], key);
      for (const checked of ownerBooks) {
        assert.equal(verifyRewardAuth(ownerMsgs[checked], pub, sig), signed === checked, `${signed} owner on ${checked}`);
      }
    }
    const reserveSol = fs.readFileSync(path.join(root, 'contracts/Reserve.sol'), 'utf8');
    const authFn = reserveSol.slice(reserveSol.indexOf('function _withdrawAuthOk'), reserveSol.indexOf('function _authOk'));
    assert.match(authFn, /magic/);
    assert.match(authFn, /block\.chainid/);
  });

  it('a missing supply magic throws, and pullPending uses the store magic', () => {
    assert.throws(() => auditCirculatingSupply([]), (err) => err?.code === 'unknown_magic');
    assert.throws(() => auditCirculatingSupply([], { magic: '' }), (err) => err?.code === 'unknown_magic');
    const empty = auditCirculatingSupply([], { magic: 'shear-testnet-v12' });
    assert.equal(empty.status, 'verified');
    assert.equal(empty.circulatingNanos, 0);
    const supplySrc = fs.readFileSync(path.join(root, 'node/src/supply.js'), 'utf8');
    const auditFn = supplySrc.slice(supplySrc.indexOf('export function auditCirculatingSupply'));
    assert.equal(/opts\.magic == null \? MAGIC_TESTNET/.test(auditFn), false);
    const workerSrc = fs.readFileSync(path.join(root, 'node/src/supply_audit_worker.js'), 'utf8');
    assert.equal(workerSrc.includes('MAGIC_TESTNET'), false);
    assert.match(workerSrc, /magic: job\?\.magic/);
    const walletApi = fs.readFileSync(path.join(root, 'pool/src/wallet_api.js'), 'utf8');
    assert.match(walletApi, /type: 'start', length: blocks\.length, magic: store\?\.magic/);
    const devPull = handleWalletApi(
      new URL('http://127.0.0.1/api/pool/pullPending?login=she1abc'),
      'GET',
      null,
      { store: { magic: 'shear-dev' } },
    );
    assert.equal(devPull.status, 200);
    assert.equal(devPull.json.chainId, 2799);
    const v12Pull = handleWalletApi(
      new URL('http://127.0.0.1/api/pool/pullPending?login=she1abc'),
      'GET',
      null,
      { store: { magic: 'shear-testnet-v12' } },
    );
    assert.equal(v12Pull.status, 200);
    assert.equal(v12Pull.json.chainId, 2701);
    const bare = handleWalletApi(
      new URL('http://127.0.0.1/api/pool/pullPending?login=she1abc'),
      'GET',
      null,
      { store: {} },
    );
    assert.equal(bare.status, 400);
    assert.equal(bare.json.reason, 'unknown_magic');
  });

  it('the dev node and the dev pool connect on the table sidecar port', async () => {
    const row = chainParams('shear-dev');
    assert.equal(defaultSidecarIpc('shear-dev', {}), `127.0.0.1:${row.poolIpcPort}`);
    assert.equal(defaultSidecarIpc('shear-testnet-v12', {}), '');
    assert.equal(defaultSidecarIpc('shear-dev', { SHEAR_P2P_IPC: '127.0.0.1:9' }), '127.0.0.1:9');
    const store = {
      magic: 'shear-dev',
      blocks: [],
      tip() { return { height: 0 }; },
    };
    let poolUp = 0;
    let sideUp = 0;
    const pool = await attachPoolIpc({
      store,
      port: row.poolIpcPort,
      onUp() { poolUp += 1; },
    });
    const side = attachSidecarIpc({
      store,
      p2p: {},
      addr: defaultSidecarIpc('shear-dev', {}),
      onUp() { sideUp += 1; },
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (poolUp < 1 || sideUp < 1)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    try {
      assert.equal(poolUp > 0, true);
      assert.equal(sideUp > 0, true);
      assert.equal(pool.port, row.poolIpcPort);
    } finally {
      side.close();
      pool.close();
    }
  });
});
