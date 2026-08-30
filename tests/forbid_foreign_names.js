import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HRP_DEST, encodeDest, encodeHrp, encodeAddress, isDestAddress, isShearAddress, isPaymentCode, newIdentity } from '../crypto/address.js';

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
        .filter((l) => !l.includes('specs/'))
        .filter((l) => !l.includes('crypto/randomx/'))
        .filter((l) => !(l.includes('site/index.html') && /GNFP|gnfp|GNFPHash/.test(word)));
      for (const l of lines) hits.push(l);
    }
    assert.deepEqual(hits, []);
  });
});

describe('dest HRP pin', () => {
  it('issued dest is ssa1; she1 is payment code not dest; shear1 is rest-frame', () => {
    const dest = encodeDest(Buffer.alloc(20, 7));
    assert.equal(dest.startsWith('ssa1'), true);
    assert.equal(dest.startsWith('she1'), false);
    assert.equal(dest.startsWith('shear1'), false);
    assert.equal(isDestAddress(dest), true);
    assert.equal(isShearAddress(dest), false);
    const id = newIdentity();
    assert.equal(isPaymentCode(id.paymentCode), true);
    assert.equal(id.paymentCode.startsWith('she1'), true);
    assert.equal(isDestAddress(id.paymentCode), false);
    const she20 = encodeHrp('she', Buffer.alloc(20, 7));
    assert.equal(isDestAddress(she20), false);
    const rest = encodeAddress(Buffer.alloc(20, 7));
    assert.equal(rest.startsWith('shear1'), true);
    assert.equal(isDestAddress(rest), false);
    assert.equal(isShearAddress(rest), true);
    assert.equal(HRP_DEST, 'ssa');
    const dart = fs.readFileSync(path.join(root, 'wallet/lib/shear_identity.dart'), 'utf8');
    assert.match(dart, /destHrp = 'ssa'/);
    assert.match(dart, /payHrp = 'she'/);
    const miner = fs.readFileSync(path.join(root, 'miner/src/shear_miner.c'), 'utf8');
    assert.match(miner, /ssa1/);
    assert.match(miner, /she1/);
    assert.equal(/--user shear1/.test(miner), false);
    const html = fs.readFileSync(path.join(root, 'pool/public/index.html'), 'utf8');
    assert.match(html, /she is private/);
    assert.match(html, /ssa1|she1/);
    assert.match(html, /she1/);
    assert.equal(/--user shear1/.test(html), false);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(readme, /--user she1/);
    assert.equal(/--user shear1/.test(readme), false);
    const wallet = fs.readFileSync(path.join(root, 'wallet/lib/main.dart'), 'utf8');
    assert.match(wallet, /ssa1/);
    assert.match(wallet, /she1/);
    assert.match(wallet, /she is private/);
  });
});
