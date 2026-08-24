import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printConfig } from '../src/node.js';
import { createStore } from '../src/store.js';
import { extraMintAllowed } from '../../crypto/asert.js';
import { parseVorticeKey, verifyVorticeDownload } from '../../crypto/vortex.js';
import { handleWalletApi } from '../../pool/src/wallet_api.js';

const ORIGIN = 'https://dapp.example/stake-pool-a.json';
const SOURCE = '{"v":1,"id":"stake-pool-a","pane":"Stake Pool A"}';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vortice-'));
}

describe('node vortice mint', () => {
  it('printConfig names vort1. keys and refuses third-party mint', () => {
    const c = printConfig();
    assert.equal(c.vorticeKeyPrefix, 'vort1.');
    assert.equal(c.vorticeCreatorsHostOwnDapps, true);
    assert.equal(c.extraMintThirdParty, false);
  });

  it('lets a creator mint a deploy key; users fetch the origin named in the key', () => {
    const store = createStore(tmp());
    const minted = store.mintVorticeDeployKey({
      programId: 'stake-pool-a',
      name: 'Stake Pool A',
      origin: ORIGIN,
      source: SOURCE,
    });
    assert.equal(minted.ok, true);
    assert.ok(minted.key.startsWith('vort1.'));
    assert.equal(minted.origin, ORIGIN);
    assert.equal(minted.id, 'stake-pool-a');
    assert.equal(extraMintAllowed(minted.id), false);
    const parsed = parseVorticeKey(minted.key);
    assert.equal(parsed.origin, ORIGIN);
    const hint = store.lookupVorticeKey(minted.key);
    assert.equal(hint.ok, true);
    assert.equal(hint.origin, ORIGIN);
    assert.equal(hint.mintedHere, true);
    assert.equal(hint.source, undefined);
    assert.equal(verifyVorticeDownload(minted.key, SOURCE).ok, true);

    const dup = store.mintVorticeDeployKey({
      programId: 'stake-pool-a',
      name: 'Stake Pool A',
      origin: 'https://other.example/a.json',
      source: SOURCE,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, 'already_minted');

    const pinned = store.mintVorticeDeployKey({
      programId: 'shear-reserve-v1',
      origin: ORIGIN,
      source: SOURCE,
    });
    assert.equal(pinned.ok, false);

    const again = createStore(store.dir);
    assert.equal(again.lookupVorticeKey(minted.key).origin, ORIGIN);
  });

  it('mintFromOrigin pins the bytes the creator host returns', async () => {
    const store = createStore(tmp());
    const minted = await store.mintVorticeFromOrigin(
      { programId: 'hosted-a', name: 'Hosted A', origin: ORIGIN },
      async () => ({ ok: true, text: async () => SOURCE }),
    );
    assert.equal(minted.ok, true);
    assert.equal(verifyVorticeDownload(minted.key, SOURCE).ok, true);
    assert.equal(verifyVorticeDownload(minted.key, 'nope').ok, false);
  });

  it('pool mint route returns the deploy key and does not store the dapp body', () => {
    const store = createStore(tmp());
    const url = new URL('http://127.0.0.1/api/vortex/mint');
    const out = handleWalletApi(url, 'POST', {
      programId: 'stake-pool-a',
      name: 'Stake Pool A',
      origin: ORIGIN,
      source: SOURCE,
    }, { store, miners: new Map(), queueSend: () => ({}) });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.ok(out.json.key.startsWith('vort1.'));
    const dump = fs.readFileSync(path.join(store.dir, 'vortice.json'), 'utf8');
    assert.equal(dump.includes(SOURCE), false);
    assert.equal(dump.includes(ORIGIN), true);
  });
});
