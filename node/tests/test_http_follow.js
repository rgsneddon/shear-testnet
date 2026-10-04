import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { noteHttpSync, pullNextHttpBlock } from '../src/http_follow.js';
import { nodeStatus } from '../src/status.js';

function jsonResponse(body) {
  return { ok: true, async text() { return JSON.stringify(body); } };
}

describe('HTTPS follow', () => {
  it('pulls the next block and stays IBD while the public tip is ahead and peers are 0', async () => {
    const store = {
      height: 0,
      tip() {
        return this.height > 0 ? { height: this.height, hash: Buffer.alloc(32, 1) } : null;
      },
      async ingest(blocks) {
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].height, 1);
        this.height = 1;
        return { ok: true };
      },
    };
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.endsWith('/stats')) {
        return jsonResponse({ magic: MAGIC_TESTNET, height: 204 });
      }
      if (u.includes('/block?height=1')) {
        return jsonResponse({
          ok: true,
          magic: MAGIC_TESTNET,
          height: 1,
          header: 'aa',
          hash: '00001ed47a67a07120dd84da83b88b6fe92df6130db2fb416ade39a3a47a15b1',
          txs: [],
        });
      }
      return { ok: false, async text() { return ''; } };
    };
    const advanced = await pullNextHttpBlock({
      store,
      fetchImpl,
      seeds: ['https://p2p.shear.digital'],
    });
    assert.equal(advanced, true);
    assert.equal(store.height, 1);
    assert.equal(store.httpSync.behind, true);
    assert.equal(store.httpSync.remoteTip, 204);
    const row = nodeStatus({
      store,
      p2p: { peers: new Map(), liveOnline: () => 0 },
    });
    assert.equal(row.peers, 0);
    assert.equal(row.ibd, true);
    assert.equal(noteHttpSync(store, 1, 1).behind, false);
    assert.equal(nodeStatus({
      store,
      p2p: { peers: new Map(), liveOnline: () => 0 },
    }).ibd, false);
  });
});
