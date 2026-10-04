import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const boot = fs.readFileSync(path.join(here, '../boot/index.html'), 'utf8');
const node = fs.readFileSync(path.join(here, '../node/index.html'), 'utf8');

function navLabels(html) {
  return [...html.matchAll(/<a class="nav-btn"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
}

describe('boot.shear.digital page', () => {
  it('is SaaS dark with pool-style navbar including DAG and downloadable latest pair', () => {
    assert.match(boot, /data-theme="dark"/);
    assert.match(boot, /Domain=\.shear\.digital/);
    assert.match(boot, /saas-dark\.css/);
    assert.match(boot, /href="\/latest\.json"/);
    assert.match(boot, /href="\/latest\.bin"/);
    assert.match(boot, /id="dl-json"/);
    assert.match(boot, /id="dl-bin"/);
    assert.match(boot, /shear-testnet-v10/);
    assert.match(boot, /Continuum 0\.69/);
    assert.doesNotMatch(boot, /Continuum 0\.66/);
    assert.doesNotMatch(boot, /shear-testnet-v6/);
    assert.doesNotMatch(boot, /testnet-v6/);
    assert.match(boot, /never hooks a bootstrap|do not pull this automatically|does not pull a bootstrap|never pull/i);
    assert.doesNotMatch(boot, /applies the snapshot once; a recorded tip resumes and does not pull/);
    assert.doesNotMatch(boot, /#eef3f8/);
    assert.match(boot, /href="https:\/\/dag\.shear\.digital\/"/);
    assert.match(boot, /href="https:\/\/vortices\.shear\.digital\/"/);
    assert.deepEqual(navLabels(boot), [
      'MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'DAG', 'MINER', 'NODE', 'WALLET', 'VORTICES', 'DOCS',
    ]);
  });
});

describe('shear.digital/node page', () => {
  it('documents sequential blank-to-tip sync, prebuilt zips for every OS, and build-from-source', () => {
    assert.match(node, /data-theme="dark"/);
    assert.match(node, /sequential|height 1, 2, 3/);
    assert.match(node, /ibd=false/);
    assert.match(node, /--solo/);
    assert.doesNotMatch(node, /export SHEAR_BOOTSTRAP=1/);
    assert.match(node, /boot\.shear\.digital/);
    assert.match(node, /Shear Sentinel v17/);
    assert.match(node, /17\.0/);
    assert.match(node, /release <strong>v17<\/strong>/);
    assert.doesNotMatch(node, /release <strong>v16<\/strong>/);
    assert.doesNotMatch(node, /node 10\.0|version":"10\.0"|pin <strong>10\.0/);
    assert.doesNotMatch(node, /Node v6|node 6\.0|shear-node-v6/);
    assert.doesNotMatch(node, /shear-node-v7-/);
    assert.doesNotMatch(node, /shear-node-0\.58-/);
    for (const flavor of ['windows', 'linux', 'archlinux', 'fedora', 'opensuse', 'macos']) {
      assert.match(node, new RegExp(`releases/download/v17/shear-node-v17-${flavor}\\.zip`));
    }
    assert.doesNotMatch(node, /shear-node-v17-macos\.dmg/);
    assert.doesNotMatch(node, /is not attached/);
    assert.doesNotMatch(node, /shear-node-9\.0-/);
    assert.doesNotMatch(node, /No prebuilt node binary on releases/);
    assert.match(node, /cmake -S crypto\/randomx/);
    assert.match(node, /make -C crypto\/native/);
    assert.match(node, /node node\/src\/node\.js/);
  });
});
