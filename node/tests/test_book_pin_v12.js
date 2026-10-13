import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import { defaultDataDir, printConfig } from '../src/node.js';
import { NODE_DISPLAY } from '../src/product.js';
import { printHelp } from '../src/help.js';
import {
  MAGIC_TESTNET,
  MAGIC_TESTNET_V11,
  MAGIC_TESTNET_V12,
  PRODUCT_VERSION,
  consensusFingerprint,
} from '../../crypto/asert.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('v12 live book pin', () => {
  it('wallet, datadir, and node magic are shear-testnet-v12, and a v11 book does not load', () => {
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v12');
    assert.equal(MAGIC_TESTNET, MAGIC_TESTNET_V12);
    assert.equal(MAGIC_TESTNET_V11, 'shear-testnet-v11');
    assert.notEqual(MAGIC_TESTNET, MAGIC_TESTNET_V11);
    assert.equal(PRODUCT_VERSION, '19.0');
    assert.equal(NODE_DISPLAY, 'Shear Sentinel v19');
    const cfg = printConfig();
    assert.equal(cfg.magic, MAGIC_TESTNET);
    assert.equal(cfg.version, PRODUCT_VERSION);
    assert.equal(cfg.display, NODE_DISPLAY);

    const ident = read('wallet/lib/shear_identity.dart');
    assert.match(ident, /const kBookMagic = 'shear-testnet-v12'/);
    const sync = read('wallet/lib/shear_read_sync.dart');
    const retired = sync.slice(sync.indexOf('const retired'), sync.indexOf('for (final name in retired)'));
    assert.match(retired, /'shear-testnet-v11'/);
    assert.match(retired, /'shear-testnet-v10'/);

    const win = defaultDataDir({
      env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
      homedir: 'C:\\Users\\x',
      platform: 'win32',
      exists: () => false,
    });
    assert.equal(win, path.join('C:\\Users\\x\\AppData\\Roaming', 'Shear', 'testnet-v12'));
    const posix = defaultDataDir({
      env: {},
      homedir: '/home/x',
      platform: 'linux',
      exists: () => false,
    });
    assert.equal(posix, path.join('/home/x', '.shear', 'testnet-v12'));
    const forced = defaultDataDir({
      env: { SHEAR_DATA: 'D:\\kept' },
      platform: 'win32',
      homedir: 'C:\\Users\\x',
    });
    assert.equal(forced, 'D:\\kept');

    const closure = read('wallet/lib/shear_closure.dart');
    const bookDir = closure.slice(
      closure.indexOf('String defaultShearBookDir()'),
      closure.indexOf('String closureNodeDataDir('),
    );
    assert.match(bookDir, /testnet-v12/);
    assert.doesNotMatch(bookDir, /testnet-v11/);

    const help = printHelp();
    assert.match(help, /shear-testnet-v12/);
    assert.match(help, /testnet-v12/);
    assert.match(help, /Continuum 0\.72/);
    assert.match(help, /Shear Sentinel v19/);
    assert.doesNotMatch(help, /shear-testnet-v11/);
    assert.doesNotMatch(help, /Continuum 0\.71/);

    const readme = read('README.md');
    assert.match(readme, /SHEAR_NETWORK=shear-testnet-v12/);
    assert.match(readme, /\/var\/lib\/shear\/testnet-v12/);
    assert.match(readme, /"version":"19\.0"/);
    assert.match(readme, /"magic":"shear-testnet-v12"/);
    assert.doesNotMatch(readme, /SHEAR_NETWORK=shear-testnet-v11/);
    assert.doesNotMatch(readme, /\/var\/lib\/shear\/testnet-v11/);

    const fp = consensusFingerprint();
    assert.match(fp, /NETWORK=shear-testnet-v12/);
    assert.doesNotMatch(fp, /NETWORK=shear-testnet-v11/);
    assert.doesNotMatch(fp, /fcmp/i);

    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pin-v11-'));
    fs.writeFileSync(path.join(foreign, 'book.magic'), MAGIC_TESTNET_V11);
    assert.throws(() => createStore(foreign), /datadir_magic:shear-testnet-v11/);

    const named = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pin-v12-'));
    fs.writeFileSync(path.join(named, 'book.magic'), MAGIC_TESTNET);
    const ok = createStore(named);
    assert.equal(ok.tip(), null);

    const launchers = ['node/pack/shear-node.cmd', 'node/pack/shear-node.bat', 'node/pack/shear-node.sh'];
    for (const rel of launchers) {
      const text = read(rel);
      assert.match(text, /testnet-v12/);
      assert.match(text, /shear-testnet-v12/);
      assert.doesNotMatch(text, /testnet-v11/);
      assert.match(text, /Shear Sentinel v19/);
    }
  });
});
