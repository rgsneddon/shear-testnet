import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { MAGIC_TESTNET, MAGIC_TESTNET_V2 } from '../../crypto/asert.js';

describe('v2 and v3 datadirs refuse each other', () => {
  it('createStore throws datadir_magic on a v2 book.magic file', () => {
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v3');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-v2-'));
    fs.writeFileSync(path.join(dir, 'book.magic'), MAGIC_TESTNET_V2);
    assert.throws(() => createStore(dir), /datadir_magic/);
  });

  it('empty datadir loads as this book', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-v3-'));
    const store = createStore(dir);
    assert.equal(store.tip(), null);
    const again = createStore(dir);
    assert.equal(again.tip(), null);
  });
});
