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
} from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { vote, deposit, emptyVault, VOTE_DECREASE, VOTE_HOLD } from '../../crypto/reserve_vault.js';
import { PI_SHE_NANOS } from '../../crypto/asert.js';
import { gateVorticeRegister } from '../../crypto/vortex.js';
import {
  buildTemplate,
  mineTemplate,
  verifyBlock,
  GENESIS_PREV,
} from '../src/chain.js';

function destOf(id) {
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function mine(tpl) {
  const found = mineTemplate(tpl, { maxTries: 3_000_000, shareBits: tpl.bits });
  assert.ok(found && found.block, 'pow');
  return {
    header: found.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
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
    assert.match(sol, /staked \* epochBps/);
    assert.match(sol, /\/ 10000/);
    assert.match(sol, /do not use 365/);
    assert.equal(/\* 365|\/ 365|365-day/.test(sol), false);
    assert.match(sol, /GENESIS_BPS = 264/);
    assert.match(sol, /UnitFloor/);
  });

  it('wrong withdraw nanos is mint_amount; idle adds 0; default committedBps is 264', async () => {
    const id = newIdentity();
    const dest = destOf(id);
    const vault = vaultDest(id.address, { viewKey: id.viewKey });
    const base = {
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
    };
    const staked = NANOS_PER_SHE;
    const want = staked + interestNanos(staked, 425);
    const wrong = {
      programId: RESERVE_PROGRAM,
      mint: true,
      kind: 'withdraw',
      from: dest,
      vin: [],
      vout: [{ address: vault, nanos: want + 1, kind: 'withdraw' }],
      stakedNanos: staked,
      principalNanos: staked,
    };
    const denied = await Promise.resolve(verifyBlock(mine(buildTemplate({ ...base, txs: [wrong] })), null, { committedBps: 425 }));
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'mint_amount');

    assert.equal(interestNanos(0, 425), 0);
    const idleTaxed = {
      programId: RESERVE_PROGRAM,
      mint: true,
      kind: 'withdraw',
      from: dest,
      vin: [],
      vout: [{ address: vault, nanos: staked + interestNanos(staked, 425), kind: 'withdraw' }],
      stakedNanos: 0,
      principalNanos: staked,
    };
    const idleDenied = await Promise.resolve(verifyBlock(mine(buildTemplate({ ...base, now: 1_700_000_000_000 + 90_000, txs: [idleTaxed] })), null, {
      committedBps: 425,
    }));
    assert.equal(idleDenied.ok, false);
    assert.equal(idleDenied.reason, 'mint_amount');

    const as425 = {
      programId: RESERVE_PROGRAM,
      mint: true,
      kind: 'withdraw',
      from: dest,
      vin: [],
      vout: [{ address: vault, nanos: staked + interestNanos(staked, 425), kind: 'withdraw' }],
      stakedNanos: staked,
      principalNanos: staked,
    };
    const defDenied = await Promise.resolve(verifyBlock(mine(buildTemplate({ ...base, now: 1_700_000_000_000 + 180_000, txs: [as425] })), null));
    assert.equal(defDenied.ok, false);
    assert.equal(defDenied.reason, 'mint_amount');
    assert.equal(GENESIS_BPS, 264);
  });

  it('gateVorticeRegister ok:false fails the block', () => {
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
    assert.equal(gateVorticeRegister(bad).ok, false);
    const block = mine(buildTemplate({
      prev: GENESIS_PREV,
      height: 1,
      miner: dest,
      bits: 4,
      now: 1_700_000_000_000,
      txs: [bad],
    }));
    const got = verifyBlock(block, null);
    assert.equal(got.ok, false);
    assert.equal(got.reason, 'ticker');
  });

  it('verifyBlock does not read reserve/latest.json; votes never move the 1 SHE pot', () => {
    const chainSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/chain.js'), 'utf8');
    assert.equal(/latest\.json/.test(chainSrc), false);
    assert.equal(BLOCK_SUBSIDY_NANOS, 100_000_000_000);
    assert.equal(HASH_BONUS_NANOS_FLOOR, 1);
    const state = emptyVault();
    const id = newIdentity();
    const dest = vaultDest(id.address, { viewKey: id.viewKey });
    deposit({ state, dest, nanos: PI_SHE_NANOS, nowMs: 1_700_000_000_000 });
    assert.equal(vote({ state, dest, choice: VOTE_DECREASE, nowMs: 1_700_000_000_001 }).reason, 'unit_floor');
    assert.equal(vote({ state, dest, choice: VOTE_HOLD, nowMs: 1_700_000_000_002 }).ok, true);
    assert.equal(BLOCK_SUBSIDY_NANOS, 100_000_000_000);
  });
});
