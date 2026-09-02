import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printConfig } from '../src/node.js';
import { createStore } from '../src/store.js';
import { JOIN_PROGRAM, JOIN_KIND_GENESIS, extraMintAllowed } from '../../crypto/asert.js';

describe('node Join vault is gone', () => {
  it('printConfig refuses Join genesis extra-mint', () => {
    const c = printConfig();
    assert.equal(c.joinRemoved, undefined);
    assert.equal(c.extraMintJoinGenesis, false);
    assert.equal(c.joinProgram, undefined);
    assert.equal(c.joinWindowDays, undefined);
    assert.equal(c.mainnet, false);
    assert.equal(extraMintAllowed(JOIN_PROGRAM, { kind: JOIN_KIND_GENESIS }), false);
  });

  it('store has no join vault; join-genesis extra-mint is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-join-gone-'));
    const store = createStore(dir);
    assert.equal(store.joinVault, undefined);
    assert.equal(store.saveJoin, undefined);
    const src = fs.readFileSync(new URL('../src/chain.js', import.meta.url), 'utf8');
    assert.match(src, /join_removed/);
    assert.match(src, /JOIN_KIND_GENESIS/);
  });
});
