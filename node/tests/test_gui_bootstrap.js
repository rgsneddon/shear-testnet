import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGuiBootstrap } from '../src/node.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function run(args, env = {}) {
  return spawnSync(process.execPath, ['node/src/node.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env },
  });
}

describe('GUI node does not seek a bootstrap', () => {
  it('empty datadir, SHEAR_BOOTSTRAP=1, and a bootstrap URL neither pull nor apply', () => {
    const cases = [
      { emptyDatadir: true, env: {}, argv: ['node', 'node/src/node.js'] },
      { emptyDatadir: false, env: { SHEAR_BOOTSTRAP: '1' }, argv: ['node', 'node/src/node.js'] },
      {
        emptyDatadir: false,
        env: {},
        argv: ['node', 'node/src/node.js', '--bootstrap=https://boot.shear.digital/latest'],
      },
    ];
    for (const c of cases) {
      let pulls = 0;
      let applies = 0;
      const decision = resolveGuiBootstrap({
        argv: c.argv,
        env: c.env,
        emptyDatadir: c.emptyDatadir,
        pullLatest() {
          pulls += 1;
          throw new Error('bootstrap_pulled');
        },
        applyLatest() {
          applies += 1;
          throw new Error('bootstrap_missing');
        },
      });
      assert.equal(pulls, 0);
      assert.equal(applies, 0);
      assert.equal(decision.pull, false);
      assert.equal(decision.apply, false);
      assert.equal(decision.missing, false);
      const saw = decision.triggersIgnored;
      assert.equal(saw.emptyDatadir || saw.env || saw.url, true);
    }
  });

  it('GUI spawn args have no bootstrap URL and local-node copy does not say auto-bootstrap', () => {
    const closure = fs.readFileSync(path.join(root, 'wallet/lib/shear_closure.dart'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'wallet/lib/main.dart'), 'utf8');
    assert.equal(closure.includes('kClosureBootstrap'), false);
    assert.equal(closure.includes('--bootstrap='), false);
    assert.equal(closure.includes('boot.shear.digital'), false);
    assert.match(closure, /kLocalNodeModeCopy =/);
    assert.match(closure, /Syncs from peers/);
    assert.equal(/auto bootstrap/i.test(closure), false);
    assert.equal(/auto bootstrap/i.test(main), false);
    assert.match(main, /kLocalNodeModeCopy/);
    assert.match(main, /kLocalNodeFullModeCopy/);
    assert.match(main, /resistance-node-console-scroll/);
    assert.match(closure, /localNodeMatchesSeeker/);
    assert.match(closure, /!ibd && nodeHeight > 0 && seekerTip > 0 && nodeHeight >= seekerTip/);
  });

  it('help exits without bootstrap_missing or bootstrap_pulled', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-noboot-'));
    const runs = [
      run(['--help'], { SHEAR_DATA: empty, SHEAR_BOOTSTRAP: '1' }),
      run(['help'], { SHEAR_DATA: empty, SHEAR_BOOTSTRAP_URL: 'https://boot.shear.digital/latest' }),
    ];
    for (const r of runs) {
      assert.equal(r.status, 0, r.stderr);
      const text = `${r.stdout}\n${r.stderr}`;
      assert.equal(text.includes('bootstrap_missing'), false);
      assert.equal(text.includes('bootstrap_pulled'), false);
      assert.equal(text.includes('bootstrap_applied'), false);
    }
  });
});
