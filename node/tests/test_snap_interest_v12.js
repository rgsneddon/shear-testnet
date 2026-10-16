import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader } from '../../crypto/header.js';
import { potSubsidyAt, MS_PER_DAY, EPOCH_DAYS_TESTNET } from '../../crypto/pot_sched.js';
import { PI_SHE_NANOS, GENESIS_BPS, MAGIC_TESTNET } from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { sealCoinbaseNote, addExcess, excessOf } from '../../crypto/note.js';
import { lockTx, withdrawTx } from '../../crypto/owned_portal.js';
import { coinbaseTx } from '../src/chain.js';
import { fillSnapInterest, foldSupply, supplyFromScalar } from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function portalDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function noteFund(tx) {
  const n = Math.floor(Number(tx.nanos) || 0);
  const sealed = sealCoinbaseNote(n, { dest20: Buffer.alloc(20, 0x91), kind: 'pot' });
  const prev = tx.vin && tx.vin[0] ? tx.vin[0] : {};
  tx.vin = [{
    ...prev,
    commit: sealed.commit,
    valueProof: sealed.valueProof,
    rangeProof: sealed.rangeProof,
  }];
  return tx;
}

function header(ts) {
  return encodeHeader({
    prevBlockHash: Buffer.alloc(32),
    merkleRoot: Buffer.alloc(32),
    continuityRoot: Buffer.alloc(32),
    timestamp: ts,
    bits: 16,
  });
}

function potAt(ts) {
  return potSubsidyAt({ nowMs: ts, genesisMs: GENESIS, magic: MAGIC_TESTNET });
}

function blockAt(ts, miner, notes, moreTxs) {
  const potNotes = notes.filter((n) => n.kind === 'pot');
  const shares = potNotes.map((n) => ({
    address: n.address || miner,
    nanos: n.nanos,
    kind: 'pot',
  }));
  const tx = coinbaseTx({
    height: 1,
    miner,
    potShares: shares,
    potNanos: shares.reduce((a, s) => a + s.nanos, 0),
    carryNanos: 0,
    shareBatch: [],
  });
  tx.vout = (tx.vout || []).filter((o) => String(o?.kind || '') !== 'hash');
  tx.excess = excessOf(tx.vout);
  if (!tx.vout.length) tx.excess = excessOf([]);
  return {
    header: header(ts),
    txs: [tx, ...(moreTxs || [])],
    shareBatch: [],
  };
}

function snapOf(state) {
  return supplyFromScalar({
    height: state.height,
    blockHash: state.blockHash,
    schedulePot: state.schedulePot,
    carry: state.carry,
    mintedPot: state.mintedPot,
    mintedHash: state.mintedHash,
    mintedLevy: state.mintedLevy,
    bLocked: state.bLocked,
    permittedHashAll: state.permittedHashAll,
    acceptedHash: state.acceptedHash,
    dust: state.dust,
    overflow: state.overflow,
    liveUnit: state.liveUnit,
    genesisMs: state.genesisMs,
  }, { owedKnown: true });
}

describe('VS-1 snap interest', () => {
  it('a 12-u64 snap is zero until the vault walk, which matches the fold', () => {
    const stake = PI_SHE_NANOS;
    const one = interestNanos(stake, GENESIS_BPS);
    assert.ok(one > 0);
    const miner = minerDest();
    const portal = portalDest();
    const drawTs = GENESIS + EPOCH_MS + 1;
    const chain = [
      blockAt(GENESIS, miner, [{ nanos: potAt(GENESIS), kind: 'pot' }], [
        noteFund(lockTx({ from: miner, to: portal, nanos: stake, id: 'lock-snap' })),
      ]),
      blockAt(drawTs, miner, [{ nanos: potAt(drawTs), kind: 'pot' }], [
        withdrawTx({ from: portal, to: miner, nanos: stake, id: 'draw-snap' }),
      ]),
    ];
    const folded = foldSupply(chain, { genesisMs: GENESIS });
    assert.equal(folded.ok, true, folded.reason);
    assert.equal(folded.state.mintedInterest, 0n);
    assert.equal(folded.state.permittedInterest, 0n);

    const kept = supplyFromScalar(folded.state, { owedKnown: true });
    assert.equal(kept.mintedInterest, 0n);
    assert.equal(kept.permittedInterest, 0n);

    let walked = foldSupply([chain[0]], { genesisMs: GENESIS });
    assert.equal(walked.ok, true, walked.reason);
    const rows = [snapOf(walked.state)];
    walked = foldSupply(chain, { genesisMs: GENESIS });
    rows.push(snapOf(walked.state));
    assert.equal(rows[0].mintedInterest, 0n);
    assert.equal(rows[1].mintedInterest, 0n);
    const filled = fillSnapInterest(rows, chain);
    assert.equal(filled.ok, true, filled.reason);
    assert.equal(rows[0].mintedInterest, 0n);
    assert.equal(rows[0].permittedInterest, 0n);
    assert.equal(rows[1].mintedInterest, 0n);
    assert.equal(rows[1].permittedInterest, 0n);
  });
});
