// R41 (Russell 28 Oct): rig and device data is shown locally only. This
// captures every byte ShearK sends to a stratum endpoint during a run (login,
// stats, submits) and fails if any rig detail is in it: CPU vendor or model,
// core or thread counts, RAM, OS strings, host name or device type. It also
// checks the local stats against the counters: computed hashes = reported =
// checked + discarded, and the stats hash rate = counted hashes / wall time.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..');
const bin = path.join(dir, process.platform === 'win32' ? 'ShearK-Miner.exe' : 'ShearK-Miner');
const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

async function miningAddress() {
  const { pointBytes } = await import('../../crypto/note.js');
  const { admitBasePub } = await import('../../crypto/admit.js');
  const { scanPub } = await import('../../crypto/blunote.js');
  const seed = randomBytes(32);
  return Buffer.concat([Buffer.from(pointBytes(admitBasePub(seed))), Buffer.from(scanPub(seed))]).toString('hex');
}

/** The rig as the miner itself reports it locally (--rig). */
function rigFacts() {
  const r = spawnSync(bin, ['--rig', '--backend', 'interpreter'], { encoding: 'utf8', timeout: 600_000 });
  assert.equal(r.status, 0, r.stderr);
  const row = (k) => {
    const m = new RegExp(`^\\s+${k}\\s+(.*)$`, 'm').exec(strip(r.stdout));
    return m ? m[1].trim() : '';
  };
  return { out: r.stdout, cpu: row('cpu'), os: row('os'), device: row('device'), cores: row('cores'), memory: row('memory') };
}

describe('no rig data leaves the miner (R41)', { timeout: 900_000 }, () => {
  it('stratum traffic carries no CPU, core/thread counts, RAM, OS, host name or device type', async () => {
    assert.equal(fs.existsSync(bin), true, `missing ${bin}`);
    const facts = rigFacts();
    const header = Buffer.alloc(128);
    header[0] = 1;
    const job = { jobId: 'priv-job', header: header.toString('hex'), shareBits: 4, blockBits: 255, bits: 255 };
    let sent = '';
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        sent += chunk.toString('utf8');
        for (const line of chunk.toString().split('\n')) {
          if (line.includes('"method":"login"')) sock.write(`${JSON.stringify({ id: 1, result: { status: 'OK' }, job })}\n`);
          else if (line.includes('"method":"submit"')) sock.write(`${JSON.stringify({ id: 2, result: { status: 'OK' } })}\n`);
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const statsFile = path.join(os.tmpdir(), `shear-stats-${process.pid}.json`);
    const child = spawn(bin, ['--backend', 'jit', '--pool', `127.0.0.1:${server.address().port}`, '--notls',
      '--user', 'rig1', '--blu', await miningAddress(), '--threads', '2', '--stats-file', statsFile, '--stats-interval', '5'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 25_000));
    child.kill('SIGTERM');
    await new Promise((r) => child.once('close', r));
    server.close();
    assert.match(sent, /"method":"login"/);
    assert.match(sent, /"method":"submit"/, out.slice(-2000));
    const forbidden = [
      ['cpuCores', /cpuCores/i], ['cpuThreads', /cpuThreads/i], ['"threads"', /"threads"\s*:/],
      ['hostname', new RegExp(os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')],
      ['os.release', new RegExp(os.release().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
      ['device type', /"(desktop|laptop|server\/VM|container|phone)"/],
      ['RAM', /mem(Total|Avail)|totalmem|"ram"/i],
      ['os name', /linux|ubuntu|windows|darwin|macos|debian|fedora/i],
    ];
    const cpuModel = facts.cpu.replace(/\s*\(.*$/, '').trim();
    if (cpuModel && cpuModel !== 'unknown unknown') {
      for (const word of cpuModel.split(/\s+/).filter((w) => w.length >= 4 && !/^unknown$/i.test(w))) {
        forbidden.push([`cpu word ${word}`, new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')]);
      }
    }
    const totalMem = String(os.totalmem());
    forbidden.push(['RAM bytes', new RegExp(totalMem)]);
    for (const [label, re] of forbidden) assert.doesNotMatch(sent, re, `${label} reached the pool`);

    // The same run's local stats file: the accounting identity and the rate.
    const st = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
    fs.rmSync(statsFile, { force: true });
    assert.ok(st.hashes.computed > 0, JSON.stringify(st));
    assert.equal(st.hashes.computed, st.hashes.reported);
    assert.equal(st.hashes.computed, st.hashes.checked + st.hashes.discarded);
    const perThread = st.perThread.reduce((n, t) => n + t.hashes, 0);
    assert.equal(perThread, st.hashes.computed);
    // hs900 spans the whole run so far: counted hashes over wall time.
    const wall = st.hashes.computed / st.uptime;
    assert.ok(Math.abs(st.hs900 - wall) / wall < 0.15, `stats ${st.hs900} vs counted ${wall}`);
    assert.match(strip(out), /computed \d+ = reported \d+ = checked \d+ \+ discarded \d+ {2}OK/);
  });

  it('the local banner shows the rig, and --redact masks the host name', () => {
    const facts = rigFacts();
    assert.match(facts.out, /local only/);
    for (const k of ['device', 'os', 'cpu', 'cores', 'caches', 'memory', 'RandomX', 'threads', 'version']) {
      assert.match(strip(facts.out), new RegExp(`^\\s+${k}\\s`, 'm'), k);
    }
    const red = spawnSync(bin, ['--rig', '--redact', '--backend', 'interpreter'], { encoding: 'utf8', timeout: 600_000 });
    assert.equal(red.status, 0);
    if (os.hostname().length >= 3) assert.equal(red.stdout.includes(os.hostname()), false);
  });
});
