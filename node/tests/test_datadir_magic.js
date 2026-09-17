import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { MAGIC_TESTNET, MAGIC_TESTNET_V1, MAGIC_TESTNET_V2, MAGIC_TESTNET_V3, MAGIC_TESTNET_V4, MAGIC_MAINNET, LIVE_MIN_BITS, packBits } from '../../crypto/asert.js';
import { encodeDest } from '../../crypto/address.js';
import { mineTemplate } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';

describe('v3 and v4 datadirs refuse each other', () => {
  it('createStore throws datadir_magic on a v2 book.magic file', () => {
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v4');
    assert.equal(MAGIC_TESTNET_V4, 'shear-testnet-v4');
    assert.notEqual(MAGIC_TESTNET_V2, MAGIC_TESTNET);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-v2-'));
    fs.writeFileSync(path.join(dir, 'book.magic'), MAGIC_TESTNET_V2);
    assert.throws(() => createStore(dir), /datadir_magic:shear-testnet-v2/);
  });

  it('createStore throws datadir_magic on a v1 book.magic file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-v1-'));
    fs.writeFileSync(path.join(dir, 'book.magic'), MAGIC_TESTNET_V1);
    assert.throws(() => createStore(dir), /datadir_magic:shear-testnet-v1/);
  });

  it('createStore throws datadir_magic on a v3 book.magic file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-v3-'));
    fs.writeFileSync(path.join(dir, 'book.magic'), MAGIC_TESTNET_V3);
    assert.throws(() => createStore(dir), /datadir_magic:shear-testnet-v3/);
  });

  it('matching v4 book.magic loads; rewrite keeps v4', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-v4-ok-'));
    fs.writeFileSync(path.join(dir, 'book.magic'), MAGIC_TESTNET_V4);
    const store = createStore(dir);
    assert.equal(store.tip(), null);
    const again = createStore(dir);
    assert.equal(again.tip(), null);
    assert.equal(fs.readFileSync(path.join(dir, 'book.magic'), 'utf8').trim(), MAGIC_TESTNET);
  });

  it('empty datadir loads as this book', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-v3-'));
    const store = createStore(dir);
    assert.equal(store.tip(), null);
    const again = createStore(dir);
    assert.equal(again.tip(), null);
  });

  it('P2P drops a hello whose magic is the frozen v2 book', async () => {
    const { createP2p } = await import('../src/p2p.js');
    const net = await import('node:net');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-p2p-'));
    const store = createStore(dir);
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = net.connect(bound.port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no inbound hello')), 2000);
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.split('\n').filter(Boolean).length >= 2) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    const closed = new Promise((resolve) => sock.once('close', resolve));
    sock.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET_V2, ua: 'v2-peer', port: 1 })}\n`);
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('v2 hello did not drop the socket')), 3000)),
    ]);
    p2p.close();
  });

  it('P2P drops a hello whose magic is frozen v1 or shear-v1', async () => {
    const { createP2p } = await import('../src/p2p.js');
    const net = await import('node:net');
    for (const bad of [MAGIC_TESTNET_V1, MAGIC_MAINNET]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-p2p-v1-'));
      const store = createStore(dir);
      const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
      const bound = await p2p.listen();
      const sock = net.connect(bound.port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        sock.once('connect', resolve);
        sock.once('error', reject);
      });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no inbound hello')), 2000);
        let buf = '';
        sock.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.split('\n').filter(Boolean).length >= 2) {
            clearTimeout(t);
            resolve();
          }
        });
      });
      const closed = new Promise((resolve) => sock.once('close', resolve));
      sock.write(`${JSON.stringify({ type: 'hello', magic: bad, ua: 'old-peer', port: 1 })}\n`);
      await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${bad} hello did not drop the socket`)), 3000)),
      ]);
      p2p.close();
    }
  });

  it('P2P hellos, tips, and headers shear-testnet-v4', async () => {
    const { createP2p } = await import('../src/p2p.js');
    const net = await import('node:net');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-p2p-v3-'));
    const store = createStore(dir);
    const dest = encodeDest(Buffer.alloc(20, 7));
    const packed = packBits(LIVE_MIN_BITS);
    const { tpl } = store.template({ miner: dest, bits: packed, shareBits: packed, now: Date.now() });
    const found = mineTemplate({ ...tpl, bits: packed }, { maxTries: 3_000_000, shareBits: packed });
    assert.ok(found && found.block, 'need pow');
    assert.equal(store.append({
      header: found.header,
      txs: tpl.txs,
      samples: tpl.samples,
      miner: dest,
    }).ok, true);
    const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const bound = await p2p.listen();
    const sock = net.connect(bound.port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    const inbound = [];
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no inbound hello/tip')), 2000);
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          inbound.push(msg);
        }
        if (inbound.some((m) => m.type === 'hello') && inbound.some((m) => m.type === 'tip')) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    const hello = inbound.find((m) => m.type === 'hello');
    const tip = inbound.find((m) => m.type === 'tip');
    assert.equal(hello.magic, MAGIC_TESTNET);
    assert.equal(hello.magic, 'shear-testnet-v4');
    assert.equal(tip.magic, 'shear-testnet-v4');
    assert.equal(tip.height, 1);
    sock.write(`${JSON.stringify({ type: 'hello', magic: MAGIC_TESTNET, ua: 'v4-peer', port: 1 })}\n`);
    sock.write(`${JSON.stringify({ type: 'getheaders', magic: MAGIC_TESTNET, locator: [], stopHash: '' })}\n`);
    const t0 = Date.now();
    let headers = inbound.find((m) => m.type === 'headers');
    while (!headers && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 25));
      headers = inbound.find((m) => m.type === 'headers');
    }
    assert.ok(headers, 'v4 peer must serve headers');
    assert.equal(headers.magic, 'shear-testnet-v4');
    assert.ok(Array.isArray(headers.headers));
    assert.ok(headers.headers.length >= 1);
    const hdr0 = headers.headers[0];
    assert.ok(hdr0.header || hdr0.hash);
    assert.equal(decodeHeader(Buffer.from(found.header)).version, 1);
    sock.destroy();
    p2p.close();
  });
});
