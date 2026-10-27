/**
 * A reorg drops a held tx, or keeps a disconnected one out, only when the
 * winning blocks spend the same note: a shared spend tag, or a shared real
 * outpoint (store.js winnerSpends). It used to key every vin as
 * `${vin.prev || ''}:${vin.index}`: an FS-1 vin names neither, so every FS-1
 * send keyed ':undefined', and a winner carrying one FS-1 send dropped every
 * other FS-1 send from the mempool. A Buffer prev and its hex never matched.
 * Origin 0c5c33a2 (30 Aug). One canonical key per spent note now
 * (spentNoteKeys): `out:` the prev's 32 bytes and index, `tag:` a spend tag.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { txSpendTags } from '../../crypto/note.js';
import { spentNoteKeys, winnerSpends } from '../src/store.js';
import { attachStubAdmitV2 } from './stub_admit_v2.js';

function fs1Send(id, tagFill) {
  return attachStubAdmitV2({ id, kind: 'send', vin: [{ commit: Buffer.alloc(32, tagFill + 40) }], vout: [] }, { tagFill });
}

const block = (...txs) => ({ txs: [{ coinbase: true, vout: [] }, ...txs] });

describe('a reorg spends only what its winning blocks spend', () => {
  it('two FS-1 sends with their own tags never collide by their vins', () => {
    const won = fs1Send('won', 2);
    const held = fs1Send('held', 9);
    assert.equal(txSpendTags(won).tags.length, 1);
    assert.equal(txSpendTags(held).tags.length, 1);
    const spent = winnerSpends([block(won)]);
    assert.equal(spent(won), true, 'the winner spends its own note');
    assert.equal(spent(held), false, 'another FS-1 send is not spent by the winner');
    // The same note (spend tag) under another body is spent.
    assert.equal(spent(fs1Send('again', 2)), true);
  });

  it('a real outpoint matches however its prev is held, and only at its index', () => {
    const prev = Buffer.alloc(32, 7);
    const spent = winnerSpends([block({ id: 'w', kind: 'send', vin: [{ prev, index: 0 }], vout: [] })]);
    assert.equal(spent({ id: 'h', vin: [{ prev: prev.toString('hex'), index: 0 }] }), true, 'hex prev');
    assert.equal(spent({ id: 'b', vin: [{ prev: Buffer.from(prev), index: 0 }] }), true, 'Buffer prev');
    assert.equal(spent({ id: 'o', vin: [{ prev, index: 1 }] }), false, 'another output of that tx');
    assert.equal(spent({ id: 'x', vin: [{ prev: `0x${prev.toString('hex').toUpperCase()}`, index: 0 }] }), true, '0x upper-case hex prev');
    assert.equal(spent({ id: 'j', vin: [{ prev: { $hex: prev.toString('hex') }, index: 0 }] }), true, '{$hex} prev');
    assert.equal(spent({ id: 'n', vin: [{ commit: Buffer.alloc(32, 1) }] }), false, 'an FS-1 vin names no outpoint');
    assert.equal(spent({ id: 's', vin: [{ prev: prev.subarray(0, 31), index: 0 }] }), false, 'a short prev is no outpoint');
  });

  it('one key per spent note, in two namespaces that never meet', () => {
    const fs1 = fs1Send('k', 7);
    const tag = txSpendTags(fs1).tags[0];
    const keys = spentNoteKeys(fs1);
    assert.deepEqual([...keys], [`tag:${tag.toString('hex')}`], 'an FS-1 send is keyed by its spend tag alone');
    // An outpoint whose prev bytes equal that tag is another note.
    const out = spentNoteKeys({ vin: [{ prev: Buffer.from(tag), index: 0 }] });
    assert.deepEqual([...out], [`out:${tag.toString('hex')}:0`]);
    assert.equal(winnerSpends([block(fs1)])({ vin: [{ prev: Buffer.from(tag), index: 0 }] }), false);
  });

  it('a winner with no spends spends nothing', () => {
    const spent = winnerSpends([block()]);
    assert.equal(spent(fs1Send('held', 9)), false);
    assert.equal(spent({ id: 'x', vin: [{ prev: Buffer.alloc(32, 7), index: 0 }] }), false);
  });
});
