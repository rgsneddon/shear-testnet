import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootPoolOperator } from '../src/pool_ident.js';
import { defaultPoolDataDir, legacyPoolDataDir } from '../src/pool_datadir.js';

describe('pool default identity', () => {
  it('refuses a new payout address when the legacy folder still has pool-miner.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-pool-home-'));
    const place = { env: {}, homedir: home, platform: 'linux' };
    const legacy = legacyPoolDataDir(place);
    const fresh = defaultPoolDataDir(place);
    fs.mkdirSync(legacy, { recursive: true });
    const legacyIdent = path.join(legacy, 'pool-miner.json');
    const body = `${JSON.stringify({ dest20: 'ab'.repeat(20) })}\n`;
    fs.writeFileSync(legacyIdent, body);
    assert.throws(() => bootPoolOperator({ dataDir: fresh, env: {}, homedir: home, platform: 'linux' }), (err) => {
      assert.equal(err.code, 'pool_ident_legacy');
      assert.match(err.message, new RegExp(legacyIdent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(err.message, /testnet-v12-pool/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(fresh, 'pool-miner.json')), false);
    assert.equal(fs.existsSync(path.join(fresh, 'pool-spend.seed')), false);
    assert.equal(fs.readFileSync(legacyIdent, 'utf8'), body);

    const tagged = bootPoolOperator({
      dataDir: fresh,
      env: { SHEAR_POOL_MINER: 'ssa1qqqq' },
      homedir: home,
      platform: 'linux',
    });
    assert.equal(tagged.miner, 'ssa1qqqq');
    assert.equal(fs.existsSync(path.join(fresh, 'pool-miner.json')), false);
  });
});
