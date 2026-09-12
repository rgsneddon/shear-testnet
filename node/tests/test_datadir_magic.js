import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { MAGIC_TESTNET, MAGIC_TESTNET_V1, MAGIC_TESTNET_V2, MAGIC_TESTNET_V3 } from '../../crypto/asert.js';

describe('v2 and v3 datadirs refuse each other', () => {
  it('createStore throws datadir_magic on a v2 book.magic file', () => {
    assert.equal(MAGIC_TESTNET, 'shear-testnet-v3');
    assert.equal(MAGIC_TESTNET_V3, 'shear-testnet-v3');
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

  it('matching v3 book.magic loads; rewrite keeps v3', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-magic-v3-ok-'));
    fs.writeFileSync(path.join(dir, 'book.magic'), MAGIC_TESTNET_V3);
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
});
