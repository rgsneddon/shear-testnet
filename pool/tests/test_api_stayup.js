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
    const poolNgx = fs.readFileSync(path.join(root, 'deploy/nginx-pool.shear.digital.conf'), 'utf8');
    assert.match(poolNgx, /location ~\* \^\/miner\/\(she1\|shear1\)/);
    assert.match(poolNgx, /access_log off;/);
    assert.match(poolNgx, /location = \/fingerprint/);
    const poolUnit = fs.readFileSync(path.join(root, 'deploy/shear-pool.service'), 'utf8');
    assert.match(poolUnit, /SHEAR_DATA=\/var\/lib\/shear\/testnet-v4/);
    assert.doesNotMatch(poolUnit, /testnet-v4-pool/);
    assert.match(poolUnit, /p2p\.shear\.digital:30303/);
    assert.match(poolUnit, /r2r\.shear\.digital:30303/);
    assert.match(poolUnit, /b2b\.shear\.digital:30303/);
    assert.doesNotMatch(poolUnit, /77\.42\.91\.84/);
    assert.doesNotMatch(poolUnit, /157\.180\.70\.110/);
    assert.doesNotMatch(poolUnit, /2\.28\.8\.89/);
    assert.doesNotMatch(poolUnit, /178\.156\.222\.223/);
    const p2pNgx = fs.readFileSync(path.join(root, 'deploy/nginx-p2p.shear.digital.conf'), 'utf8');
    const r2rNgx = fs.readFileSync(path.join(root, 'deploy/nginx-r2r.shear.digital.conf'), 'utf8');
    const b2bNgx = fs.readFileSync(path.join(root, 'deploy/nginx-b2b.shear.digital.conf'), 'utf8');
    assert.match(p2pNgx, /server_name p2p\.shear\.digital;/);
    assert.match(r2rNgx, /server_name r2r\.shear\.digital;/);
    assert.match(b2bNgx, /server_name b2b\.shear\.digital;/);
    assert.doesNotMatch(p2pNgx, /proxy_pass http:\/\/127\.0\.0\.1:8088/);
    assert.doesNotMatch(r2rNgx, /proxy_pass http:\/\/127\.0\.0\.1:8088/);
    assert.doesNotMatch(b2bNgx, /proxy_pass http:\/\/127\.0\.0\.1:8088/);
    assert.doesNotMatch(p2pNgx, /77\.42\.91\.84/);
    assert.doesNotMatch(r2rNgx, /2\.28\.8\.89/);
    assert.doesNotMatch(b2bNgx, /178\.156\.222\.223/);
  });
});
