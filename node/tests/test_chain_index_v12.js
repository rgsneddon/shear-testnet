// The chain-by-hash index p2p and store use for every frame and ingest. It
// must follow the chain at O(1) per appended block: rebuilt per tip, IBD was
// O(N^2) on the main thread (Protocol lane F5, 25 Oct).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chainIndexOf, emptyChainIndex, syncChainIndex } from '../src/chain_index.js';

const blockOf = (tag) => ({ hash: createHash('sha256').update(String(tag)).digest() });

describe('chain index', () => {
  it('IBD of N blocks hexes each block once, not once per tip', () => {
    const list = [];
    const index = emptyChainIndex();
    let hexed = 0;
    const N = 5000;
    for (let i = 0; i < N; i += 1) {
      list.push(blockOf(`main-${i}`));
      hexed += syncChainIndex(index, list);
      assert.equal(chainIndexOf(index, list, list[i].hash), i);
    }
    // A rebuild per tip would hex N(N+1)/2 = 12,502,500 entries here.
    assert.equal(hexed, N);
    assert.equal(chainIndexOf(index, list, Buffer.alloc(32, 7)), -1);
    assert.equal(syncChainIndex(index, list), 0, 'an unchanged chain costs nothing');
  });

  it('a reorg or a shorter chain rebuilds, so no hash from the old branch is found', () => {
    const list = Array.from({ length: 50 }, (_v, i) => blockOf(`main-${i}`));
    const index = emptyChainIndex();
    syncChainIndex(index, list);
    const old = list.slice(40).map((b) => b.hash);
    // Reorg: the top ten replaced by a longer branch.
    list.splice(40, 10, ...Array.from({ length: 12 }, (_v, i) => blockOf(`side-${i}`)));
    assert.equal(syncChainIndex(index, list), list.length, 'a moved tip rebuilds once');
    for (const hash of old) assert.equal(chainIndexOf(index, list, hash), -1);
    assert.equal(chainIndexOf(index, list, list[51].hash), 51);
    // Same length, other tip.
    list[list.length - 1] = blockOf('side-top');
    assert.equal(syncChainIndex(index, list), list.length);
    assert.equal(chainIndexOf(index, list, list[list.length - 1].hash), list.length - 1);
    // Shorter.
    const dropped = list[list.length - 1].hash;
    list.length = 30;
    assert.equal(syncChainIndex(index, list), 30);
    assert.equal(chainIndexOf(index, list, dropped), -1);
    // Empty.
    list.length = 0;
    syncChainIndex(index, list);
    assert.equal(chainIndexOf(index, list, dropped), -1);
  });

  it('reads hex text and Buffers alike', () => {
    const list = [blockOf('a'), blockOf('b')];
    const index = emptyChainIndex();
    assert.equal(chainIndexOf(index, list, list[1].hash.toString('hex').toUpperCase()), 1);
    assert.equal(chainIndexOf(index, list, `0x${list[0].hash.toString('hex')}`), 0);
  });
});
