/**
 * Per-withdraw interest: opened must be principal + the bps schedule on the
 * pre-withdraw vault. Snap fill and the supply step both reject a miss.
 * verifyBlock does not reach that check until vault funding lands.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity, hash20FromAddress } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { encodeHeader, decodeHeader } from '../../crypto/header.js';
import { merkleRoot } from '../../crypto/merkle.js';
import {
  potSubsidyAt,
  MS_PER_DAY,
  EPOCH_DAYS_TESTNET,
  joinCutoffMs,
} from '../../crypto/pot_sched.js';
import {
  PI_SHE_NANOS,
  GENESIS_BPS,
  MAGIC_TESTNET,
  HASH_BONUS_NANOS,
  HASH_BONUS_NANOS_FLOOR,
} from '../../crypto/asert.js';
import { interestNanos } from '../../crypto/reserve_oracle.js';
import { sealCoinbaseNote, addExcess, excessOf } from '../../crypto/note.js';
import { reserveFeeDest } from '../../crypto/levy.js';
import {
  lockTx,
  withdrawTx,
  voteTx,
  reserveAction,
  cloneVault,
  VOTE_HOLD,
  VOTE_DECREASE,
  blockWithdrawInterest,
  blockPermittedInterest,
} from '../../crypto/reserve_vault.js';
import { explicitTypedKindRejected, boundReserveWithdraw } from '../../crypto/spend.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { walletAnchor, checkAdmitAnchor } from '../../crypto/admit_v3.js';
import { coinbaseTx, verifyBlock, digestTx } from '../src/chain.js';
import { createStore } from '../src/store.js';
import {
  auditCirculatingSupply,
  fillSnapInterest,
  foldSupply,
  supplyStep,
  vaultAfterBlock,
} from '../src/supply.js';

const GENESIS = 1_700_000_000_000;
const EPOCH_MS = EPOCH_DAYS_TESTNET * MS_PER_DAY;
const DRAW = GENESIS + EPOCH_MS + 1;
const U64 = 0xffffffffffffffffn;
const ABOVE_SAFE = 2n ** 53n;

function minerDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

function portalDest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
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

function blockAt(ts, miner, notes, moreTxs, observe) {
  const potNotes = notes.filter((n) => n.kind !== 'finder-fee' && n.kind !== 'reserve-fee' && n.kind !== 'hash');
  const shares = potNotes.map((n) => ({
    address: n.address || miner,
    nanos: n.nanos,
    kind: n.kind || 'pot',
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
  const rest = notes.filter((n) => n.kind === 'finder-fee' || n.kind === 'reserve-fee' || n.kind === 'hash');
  for (const n of rest) {
    const sealed = sealCoinbaseNote(n.nanos, {
      dest20: hash20FromAddress(n.address || miner),
      kind: n.kind,
    });
    tx.vout.push(sealed);
    tx.excess = addExcess(tx.excess, sealed.r);
  }
  if (observe) tx.observe = observe;
  return {
    header: header(ts),
    txs: [tx, ...(moreTxs || [])],
    shareBatch: [],
  };
}

function potBlock(ts, miner, more, observe) {
  return blockAt(ts, miner, [{ nanos: potAt(ts), kind: 'pot' }], more, observe);
}

function lockOf(miner, portal, stake, id) {
  return lockTx({ from: miner, to: portal, nanos: stake, id });
}

function drawOf(portal, miner, nanos, id) {
  return withdrawTx({ from: portal, to: miner, nanos, id });
}

function foldOpts() {
  return { genesisMs: GENESIS, magic: MAGIC_TESTNET };
}

function expectSupplyReject(chain, label) {
  const snap = fillSnapInterest(chain.map(() => ({})), chain);
  assert.equal(snap.ok, false, `${label} snap ${snap.reason}`);
  assert.equal(snap.reason, 'supply', label);
  const folded = foldSupply(chain, foldOpts());
  assert.equal(folded.ok, false, `${label} fold ${folded.reason}`);
  assert.ok(folded.reason === 'supply' || folded.reason === 'epoch_open', `${label} fold ${folded.reason}`);
  const audit = auditCirculatingSupply(chain);
  assert.equal(audit.status, 'mismatch', label);
  assert.ok(audit.reason === 'supply' || audit.reason === 'epoch_open', `${label} ${audit.reason}`);
}

function expectVerified(chain, interest, label) {
  const snap = fillSnapInterest(chain.map(() => ({})), chain);
  assert.equal(snap.ok, true, `${label} snap ${snap.reason}`);
  const folded = foldSupply(chain, foldOpts());
  assert.equal(folded.ok, true, `${label} fold ${folded.reason}`);
  assert.equal(folded.state.mintedInterest, BigInt(interest), label);
  assert.equal(folded.state.permittedInterest, BigInt(interest), label);
  const audit = auditCirculatingSupply(chain);
  assert.equal(audit.status, 'verified', `${label} ${audit.reason}`);
  assert.equal(audit.extraMintNanos, interest, label);
}

describe('per-withdraw interest spread', () => {
  it('accepts one, two, and many exact withdraws and rejects every deviation', () => {
    const counts = [1, 2, 4];
    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    assert.ok(interest > 1);
    const deltas = [
      { name: 'exact', delta: 0, ok: true },
      { name: 'small-plus', delta: 1, ok: false },
      { name: 'small-minus', delta: -1, ok: false },
      { name: 'large-plus', delta: PI_SHE_NANOS, ok: false },
      { name: 'large-minus', delta: -interest, ok: false },
    ];
    for (const count of counts) {
      for (const row of deltas) {
        const miner = minerDest();
        const portals = Array.from({ length: count }, () => portalDest());
        const locks = portals.map((portal, i) => lockOf(miner, portal, PI_SHE_NANOS, `L${count}-${row.name}-${i}`));
        const draws = portals.map((portal, i) => drawOf(
          portal,
          miner,
          PI_SHE_NANOS + interest + row.delta,
          `W${count}-${row.name}-${i}`,
        ));
        const chain = [
          potBlock(GENESIS, miner, locks),
          potBlock(DRAW, miner, draws),
        ];
        const label = `${count} ${row.name}`;
        if (row.ok) expectVerified(chain, interest * count, label);
        else expectSupplyReject(chain, label);
      }
    }
  });

  it('rejects an offsetting pair whose block total still matches the schedule', () => {
    const miner = minerDest();
    const a = portalDest();
    const b = portalDest();
    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const honest = PI_SHE_NANOS + interest;
    const chain = [
      potBlock(GENESIS, miner, [
        lockOf(miner, a, PI_SHE_NANOS, 'off-a'),
        lockOf(miner, b, PI_SHE_NANOS, 'off-b'),
      ]),
      potBlock(DRAW, miner, [
        drawOf(a, miner, honest + 5, 'off-wa'),
        drawOf(b, miner, honest - 5, 'off-wb'),
      ]),
    ];
    const openedA = honest + 5 - PI_SHE_NANOS;
    const openedB = honest - 5 - PI_SHE_NANOS;
    assert.equal(openedA + openedB, interest * 2);
    expectSupplyReject(chain, 'offset');
    const parent = vaultAfterBlock(null, chain[0]);
    assert.equal(parent.ok, true);
    const minted = blockWithdrawInterest(parent.vault, chain[1], DRAW);
    const allowed = blockPermittedInterest(parent.vault, chain[1], DRAW);
    assert.equal(minted.ok, false);
    assert.equal(allowed.ok, false);
    assert.equal(minted.reason, 'supply');
  });

  it('pays zero interest on dust and the rounding boundary, and no stake on a last-quarter lock', () => {
    // Smallest stake whose floor(stake * bps / 10000) is 1, and the unit below it.
    // A stake below π earns nothing. The +1 rounding is paid on a qualified
    // stake of π plus that boundary unit.
    const boundary = Math.ceil(10000 / GENESIS_BPS);
    const dust = boundary - 1;
    assert.equal(interestNanos(dust, GENESIS_BPS), 0);
    assert.equal(interestNanos(boundary, GENESIS_BPS), 1);
    const miner = minerDest();
    const sponsor = portalDest();
    const low = portalDest();
    const edge = portalDest();
    const sponsorInterest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const edgeStake = PI_SHE_NANOS + boundary;
    const edgeInterest = interestNanos(edgeStake, GENESIS_BPS);
    assert.equal(edgeInterest, sponsorInterest + 1);
    const chain = [
      potBlock(GENESIS, miner, [
        lockOf(miner, sponsor, PI_SHE_NANOS, 'z-sponsor'),
        lockOf(miner, low, dust, 'z-dust'),
        lockOf(miner, edge, edgeStake, 'z-edge'),
      ]),
      potBlock(DRAW, miner, [
        drawOf(sponsor, miner, PI_SHE_NANOS + sponsorInterest, 'z-ws'),
        drawOf(low, miner, dust, 'z-wl'),
        drawOf(edge, miner, edgeStake + edgeInterest, 'z-we'),
      ]),
    ];
    expectVerified(chain, sponsorInterest + edgeInterest, 'dust-boundary');

    const late = GENESIS + EPOCH_MS - joinCutoffMs(MAGIC_TESTNET) + 1000;
    assert.ok(late < GENESIS + EPOCH_MS);
    const idleStake = 1000;
    const idleMiner = minerDest();
    const parked = portalDest();
    const idleChain = [
      potBlock(GENESIS, idleMiner, [lockOf(idleMiner, portalDest(), PI_SHE_NANOS, 'idle-open')]),
      potBlock(late, idleMiner, [lockOf(idleMiner, parked, idleStake, 'idle-lock')]),
      potBlock(DRAW, idleMiner, [drawOf(parked, idleMiner, idleStake, 'idle-draw')]),
    ];
    expectVerified(idleChain, 0, 'idle');
  });

  it('keeps the genesis bps across epochs; an observe is not a rate', () => {
    const miner = minerDest();
    const first = portalDest();
    const second = portalDest();
    const stake = PI_SHE_NANOS;
    const atGenesis = interestNanos(stake, GENESIS_BPS);
    const observed = potBlock(GENESIS, miner, [lockOf(miner, first, stake, 'bps-obs')], {
      annualBps: 0,
      observedAtMs: GENESIS,
    });
    assert.equal(vaultAfterBlock(null, observed).ok, false);
    const chain = [
      potBlock(GENESIS, miner, [lockOf(miner, first, stake, 'bps-a')]),
      potBlock(GENESIS + 1000, miner, [
        voteTx({ from: miner, dest: first, choice: VOTE_HOLD, id: 'bps-hold' }),
      ]),
      potBlock(DRAW, miner, [
        drawOf(first, miner, stake + atGenesis, 'bps-wa'),
      ]),
      potBlock(GENESIS + 2 * EPOCH_MS, miner, [lockOf(miner, second, stake, 'bps-b')]),
      potBlock(GENESIS + 3 * EPOCH_MS, miner, [
        drawOf(second, miner, stake + atGenesis, 'bps-wb'),
      ]),
    ];
    expectVerified(chain, atGenesis + atGenesis, 'genesis-rate');
    let vault = vaultAfterBlock(null, chain[0]);
    assert.equal(vault.ok, true);
    vault = vaultAfterBlock(vault.vault, chain[1]);
    assert.equal(vault.ok, true);
    assert.equal(vault.vault.epochBps, GENESIS_BPS);
    vault = vaultAfterBlock(vault.vault, chain[2]);
    assert.equal(vault.ok, true);
    vault = vaultAfterBlock(vault.vault, chain[3]);
    assert.equal(vault.ok, true, 'roll');
    assert.equal(vault.vault.epochBps, GENESIS_BPS);

    const floorMiner = minerDest();
    const voter = portalDest();
    const opened = potBlock(GENESIS, floorMiner, [lockOf(floorMiner, voter, stake, 'floor-lock')]);
    const down = potBlock(GENESIS + 1000, floorMiner, [
      voteTx({ from: floorMiner, dest: voter, choice: VOTE_DECREASE, id: 'floor-down' }),
    ]);
    assert.equal(HASH_BONUS_NANOS_FLOOR, 1);
    const seated = vaultAfterBlock(null, opened);
    const denied = vaultAfterBlock(seated.vault, down);
    assert.equal(denied.ok, false);
    expectSupplyReject([opened, down], 'unit-floor');
  });

  it('rejects a mid-epoch withdraw, and a same-block lock does not earn that epoch', () => {
    const miner = minerDest();
    const portal = portalDest();
    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const mid = [
      potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 'mid-lock')]),
      potBlock(GENESIS + Math.floor(EPOCH_MS / 2), miner, [
        drawOf(portal, miner, PI_SHE_NANOS + interest, 'mid-draw'),
      ]),
    ];
    expectSupplyReject(mid, 'mid-epoch');

    const again = minerDest();
    const who = portalDest();
    const added = 38;
    const withLock = interestNanos(PI_SHE_NANOS + added, GENESIS_BPS);
    assert.equal(withLock, interest + 1);
    // A top-up opens in the new epoch. That credit stays locked. Taking it,
    // or paying it this epoch's interest, is refused. The earlier principal
    // is payable in the same block.
    const before = [
      potBlock(GENESIS, again, [lockOf(again, who, PI_SHE_NANOS, 'pre-lock')]),
      potBlock(DRAW, again, [
        lockOf(again, who, added, 'pre-add'),
        drawOf(who, again, PI_SHE_NANOS + added + withLock, 'pre-draw'),
      ]),
    ];
    expectSupplyReject(before, 'lock-then-withdraw-old');
    const honest = [
      potBlock(GENESIS, again, [lockOf(again, who, PI_SHE_NANOS, 'pre-lock-ok')]),
      potBlock(DRAW, again, [
        lockOf(again, who, added, 'pre-add-ok'),
        drawOf(who, again, PI_SHE_NANOS + added + interest, 'pre-draw-ok'),
      ]),
    ];
    expectSupplyReject(honest, 'lock-then-withdraw');
    const released = [
      potBlock(GENESIS, again, [lockOf(again, who, PI_SHE_NANOS, 'own-lock')]),
      potBlock(DRAW, again, [
        lockOf(again, who, added, 'own-add'),
        drawOf(who, again, PI_SHE_NANOS + interest, 'own-draw'),
      ]),
    ];
    expectVerified(released, interest, 'old-principal-while-top-up-open');
    const after = [
      potBlock(GENESIS, again, [lockOf(again, who, PI_SHE_NANOS, 'post-lock')]),
      potBlock(DRAW, again, [
        drawOf(who, again, PI_SHE_NANOS + interest, 'post-draw'),
        lockOf(again, who, added, 'post-add'),
      ]),
    ];
    expectVerified(after, interest, 'withdraw-then-lock');
  });

  it('rejects a value above 2^53 and a running total at the u64 cap', () => {
    const stake = 2 ** 52;
    const one = interestNanos(stake, GENESIS_BPS);
    assert.equal(Number.isSafeInteger(one), true);
    assert.ok(one > 0);
    const miner = minerDest();
    const portal = portalDest();
    const honest = [
      potBlock(GENESIS, miner, [lockOf(miner, portal, stake, 'safe-lock')]),
      potBlock(DRAW, miner, [drawOf(portal, miner, stake + one, 'safe-draw')]),
    ];
    expectVerified(honest, one, 'near-2^53');

    const high = drawOf(portal, miner, stake + one, 'high-draw');
    high.nanos = ABOVE_SAFE.toString();
    const above = [
      potBlock(GENESIS, miner, [lockOf(miner, portal, stake, 'high-lock')]),
      potBlock(DRAW, miner, [high]),
    ];
    assert.equal(reserveAction(high).opened, false);
    expectSupplyReject(above, 'above-2^53');

    const parent = foldSupply([honest[0]], foldOpts());
    assert.equal(parent.ok, true);
    parent.state.mintedInterest = U64;
    parent.state.permittedInterest = U64;
    const vault = vaultAfterBlock(null, honest[0]);
    const stepped = supplyStep(parent.state, honest[1], {
      magic: MAGIC_TESTNET,
      unit: HASH_BONUS_NANOS,
      tipHeight: 2,
      height: 2,
      genesisMs: GENESIS,
      vault: vault.vault,
    });
    assert.equal(stepped.ok, false);
    assert.equal(stepped.reason, 'supply');
  });

  it('a reorg that drops the withdraw does not keep the minted interest', () => {
    const miner = minerDest();
    const portal = portalDest();
    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const lock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 're-lock')]);
    const draw = potBlock(DRAW, miner, [drawOf(portal, miner, PI_SHE_NANOS + interest, 're-draw')]);
    const empty = potBlock(DRAW, miner, []);
    expectVerified([lock, draw], interest, 'withdraw-fork');
    expectVerified([lock, empty], 0, 'reorg-fork');
    const rows = [{}, {}];
    const snap = fillSnapInterest(rows, [lock, empty]);
    assert.equal(snap.ok, true);
    assert.equal(rows[1].mintedInterest, 0n);
    assert.equal(rows[1].permittedInterest, 0n);
    const kept = fillSnapInterest([{}, {}], [lock, draw]);
    assert.equal(kept.ok, true);
  });

  it('trips lock conservation when locked-in is short of principal out', () => {
    const miner = minerDest();
    const portal = portalDest();
    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const lock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 'cons-lock')]);
    const draw = potBlock(DRAW, miner, [drawOf(portal, miner, PI_SHE_NANOS + interest, 'cons-draw')]);
    const parent = vaultAfterBlock(null, lock);
    assert.equal(parent.ok, true, parent.reason);
    const honest = blockWithdrawInterest(parent.vault, draw, DRAW);
    assert.equal(honest.ok, true, honest.reason);
    assert.equal(honest.nanos, BigInt(interest));

    // No lock tx in this block, so locked-in is 0. The withdraw clamps a short
    // book at 0 and principal out is left uncovered.
    const short = cloneVault(parent.vault);
    short.totalLockedNanos = 0n;
    const tripped = blockWithdrawInterest(short, draw, DRAW);
    assert.equal(tripped.ok, false);
    assert.equal(tripped.reason, 'supply');
    const trippedAllowed = blockPermittedInterest(short, draw, DRAW);
    assert.equal(trippedAllowed.ok, false);
    assert.equal(trippedAllowed.reason, 'supply');
    const folded = foldSupply([lock], foldOpts());
    assert.equal(folded.ok, true, folded.reason);
    const stepped = supplyStep(folded.state, draw, {
      magic: MAGIC_TESTNET,
      unit: HASH_BONUS_NANOS,
      tipHeight: 2,
      height: 2,
      genesisMs: GENESIS,
      vault: short,
    });
    assert.equal(stepped.ok, false);
    assert.equal(stepped.reason, 'supply');

    const over = cloneVault(parent.vault);
    over.totalLockedNanos = BigInt(PI_SHE_NANOS) + 5n;
    const still = blockWithdrawInterest(over, draw, DRAW);
    assert.equal(still.ok, true, still.reason);
    assert.equal(still.nanos, BigInt(interest));
  });

  it('rejects a multi-note withdraw, a note-less withdraw, and a kindless note', () => {
    const miner = minerDest();
    const portal = portalDest();
    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const payout = PI_SHE_NANOS + interest;
    const lock = potBlock(GENESIS, miner, [lockOf(miner, portal, PI_SHE_NANOS, 'note-lock')]);

    const multi = drawOf(portal, miner, payout, 'note-multi');
    multi.vout.push(drawOf(portal, miner, payout, 'note-multi-2').vout[0]);
    assert.equal(reserveAction(multi).opened, false);
    expectSupplyReject([lock, potBlock(DRAW, miner, [multi])], 'multi-note');

    const bare = drawOf(portal, miner, payout, 'note-bare');
    delete bare.vout[0].commit;
    delete bare.vout[0].valueProof;
    assert.equal(reserveAction(bare).opened, false);
    expectSupplyReject([lock, potBlock(DRAW, miner, [bare])], 'no-note');

    const hidden = drawOf(portal, miner, payout, 'note-kind');
    delete hidden.vout[0].kind;
    assert.equal(reserveAction(hidden).opened, false);
    assert.equal(explicitTypedKindRejected(hidden)?.reason, 'kind');
    expectSupplyReject([lock, potBlock(DRAW, miner, [hidden])], 'no-kind');

    const beside = drawOf(portal, miner, payout, 'note-beside');
    beside.vout.push({ commit: beside.vout[0].commit });
    assert.equal(reserveAction(beside).opened, true);
    assert.equal(explicitTypedKindRejected(beside)?.reason, 'kind');
    const parent = vaultAfterBlock(null, lock);
    const bound = boundReserveWithdraw(beside, parent.vault, null, DRAW);
    assert.equal(bound.ok, true, bound.reason);
  });

  it('verifyBlock does not reach supply until vault funding lands', async () => {
    // Stage 0 does not fund a vault tx. A sealed withdraw with an in-window
    // anchor gets past admit_anchor_window and stops at admit_version.
    // The byte-3 funding shape stops at vault_unavailable. supplyStep does
    // not run, so plus, minus, an offsetting pair, and an honest withdraw
    // share those reason codes. Snap fill still tells them apart.
    const chainMiner = minerDest();
    const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-vb-anchor-')));
    for (let i = 0; i < 16; i += 1) {
      const { job } = store.template({ miner: chainMiner, now: GENESIS + i * 90_000 });
      const sealed = await store.submitHeader({
        jobId: job.jobId,
        nonce: 0n,
        miner: chainMiner,
        powHash: `${'00'.repeat(31)}${(0x20 + i).toString(16).padStart(2, '0')}`,
      }, { trusted: true });
      assert.equal(sealed.ok, true, sealed.reason);
    }
    const parent = store.tip();
    const height = parent.height + 1;
    const anchor = walletAnchor(height);
    assert.equal(checkAdmitAnchor({ anchor }, height).ok, true);
    const parentTs = Number(decodeHeader(Buffer.from(parent.header)).timestamp);

    const interest = interestNanos(PI_SHE_NANOS, GENESIS_BPS);
    const payout = PI_SHE_NANOS + interest;
    const portal = portalDest();
    const other = portalDest();
    const lock = potBlock(GENESIS, chainMiner, [
      lockOf(chainMiner, portal, PI_SHE_NANOS, 'vb-lock'),
      lockOf(chainMiner, other, PI_SHE_NANOS, 'vb-lock-b'),
    ]);
    const vault = vaultAfterBlock(null, lock);
    assert.equal(vault.ok, true, vault.reason);

    async function verdictFor(rows) {
      const { tpl } = store.template({ miner: chainMiner, now: parentTs + 90_000 });
      const decoded = decodeHeader(Buffer.from(tpl.header));
      const txs = [tpl.txs[0], ...rows.map((tx) => compactTx(tx))];
      const header = encodeHeader({
        version: decoded.version,
        prevBlockHash: decoded.prevBlockHash,
        merkleRoot: merkleRoot(txs.map((tx) => digestTx(tx))),
        continuityRoot: decoded.continuityRoot,
        timestamp: decoded.timestamp,
        bits: decoded.bits,
        nonce: 0n,
        baseFee: decoded.baseFee,
      });
      return verifyBlock({
        header,
        txs,
        samples: tpl.samples,
        shareBatch: tpl.shareBatch || [],
        miner: tpl.miner,
        aLeaves: tpl.aLeaves,
        bLeaves: tpl.bLeaves,
        weight: tpl.weight,
        height,
      }, parent, {
        probeBody: true,
        genesisMs: GENESIS,
        magic: MAGIC_TESTNET,
        reserveState: vault.vault,
      });
    }

    function atAnchor(tx) {
      tx.anchor = anchor;
      return tx;
    }

    const honest = atAnchor(drawOf(portal, chainMiner, payout, 'vb-honest'));
    const plus = atAnchor(drawOf(portal, chainMiner, payout + 1, 'vb-plus'));
    const minus = atAnchor(drawOf(portal, chainMiner, payout - 1, 'vb-minus'));
    const high = atAnchor(drawOf(portal, chainMiner, payout + 5, 'vb-off-high'));
    const low = atAnchor(drawOf(other, chainMiner, payout - 5, 'vb-off-low'));
    expectVerified([lock, potBlock(DRAW, chainMiner, [honest])], interest, 'vb-honest');
    expectSupplyReject([lock, potBlock(DRAW, chainMiner, [plus])], 'vb-plus');
    expectSupplyReject([lock, potBlock(DRAW, chainMiner, [minus])], 'vb-minus');
    expectSupplyReject([lock, potBlock(DRAW, chainMiner, [high, low])], 'vb-offset');

    for (const row of [
      { name: 'honest', txs: [honest] },
      { name: 'plus', txs: [plus] },
      { name: 'minus', txs: [minus] },
      { name: 'offset', txs: [high, low] },
    ]) {
      const got = await verdictFor(row.txs);
      assert.equal(got.ok, false, row.name);
      assert.equal(got.reason, 'admit_version', `${row.name} ${got.reason}`);
    }

    const unanchored = drawOf(portal, chainMiner, payout, 'vb-window');
    const windowed = await verdictFor([unanchored]);
    assert.equal(windowed.ok, false);
    assert.equal(windowed.reason, 'admit_anchor_window', windowed.reason);

    const funded = drawOf(portal, chainMiner, payout, 'vb-fund');
    const ct = Buffer.alloc(32, 7);
    funded.anchor = anchor;
    funded.vin = [{ commit: ct }];
    funded.admit_proof = {
      blob: Buffer.concat([Buffer.from([3]), Buffer.alloc(40, 1)]),
      cTilde: ct,
    };
    const stage0 = await verdictFor([funded]);
    assert.equal(stage0.ok, false);
    assert.equal(stage0.reason, 'vault_unavailable', stage0.reason);

    const bare = atAnchor(drawOf(portal, chainMiner, payout, 'vb-bare'));
    delete bare.vout[0].commit;
    delete bare.vout[0].valueProof;
    const noteLess = await verdictFor([bare]);
    assert.equal(noteLess.ok, false);
    assert.equal(noteLess.reason, 'mint_amount', noteLess.reason);
  });
});
