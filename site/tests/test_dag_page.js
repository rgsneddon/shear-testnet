import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blueShareModel, orbitWorkers, shareUnit } from '../dag/blue_shares.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, '../dag/index.html'), 'utf8');

function navLabels(html) {
  return [...html.matchAll(/<a class="nav-btn"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
}

describe('dag.shear.digital page', () => {
  it('is SaaS dark, states the blue-set mint, and lists DAG in the navbar', () => {
    assert.match(page, /data-theme="dark"/);
    assert.match(page, /Domain=\.shear\.digital/);
    assert.match(page, /saas-dark\.css/);
    assert.match(page, /background:#07090c/);
    assert.doesNotMatch(page, /#eef3f8/);
    assert.match(page, /DINS-DAG/);
    assert.match(page, /blue set, sorted by identity/);
    assert.match(page, /not paid a second time/);
    assert.match(page, /Continuum 0\.54/);
    assert.match(page, /ShearK 2\.6/);
    assert.match(page, /shear-testnet-v5/);
    assert.match(page, /DAG is a link in the client navbar/);
    assert.match(page, /href="https:\/\/dag\.shear\.digital\/"/);
    assert.match(page, /href="https:\/\/vortices\.shear\.digital\/"/);
    assert.doesNotMatch(page, /not a button in the client navbar/);
    assert.match(page, /docs\/#\/dins-dag/);
    assert.match(page, /id="dag"/);
    assert.match(page, /https:\/\/explorer\.shear\.digital\/api\/stats/);
    assert.match(page, /Math\.log\(1 \+ n\)/);
    assert.match(page, /function headerTipMs\(hex\)/);
    assert.match(page, /nodesOnline/);
    assert.match(page, /r = ln\(1 \+ n\)/);
    assert.match(page, /from '\.\/blue_shares\.js'/);
    assert.match(page, /blueShareModel\(stats\.workers, stats\.shareBits\)/);
    assert.match(page, /orbitWorkers\(stats\.workers\)/);
    assert.match(page, /id="f-blue"/);
    assert.match(page, /#3d7bff/);
    assert.match(page, /blue shares/);
    assert.match(page, /function diamond\(/);
    assert.match(page, /setInterval\(poll, 2000\)/);
    assert.doesNotMatch(page, /\/api\/mempool/);
    assert.doesNotMatch(page, /lastFoundAt/);
    assert.doesNotMatch(page, /demoData/);
    assert.doesNotMatch(page, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    assert.doesNotMatch(page, /GHOSTDAG/);
    assert.doesNotMatch(page, /GH\/s|sol\/s|hashes per second/i);
    const labels = navLabels(page);
    assert.deepEqual(labels, ['MAIN', 'POOL', 'EXPLORER', 'MEMPOOL', 'DAG', 'MINER', 'NODE', 'WALLET', 'VORTICES', 'DOCS']);
  });
});

describe('open-round blue shares', () => {
  it('counts proven hashes at the published share bits, sorted by identity', () => {
    assert.equal(shareUnit(8), 256);
    assert.equal(shareUnit(0), 0);
    const live = blueShareModel(
      [{ miner: 'me41cc324', worker: 'solo', connected: true, accepted: 69, stale: 1, roundHashes: 3072 }],
      8,
    );
    assert.equal(live.total, 12);
    assert.equal(live.identities, 1);
    assert.equal(live.glyphs.length, 12);
    assert.equal(live.glyphs[0].identity, 'me41cc324');
    assert.equal(live.glyphs[11].ord, 11);

    const skipped = blueShareModel(
      [{ miner: 'mold', connected: true, accepted: 69, stale: 4, roundHashes: 0 }],
      8,
    );
    assert.equal(skipped.total, 0);
    assert.equal(skipped.glyphs.length, 0);

    const ordered = blueShareModel(
      [
        { miner: 'm2', roundHashes: 512 },
        { miner: 'm1', roundHashes: 256 },
      ],
      8,
    );
    assert.equal(ordered.total, 3);
    assert.deepEqual(ordered.glyphs.map((g) => g.identity), ['m1', 'm2', 'm2']);

    const grew = blueShareModel(
      [{ miner: 'me41cc324', roundHashes: 3328 }],
      8,
    );
    assert.equal(grew.total, 13);

    const orbit = orbitWorkers([
      { miner: 'm2', connected: true, roundHashes: 0 },
      { miner: 'm1', connected: true, roundHashes: 256 },
      { miner: 'm0', connected: false, roundHashes: 512 },
    ]);
    assert.deepEqual(orbit, [
      { identity: 'm1', blue: true },
      { identity: 'm2', blue: false },
    ]);
  });
});
