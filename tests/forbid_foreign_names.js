import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
