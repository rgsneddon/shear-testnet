/**
 * The compaction read walk records what it is meant to (compact_reads.js):
 * a read, or a presence test, of a field the compact body lacks and the full
 * row carries; never a read of a field the compact body keeps, and never a
 * read made while compacting. A silent walk proves nothing unless these hold.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactTx } from '../../crypto/chronoflux.js';
import { readWalk, BENIGN_DROPPED_READS } from './compact_reads.js';

describe('compaction read walk', () => {
  it('records a dropped read and a dropped presence test, and nothing else', () => {
    const full = { kind: 'send', fee: 5, nanos: 7, vout: [{ kind: 'send', commit: Buffer.alloc(32, 1), nanos: 7 }] };
    const misses = new Set();
    const walked = readWalk({ kind: 'send', fee: 5, vout: [{ kind: 'send', commit: Buffer.alloc(32, 1) }] }, full, misses);
    // Kept fields are not misses.
    assert.equal(walked.kind, 'send');
    assert.equal(walked.vout[0].kind, 'send');
    assert.deepEqual([...misses], []);
    // A validator reading a dropped field is.
    assert.equal(walked.nanos, undefined);
    assert.deepEqual([...misses], ['nanos']);
    // So is one testing for it, by `in` or by hasOwnProperty, at any depth.
    assert.equal('nanos' in walked.vout[0], false);
    assert.equal(Object.prototype.hasOwnProperty.call(walked, 'nanos'), false);
    assert.deepEqual([...misses].sort(), ['nanos', 'nanos?', 'vout[].nanos?']);
    // Each miss names the code that made it.
    assert.ok(misses.readers.get('nanos'));
  });

  it('does not count the compactor reading its own input', () => {
    const full = { kind: 'send', fee: 5, nanos: 7, memo: 'x', vout: [{ kind: 'send', commit: Buffer.alloc(32, 1) }] };
    const misses = new Set();
    compactTx(readWalk({ kind: 'send', fee: 5, vout: [{ kind: 'send', commit: Buffer.alloc(32, 1) }] }, full, misses));
    assert.deepEqual([...misses], []);
  });

  it('names a reason for every read it lets through', () => {
    for (const [path, why] of Object.entries(BENIGN_DROPPED_READS)) {
      assert.ok(typeof why === 'string' && why.length > 20, `${path} has a reason`);
    }
  });
});
