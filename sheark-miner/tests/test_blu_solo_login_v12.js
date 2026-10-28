// R28 solo payout (b): ShearK-Miner sends its BluNotes mining address B||Y at
// login only with --solo, so the user's own node can pay an empty round's pot
// to a one-time key of it. A login to a pool (no --solo) never carries it, and
// --solo without --blu is refused before any mining.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeDest } from '../../crypto/address.js';
import { pointBytes } from '../../crypto/note.js';
import { admitBasePub } from '../../crypto/admit.js';
import { scanPub } from '../../crypto/blunote.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const minerDir = path.join(here, '..');

function minerBin() {
  const names = process.platform === 'win32' ? ['ShearK-Miner-2.5.exe', 'ShearK-Miner.exe'] : ['ShearK-Miner'];
  for (const n of names) {
    const p = path.join(minerDir, n);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function ensureMiner() {
  if (minerBin()) return minerBin();
  const built = spawnSync('make', ['-C', minerDir, '-j', String(os.availableParallelism?.() || 1)], { encoding: 'utf8', timeout: 540_000 });
  const bin = minerBin();
  assert.ok(bin, `ShearK-Miner build failed: ${(built.stderr || built.stdout || '').slice(-1500)}`);
  return bin;
}

function miningAddress() {
  const seed = randomBytes(32);
  return Buffer.concat([Buffer.from(pointBytes(admitBasePub(seed))), Buffer.from(scanPub(seed))]).toString('hex');
}

/** The first line the miner sends to a stratum listener, as parsed JSON. */
async function firstLogin(bin, args) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const got = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no login line')), 120_000);
    server.on('connection', (sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        const i = buf.indexOf('\n');
        if (i < 0) return;
        clearTimeout(t);
        resolve(JSON.parse(buf.slice(0, i)));
        sock.destroy();
      });
    });
  });
  const child = spawn(bin, ['--backend', 'interpreter', '--pool', `127.0.0.1:${port}`, '--notls', '--threads', '1', ...args], { stdio: 'ignore' });
  try {
    return await got;
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await new Promise((r) => (child.exitCode != null ? r() : child.once('close', r)));
    server.close();
  }
}

describe('ShearK-Miner --solo login (R28 option (b))', { timeout: 900_000 }, () => {
  const dest = encodeDest(Buffer.alloc(20, 5));

  it('--solo sends the mining address; a pool login never does', async () => {
    const bin = ensureMiner();
    const addr = miningAddress();
    const solo = await firstLogin(bin, ['--user', `${dest}.solo`, '--blu', addr, '--solo']);
    assert.equal(solo.method, 'login');
    assert.equal(solo.params.bluAddr, addr);
    const pooled = await firstLogin(bin, ['--user', `${dest}.rig`, '--blu', addr]);
    assert.equal(pooled.method, 'login');
    assert.equal(pooled.params.bluAddr, undefined);
    assert.doesNotMatch(JSON.stringify(pooled), new RegExp(addr.slice(0, 32)));
  });

  it('--solo without --blu is refused before mining', () => {
    const bin = ensureMiner();
    const run = spawnSync(bin, ['--pool', '127.0.0.1:1', '--notls', '--user', `${dest}.solo`, '--solo'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--solo needs --blu/);
  });
});
