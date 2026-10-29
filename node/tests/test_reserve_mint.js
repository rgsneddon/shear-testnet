import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin, vaultDest } from '../../crypto/flow_sheet.js';
import {
  RESERVE_PROGRAM,
  NANOS_PER_SHE,
  BLOCK_SUBSIDY_NANOS,
  HASH_BONUS_NANOS_FLOOR,
  extraMintAllowed,
  wrapMintForbidden,
  GENESIS_BPS,
  GENESIS_BITS_PACKED,
} from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { vote, emptyVault, VOTE_DECREASE, VOTE_HOLD, withdrawTx, withdrawLeakRejected } from '../../crypto/reserve_vault.js';
import { unsignedBodyField } from '../../crypto/spend.js';
import { deposit } from '../../crypto/owned_portal.js';
import { PI_SHE_NANOS } from '../../crypto/asert.js';
import { gateVorticeRegister } from '../../crypto/vortex.js';
import { softNeverMasks } from './soft_verdict.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

function destOf(id) {
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

/**
 * withdrawTx still writes from, to, payoutPortalId, and the vout address.
 * Since 325b50f5 those are vote_leak, which the block names before an
 * uncovered field. A posted withdraw names its lock by portalId and pays
 * dest20, so drop them. r is the blind and never goes on the wire.
 */
function compactWithdraw(args) {
  const tx = withdrawTx(args);
  delete tx.from;
  delete tx.to;
  delete tx.payoutPortalId;
  tx.vout = tx.vout.map(({ address: _address, r: _r, ...row }) => row);
  assert.equal(withdrawLeakRejected(tx), null);
  // The bare body is covered, so an 'unsigned' verdict below names the stake fields.
  assert.equal(unsignedBodyField(tx), null);
  return tx;
}

/** The same body with the named unsigned fields removed. */
function without(tx, keys) {
  const next = { ...tx };
  for (const k of keys) delete next[k];
  return next;
}

const STAKE_KEYS = ['stakedNanos', 'principalNanos'];

function mine(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    weight: tpl.weight,
  };
}

describe('Reserve mint is sealed-state pure', () => {
  it('extra mint is only shear-reserve-v1 withdraw; wrap and third-party are forbidden', () => {
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'withdraw' }), true);
    assert.equal(extraMintAllowed(RESERVE_PROGRAM, { kind: 'lock' }), false);
    assert.equal(extraMintAllowed('other-vortice', { kind: 'withdraw' }), false);
    assert.equal(wrapMintForbidden({ kind: 'wrap', programId: 'wrap-she-v1' }), true);
  });

  it('JS and Solidity share the 1 SHE × 425 bps = 4_250_000_000 vector', () => {
    assert.equal(interestNanos(NANOS_PER_SHE, 425), 4_250_000_000);
    const sol = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../contracts/Reserve.sol'), 'utf8');
    assert.match(sol, /active \* epochBps/);
    assert.match(sol, /\/ 10000/);
    assert.match(sol, /do not use 365/);
    assert.equal(/\* 365|\/ 365|365-day/.test(sol), false);
    assert.match(sol, new RegExp(`GENESIS_BPS = ${GENESIS_BPS}`));
    assert.match(sol, /UnitFloor/);
  });

  it('an uncovered stake field is unsigned; idle interest is 0; default bps stays the bundle', async () => {
    const id = newIdentity();
    const dest = destOf(id);
    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const TRUSTED = Buffer.alloc(32);
    const base = {
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
    };
    const staked = NANOS_PER_SHE;
    const want = staked + interestNanos(staked, 425);
    const wrong = {
      ...compactWithdraw({ from: dest, to: vault, nanos: want + 1, id: 'w-wrong' }),
      stakedNanos: staked,
      principalNanos: staked,
    };
    // stakedNanos and principalNanos are not spend-signed body fields: the
    // row check names unsigned, and a final fault the fixture body also
    // carries is the block's verdict (no masking, Russell 26 Oct).
    const stakeCase = (tx, at, opts, label) => softNeverMasks({
      block: mine(buildTemplate({ ...base, ...at, txs: [tx] })),
      without: mine(buildTemplate({ ...base, ...at, txs: [without(tx, STAKE_KEYS)] })),
      verify: (b) => verifyBlock(b, null, opts),
      label,
    });
    await stakeCase(wrong, {}, { committedBps: 425, trustedPowHash: TRUSTED }, 'wrong interest');

    assert.equal(interestNanos(0, 425), 0);
    const idleTaxed = {
      ...compactWithdraw({ from: dest, to: vault, nanos: staked + interestNanos(staked, 425), id: 'w-idle' }),
      stakedNanos: 0,
      principalNanos: staked,
    };
    await stakeCase(idleTaxed, { now: 1_700_000_000_000 + 90_000 }, { committedBps: 425, trustedPowHash: TRUSTED }, 'idle taxed');

    const as425 = {
      ...compactWithdraw({ from: dest, to: vault, nanos: staked + interestNanos(staked, 425), id: 'w-425' }),
      stakedNanos: staked,
      principalNanos: staked,
    };
    await stakeCase(as425, { now: 1_700_000_000_000 + 180_000 }, { trustedPowHash: TRUSTED }, 'default bps');
    assert.equal(GENESIS_BPS, 281);
  });

  it('a SHE ticker is unsigned on the block, and the gate still names ticker', async () => {
    const id = newIdentity();
    const dest = destOf(id);
    const bad = {
      kind: 'vortice-register',
      from: dest,
      to: dest,
      nanos: 0,
      fee: 100,
      vin: [{ address: dest }],
      vout: [{ address: dest, nanos: 0, kind: 'vortice-register' }],
      bytesHash: '00'.repeat(32),
      vort1: 'vort1.ok',
      ticker: 'SHE',
    };
    assert.equal(gateVorticeRegister(bad).reason, 'ticker');
    const blockOf = (tx) => mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: GENESIS_BITS_PACKED,
      now: 1_700_000_000_000,
      txs: [tx],
    }));
    // ticker, vort1, and bytesHash are not spend-signed body fields, so the
    // row check names unsigned before the gate; a final fault the body also
    // carries is the block's verdict. The gate itself still names ticker.
    await softNeverMasks({
      block: blockOf(bad),
      without: blockOf(without(bad, ['ticker', 'vort1', 'bytesHash'])),
      verify: (b) => verifyBlock(b, null, { trustedPowHash: Buffer.from(`${'00'.repeat(31)}01`, 'hex') }),
      label: 'SHE ticker',
    });
  });

  it('verifyBlock does not read reserve/latest.json; votes never move the 1 SHE pot', () => {
    const chainSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/chain.js'), 'utf8');
    assert.equal(/latest\.json/.test(chainSrc), false);
    assert.equal(BLOCK_SUBSIDY_NANOS, 100_000_000_000);
    assert.equal(HASH_BONUS_NANOS_FLOOR, 1);
    const state = emptyVault();
    state.genesisMs = 1_700_000_000_000;
    const id = newIdentity();
    const dest = vaultDest(id.address, { viewKey: id.viewKey });
    deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: 1_700_000_000_000 });
    assert.equal(vote({ state, dest, choice: VOTE_DECREASE, nowMs: 1_700_000_000_001 }).reason, 'vote_retired');
    assert.equal(vote({ state, dest, choice: VOTE_HOLD, nowMs: 1_700_000_000_002 }).reason, 'vote_retired');
    assert.equal(BLOCK_SUBSIDY_NANOS, 100_000_000_000);
  });
});
