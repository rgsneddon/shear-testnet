import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);

function reportLine(text) {
  const line = String(text || '').split(/\r?\n/).find((row) => row.startsWith('RAM_REPORT '));
  assert.ok(line, text);
  return JSON.parse(line.slice('RAM_REPORT '.length));
}

if (process.env.SHEAR_RAM_CHILD === '1') {
  const home = os.homedir();
  const watchFile = path.join(home, 'watch.jsonl');
  const chainPath = path.join(home, 'chain.bin');
  const dataDir = path.join(home, 'book');
  const catDir = path.join(home, 'vortice');
  const publishDir = path.join(home, 'bootstrap-out');
  const direct = path.join(home, 'direct-write');
  const ensured = path.join(home, 'ensure');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(catDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'chain.bin'), Buffer.alloc(0));
  const beforeTmp = new Set(fs.readdirSync(os.tmpdir()));
  try {
    const ram = await import('../src/ram_fs.js');
    if (typeof ram.installRamFs === 'function') ram.installRamFs();
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  const { appendWatch } = await import('../src/watch.js');
  const { bookSealKeyFor } = await import('../src/book_seal_key.js');
  const { writeChainBin } = await import('../../crypto/chainbin.js');
  const { ensureDatadir } = await import('../src/datadir_acl.js');
  const { publishOnce } = await import('../src/publish_bootstrap.js');
  const { createVorticeCatalog } = await import('../src/vortice.js');
  const { resolveGuiBootstrap } = await import('../src/node.js');

  const probes = [];
  function note(name, fn) {
    try {
      const result = fn();
      probes.push({ name, threw: false, result: result && result.ok });
    } catch (err) {
      probes.push({ name, threw: true, message: String(err && err.message) });
    }
  }
  note('home', () => fs.writeFileSync(direct, 'x'));
  note('watch', () => appendWatch(watchFile, { t: 1 }));
  note('seal', () => bookSealKeyFor(dataDir));
  note('chainbin', () => writeChainBin(chainPath, []));
  note('datadir', () => ensureDatadir(ensured));
  note('vortice', () => createVorticeCatalog(catDir).mintVorticeDeployKey({
    programId: 'stake-pool-a',
    name: 'Stake Pool A',
    origin: 'https://dapp.example/stake-pool-a.json',
    source: '{"v":1}',
  }));
  let pub;
  try {
    pub = publishOnce({ dataDir, publishDir });
  } catch (err) {
    pub = { threw: true, reason: String(err && err.message) };
  }
  const pulls = [];
  let boot;
  try {
    boot = await resolveGuiBootstrap({
      argv: [],
      env: { SHEAR_RAM: '1', SHEAR_BOOTSTRAP: '1' },
      emptyDatadir: true,
      pullLatest: async () => {
        pulls.push('pull');
        return home;
      },
      applyLatest: async () => {
        pulls.push('apply');
        return { height: 1 };
      },
    });
  } catch (err) {
    boot = { threw: true, reason: String(err && err.message) };
  }
  const leaks = [];
  for (const file of [
    direct,
    watchFile,
    chainPath,
    ensured,
    path.join(catDir, 'vortice.json'),
    path.join(publishDir, 'latest.json'),
    path.join(home, '.shear'),
  ]) {
    if (fs.existsSync(file)) leaks.push(file);
  }
  const afterTmp = fs.readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('shear-boot-') && !beforeTmp.has(name));
  const writesRefused = probes.every((row) => row.threw && row.message === 'shear_ram');
  const publishRefused = pub && pub.ok === false && pub.reason === 'shear_ram' && afterTmp.length === 0;
  const bootstrapRefused = boot
    && boot.pull === false
    && boot.apply === false
    && boot.reason === 'shear_ram'
    && pulls.length === 0;
  const refused = writesRefused && publishRefused && bootstrapRefused && leaks.length === 0;
  console.log(`RAM_REPORT ${JSON.stringify({
    refused, writesRefused, publishRefused, bootstrapRefused, probes, pub, boot, pulls, leaks, afterTmp,
  })}`);
  process.exit(refused ? 0 : 1);
}

test('SHEAR_RAM throws on every write, including the home directory, and refuses bootstrap publish', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-ram-home-'));
  try {
    const run = spawnSync(process.execPath, [self], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SHEAR_RAM: '1',
        SHEAR_RAM_CHILD: '1',
        SHEAR_SEAL_KEY_DIR: '',
      },
      encoding: 'utf8',
      timeout: 180000,
    });
    const text = `${run.stdout || ''}\n${run.stderr || ''}`;
    assert.equal(run.status, 0, text);
    const report = reportLine(run.stdout);
    assert.equal(report.refused, true);
    assert.deepEqual(report.leaks, []);
    assert.deepEqual(report.pulls, []);
    assert.equal(report.pub.reason, 'shear_ram');
    assert.equal(report.boot.reason, 'shear_ram');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
