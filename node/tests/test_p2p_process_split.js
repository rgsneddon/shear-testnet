import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { encodeWireBlock } from '../src/p2p.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = path.join(root, 'node/tests/fixtures/p2p-wedge-blocks.json');

function killChild(child) {
  if (!child || child.exitCode != null) return;
  try { child.kill(); } catch { /* ignore */ }
  if (child.pid && process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childEnv(extra) {
  const env = { ...process.env };
  for (const key of [
    'SHEAR_MAINNET_EMIT', 'SHEAR_MAINNET_EMIT_CONFIRM', 'SHEAR_P2P_PORT', 'SHEAR_P2P_BIND',
    'SHEAR_SEEDS', 'SHEAR_P2P_IPC', 'SHEAR_DATA', 'SHEAR_HTTP', 'SHEAR_STRATUM',
    'SHEAR_RPC_PORT', 'SHEAR_MODE',
  ]) delete env[key];
  env.SHEAR_NETWORK = 'shear-testnet-v4';
  return { ...env, ...extra };
}

function bootChild(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
  const boot = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`boot timeout\nSTDOUT ${out.slice(-1500)}\nSTDERR ${err.slice(-1500)}`));
    }, 40_000);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const check = () => {
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.event === 'boot' && msg.ok) finish(() => resolve(msg));
        } catch { /* not boot */ }
      }
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => finish(() => reject(new Error(`exit ${code}\n${out}\n${err}`))));
    child.on('error', (e) => finish(() => reject(e)));
  });
  return { child, boot, stderr: () => err, stdout: () => out };
}

function owningPid(port) {
  const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  const text = `${out.stdout || ''}\n${out.stderr || ''}`;
  for (const line of text.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1] || '';
    const got = Number(local.slice(local.lastIndexOf(':') + 1));
    if (got !== port) continue;
    return Number(parts[parts.length - 1]);
  }
  return 0;
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const got = await fn();
    if (got) return got;
    await delay(40);
  }
  throw new Error(label || 'timeout');
}

function jsonEvents(text, event) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.includes(event)) continue;
    const start = line.indexOf('{');
    if (start < 0) continue;
    try {
      const msg = JSON.parse(line.slice(start));
      if (msg.event === event) out.push(msg);
    } catch { /* ignore */ }
  }
  return out;
}

function connectPeer(port, bucket) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const lines = [];
    let buf = '';
    sock.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      bucket.push(text);
      buf += text;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { /* keep raw in bucket */ }
      }
    });
    sock.once('error', reject);
    sock.once('connect', () => resolve({ sock, lines }));
  });
}

async function stats(httpPort) {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/stats`, {
    signal: AbortSignal.timeout(3000),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function assertStats(sample) {
  assert.equal(sample.status, 200);
  assert.equal(sample.body.ok, true);
  assert.equal(Number.isFinite(Number(sample.body.height)), true);
  assert.equal(sample.body.admit, 'ADMITv2');
}

describe('p2p process split', { concurrency: 1, timeout: 400_000 }, () => {
  it('pool unit does not bind :30303 and fleet runs the sidecar', () => {
    const poolUnit = fs.readFileSync(path.join(root, 'deploy/shear-pool.service'), 'utf8');
    const sideUnit = fs.readFileSync(path.join(root, 'deploy/shear-p2p.service'), 'utf8');
    const nodeUnit = fs.readFileSync(path.join(root, 'deploy/shear-node.service'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'pool/src/main.js'), 'utf8');
    const nodeJs = fs.readFileSync(path.join(root, 'node/src/node.js'), 'utf8');
    assert.doesNotMatch(mainJs, /createP2p\s*\(/);
    assert.match(mainJs, /attachPoolIpc\s*\(/);
    assert.match(nodeJs, /startP2pSync/);
    assert.match(nodeJs, /--solo/);
    assert.doesNotMatch(poolUnit, /SHEAR_P2P_PORT=30303/);
    assert.match(poolUnit, /pool\/src\/main\.js/);
    assert.match(sideUnit, /--mode=p2p-sync/);
    assert.match(sideUnit, /SHEAR_P2P_PORT=30303/);
    assert.doesNotMatch(sideUnit, /pool\/src\/main/);
    assert.match(nodeUnit, /--mode=p2p-sync/);
    assert.match(nodeUnit, /SHEAR_P2P_PORT=30303/);
    assert.doesNotMatch(nodeUnit, /pool\/src\/main/);
    assert.doesNotMatch(nodeUnit, /SHEAR_HTTP/);
    assert.doesNotMatch(nodeUnit, /SHEAR_STRATUM/);
    const wire = encodeWireBlock({
      header: Buffer.alloc(128, 1),
      hash: Buffer.alloc(32, 2),
      height: 1,
      txs: [],
      shareBatch: [{ nonce: 1 }],
    });
    assert.equal(JSON.stringify(wire).includes('trustedPowHash'), false);
  });

  it('two process launches: fat shareBatch ingest, stats 200, bad pow, best peer, serve cap', async () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const blocks = fixture.blocks;
    assert.ok((blocks[1].shareBatch || []).length >= 1);
    assert.ok((blocks[2].shareBatch || []).length >= 1);
    const fatBytes = JSON.stringify(blocks[1]) + JSON.stringify(blocks[2]);
    assert.ok(fatBytes.length > 1500, `shareBatch blocks are ${fatBytes.length} bytes`);

    async function once() {
      const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-psplit-pool-'));
      const sideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-psplit-side-'));
      const received = [];
      const peers = [];
      let pool = null;
      let side = null;
      try {
        pool = bootChild(['pool/src/main.js'], childEnv({
          SHEAR_DATA: poolDir,
          SHEAR_HTTP: '0',
          SHEAR_STRATUM: '0',
          SHEAR_STRATUM_BIND: '127.0.0.1',
          SHEAR_P2P_IPC: '127.0.0.1:0',
          SHEAR_SEEDS: '',
        }));
        const poolBoot = await pool.boot;
        assert.equal(poolBoot.role, 'pool');
        assert.equal(poolBoot.p2p, 0);
        assert.equal(poolBoot.admit, 'ADMITv2');
        assert.ok(poolBoot.http > 0);
        assert.ok(poolBoot.ipc > 0);

        side = bootChild(['node/src/node.js', '--mode=p2p-sync'], childEnv({
          SHEAR_DATA: sideDir,
          SHEAR_P2P_PORT: '0',
          SHEAR_P2P_BIND: '127.0.0.1',
          SHEAR_P2P_IPC: `127.0.0.1:${poolBoot.ipc}`,
          SHEAR_SEEDS: '',
          SHEAR_RPC_PORT: '0',
          SHEAR_RPC_BIND: '127.0.0.1',
        }));
        const sideBoot = await side.boot;
        assert.equal(sideBoot.role, 'sidecar');
        assert.equal(sideBoot.mode, 'p2p-sync');
        assert.equal(sideBoot.solo, false);
        assert.equal(sideBoot.stratum, null);
        assert.ok(sideBoot.p2p > 0);
        assert.notEqual(sideBoot.p2p, poolBoot.http);

        await waitFor(() => side.stderr().includes('"event":"ipc_up"') && pool.stderr().includes('"event":"ipc_up"'), 10_000, `ipc did not come up\n${pool.stderr()}\n${side.stderr()}`);
        const p2pOwner = owningPid(sideBoot.p2p);
        assert.equal(p2pOwner, side.child.pid, `p2p port ${sideBoot.p2p} owner ${p2pOwner} sidecar ${side.child.pid} pool ${pool.child.pid}`);
        assert.notEqual(owningPid(sideBoot.p2p), pool.child.pid);
        assert.equal(owningPid(poolBoot.http), pool.child.pid);

        const feeder = await connectPeer(sideBoot.p2p, received);
        peers.push(feeder);
        await waitFor(() => feeder.lines.filter((m) => m.type === 'hello' || m.type === 'tip').length >= 2, 5000, 'sidecar hello');
        const opening = feeder.lines.find((m) => m.type === 'tip');
        assert.ok(opening);
        assert.equal(JSON.stringify(feeder.lines).includes('trustedPowHash'), false);

        const samples = [];
        const payload = [blocks[0], blocks[1], blocks[2]].map((block) => (
          `${JSON.stringify({ type: 'block', magic: MAGIC_TESTNET, block })}\n`
        )).join('');
        assert.equal(payload.includes('trustedPowHash'), false);
        const parent = `${JSON.stringify({ type: 'block', magic: MAGIC_TESTNET, block: blocks[0] })}\n`;
        const fat = payload.slice(parent.length);
        feeder.sock.write(parent);
        await waitFor(async () => {
          const sample = await stats(poolBoot.http);
          samples.push(sample);
          assertStats(sample);
          return Number(sample.body.height) >= 1;
        }, 90_000, `parent block did not apply\n${side.stderr().slice(-2000)}\n${pool.stderr().slice(-2000)}`);

        let sawDuringFat = false;
        const polling = (async () => {
          const deadline = Date.now() + 90_000;
          while (Date.now() < deadline) {
            const sample = await stats(poolBoot.http);
            samples.push(sample);
            assertStats(sample);
            if (Number(sample.body.height) < 3) sawDuringFat = true;
            if (Number(sample.body.height) >= 3) return sample;
            await delay(30);
          }
          throw new Error(`height stuck\n${side.stderr().slice(-2000)}\n${pool.stderr().slice(-1500)}`);
        })();
        feeder.sock.write(fat);
        const done = await polling;
        assert.equal(sawDuringFat, true);
        assert.equal(Number(done.body.height), 3);
        assert.equal(String(done.body.header || '').toLowerCase(), String(blocks[2].header).toLowerCase());
        assert.ok(samples.length >= 2);

        const beforeBad = Number((await stats(poolBoot.http)).body.height);
        const tipDecoded = decodeHeader(Buffer.from(blocks[2].header, 'hex'));
        const badHeader = encodeHeader({
          version: tipDecoded.version,
          prevBlockHash: Buffer.from(blocks[2].hash, 'hex'),
          merkleRoot: tipDecoded.merkleRoot,
          continuityRoot: tipDecoded.continuityRoot,
          timestamp: tipDecoded.timestamp,
          bits: tipDecoded.bits,
          nonce: tipDecoded.nonce + 99n,
          baseFee: tipDecoded.baseFee,
        });
        const bad = JSON.parse(JSON.stringify(blocks[2]));
        bad.header = badHeader.toString('hex');
        bad.hash = 'ff'.repeat(32);
        bad.height = beforeBad + 1;
        const badLine = `${JSON.stringify({ type: 'block', magic: MAGIC_TESTNET, block: bad })}\n`;
        assert.equal(badLine.includes('trustedPowHash'), false);
        const badPeer = await connectPeer(sideBoot.p2p, received);
        peers.push(badPeer);
        await waitFor(() => badPeer.lines.length >= 1, 4000, 'bad-pow peer hello');
        badPeer.sock.write(badLine);
        await waitFor(
          () => jsonEvents(side.stderr(), 'p2p_ingest').some((e) => e.ok === false && e.reason === 'pow'),
          60_000,
          `bad pow not rejected\n${side.stderr().slice(-2500)}`,
        );
        await delay(200);
        const afterBad = await stats(poolBoot.http);
        assertStats(afterBad);
        assert.equal(Number(afterBad.body.height), beforeBad);

        const probe = await connectPeer(sideBoot.p2p, received);
        peers.push(probe);
        await waitFor(() => probe.lines.some((m) => m.type === 'tip'), 4000, 'live tip');
        const liveTip = probe.lines.find((m) => m.type === 'tip');
        const localH = Number(liveTip.height);
        const localWork = liveTip.work || '0x0';
        assert.equal(localH, 3);
        probe.sock.destroy();
        async function announce(height, hash, work) {
          const peer = await connectPeer(sideBoot.p2p, received);
          peers.push(peer);
          await waitFor(() => peer.lines.length >= 2, 4000, 'peer hello');
          const mark = peer.lines.length;
          peer.sock.write(`${JSON.stringify({
            type: 'tip', magic: MAGIC_TESTNET, height, hash, work,
          })}\n`);
          return { peer, mark };
        }

        const same = await announce(localH, 'ab'.repeat(32), localWork);
        await delay(500);
        assert.equal(same.peer.lines.slice(same.mark).some((m) => m.type === 'getheaders'), false);
        same.peer.sock.destroy();

        const taller = await announce(localH + 4, 'cd'.repeat(32), localWork);
        await waitFor(() => taller.peer.lines.slice(taller.mark).some((m) => m.type === 'getheaders'), 4000, 'taller peer was not asked');
        taller.peer.sock.destroy();

        const heavierWork = `0x${(BigInt(localWork) + 1n).toString(16)}`;
        const heavy = await announce(localH, 'ef'.repeat(32), heavierWork);
        await waitFor(() => heavy.peer.lines.slice(heavy.mark).some((m) => m.type === 'getheaders'), 4000, 'heavier work was not asked');
        heavy.peer.sock.destroy();

        const best = await connectPeer(sideBoot.p2p, received);
        const other = await connectPeer(sideBoot.p2p, received);
        peers.push(best, other);
        await waitFor(() => best.lines.length >= 2 && other.lines.length >= 2, 4000, 'pair hello');
        const bestMark = best.lines.length;
        const otherMark = other.lines.length;
        best.sock.write(`${JSON.stringify({
          type: 'tip', magic: MAGIC_TESTNET, height: localH + 10, hash: '11'.repeat(32), work: localWork,
        })}\n`);
        await waitFor(() => best.lines.slice(bestMark).some((m) => m.type === 'getheaders'), 4000, 'best peer headers');
        other.sock.write(`${JSON.stringify({
          type: 'tip', magic: MAGIC_TESTNET, height: localH + 2, hash: '22'.repeat(32), work: localWork,
        })}\n`);
        await delay(400);
        assert.equal(other.lines.slice(otherMark).some((m) => m.type === 'getheaders'), false);
        const missing = 'd'.repeat(64);
        const bestBlocks = best.lines.length;
        const otherBlocks = other.lines.length;
        best.sock.write(`${JSON.stringify({
          type: 'headers', magic: MAGIC_TESTNET, headers: [{ hash: missing, height: localH + 1 }],
        })}\n`);
        other.sock.write(`${JSON.stringify({
          type: 'headers', magic: MAGIC_TESTNET, headers: [{ hash: 'e'.repeat(64), height: localH + 1 }],
        })}\n`);
        await waitFor(() => best.lines.slice(bestBlocks).some((m) => m.type === 'getblock'), 4000, 'best peer blocks');
        await delay(400);
        assert.equal(other.lines.slice(otherBlocks).some((m) => m.type === 'getblock'), false);
        best.sock.destroy();
        other.sock.destroy();

        const ask = await connectPeer(sideBoot.p2p, received);
        peers.push(ask);
        await waitFor(() => ask.lines.length >= 1, 4000, 'serve peer');
        ask.sock.write(`${JSON.stringify({ type: 'getblock', magic: MAGIC_TESTNET, hash: blocks[0].hash })}\n${JSON.stringify({ type: 'getblock', magic: MAGIC_TESTNET, hash: blocks[1].hash })}\n`);
        await waitFor(() => jsonEvents(side.stderr(), 'p2p_getblock_serve').some((e) => e.n <= 1 && e.left >= 1), 8000, `serve cap\n${side.stderr().slice(-1500)}`);

        const wireText = received.join('');
        assert.equal(wireText.includes('trustedPowHash'), false);
        assert.equal(payload.includes('trustedPowHash'), false);
        assert.equal(badLine.includes('trustedPowHash'), false);
      } finally {
        for (const peer of peers) {
          try { peer.sock.destroy(); } catch { /* ignore */ }
        }
        killChild(side?.child);
        killChild(pool?.child);
        await delay(200);
      }
    }

    await once();
    await once();
  });
});
