import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_MAINNET, MAGIC_TESTNET, NANOS_PER_SHE, extraMintAllowed } from './asert.js';
import { levyNanos, LEVY_CAP_NANOS as LEVY_CAP, FEE_SPLIT_FINDER_BPS, FEE_SPLIT_RESERVE_BPS, splitLevy } from './levy.js';
import { networkOf, acceptsMagic, MAINNET_GENESIS_MS, MAINNET_SEEDS, NETWORKS } from './network.js';
import { generateMainnetGenesis } from './genesis_mainnet.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBlock } from '../node/src/chain.js';
import { shearHash, hashHex, HEADER_LEN, V2_SELFTEST, V1_SELFTEST, setHashBackend, PERSONAL } from './shear_hash.js';

describe('network profiles', () => {
  it('mainnet is shear-v1 with p2p.shear.digital seeds; testnet stays shear-testnet-v2', () => {
    const tn = networkOf('testnet');
    const mn = networkOf('mainnet');
    assert.equal(tn.magic, MAGIC_TESTNET);
    assert.equal(tn.magic, 'shear-testnet-v2');
    assert.equal(mn.magic, MAGIC_MAINNET);
    assert.equal(mn.magic, 'shear-v1');
    assert.equal(mn.dataDirName, 'mainnet');
    assert.equal(tn.dataDirName, 'testnet-v2');
    assert.deepEqual(mn.seeds, MAINNET_SEEDS);
    assert.equal(mn.seeds[0], 'p2p.shear.digital:30303');
    assert.equal(mn.seeds.includes('46.224.132.83:30303'), true);
    assert.equal(JSON.stringify(mn).includes('shear-testnet-v2'), false);
    assert.equal(JSON.stringify(mn).toLowerCase().includes('feeless'), false);
    assert.equal(networkOf('shear-v1').id, 'mainnet');
    assert.equal(MAINNET_GENESIS_MS, Date.parse('2026-09-11T20:00:00.000Z'));
    assert.equal(new Date(MAINNET_GENESIS_MS).toISOString(), '2026-09-11T20:00:00.000Z');
    assert.equal(NETWORKS.mainnet.genesisMs, MAINNET_GENESIS_MS);
    const rec = generateMainnetGenesis();
    assert.equal(rec.timestamp, MAINNET_GENESIS_MS);
    assert.equal(rec.magic, MAGIC_MAINNET);
    const stubPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../prep/genesis-mainnet.json');
    const stub = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
    assert.equal(stub.timestamp, MAINNET_GENESIS_MS);
    assert.equal(stub.timestampISO, '2026-09-11T20:00:00.000Z');
  });

  it('acceptsMagic isolates books: testnet rejects shear-v1, mainnet rejects shear-testnet-v2', () => {
    assert.equal(acceptsMagic(MAGIC_TESTNET, MAGIC_TESTNET), true);
    assert.equal(acceptsMagic(MAGIC_TESTNET, MAGIC_MAINNET), false);
    assert.equal(acceptsMagic(MAGIC_MAINNET, MAGIC_MAINNET), true);
    assert.equal(acceptsMagic(MAGIC_MAINNET, MAGIC_TESTNET), false);
    assert.equal(acceptsMagic(MAGIC_MAINNET, ''), false);
    assert.equal(acceptsMagic(MAGIC_TESTNET, ''), true);
    assert.equal(acceptsMagic(MAGIC_TESTNET, null), true);
  });
});

describe('mainnet profile keeps 0.27 mint law', () => {
  it('levy cap 0.001 SHE still holds; extra mint only Reserve; split 50/50', () => {
    assert.equal(LEVY_CAP, Math.floor(0.001 * NANOS_PER_SHE));
    assert.equal(levyNanos(5 * NANOS_PER_SHE), LEVY_CAP);
    assert.equal(levyNanos(100 * NANOS_PER_SHE), LEVY_CAP);
    assert.ok(levyNanos(NANOS_PER_SHE) <= LEVY_CAP);
    assert.equal(FEE_SPLIT_FINDER_BPS, 5000);
    assert.equal(FEE_SPLIT_RESERVE_BPS, 5000);
    assert.deepEqual(splitLevy(12), { finder: 6, reserve: 6 });
    assert.equal(extraMintAllowed('shear-reserve-v1'), true);
    assert.equal(extraMintAllowed('third-party-vortice'), false);
  });
});

describe('foreign magic on verifyBlock', () => {
  it('testnet verify rejects a shear-v1 envelope; mainnet verify rejects shear-testnet-v2', () => {
    const header = Buffer.alloc(HEADER_LEN);
    header[0] = 1;
    const tn = { header, magic: MAGIC_TESTNET, txs: [{ coinbase: true }] };
    const mn = { header, magic: MAGIC_MAINNET, txs: [{ coinbase: true }] };
    const tnRejectsMain = verifyBlock(mn, null, { magic: MAGIC_TESTNET });
    assert.equal(tnRejectsMain.ok, false);
    assert.equal(tnRejectsMain.reason, 'foreign_magic');
    const mnRejectsTest = verifyBlock(tn, null, { magic: MAGIC_MAINNET });
    assert.equal(mnRejectsTest.ok, false);
    assert.equal(mnRejectsTest.reason, 'foreign_magic');
    const tnLegacy = verifyBlock({ header, txs: [{ coinbase: true }] }, null, { magic: MAGIC_TESTNET });
    assert.notEqual(tnLegacy.reason, 'foreign_magic');
    const mnNeedsMagic = verifyBlock({ header, txs: [{ coinbase: true }] }, null, { magic: MAGIC_MAINNET });
    assert.equal(mnNeedsMagic.reason, 'foreign_magic');
  });
});

describe('ShearHash-v2 selftest still passes; frozen v1 vector still fails as v2', () => {
  it('v2 selftest header digest is unchanged and not the v1 vector', () => {
    setHashBackend('interpreter');
    const header = Buffer.alloc(HEADER_LEN);
    header[0] = 1;
    assert.equal(PERSONAL, 'ShearHash-v2');
    assert.equal(hashHex(shearHash(header)), V2_SELFTEST);
    assert.notEqual(V2_SELFTEST, V1_SELFTEST);
    assert.equal(V2_SELFTEST, '64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895');
  });
});
