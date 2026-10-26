/**
 * No masking (Russell 26 Oct): a block with an upgradeable row fault (here
 * unsigned) and a final fault is recorded final. The pre-PoW row check still
 * names the soft fault; the block's verdict is the final fault the same block
 * carries without the soft field, and the soft verdict only when it has none.
 */
import assert from 'node:assert/strict';
import { UPGRADEABLE_REASONS, earlyRowsRejected } from '../src/chain.js';

/**
 * `block` carries the soft field; `without` is the same block with that field
 * removed (merkle resealed). `verify` is the call under test. Returns the verdict.
 */
export async function softNeverMasks({ block, without, verify, soft = 'unsigned', label = '' }) {
  assert.equal(earlyRowsRejected(block)?.reason, soft, `${label}: the row check names ${soft}`);
  const got = await Promise.resolve(verify(block));
  assert.equal(got?.ok, false, `${label}: refused`);
  const bare = await Promise.resolve(verify(without));
  if (bare?.ok === false && !UPGRADEABLE_REASONS.has(bare.reason)) {
    assert.equal(got.reason, bare.reason, `${label}: the final ${bare.reason} is the verdict, not ${got.reason}`);
  } else {
    assert.equal(got.reason, soft, `${label}: ${soft} with no final fault (${bare?.reason || 'ok'})`);
  }
  return got;
}
