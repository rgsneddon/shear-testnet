#!/usr/bin/env node
// R41 stratum bench: ShearK-Miner against a local stratum on 127.0.0.1 only.
//
//   node sheark-miner/bench/stratum_bench.mjs --mode pool|solo|refusals
//        --miner PATH [--secs 300] [--threads N] [--backend jit-full]
//        [--bits 16] [--share-bits 8] [--sample 60] [--out FILE.json]
//
// pool: createPool (a fresh data dir, loopback stratum) and the miner with --blu.
// solo: createSoloStratum on a fresh store, and the miner with --blu --solo.
// refusals: need_key (pool submit without a key), need_blu (solo login
// without bluAddr) and exit 2 (--solo without --blu).
//
// A loopback proxy between the miner and the stratum times each submit to
// its reply (IN_FLIGHT_MAX is 1, so replies come back in order). The miner's
// own counters give H/s; /proc gives its RSS. Nothing leaves the host.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
// --root: the checkout whose pool/node code serves the stratum.
const root = path.resolve(arg('root', path.join(here, '..', '..')));
const flag = (name) => process.argv.includes(`--${name}`);

const mode = arg('mode', 'pool');
const minerBin = path.resolve(arg('miner', path.join(root, 'sheark-miner', process.platform === 'win32' ? 'ShearK-Miner.exe' : 'ShearK-Miner')));
const secs = Number(arg('secs', '300'));
const threads = arg('threads', '');
const backend = arg('backend', 'jit-full');
const bits = Number(arg('bits', '16'));
const shareBits = Number(arg('share-bits', '8'));
const sampleSecs = Number(arg('sample', '60'));
const warmSecs = Number(arg('warm', '30'));
const outFile = arg('out', '');
const restartCheck = flag('restart');
// --miner-args "A B": extra miner flags (e.g. --stats-file PATH --stats-interval 300).
const minerArgs = String(arg('miner-args', '')).split(/\s+/).filter(Boolean);

// A file URL, so a Windows drive path imports too.
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { encodeDest } = await load('crypto/address.js');
const { pointBytes } = await load('crypto/note.js');
const { admitBasePub } = await load('crypto/admit.js');
const { scanPub } = await load('crypto/blunote.js');

function miningAddress() {
  const seed = randomBytes(32);
  return Buffer.concat([Buffer.from(pointBytes(admitBasePub(seed))), Buffer.from(scanPub(seed))]).toString('hex');
}

const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

function rssKb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** Loopback proxy; returns { port, stats, close }. */
async function proxy(upPort) {
  const stats = { submits: 0, ok: 0, stale: 0, rejected: 0, reasons: {}, lat: [], blocks: 0, jobs: 0, loginErr: '' };
  const pending = [];
  const server = net.createServer((down) => {
    const up = net.connect(upPort, '127.0.0.1');
    let dbuf = '';
    let ubuf = '';
    down.on('data', (d) => {
      dbuf += d.toString('utf8');
      let i;
      while ((i = dbuf.indexOf('\n')) >= 0) {
        const ln = dbuf.slice(0, i);
        dbuf = dbuf.slice(i + 1);
        if (/"method":"submit"/.test(ln)) {
          stats.submits += 1;
          pending.push(process.hrtime.bigint());
        }
      }
      up.write(d);
    });
    up.on('data', (d) => {
      ubuf += d.toString('utf8');
      let i;
      while ((i = ubuf.indexOf('\n')) >= 0) {
        const ln = ubuf.slice(0, i);
        ubuf = ubuf.slice(i + 1);
        let j = null;
        try { j = JSON.parse(ln); } catch { continue; }
        if (j?.method === 'job') { stats.jobs += 1; continue; }
        if (j?.id === 1 && j.error) stats.loginErr = String(j.error?.message || j.error);
        if (j?.id !== 2) continue;
        const t = pending.shift();
        if (t && stats.lat.length < 200000) stats.lat.push(Number(process.hrtime.bigint() - t) / 1e6);
        const err = j.error ? String(j.error?.message || j.error) : '';
        if (!err && /ok/i.test(String(j.result?.status || ''))) {
          stats.ok += 1;
          if (j.result?.block === true) stats.blocks += 1;
        } else if (/stale/i.test(err)) {
          stats.stale += 1;
          stats.reasons[err] = (stats.reasons[err] || 0) + 1;
        } else {
          stats.rejected += 1;
          stats.reasons[err || 'unknown'] = (stats.reasons[err || 'unknown'] || 0) + 1;
        }
      }
      down.write(d);
    });
    const end = () => { down.destroy(); up.destroy(); };
    down.on('error', end); up.on('error', end); down.on('close', end); up.on('close', end);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, stats, close: () => server.close() };
}

async function startStratum(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r41-${kind}-`));
  if (kind === 'pool') {
    const { createPool } = await load('pool/src/pool.js');
    const dest = encodeDest(Buffer.alloc(20, 7));
    const pool = createPool({ dataDir: dir, stratumPort: 0, httpPort: 0, tlsPort: 0, stratumBind: '127.0.0.1', miner: dest, shareBits, bits });
    const heard = await pool.listen();
    return { port: heard.stratumPort, close: () => pool.close(), dir };
  }
  const { createStore } = await load('node/src/store.js');
  const { createSoloStratum } = await load('node/src/solo_stratum.js');
  const store = createStore(dir);
  const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1' });
  const bound = await stratum.listen();
  return { port: bound.port, close: () => stratum.close(), dir };
}

function runMiner(port, extra) {
  const args = ['--backend', backend, '--pool', `127.0.0.1:${port}`, '--notls', ...extra, ...minerArgs];
  if (threads) args.push('--threads', threads);
  const child = spawn(minerBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
  child.out = '';
  child.tail = '';
  child.last = null;
  child.status = { hashes: 0, accepted: 0, rejected: 0, dropped: 0, blocks: 0 };
  const onData = (d) => {
    const s = strip(d.toString('utf8'));
    child.tail = (child.tail + s).slice(-20000);
    if (child.out.length < 20000) child.out += s;
    for (const ln of s.split('\n')) {
      const m = /hashes=(\d+) .*accepted=(\d+) rejected=(\d+) submitted=\d+ blocks=(\d+) dropped=(\d+)/.exec(ln);
      if (m) child.status = { hashes: Number(m[1]), accepted: Number(m[2]), rejected: Number(m[3]), blocks: Number(m[4]), dropped: Number(m[5]) };
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.closed = new Promise((r) => child.once('close', (code, sig) => r({ code, sig })));
  return child;
}

async function stopMiner(child, ms = 20000) {
  if (child.exitCode != null) return { code: child.exitCode, ms: 0 };
  const t0 = Date.now();
  child.kill('SIGTERM');
  const res = await Promise.race([child.closed, sleep(ms).then(() => null)]);
  if (!res) {
    child.kill('SIGKILL');
    await child.closed;
    return { code: 'killed', ms: Date.now() - t0 };
  }
  return { code: res.code, sig: res.sig, ms: Date.now() - t0 };
}

async function mine(kind) {
  const strat = await startStratum(kind);
  const px = await proxy(strat.port);
  const blu = miningAddress();
  // R28 option 2: the login is a worker name; the mining address is --blu.
  const extra = ['--user', kind === 'solo' ? 'solo' : 'r41', '--blu', blu];
  if (kind === 'solo') extra.push('--solo');
  const child = runMiner(px.port, extra);
  const t0 = Date.now();
  const samples = [];
  let crashed = null;
  let warmH = null;
  let warmT = null;
  let lastH = 0;
  let lastT = t0;
  while (Date.now() - t0 < secs * 1000) {
    await sleep(Math.min(sampleSecs, 5) * 1000);
    if (child.exitCode != null) { crashed = { code: child.exitCode, tail: child.tail.slice(-3000) }; break; }
    const now = Date.now();
    const el = (now - t0) / 1000;
    if (warmH == null && el >= warmSecs) { warmH = child.status.hashes; warmT = now; lastH = warmH; lastT = now; }
    if (warmH != null && now - lastT >= sampleSecs * 1000) {
      const row = { t: Math.round(el), hs: (child.status.hashes - lastH) / ((now - lastT) / 1000), rssKb: rssKb(child.pid), ok: px.stats.ok, stale: px.stats.stale, rej: px.stats.rejected, blocks: px.stats.blocks, dropped: child.status.dropped };
      samples.push(row);
      // A long soak leaves a trail: one line per sample, and the samples so far on disk.
      console.log(`sample ${JSON.stringify(row)}`);
      if (outFile) {
        try { fs.writeFileSync(`${outFile}.partial`, JSON.stringify({ samples, reasons: px.stats.reasons, lat: { p50: pct(px.stats.lat, 50), p95: pct(px.stats.lat, 95) } })); } catch { /* ignore */ }
      }
      lastH = child.status.hashes;
      lastT = now;
    }
  }
  const endT = Date.now();
  const endH = child.status.hashes;
  let restart = null;
  const stop = await stopMiner(child);
  if (restartCheck && !crashed) {
    const okBefore = px.stats.ok;
    const again = runMiner(px.port, extra);
    const r0 = Date.now();
    while (Date.now() - r0 < 300_000 && px.stats.ok === okBefore && again.exitCode == null) await sleep(500);
    restart = { firstAcceptS: px.stats.ok > okBefore ? (Date.now() - r0) / 1000 : null, exit: again.exitCode };
    restart.stop = await stopMiner(again);
  }
  px.close();
  if (process.env.R41_OLD_CLOSE) strat.close(); else await strat.close();
  const hsList = samples.map((s) => s.hs);
  const mean = hsList.length ? hsList.reduce((a, b) => a + b, 0) / hsList.length : null;
  const sd = hsList.length > 1 ? Math.sqrt(hsList.reduce((a, b) => a + (b - mean) ** 2, 0) / (hsList.length - 1)) : null;
  const st = px.stats;
  const answered = st.ok + st.stale + st.rejected;
  const out = {
    mode: kind, backend, threads: threads || 'auto', secs, bits, shareBits,
    hs: warmH != null ? (endH - warmH) / ((endT - warmT) / 1000) : null,
    hsSampleMean: mean, hsSampleSd: sd, hsSampleMin: hsList.length ? Math.min(...hsList) : null,
    submits: st.submits, accepted: st.ok, stale: st.stale, rejected: st.rejected, reasons: st.reasons,
    acceptRate: answered ? st.ok / answered : null,
    latMsP50: pct(st.lat, 50), latMsP95: pct(st.lat, 95), latMsMax: st.lat.length ? Math.max(...st.lat) : null,
    blocks: st.blocks, jobs: st.jobs, minerDropped: child.status.dropped,
    rssKbFirst: samples[0]?.rssKb ?? null, rssKbLast: samples.at(-1)?.rssKb ?? null,
    rssKbMax: samples.length ? Math.max(...samples.map((s) => s.rssKb || 0)) : null,
    crashed, stop, restart, head: child.out.slice(0, 8000), samples,
  };
  return out;
}

async function refusals() {
  const res = {};
  // 1. need_key. The R28 miner will not start without --blu (exit 2, need_key
  // named in the message), and the pool refuses a submit that carries no
  // one-time key. The second is sent raw, as an old or foreign client would.
  {
    const run = spawnSync(minerBin, ['--pool', '127.0.0.1:1', '--notls', '--user', 'nokey', '--threads', '1'], { encoding: 'utf8', timeout: 60_000 });
    const strat = await startStratum('pool');
    const reply = await new Promise((resolve) => {
      const sock = net.connect(strat.port, '127.0.0.1');
      let buf = '';
      let job = null;
      const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
      const timer = setTimeout(() => done({ error: 'timeout' }), 60_000);
      sock.on('error', (e) => { clearTimeout(timer); done({ error: String(e.message) }); });
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let j = null;
          try { j = JSON.parse(ln); } catch { continue; }
          const jb = j?.params?.header ? j.params : j?.result?.job || j?.job || null;
          if (!job && jb?.jobId) {
            job = jb;
            sock.write(JSON.stringify({ id: 2, method: 'submit', params: { login: 'nokey', name: 'ShearK-Miner', client: 'ShearHash', version: '2.9', algorithm: 'ShearHash', jobId: job.jobId, nonce: '1', hash: 'ab'.repeat(32) } }) + '\n');
          } else if (j?.id === 2) {
            clearTimeout(timer);
            done(j);
          }
        }
      });
      sock.on('connect', () => sock.write(JSON.stringify({ id: 1, method: 'login', params: { login: 'nokey', name: 'ShearK-Miner', client: 'ShearHash', version: '2.9', algorithm: 'ShearHash' } }) + '\n'));
    });
    await strat.close();
    const err = String(reply?.error?.message || reply?.error || '');
    res.need_key = {
      minerExit: run.status, minerSays: run.stderr.trim().split('\n')[0], poolReply: err,
      pass: run.status === 2 && /need_key/.test(run.stderr) && /need_key/.test(err),
    };
  }
  // 2. need_blu: a solo login with no bluAddr (--blu given, --solo absent).
  {
    const strat = await startStratum('solo');
    const px = await proxy(strat.port);
    const child = runMiner(px.port, ['--user', 'solo', '--blu', miningAddress(), '--threads', '1']);
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000 && !/need_blu/.test(child.tail) && !px.stats.loginErr) await sleep(500);
    res.need_blu = { loginErr: px.stats.loginErr, minerSaw: /need_blu/.test(child.tail), accepted: px.stats.ok, pass: (/need_blu/.test(px.stats.loginErr) || /need_blu/.test(child.tail)) && px.stats.ok === 0 };
    await stopMiner(child);
    px.close();
    await strat.close();
  }
  // 3. --solo without --blu exits 2 before mining.
  {
    const run = spawnSync(minerBin, ['--pool', '127.0.0.1:1', '--notls', '--user', 'solo', '--solo'], { encoding: 'utf8', timeout: 60_000 });
    res.solo_no_blu = { status: run.status, stderr: run.stderr.trim(), pass: run.status === 2 && /--solo needs --blu/.test(run.stderr) };
  }
  res.pass = res.need_key.pass && res.need_blu.pass && res.solo_no_blu.pass;
  return res;
}

const result = mode === 'refusals' ? await refusals() : await mine(mode);
result.miner = minerBin;
result.host = os.hostname();
result.at = new Date().toISOString();
const text = JSON.stringify(result, null, 1);
if (outFile) fs.writeFileSync(outFile, text + '\n');
console.log(JSON.stringify({ ...result, samples: undefined, head: undefined }));
process.exit(0);
