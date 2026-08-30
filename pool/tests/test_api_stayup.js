import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('pool UI/API cannot vanish on restart', () => {
  it('cgroup-caps the pool so RandomX cannot eat the box', () => {
    const unit = fs.readFileSync(path.join(root, 'deploy/shear-pool.service'), 'utf8');
    assert.match(unit, /MemoryMax=1536M/);
    assert.match(unit, /MemoryHigh=1024M/);
    assert.match(unit, /Restart=always/);
  });

  it('nginx serves last-good /api/stats in 2s if the pool is restarting', () => {
    const cache = fs.readFileSync(path.join(root, 'deploy/nginx-shear-stats-cache.conf'), 'utf8');
    assert.match(cache, /keys_zone=shear_stats/);
    const sites = [
      'deploy/nginx-shear.digital.conf',
      'deploy/nginx-pool.shear.digital.conf',
      'deploy/nginx-explorer.shear.digital.conf',
      'deploy/nginx-mempool.shear.digital.conf',
    ];
    for (const rel of sites) {
      const conf = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.match(conf, /proxy_connect_timeout 1s/, rel);
      assert.match(conf, /proxy_read_timeout 2s/, rel);
      assert.match(conf, /proxy_cache_use_stale/, rel);
    }
  });
});
