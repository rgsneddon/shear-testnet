import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { encodeDest } from '../../crypto/address.js';
import { createStore } from '../src/store.js';
import { startNode } from '../src/node.js';
import {
  createSoloStratum,
  evaluateSoloSubmit,
  soloShareLogFields,
} from '../src/solo_stratum.js';

function readLines(sock, ms = 500) {
  return new Promise((resolve) => {
    const lines = [];
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        try { lines.push(JSON.parse(raw)); } catch { lines.push({ raw }); }
      }
    };
    sock.on('data', onData);
    setTimeout(() => {
      sock.off('data', onData);
      resolve(lines);
    }, ms);
  });
}

describe('solo stratum bad input', () => {
  it('a null or non-object line errors that socket and the listener stays up', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-null-'));
    const store = createStore(dir);
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1', followPublic: false });
    const bound = await stratum.listen();
    const faults = [];
    const onReject = (err) => faults.push(String(err));
    const onThrow = (err) => faults.push(String(err));
    process.on('unhandledRejection', onReject);
    process.on('uncaughtException', onThrow);
    try {
      const sock = net.connect(bound.port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
      const pending = readLines(sock, 400);
      sock.write('null\n[]\n"x"\n1\ntrue\nnot-json\n');
      const lines = await pending;
      assert.ok(lines.length >= 1, JSON.stringify(lines));
      assert.ok(lines.every((row) => row.error === 'bad_json'), JSON.stringify(lines));
      const again = net.connect(bound.port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        again.once('connect', resolve);
        again.once('error', reject);
      });
      const second = readLines(again, 300);
      again.write('null\n');
      const more = await second;
      assert.equal(more[0]?.error, 'bad_json');
      sock.destroy();
      again.destroy();
      assert.equal(faults.length, 0, faults.join('\n'));
    } finally {
      process.off('unhandledRejection', onReject);
      process.off('uncaughtException', onThrow);
      stratum.close();
    }
  });

  it('a throw inside the data handler closes that socket only', async () => {
    const store = {
      tip: () => ({ height: 0, hash: Buffer.alloc(32) }),
      jobs: new Map(),
      template() { throw new Error('template_boom'); },
      on() { return () => {}; },
    };
    const stratum = createSoloStratum({ store, port: 0, host: '127.0.0.1', followPublic: false });
    const bound = await stratum.listen();
    const faults = [];
    const onThrow = (err) => faults.push(String(err));
    process.on('uncaughtException', onThrow);
    try {
      const dest = encodeDest(Buffer.alloc(20, 7));
      const sock = net.connect(bound.port, '127.0.0.1');
      sock.on('data', () => {});
      sock.on('error', () => {});
      await new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
      const closed = new Promise((resolve) => sock.once('close', () => resolve(true)));
      sock.write(`${JSON.stringify({ id: 1, method: 'login', params: { login: dest } })}\n`);
      const didClose = await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      assert.equal(didClose, true);
      const again = net.connect(bound.port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        again.once('connect', resolve);
        again.once('error', reject);
      });
      again.destroy();
      assert.equal(faults.length, 0, faults.join('\n'));
    } finally {
      process.off('uncaughtException', onThrow);
      stratum.close();
    }
  });

  it('missing hash backend rejects the share as native_missing and --solo refuses boot', async () => {
    const header = Buffer.alloc(128, 3);
    const jobs = new Map([['job-1', { tpl: { header }, job: { bits: 4 }, shareBits: 4 }]]);
    const judged = evaluateSoloSubmit({
      store: { jobs },
      jobId: 'job-1',
      nonce: 1,
      dest: '',
      hashKind: '',
    });
    assert.equal(judged.ok, false);
    assert.equal(judged.reason, 'native_missing');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-solo-boot-'));
    await assert.rejects(
      () => startNode({
        dataDir: dir,
        solo: true,
        p2pPort: 0,
        rpcPort: 0,
        seeds: [],
        soloHashOk: () => false,
      }),
      (err) => err?.code === 'native_missing' && /missing/.test(String(err.message)),
    );
  });

  it('solo_share truncates dest and nonce', () => {
    const dest = `ssa1${'a'.repeat(50)}`;
    const nonce = '12345678901234567890';
    const row = soloShareLogFields({ dest, jobId: 'shear-1-2', nonce, hash: 'ab' });
    assert.equal(row.event, 'solo_share');
    assert.equal(row.dest.includes(dest), false);
    assert.equal(row.nonce.includes(nonce), false);
    assert.ok(row.dest.startsWith('ssa1'));
    assert.ok(row.dest.length < dest.length);
    assert.ok(row.nonce.length < nonce.length);
  });
});
