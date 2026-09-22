import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeDest } from '../../crypto/address.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function killChild(child) {
  if (!child || child.exitCode != null) return;
  try { child.kill(); } catch { /* ignore */ }
  if (child.pid && process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function childEnv(extra) {
  const env = { ...process.env };
  for (const key of ['SHEAR_MAINNET_EMIT', 'SHEAR_MAINNET_EMIT_CONFIRM', 'SHEAR_DATA', 'SHEAR_SEEDS']) {
    delete env[key];
  }
  env.SHEAR_NETWORK = 'shear-testnet-v4';
  return { ...env, ...extra };
}

async function launchSolo() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-entry-'));
  const stratumPort = await freePort();
  const env = childEnv({
    SHEAR_DATA: dataDir,
    SHEAR_P2P_PORT: '0',
    SHEAR_P2P_BIND: '127.0.0.1',
    SHEAR_RPC_PORT: '0',
    SHEAR_RPC_BIND: '127.0.0.1',
    SHEAR_STRATUM: String(stratumPort),
    SHEAR_STRATUM_BIND: '127.0.0.1',
    SHEAR_SEEDS: '',
  });
  const child = spawn(process.execPath, ['node/src/node.js', '--solo'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
  const boot = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child);
      reject(new Error(`solo boot timeout\n${out}\n${err}`));
    }, 40_000);
    const check = () => {
      if (settled) return;
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.event === 'boot' && msg.ok && msg.solo) {
            settled = true;
            clearTimeout(timer);
            resolve(msg);
          }
        } catch { /* next line */ }
      }
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`solo exit ${code}\n${out}\n${err}`));
    });
  });
  return { child, boot, dataDir, stratumPort, stderr: () => err };
}

function login(port, dest) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('login timeout'));
    }, 10_000);
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once('connect', () => {
      sock.write(`${JSON.stringify({
        id: 1,
        method: 'login',
        params: { login: `${dest}.solo`, threads: 1 },
      })}\n`);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      const line = buf.slice(0, idx).trim();
      sock.destroy();
      resolve(line);
    });
  });
}

describe('solo entry launch', { concurrency: 1, timeout: 120_000 }, () => {
  it('shared node --solo accepts a localhost login and returns a job twice', async () => {
    const dest = encodeDest(Buffer.alloc(20, 5));
    for (let i = 0; i < 2; i += 1) {
      const launched = await launchSolo();
      try {
        assert.equal(launched.boot.solo, true);
        assert.match(String(launched.boot.stratum), /127\.0\.0\.1:\d+/);
        assert.equal(launched.child.exitCode, null);
        const line = await login(launched.stratumPort, dest);
        const msg = JSON.parse(line);
        assert.equal(msg.result?.status, 'OK');
        assert.ok(msg.job?.jobId, line);
        assert.equal(launched.child.exitCode, null);
      } finally {
        killChild(launched.child);
      }
    }
  });
});
