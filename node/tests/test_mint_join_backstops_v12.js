/**
 * join_removed and mint_forbidden in verifyBlock. Each live arm is reached by a
 * v12 kind, and each arm that an earlier gate shadows is still refused, by that
 * gate. If an earlier gate moves, the shadowed arm becomes the refusal and the
 * test names it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS_BITS_PACKED, JOIN_PROGRAM, RESERVE_PROGRAM, wrapMintForbidden } from '../../crypto/asert.js';
import { newIdentity, encodeDest, destCommitFromSpendPub } from '../../crypto/address.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import { unsignedBodyField } from '../../crypto/spend.js';
import { GENESIS_PREV, buildTemplate, digestTx, verifyBlock } from '../src/chain.js';

const id = newIdentity();
const who = encodeDest(destCommitFromSpendPub(id.spendPub), id.admitBase);

/** A height-1 block carrying `tx`. probeBody judges the body, not the hash. */
function verdict(tx) {
  const tpl = buildTemplate({
    prev: GENESIS_PREV,
    height: 1,
    miner: who,
    finderDest: who,
    txs: [],
    bits: GENESIS_BITS_PACKED,
    now: 1_700_000_000_000,
  });
  const txs = [tpl.txs[0], { id: 'probe', ...tx }];
  const d = decodeHeader(Buffer.from(tpl.header));
  const header = encodeHeader({ ...d, merkleRoot: merkleRoot(txs.map(digestTx)) });
  return verifyBlock({ ...tpl, header, txs }, null, { probeBody: true, magic: 'shear-testnet-v12' }).reason;
}

const bare = (extra) => ({ fee: 0, vin: [], vout: [], ...extra });

describe('verifyBlock keeps the join and mint backstops', () => {
  it('join_removed is live for any v12 kind on the join programme', () => {
    for (const kind of ['vote', 'roll', 'b-spend', 'reward-claim']) {
      assert.equal(verdict(bare({ kind, programId: JOIN_PROGRAM })), 'join_removed', kind);
    }
  });

  it('the join-genesis kind is refused first by the kind gate', () => {
    assert.equal(verdict(bare({ kind: 'join-genesis', programId: JOIN_PROGRAM })), 'kind');
  });

  it('a wrapped-SHE programme is mint_forbidden for any v12 kind', () => {
    for (const kind of ['vote', 'roll']) {
      assert.equal(verdict(bare({ kind, programId: 'wrapper' })), 'mint_forbidden', kind);
    }
  });

  it('the wrap kind is refused first; the SHE ticker arm is unsigned on its row and mint_forbidden on the block', () => {
    assert.equal(verdict(bare({ kind: 'wrap', programId: 'x' })), 'kind');
    // ticker is not spend-signed (the row check names unsigned), and the
    // backstop is a final fault, so it is the block's verdict (no masking).
    assert.equal(unsignedBodyField(bare({ kind: 'vote', programId: 'x', ticker: 'she' }))?.reason, 'unsigned');
    assert.equal(verdict(bare({ kind: 'vote', programId: 'x', ticker: 'she' })), 'mint_forbidden');
    // The backstop itself still covers both, if the earlier gates ever move.
    assert.equal(wrapMintForbidden({ kind: 'wrap', programId: 'x' }), true);
    assert.equal(wrapMintForbidden({ kind: 'vote', programId: 'x', ticker: 'she' }), true);
  });

  it('an unfunded body that is not the Reserve extra-mint is mint_forbidden', () => {
    const cases = [
      ['fee-paying Reserve vote with no input', bare({ kind: 'vote', programId: RESERVE_PROGRAM, fee: 5 })],
      ['Reserve roll with no input', bare({ kind: 'roll', programId: RESERVE_PROGRAM })],
      ['Reserve roll that sets mint', bare({ kind: 'roll', programId: RESERVE_PROGRAM, mint: true, vin: [{ dest20: Buffer.alloc(20, 3) }] })],
      ['b-spend with no input', bare({ kind: 'b-spend' })],
      ['fee-paying vote off the Reserve', bare({ kind: 'vote', programId: 'x', fee: 1 })],
    ];
    for (const [name, tx] of cases) assert.equal(verdict(tx), 'mint_forbidden', name);
  });
});
