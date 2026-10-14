import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';
import { MAGIC_TESTNET, SHEARK_MINER_VERSION } from '../../crypto/asert.js';
import { admitClient, gateStratumLogin } from '../src/pool.js';

describe('v12 ShearK admit floor', () => {
  it('refuses every client below the pin and admits the pin and newer', () => {
    const dest = freshStealthDest(newIdentity()).dest;
    const below = ['', '0.9', '1.1', '2'];
    for (let minor = 0; minor <= 8; minor += 1) below.push(`2.${minor}`);
    below.push('2.8.9', 'nope');
    for (const version of below) {
      for (const gate of [admitClient, gateStratumLogin]) {
        const got = gate({ version, login: dest, client: 'ShearHash' });
        assert.equal(got.ok, false, version);
        assert.equal(got.reason, 'miner_version', version);
        assert.match(got.message, new RegExp(`ShearK ${SHEARK_MINER_VERSION}`));
        assert.match(got.message, new RegExp(MAGIC_TESTNET));
        const shown = String(version || '').trim() || 'unversioned';
        assert.ok(got.message.endsWith(`This client is ${shown}.`), `${version} ${got.message}`);
        assert.equal(got.message.includes(dest), false);
      }
    }
    for (const version of [SHEARK_MINER_VERSION, `${SHEARK_MINER_VERSION}.1`, '3.0', '4.2']) {
      const got = admitClient({ version, login: dest, client: 'ShearHash' });
      assert.equal(got.ok, true, `${version} ${got.reason || ''}`);
      assert.equal(got.message, undefined);
    }
  });
});
