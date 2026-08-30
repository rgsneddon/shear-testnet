import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.platform === 'win32'
  ? path.join(root, 'ShearK-Miner.exe')
  : path.join(root, 'ShearK-Miner');

describe('ShearK-Miner', () => {
  it('selftest and print-config are ShearHash-v2 light', () => {
    assert.equal(fs.existsSync(bin), true, `missing ${bin}`);
    const st = spawnSync(bin, ['--backend', 'interpreter', '--selftest'], { encoding: 'utf8' });
    assert.equal(st.status, 0, st.stderr + st.stdout);
    assert.match(st.stdout, /selftest ok 64d41fa97f5ebea8a7e2a2625b1824467ce9d081bf29b0b2ae0a7fe617599895/);
    assert.match(st.stdout, /k e46e00191cde74015961b7a68274933c680b69f05bdbbad1ef51e75fbc19f389/);
    assert.match(st.stdout, /client=ShearHash/);
    assert.match(st.stdout, /algorithm=ShearHash/);
    assert.match(st.stdout, /personalisation=ShearHash-v2/);
    assert.equal(st.stdout.includes('5d00a24233609829e59d6e83d9fcd2f262c4014e772a23024fd3db4e66ee2066'), false);
    assert.equal(st.stdout.toLowerCase().includes('feeless'), false);
    const cfg = spawnSync(bin, ['--print-config'], { encoding: 'utf8' });
    assert.equal(cfg.status, 0, cfg.stderr);
    const j = JSON.parse(cfg.stdout);
    assert.equal(j.name, 'ShearK-Miner');
    assert.equal(j.client, 'ShearHash');
    assert.equal(j.algorithm, 'ShearHash');
    assert.equal(j.personalisation, 'ShearHash-v2');
    assert.equal(j.version, '1.0');
    assert.equal(j.version.split('.').length, 2);
    assert.equal(j.headerBytes, 128);
    assert.equal(j.magic, 'shear-testnet-v2');
    assert.equal(j.rxMode, 'light');
    assert.equal(j.rxCacheMiB, 128);
    assert.equal(j.feePct, 0);
    assert.equal(j.clientLogin, 'direct');
    assert.equal(j.pool, 'pool.shear.digital:1111');
    assert.equal(j.feeDest, undefined);
    const src = fs.readFileSync(path.join(root, 'src/sheark_miner.c'), 'utf8');
    assert.equal(src.toLowerCase().includes('feeless'), false);
    assert.equal(/g_fee_login/.test(src), false);
    const help = spawnSync(bin, ['--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /ShearK-Miner/);
    assert.match(help.stdout, /ShearHash-v2 light/);
    assert.equal(help.stdout.toLowerCase().includes('feeless'), false);
  });
});
