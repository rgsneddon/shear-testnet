import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mintVorticeDeployKey,
  mintVorticeDeployKeyFromOrigin,
  issueVorticeKey,
  parseVorticeKey,
  verifyVorticeDownload,
  addVortice,
  validOrigin,
  RESERVE_VORTICE,
  JOIN_VORTICE,
  JOIN_WATCH_PROGRAM,
  VORTICE_KEY_PREFIX,
} from './vortex.js';
import { extraMintAllowed, JOIN_PROGRAM, RESERVE_PROGRAM } from './asert.js';

const ORIGIN = 'https://dapp.example/stake-pool-a.json';
const SOURCE = '{"v":1,"id":"stake-pool-a","pane":"Stake Pool A"}';

describe('vortice deploy keys', () => {
  it('mints vort1. keys that name the creator host and pin the hosted bytes', () => {
    assert.equal(RESERVE_VORTICE.id, RESERVE_PROGRAM);
    assert.equal(JOIN_VORTICE.id, JOIN_PROGRAM);
    assert.equal(mintVorticeDeployKey({ programId: RESERVE_PROGRAM, origin: ORIGIN, source: SOURCE }), null);
    assert.equal(mintVorticeDeployKey({ programId: JOIN_PROGRAM, origin: ORIGIN, source: SOURCE }), null);
    assert.equal(mintVorticeDeployKey({ programId: JOIN_WATCH_PROGRAM, origin: ORIGIN, source: SOURCE }), null);
    assert.equal(mintVorticeDeployKey({ programId: 'stake-pool-a', origin: ORIGIN }), null);
    assert.equal(issueVorticeKey('stake-pool-a'), null);
    assert.equal(validOrigin('javascript:alert(1)'), null);
    const key = mintVorticeDeployKey({
      programId: 'stake-pool-a',
      name: 'Stake Pool A',
      origin: ORIGIN,
      source: SOURCE,
    });
    assert.ok(key.startsWith(VORTICE_KEY_PREFIX));
    const parsed = parseVorticeKey(key);
    assert.equal(parsed.id, 'stake-pool-a');
    assert.equal(parsed.name, 'Stake Pool A');
    assert.equal(parsed.origin, ORIGIN);
    assert.equal(parsed.mint, false);
    assert.equal(extraMintAllowed(parsed.id), false);
    assert.equal(parseVorticeKey('deadbeef.stake-pool-a'), null);
    assert.equal(verifyVorticeDownload(key, SOURCE).ok, true);
    assert.equal(verifyVorticeDownload(key, SOURCE + 'tamper').ok, false);
    assert.equal(verifyVorticeDownload(key, SOURCE).reason, undefined);
    const list = addVortice([], key, SOURCE);
    assert.equal(list.length, 1);
    assert.equal(list[0].origin, ORIGIN);
    assert.equal(addVortice([], key).length, 0);
    assert.equal(addVortice(list, key, SOURCE).length, 1);
  });

  it('mintFromOrigin fetches the creator host and refuses a mismatch later', async () => {
    const key = (await mintVorticeDeployKeyFromOrigin(
      { programId: 'hosted-a', name: 'Hosted A', origin: ORIGIN },
      async () => ({ ok: true, text: async () => SOURCE }),
    )).key;
    const parsed = parseVorticeKey(key);
    assert.equal(parsed.origin, ORIGIN);
    assert.equal(verifyVorticeDownload(key, SOURCE).ok, true);
    assert.equal(verifyVorticeDownload(key, 'other').reason, 'bundle_mismatch');
  });
});
