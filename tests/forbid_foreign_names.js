import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HRP_DEST, encodeDest, encodeHrp, encodeAddress, isDestAddress, isShearAddress } from '../crypto/address.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN = [
  'GNFP',
  'gnfp',
  'GNFPHash',
  'Bitcoin',
  'bitcoin',
  'Ethereum',
  'ethereum',
  'Monero',
  'BeamHash',
  'restoreprivacy',
];

describe('foreign names', () => {
  it('are absent from shipped Shear artifacts', () => {
    const hits = [];
    for (const word of FORBIDDEN) {
      const r = spawnSync(
        'grep',
        ['-RIn', '--exclude-dir=.git', '--exclude-dir=node_modules', '-E', word, '.'],
        { cwd: root, encoding: 'utf8' },
      );
      const lines = (r.stdout || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !l.includes('forbid_foreign_names.js'))
        .filter((l) => !l.includes('SHEPLAN.md'))
        .filter((l) => !l.includes('/tests/'))
        .filter((l) => !l.includes('specs/'));
      for (const l of lines) hits.push(l);
    }
    assert.deepEqual(hits, []);
  });
});

describe('dest HRP pin', () => {
  it('issued dest is sdcard1 or she1; dest-check accepts both; shear1 is rest-frame', () => {
    const dest = encodeDest(Buffer.alloc(20, 7));
    assert.equal(dest.startsWith('she1'), true);
    assert.equal(dest.startsWith('shear1'), false);
    assert.equal(isDestAddress(dest), true);
    assert.equal(isShearAddress(dest), false);
    const she = encodeHrp('she', Buffer.alloc(20, 7));
    assert.equal(she.startsWith('she1'), true);
    assert.equal(she.startsWith('shear1'), false);
    assert.equal(isDestAddress(she), true);
    assert.equal(isShearAddress(she), false);
    const sd = encodeHrp('sdcard', Buffer.alloc(20, 7));
    assert.equal(isDestAddress(sd), true);
    const rest = encodeAddress(Buffer.alloc(20, 7));
    assert.equal(rest.startsWith('shear1'), true);
    assert.equal(isDestAddress(rest), false);
    assert.equal(isShearAddress(rest), true);
    assert.equal(HRP_DEST, 'she');
    const dart = fs.readFileSync(path.join(root, 'wallet/lib/shear_identity.dart'), 'utf8');
    assert.match(dart, /destHrp = 'she'/);
    assert.match(dart, /she1/);
    const miner = fs.readFileSync(path.join(root, 'miner/src/shear_miner.c'), 'utf8');
    assert.match(miner, /sdcard1/);
    assert.match(miner, /she1/);
    assert.equal(/--user shear1/.test(miner), false);
    const html = fs.readFileSync(path.join(root, 'pool/public/index.html'), 'utf8');
    assert.match(html, /sdcard1/);
    assert.match(html, /she1/);
    assert.match(html, /sdcard1\|she1/);
    assert.equal(/--user shear1/.test(html), false);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(readme, /--user she1/);
    assert.match(readme, /sdcard1/);
    assert.equal(/--user shear1/.test(readme), false);
    const wallet = fs.readFileSync(path.join(root, 'wallet/lib/main.dart'), 'utf8');
    assert.match(wallet, /sdcard1/);
    assert.match(wallet, /she1/);
  });
});
