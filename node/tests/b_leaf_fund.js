/**
 * Fund a B leaf by spending a real pot.
 * The lock is part of the conservation inputs only when lockInInputs is set.
 * A send that already balances and also carries a unit is the free-leaf case.
 *
 * R28: a coinbase carries no pot note. A payer mines solo with option (b)
 * (Russell 28 Oct): its empty-round template pays the pot to a fresh
 * one-time key of its wallet, and the payer finds that coin in the block's
 * record with its scan key. Every template built here for a payer's dest
 * pays that way.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildTemplate, GENESIS_PREV, retarget } from '../src/chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { bProof } from '../../crypto/clearing.js';
import { hashBonusUnitNanos } from '../../crypto/asert.js';
import { openedCoinbaseNanos, sealNote } from '../../crypto/note.js';
import { attachAdmitPub } from '../../crypto/admit.js';
import { attachStubAdmitV2 } from './stub_admit_v2.js';
import { attachDummyOuts } from '../../crypto/dummy.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { signSpendTx } from '../../crypto/spend.js';
import {
  admitBaseFromAddress,
  ed25519SeedOf,
  freshStealthDest,
  hash20FromAddress,
  newIdentity,
  stealthKey,
} from '../../crypto/address.js';
import { LEVY_CAP_NANOS, LEVY_FLOOR_UNITS, levyNeed } from '../../crypto/levy.js';
import { bluWallet, soloCoin, soloPay } from './support/blunote_mine.js';

export const T0 = 1_700_000_000_000;
export const PAY_NANOS = 1;

let powTag = 1;
export function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

// A payer's dest -> its wallet (spend base and scan key), for solo option (b).
const soloWallets = new Map();

/** The wallet a payer's dest mines solo for, or null. */
export function soloWalletOf(dest) {
  return soloWallets.get(String(dest || '')) || null;
}

export function payerIdentity() {
  const id = newIdentity();
  const pay = freshStealthDest(id);
  const spendSeed = id.spendSeed || ed25519SeedOf(id.privateKey);
  const blu = bluWallet(spendSeed);
  soloWallets.set(pay.dest, blu);
  return {
    id,
    dest: pay.dest,
    spendSeed,
    blu,
    key: stealthKey(pay.shared, spendSeed),
  };
}

export function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = createStore(dir);
  return {
    dir,
    store,
    close() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function asBlock(tpl) {
  return {
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples || [],
    shareBatch: tpl.shareBatch || [],
    miner: tpl.miner,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  };
}

export function stampNow(store) {
  const t = store.tip();
  if (!t?.header) return T0;
  return Number(decodeHeader(Buffer.from(t.header)).timestamp) + 90_000;
}

/** The coin a stored block paid its miner's wallet (solo option b), or null. */
export function potOutput(block, miner = block?.miner) {
  const blu = soloWalletOf(miner);
  return blu ? soloCoin(blu, block) : null;
}

export function openedPot(block, miner = block?.miner) {
  const pot = potOutput(block, miner);
  if (!pot) return null;
  return Number.isSafeInteger(pot.opened) ? pot.opened : null;
}

/** The template note, before append strips the blinding. The chain row keeps the commit. */
export function retainNote(o) {
  if (!o?.commit || !o?.r) return null;
  // A record coin is already its owner's opening.
  if (o.kind === 'pool-fee' && o.x != null) return o;
  return {
    kind: o.kind,
    commit: o.commit,
    noteCommit: o.noteCommit,
    admitPub: o.admitPub,
    r: o.r,
    dest20: o.dest20,
    valueProof: o.valueProof,
    rangeProof: o.rangeProof,
    address: o.address,
  };
}

/** Units that fit in one pot after a 1-nanos pay and the levy cap. Any pot size. */
export function fundedUnitSpread(opened) {
  if (!Number.isSafeInteger(opened) || opened <= 0) return null;
  const room = opened - PAY_NANOS - LEVY_CAP_NANOS;
  if (!Number.isSafeInteger(room) || room <= (2 ** 20)) return null;
  const third = Math.floor(room / 3);
  const units = [1, 2 ** 20, third];
  if (new Set(units).size !== units.length) return null;
  if (units.some((n) => !Number.isSafeInteger(n) || n <= 0 || n > room)) return null;
  return units;
}

export function sealMintOut(amount, dest, kind) {
  const d20 = hash20FromAddress(dest);
  if (!d20 || Buffer.from(d20).length !== 20) return null;
  let note = sealNote(amount, { dest20: Buffer.from(d20), kind });
  note.address = dest;
  note = attachAdmitPub(note, { admitBase: admitBaseFromAddress(dest) });
  return note;
}

export function templateOn(store, { miner, txs = [], bLeaves, now } = {}) {
  const stamp = now != null ? now : stampNow(store);
  const t = store.tip();
  const hashBonusNanos = hashBonusUnitNanos(store.reserveVault?.liveHashBonusNanos);
  const blu = soloWalletOf(miner);
  const pay = blu ? soloPay(blu) : {};
  if (!t) {
    return buildTemplate({
      ...pay,
      prev: GENESIS_PREV,
      height: 1,
      miner,
      now: stamp,
      txs,
      bLeaves,
      shareBatch: [],
      hashBonusNanos,
    });
  }
  return buildTemplate({
    ...pay,
    prev: t.hash,
    prevHeader: t.header,
    prevBlock: t,
    parentWeight: t.weight,
    height: t.height + 1,
    miner,
    txs,
    now: stamp,
    bits: retarget(store.blocks, stamp),
    parentBlocks: store.blocks,
    parentFluxset: store.fluxset(),
    hashBonusNanos,
    shareBatch: [],
    bLeaves,
  });
}

export function appendTpl(store, tpl) {
  return Promise.resolve(store.append(asBlock(tpl), {
    trustedPowHash: easyPowHash(),
    skipSharePow: true,
  }));
}

export function sealEmpty(store, miner, now) {
  const tpl = templateOn(store, { miner, now });
  return appendTpl(store, tpl).then((got) => ({
    ...got,
    pot: got.ok ? potOutput(store.tip(), miner) : null,
  }));
}

/**
 * A real Flow spend of the tip pot.
 * ask + lockInInputs pays the unit from the opened note.
 * ask without lockInInputs balances the note and still carries the unit.
 */
export function balancedSend(store, payer, {
  unit = 0,
  lockInInputs = false,
  ask = false,
  nonce = 0,
  id = 'b-ask',
  fee = LEVY_FLOOR_UNITS,
  spentNote = null,
} = {}) {
  const spent = spentNote;
  // A record coin states its opened value; an explicit note opens by proof.
  const opened = spent ? (Number.isSafeInteger(spent.opened) ? spent.opened : openedCoinbaseNanos(spent)) : null;
  if (!spent?.r || !Number.isSafeInteger(opened) || opened <= 0) {
    return { ok: false, reason: 'no_pot_open' };
  }
  const lock = lockInInputs ? unit : 0;
  if (typeof lock !== 'number' || !Number.isSafeInteger(lock) || lock < 0) {
    return { ok: false, reason: 'unit_does_not_fit', opened };
  }
  const change = opened - PAY_NANOS - fee - lock;
  if (!Number.isSafeInteger(change) || change < 0) {
    return { ok: false, reason: 'unit_does_not_fit', opened, fee, unit };
  }
  const dest20 = Buffer.from(hash20FromAddress(payer.dest));
  const vout = [{ address: payer.dest, nanos: PAY_NANOS, kind: 'send' }];
  if (change > 0) vout.push({ address: payer.dest, nanos: change, kind: 'send' });
  let tx = {
    id,
    kind: 'send',
    from: payer.dest,
    to: payer.dest,
    nanos: PAY_NANOS,
    fee,
    changeNanos: change,
    vin: [{ commit: spent.commit, address: payer.dest }],
    vout,
  };
  if (ask) {
    tx.bFlag = 1;
    tx.unit = unit;
    tx.dest20 = dest20;
    tx.nonce = nonce;
  }
  tx = attachDummyOuts(tx, { spent });
  tx = attachStubAdmitV2(tx);
  if (!tx.admit_proof || !tx.excess) return { ok: false, reason: 'prove', tx };
  signSpendTx(tx, payer.key);
  const wire = compactTx(tx);
  const need = levyNeed(wire);
  return { ok: true, tx, wire, need, fee, opened, change };
}

export async function sealBalanced(store, payer, opts = {}) {
  let fee = LEVY_FLOOR_UNITS;
  let built = null;
  for (let i = 0; i < 8; i += 1) {
    built = balancedSend(store, payer, { ...opts, fee });
    if (!built.ok) return built;
    if (built.need <= fee && fee <= LEVY_CAP_NANOS) break;
    if (built.need > LEVY_CAP_NANOS) return { ok: false, reason: 'levy_cap', need: built.need };
    fee = built.need;
  }
  if (!built?.ok) return built || { ok: false, reason: 'prove' };
  if (built.need > built.fee) return { ok: false, reason: 'levy', need: built.need, fee: built.fee };
  const tpl = templateOn(store, { miner: payer.dest, txs: [built.wire] });
  // A byte-2 flow proof is admit_version. The leaf is not published.
  const got = await appendTpl(store, tpl);
  const tip = got.ok ? store.tip() : null;
  const nextPot = tip ? potOutput(tip, payer.dest) : null;
  const leaves = tip?.bLeaves || [];
  const leaf = leaves[0] || null;
  return {
    ...built,
    got,
    nextPot,
    tip,
    leaf,
    leaves,
    proof: leaf ? bProof(leaves, 0) : null,
    height: tip?.height || 0,
  };
}
