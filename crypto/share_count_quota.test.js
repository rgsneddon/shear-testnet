import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SHARE_FLOOR_BITS } from './asert.js';
import { nonceWithShareTarget, selectBlockShares, unitsForShare } from './share_batch.js';

function commit(byte) {
  const nc = Buffer.alloc(32, byte);
  nc[31] = byte;
  return nc;
}

function share(byte, n, bits) {
  return {
    noteCommit: commit(byte),
    nonce: nonceWithShareTarget(BigInt(n), bits),
    lz: bits,
    shareBits: bits,
  };
}

function keptWork(rows) {
  let n = 0n;
  for (const row of rows) n += BigInt(unitsForShare(row.shareBits));
  return n;
}

function byCommit(rows) {
  const out = new Map();
  for (const row of rows) {
    const key = row.noteCommit.toString('hex');
    out.set(key, (out.get(key) || 0n) + BigInt(unitsForShare(row.shareBits)));
  }
  return out;
}

function pileWork(rows, bytes) {
  const want = new Set(bytes.map((b) => commit(b).toString('hex')));
  let n = 0n;
  for (const [key, units] of byCommit(rows)) {
    if (want.has(key)) n += units;
  }
  return n;
}

describe('share-count cap quotas follow submitted work', () => {
  it('splitting the same work across more noteCommits does not raise its kept share', () => {
    const caps = [1, 2, 3, 7, 8, 15];
    const splits = [2, 4, 8];
    const widths = [SHARE_FLOOR_BITS, SHARE_FLOOR_BITS + 2, SHARE_FLOOR_BITS + 4];
    const counts = [1, 4, 8];
    for (const bits of widths) {
      for (const count of counts) {
        for (const cap of caps) {
          const other = [];
          for (let i = 0; i < count; i += 1) other.push(share(1, 100 + i, bits));
          const unsplit = [];
          for (let i = 0; i < count; i += 1) unsplit.push(share(40, 300 + i, bits));
          const unsplitKept = pileWork(selectBlockShares(other.concat(unsplit), cap), [40]);
          for (const split of splits) {
            if (count % split !== 0) continue;
            const sybil = [];
            const bytes = [];
            const each = count / split;
            for (let d = 0; d < split; d += 1) {
              bytes.push(50 + d);
              for (let i = 0; i < each; i += 1) sybil.push(share(50 + d, 400 + d * 20 + i, bits));
            }
            const kept = selectBlockShares(other.concat(sybil), cap);
            const splitKept = pileWork(kept, bytes);
            assert.ok(
              splitKept <= unsplitKept,
              `bits ${bits} count ${count} cap ${cap} split ${split} split ${splitKept} unsplit ${unsplitKept}`,
            );
            const flipped = selectBlockShares(sybil.concat(other).reverse(), cap);
            assert.equal(keptWork(flipped), keptWork(kept));
          }
        }
      }
    }
  });

  it('mixed widths keep work share, and a heavier share wins the last slot', () => {
    const floor = SHARE_FLOOR_BITS;
    const cases = [
      [1, 4],
      [3, 8],
      [5, 16],
    ];
    for (const [lightCount, heavyCount] of cases) {
      const light = [];
      const heavy = [];
      for (let i = 0; i < lightCount; i += 1) light.push(share(2, 300 + i, floor));
      for (let i = 0; i < heavyCount; i += 1) heavy.push(share(3, 400 + i, floor + 3));
      const cap = Math.max(1, Math.floor((lightCount + heavyCount) / 2));
      const kept = selectBlockShares(light.concat(heavy), cap);
      assert.equal(kept.length, cap);
      const work = byCommit(kept);
      const lightKept = work.get(commit(2).toString('hex')) || 0n;
      const heavyKept = work.get(commit(3).toString('hex')) || 0n;
      const lightAll = BigInt(lightCount) * BigInt(unitsForShare(floor));
      const heavyAll = BigInt(heavyCount) * BigInt(unitsForShare(floor + 3));
      if (heavyAll > lightAll) assert.ok(heavyKept >= lightKept);
    }
    const one = selectBlockShares([
      share(1, 1, floor),
      share(9, 2, floor + 6),
    ], 1);
    assert.equal(one.length, 1);
    assert.equal(one[0].noteCommit[0], 9);
  });
});
