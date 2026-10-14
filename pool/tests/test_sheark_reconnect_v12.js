import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { freshStealthDest, newIdentity } from '../../crypto/address.js';
import {
  BLOCK_SUBSIDY_NANOS,
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  POOL_FEE_BPS,
  SHARE_FLOOR_BITS,
  SHEARK_MINER_VERSION,
  unpackBits,
} from '../../crypto/asert.js';
import {
  aLeavesFromShares,
  nonceWithShareTarget,
  noteCommitOfShare,
  unitsForShare,
} from '../../crypto/share_batch.js';
import { potSharesFromBatch } from '../../node/src/chain.js';
import {
  admitClient,
  createPool,
  destShareBitsKey,
  loadDestShareBitsMap,
  LOGIN_PER_IP_WINDOW_MS,
  persistDestShareBitsMap,
  rememberDestShareBits,
  SHARE_BITS_FILE,
} from '../src/pool.js';
import {
  destVardiffOnShare,
  mintShareMinBits,
  SHARE_VARDIFF_EASE_MAX,
  SHARE_VARDIFF_RETARGET_MS,
} from '../src/share_vardiff.js';

const CLIENT = 'ShearHash';
const FLOOR = mintShareMinBits();
const BLOCK = GENESIS_BITS_PACKED;

function send(sock, obj) {
  sock.write(`${JSON.stringify(obj)}\n`);
}

function attachLines(sock) {
  let buf = '';
  const q = [];
  const waiters = [];
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let n;
    while ((n = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, n);
      buf = buf.slice(n + 1);
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw);
      if (waiters.length) waiters.shift()(msg);
      else q.push(msg);
    }
  });
  return function readLine(timeoutMs = 8000) {
    if (q.length) return Promise.resolve(q.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('line timeout')), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  };
}

function boot(dir, miner) {
  const pool = createPool({
    dataDir: dir,
    stratumPort: 0,
    httpPort: 0,
    miner,
    shareBits: FLOOR,
    bits: BLOCK,
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('listen timeout')), 20_000);
    const fail = (err) => {
      clearTimeout(t);
      reject(err);
    };
    pool.stratum.once('error', fail);
    pool.httpServer.once('error', fail);
    pool.stratum.listen(0, '127.0.0.1', () => {
      pool.httpServer.listen(0, '127.0.0.1', () => {
        clearTimeout(t);
        resolve(pool);
      });
    });
  });
}

function login(pool, user, version = SHEARK_MINER_VERSION) {
  const sock = net.connect(pool.stratum.address().port, '127.0.0.1');
  const readLine = attachLines(sock);
  send(sock, {
    id: 1,
    method: 'login',
    params: { login: user, client: CLIENT, version, threads: 1 },
  });
  return readLine().then((msg) => ({ sock, msg }));
}

function climbOne(state) {
  const start = Number(state.windowAt);
  const limit = start + SHARE_VARDIFF_RETARGET_MS + 1_000;
  for (let t = start; t <= limit; t += 100) {
    state = destVardiffOnShare({
      state,
      now: t,
      minBits: FLOOR,
      blockBits: BLOCK,
    });
    if (state.stepped) {
      assert.equal(state.move, 'climb');
      assert.equal(state.bits, state.from + 1);
      assert.ok(state.bits > FLOOR);
      return state;
    }
  }
  throw new Error(`climb did not leave ${state.bits}`);
}

function ease(state, gap) {
  const start = Number(state.windowAt);
  let last = state;
  for (let i = 0; i < 16; i += 1) {
    last = destVardiffOnShare({
      state: last,
      now: start + i * gap,
      minBits: FLOOR,
      blockBits: BLOCK,
    });
    if (last.stepped) return last;
  }
  throw new Error(`ease gap ${gap} stayed at ${state.bits}`);
}

function hold(state) {
  const start = Number(state.windowAt);
  const kept = state.bits;
  let last = state;
  for (let i = 0; i < 16; i += 1) {
    last = destVardiffOnShare({
      state: last,
      now: start + i * 2_000,
      minBits: FLOOR,
      blockBits: BLOCK,
    });
    if (last.shares === 0 && last.reason) {
      assert.equal(last.stepped, false);
      assert.equal(last.bits, kept);
      assert.equal(last.reason, 'in_band');
      return last;
    }
  }
  throw new Error('hold window did not finish');
}

/** Dial the shipped vardiff function the way an accept window does. */
function dialFor(mode) {
  let state = { shares: 0, windowAt: 1_000, bits: FLOOR, lastStepAt: 0, suppressClimb: false };
  if (mode === 'climb') return climbOne(state).bits;
  if (mode === 'ease1') {
    for (let i = 0; i < 4; i += 1) state = climbOne(state);
    const from = state.bits;
    state = ease(state, 4_000);
    assert.equal(state.move, 'ease');
    assert.equal(state.movedBits, 1);
    assert.equal(state.bits, from - 1);
    assert.ok(state.bits > FLOOR);
    return state.bits;
  }
  if (mode === 'ease2') {
    for (let i = 0; i < 4; i += 1) state = climbOne(state);
    const from = state.bits;
    state = ease(state, 5_000);
    assert.equal(state.move, 'ease');
    assert.equal(state.movedBits, SHARE_VARDIFF_EASE_MAX);
    assert.equal(state.bits, from - SHARE_VARDIFF_EASE_MAX);
    assert.ok(state.bits > FLOOR);
    return state.bits;
  }
  state = climbOne(state);
  state = climbOne(state);
  return hold(state).bits;
}

async function loginWhenReady(pool, user) {
  let sock;
  let msg;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    ({ sock, msg } = await login(pool, user));
    if (msg.error !== 'busy') return { sock, msg };
    sock.destroy();
    await new Promise((resolve) => setTimeout(resolve, LOGIN_PER_IP_WINDOW_MS + 250));
  }
  return { sock, msg };
}

async function assertCarried(pool, rows) {
  const jobs = [];
  for (const row of rows) {
    for (const worker of ['a', 'b']) {
      const user = `${row.dest}.${worker}`;
      const { sock, msg } = await loginWhenReady(pool, user);
      try {
        assert.equal(msg.error, undefined, JSON.stringify(msg));
        const job = msg.job || msg.result?.job;
        assert.ok(job, `login job missing ${JSON.stringify(msg)}`);
        assert.equal(Number(job.shareBits), row.bits, `${worker} ${row.mode}`);
        assert.notEqual(Number(job.shareBits), FLOOR);
        assert.equal(Number(job.blockBits), BLOCK);
        assert.ok(Number(job.shareBits) <= unpackBits(job.blockBits));
        assert.equal(destShareBitsKey(user), row.dest);
        if (worker === 'a') jobs.push({ dest: row.dest, bits: Number(job.shareBits), job });
      } finally {
        sock.end();
      }
    }
  }
  return jobs;
}

function assertWorkNotCount(rows, feeTo) {
  const widths = new Set(rows.map((row) => row.bits));
  if (rows.length > 1) assert.ok(widths.size >= 2, [...widths].join(','));
  const subsidies = [10_000, 100_000_003, BLOCK_SUBSIDY_NANOS];
  const carries = [0, 17, 50_000];
  for (const copies of [1, 3, 8]) {
    let nonce = 1n;
    const batch = [];
    const stripped = [];
    for (const row of rows) {
      for (let c = 0; c < copies; c += 1) {
        batch.push({
          dest: row.dest,
          nonce: nonceWithShareTarget(nonce, row.bits),
          lz: row.bits,
          shareBits: row.bits,
          proofSlot: 0,
        });
        stripped.push({
          dest: row.dest,
          nonce: nonceWithShareTarget(nonce, SHARE_FLOOR_BITS),
          lz: SHARE_FLOOR_BITS,
        });
        nonce += 1n;
      }
    }
    const leaves = aLeavesFromShares(batch);
    for (const row of rows) {
      const hex = noteCommitOfShare({ dest: row.dest }).toString('hex');
      const leaf = leaves.find((item) => item.noteCommit.toString('hex') === hex);
      assert.ok(leaf, row.dest);
      assert.equal(leaf.count, copies * unitsForShare(row.bits));
      assert.notEqual(leaf.count, copies * unitsForShare(SHARE_FLOOR_BITS));
    }
    for (const subsidy of subsidies) {
      for (const carry of carries) {
        const work = potSharesFromBatch(batch, feeTo, subsidy, carry);
        const counts = potSharesFromBatch(stripped, feeTo, subsidy, carry);
        const rev = potSharesFromBatch([...batch].reverse(), feeTo, subsidy, carry);
        const fee = Math.floor(subsidy * POOL_FEE_BPS / 10000);
        const feePay = work.filter((row) => row.kind === 'pool-fee');
        assert.equal(feePay.reduce((sum, row) => sum + row.nanos, 0), fee);
        assert.ok(feePay.every((row) => row.address === feeTo));
        assert.equal(work.reduce((sum, row) => sum + row.nanos, 0), subsidy + carry);
        for (const row of rows) {
          assert.notEqual(row.dest, feeTo);
          const pay = work.find((item) => item.address === row.dest && item.kind !== 'pool-fee')?.nanos || 0;
          const again = rev.find((item) => item.address === row.dest && item.kind !== 'pool-fee')?.nanos || 0;
          assert.ok(pay > 0, `zero pay bits ${row.bits} subsidy ${subsidy}`);
          assert.equal(again, pay);
        }
        if (rows.length === 1) {
          const pay = work.find((item) => item.address === rows[0].dest)?.nanos || 0;
          assert.equal(pay, subsidy - fee + carry);
        } else {
          const ranked = [...rows].sort((a, b) => a.bits - b.bits);
          const low = ranked[0];
          const high = ranked[ranked.length - 1];
          const lowPay = work.find((item) => item.address === low.dest && item.kind !== 'pool-fee')?.nanos || 0;
          const highPay = work.find((item) => item.address === high.dest && item.kind !== 'pool-fee')?.nanos || 0;
          const lowCount = counts.find((item) => item.address === low.dest && item.kind !== 'pool-fee')?.nanos || 0;
          const highCount = counts.find((item) => item.address === high.dest && item.kind !== 'pool-fee')?.nanos || 0;
          assert.ok(high.bits > low.bits);
          assert.ok(highPay > lowPay, `${high.bits} ${highPay} vs ${low.bits} ${lowPay}`);
          const ratio = unitsForShare(high.bits) / unitsForShare(low.bits);
          assert.ok(highPay / lowPay > ratio / 2, `ratio ${highPay / lowPay} vs ${ratio}`);
          // Equal unit counts. The last noteCommit keeps a remainder under the miner count.
          assert.ok(Math.abs(lowCount - highCount) < rows.length, `count ${lowCount} ${highCount}`);
          assert.ok(highPay - lowPay > Math.abs(highCount - lowCount));
          assert.notEqual(highPay, highCount);
        }
      }
    }
  }
}

describe('v12 ShearK reconnect', () => {
  it('keeps a stepped dest dial across a pool bounce and pays that work', async () => {
    const counts = [1, 3, 8];
    const modes = ['climb', 'ease1', 'ease2', 'hold'];
    for (const n of counts) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-sk-bounce-'));
      const feeTo = freshStealthDest(newIdentity()).dest;
      const book = new Map();
      const rows = [];
      for (let i = 0; i < n; i += 1) {
        const dest = freshStealthDest(newIdentity()).dest;
        const mode = n === 1 ? 'ease2' : modes[i % modes.length];
        const bits = dialFor(mode);
        const adm = admitClient({
          login: `${dest}.a`,
          client: CLIENT,
          version: SHEARK_MINER_VERSION,
        });
        assert.equal(adm.ok, true, adm.reason);
        assert.equal(adm.login, dest);
        rememberDestShareBits(book, adm.login, bits);
        rows.push({ dest, bits, mode });
      }
      persistDestShareBitsMap(dir, book);
      const disk = JSON.parse(fs.readFileSync(path.join(dir, SHARE_BITS_FILE), 'utf8'));
      for (const row of rows) {
        assert.equal(disk[row.dest], row.bits);
        assert.equal(disk[`${row.dest}.a`], undefined);
        assert.equal(loadDestShareBitsMap(dir).get(row.dest), row.bits);
      }
      const first = await boot(dir, feeTo);
      try {
        await assertCarried(first, rows);
        const job = first.issueJob(undefined, { force: true });
        assert.ok(job?.header);
        const opened = first.creditAcceptedShare({
          jobId: job.jobId,
          header: Buffer.from(job.header, 'hex'),
          nonce: nonceWithShareTarget(1n, rows[0].bits).toString(),
          hash: 'pre-bounce',
          dest: rows[0].dest,
          shareBits: rows[0].bits,
          lz: rows[0].bits,
        });
        assert.equal(opened.ok, true, opened.reason);
        assert.ok(first.openShares.length >= 1);
      } finally {
        first.close();
      }
      const second = await boot(dir, feeTo);
      try {
        assert.equal(second.openShares.length, 0);
        assert.equal(second.lag1Shares.length, 0);
        const jobs = await assertCarried(second, rows);
        for (const job of jobs) {
          const row = rows.find((item) => item.dest === job.dest);
          assert.equal(job.bits, row.bits);
        }
        assertWorkNotCount(jobs, feeTo);
      } finally {
        second.close();
      }
    }
  });

  it('refuses an old ShearK on the live socket without the dest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-sk-old-'));
    const dest = freshStealthDest(newIdentity()).dest;
    const pool = await boot(dir, dest);
    const below = ['', '0.9', '1.1', '2'];
    for (let minor = 0; minor <= 8; minor += 1) below.push(`2.${minor}`);
    below.push('2.8.9', 'nope');
    try {
      for (const version of below) {
        const { sock, msg } = await login(pool, `${dest}.old`, version);
        try {
          assert.equal(msg.error, 'miner_version', version);
          assert.match(msg.message, new RegExp(`ShearK ${SHEARK_MINER_VERSION}`));
          assert.match(msg.message, new RegExp(MAGIC_TESTNET));
          const shown = String(version || '').trim() || 'unversioned';
          assert.ok(msg.message.endsWith(`This client is ${shown}.`), msg.message);
          assert.equal(msg.message.includes(dest), false);
        } finally {
          sock.destroy();
        }
      }
    } finally {
      pool.close();
    }
  });
});
