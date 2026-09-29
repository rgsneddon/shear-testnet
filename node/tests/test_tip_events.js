import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from '../src/rpc.js';

describe('node tip events', () => {
  it('advises listeners the moment the book seals a block', async () => {
    const store = new EventEmitter();
    store.blocks = [];
    store.tip = () => ({ height: 0 });
    const rpc = createRpc({ store, port: 0, host: '127.0.0.1' });
    const addr = await rpc.listen();
    try {
      const body = await new Promise((resolve, reject) => {
        const req = http.get({
          host: '127.0.0.1',
          port: addr.port,
          path: '/events',
          headers: { accept: 'text/event-stream' },
        }, (res) => {
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            if (buf.includes('event: tip')) {
              res.destroy();
              resolve(buf);
            }
          });
        });
        req.on('error', (err) => {
          if (err.code !== 'ECONNRESET') reject(err);
        });
        setTimeout(() => {
          store.emit('tip', { height: 440, hash: 'abc' });
        }, 40);
      });
      assert.match(body, /event: tip/);
      assert.match(body, /"height":440/);
      assert.doesNotMatch(body, /event: reorg/);
    } finally {
      await rpc.close();
    }
  });
});
