import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { printConfig } from '../src/node.js';
import { networkOf } from '../../crypto/network.js';
import { MAGIC_MAINNET } from '../../crypto/asert.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('mainnet-labelled artefacts', () => {
  it('node --network mainnet printConfig is shear-v1 with p2p seed and no testnet magic', () => {
    const j = printConfig('mainnet');
    assert.equal(j.magic, MAGIC_MAINNET);
    assert.equal(j.magic, 'shear-v1');
    assert.equal(j.mainnet, true);
    assert.equal(j.dataDirName, 'mainnet');
    assert.equal(j.seeds[0], 'p2p.shear.digital:30303');
    assert.equal(JSON.stringify(j).includes('shear-testnet-v2'), false);
    assert.equal(JSON.stringify(j).toLowerCase().includes('feeless'), false);
    const tn = printConfig('testnet');
    assert.equal(tn.magic, 'shear-testnet-v2');
    assert.equal(tn.mainnet, false);
  });

  it('staged site, genesis stub, unit, specs, pool.env carry shear-v1 and zero testnet magic', () => {
    const files = [
      'prep/site/index.html',
      'prep/genesis-mainnet.json',
      'prep/pool-mainnet/pool.env',
      'deploy/shear-node-mainnet.service',
      'specs/mainnet.md',
    ];
    for (const rel of files) {
      const s = read(rel);
      assert.match(s, /shear-v1/, rel);
      assert.doesNotMatch(s, /shear-testnet-v2/, rel);
      assert.doesNotMatch(s, /feeless/i, rel);
    }
    const site = read('prep/site/index.html');
    assert.match(site, /p2p\.shear\.digital:30303/);
    assert.match(site, /GENESIS_HASH/);
    assert.match(site, /FIRST_RELEASE_URL/);
    assert.match(site, />DOCS</);
    assert.match(site, />MAINNET</);
    assert.match(site, /Friday 11 September 2026/);
    assert.doesNotMatch(site, /Thursday/);
    const unit = read('deploy/shear-node-mainnet.service');
    assert.doesNotMatch(unit, /:1111/);
    assert.doesNotMatch(unit, /ExecStart=.*stratum/i);
    assert.match(unit, /SHEAR_NETWORK=mainnet/);
    assert.match(unit, /P2P_PORT=30303/);
    assert.match(unit, /node\.js --network mainnet/);
    const dart = read('wallet/lib/shear_network.dart');
    assert.match(dart, /kMagicMainnet = 'shear-v1'/);
    assert.match(dart, /p2p\.shear\.digital:30303/);
    const net = networkOf('mainnet');
    assert.equal(net.magic, 'shear-v1');
  });
});
