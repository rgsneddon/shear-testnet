import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { defaultDataDir, printConfig } from '../src/node.js';
import { NODE_DISPLAY, NODE_DISPLAY_PREV } from '../src/product.js';
import { printHelp } from '../src/help.js';
import {
  MAGIC_TESTNET, MAGIC_TESTNET_V11, MAGIC_TESTNET_V12,
  PRODUCT_VERSION, consensusFingerprint,
} from '../../crypto/asert.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

describe('v12 book pin and Sentinel v19 display', () => {
  it('pins live magic and v19 display, and keeps the testnet-v11 datadir folder', () => {
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v12');
    assert.equal(MAGIC_TESTNET, MAGIC_TESTNET_V12);
    assert.equal(MAGIC_TESTNET_V11, 'shear-testnet-v11');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V11);
    assert.equal(PRODUCT_VERSION, '19.0');
    assert.equal(NODE_DISPLAY, 'Shear Sentinel v19');
    assert.equal(NODE_DISPLAY_PREV, 'Shear Sentinel v18');
    const cfg = printConfig();
    assert.equal(cfg.magic, MAGIC_TESTNET);
    assert.equal(cfg.version, PRODUCT_VERSION);
    assert.equal(cfg.display, NODE_DISPLAY);
    assert.equal(cfg.admit, 'ADMITv2');

    const ident = read('wallet/lib/shear_identity.dart');
    assert.match(ident, /const kBookMagic = 'shear-testnet-v12'/);

    const win = defaultDataDir({
      env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
      homedir: 'C:\\Users\\x', platform: 'win32', exists: () => false,
    });
    assert.equal(win, path.join('C:\\Users\\x\\AppData\\Roaming', 'Shear', 'testnet-v11'));
    const posix = defaultDataDir({
      env: {}, homedir: '/home/x', platform: 'linux', exists: () => false,
    });
    assert.equal(posix, path.join('/home/x', '.shear', 'testnet-v11'));
    assert.equal(defaultDataDir({
      env: { SHEAR_DATA: 'D:\\kept' }, platform: 'win32', homedir: 'C:\\Users\\x',
    }), 'D:\\kept');

    const closure = read('wallet/lib/shear_closure.dart');
    const bookDir = closure.slice(
      closure.indexOf('String defaultShearBookDir()'),
      closure.indexOf('String closureNodeDataDir('),
    );
    assert.match(bookDir, /testnet-v11/);
    assert.doesNotMatch(bookDir, /testnet-v12/);

    const help = printHelp();
    assert.match(help, /Shear Sentinel v19/);
    assert.match(help, /Continuum 0\.72/);
    assert.match(help, /Book magic: shear-testnet-v12/);
    assert.match(help, /testnet-v11/);
    assert.match(help, /ShearK-Miner 2\.9/);

    const readme = read('README.md');
    assert.match(readme, /Shear Sentinel v19/);
    assert.match(readme, /\(product 19\.0\)/);
    assert.match(readme, /Wallet pin: \*\*0\.72\*\*/);
    assert.match(readme, /"version":"19\.0"/);
    assert.match(readme, /"magic":"shear-testnet-v12"/);
    assert.match(readme, /SHEAR_NETWORK=shear-testnet-v11/);
    assert.match(readme, /\/var\/lib\/shear\/testnet-v11/);
    assert.match(readme, /releases\/tag\/v18/);
    assert.doesNotMatch(readme, /releases\/tag\/v19/);

    const fp = consensusFingerprint();
    assert.match(fp, /NETWORK=shear-testnet-v12/);
    assert.doesNotMatch(fp, /NETWORK=shear-testnet-v11/);
    assert.doesNotMatch(fp, /fcmp/i);
    assert.match(fp, /ADMIT=ADMITv3/);

    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pin-v11-'));
    fs.writeFileSync(path.join(foreign, 'book.magic'), MAGIC_TESTNET_V11);
    assert.throws(() => createStore(foreign), /datadir_magic:shear-testnet-v11/);
    const named = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pin-v12-'));
    fs.writeFileSync(path.join(named, 'book.magic'), MAGIC_TESTNET);
    const ok = createStore(named);
    assert.equal(ok.tip(), null);

    for (const rel of ['node/pack/shear-node.cmd', 'node/pack/shear-node.bat', 'node/pack/shear-node.sh']) {
      const text = read(rel);
      assert.match(text, /Shear Sentinel v19/);
      assert.match(text, /testnet-v11/);
      assert.match(text, /shear-testnet-v11/);
      assert.doesNotMatch(text, /testnet-v12/);
    }
  });
});
