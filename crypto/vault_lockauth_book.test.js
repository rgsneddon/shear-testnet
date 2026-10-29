/**
 * LOCK_AUTH=book-magic. The lock owner signature binds the book's own magic
 * (and chainId 2701), the JS check verifies under the book that applies the
 * block, and the EVM is booted as that same book. A lockAuth signed for one
 * book is refused on the other, and a missing magic throws `unknown_magic`
 * instead of falling back to testnet. FEE_TAU_MS is gone from the law.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as asert from './asert.js';
import * as levy from './levy.js';
import {
  DEST_HRP,
  FEE_TARGET_WEIGHT,
  MAGIC_TESTNET,
  PI_SHE_NANOS,
  consensusFingerprint,
  consensusLaw,
  mainnetFingerprint,
} from './asert.js';
import { MAGIC_MAINNET, epochMs } from './pot_sched.js';
import { hash20FromAddress, newIdentity, spendDestOf } from './address.js';
import { txDigestV3 } from './admit_v3.js';
import { reserveAuth, signSpendTx } from './spend.js';
import {
  applyReserveBlock,
  attachLockEquality,
  chainPeriodIndex,
  cloneVault,
  coinbaseRewardRoot,
  consensusUnlockPeriod,
  emptyVault,
  leafEpochsToBurn,
  lockTx,
  portalIdFromDest20,
  provePrincipalOpen,
  signWithdrawReward,
  withdrawSignedDest,
  withdrawTx,
} from './reserve_vault.js';
import {
  SHEAR_EVM_CHAIN_ID,
  attachLockAuth,
  bootReserveEvm,
  callReserve,
  executeBlockEvm,
  selector,
  shearMagicBytes,
  verifyLockAuth,
} from './reserve_evm.js';
import { arrivalStubNanos } from './vault_accrual.js';
import { GENESIS_BPS } from './reserve_oracle.js';
import { proveLeafRetire, vaultLockNote } from './vault_reward_fs1.js';
import * as supply from '../node/src/supply.js';

const T0 = 1_700_000_000_000;
const LOCK_HEIGHT = 100;
const BOOKS = [MAGIC_TESTNET, MAGIC_MAINNET];
const other = (book) => (book === MAGIC_MAINNET ? MAGIC_TESTNET : MAGIC_MAINNET);

function who() {
  const id = newIdentity();
  return { id, dest: spendDestOf(id.spendPub), pub: Buffer.from(id.spendPub).toString('hex'), key: id.privateKey };
}

/** One π note lock for `book`, with the π proof and no lockAuth yet. */
function noteLock(book, owner, id) {
  const scalar = 81n + BigInt(id.length);
  const blind = 83n + BigInt(id.length);
  const unlock = consensusUnlockPeriod(0);
  const leaf = vaultLockNote(PI_SHE_NANOS, scalar, blind, unlock);
  const tx = lockTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS, blind, ownerPub: owner.pub, id });
  // The EVM and the replay gate key the portal by dest20 = H(spendPub).
  const pid = portalIdFromDest20(hash20FromAddress(owner.dest));
  tx.portalId = pid;
  for (const out of tx.vout) if (out?.kind === 'lock') out.portalId = pid;
  tx.vaultLockNote = leaf.note;
  assert.ok(attachLockEquality(tx, book), 'π proof');
  return { tx, leaf, scalar, blind, unlock, pid };
}

function bookState(book) {
  const state = emptyVault();
  state.genesisMs = T0;
  state.magic = book;
  return state;
}

const cb = () => ({ coinbase: true, vout: [] });

/** The compact FS-1 form a block replays: no spendPub, the owner is lockAuth. */
function compactLock(tx) {
  const view = {
    ...tx,
    fs1: Buffer.from([0xf1, 0x01]),
    vin: [{ commit: Buffer.alloc(32, 1) }],
    admit_proofs: [{ blob: Buffer.from([0xf1]), cTilde: Buffer.alloc(32, 2), spendTag: Buffer.alloc(32, 3) }],
  };
  delete view.spendPub;
  delete view.sig;
  delete view.signature;
  return view;
}

describe('LOCK_AUTH=book-magic', () => {
  it('(a) an honest lock then withdraw passes JS and the EVM, on each book', async () => {
    for (const book of BOOKS) {
      const owner = who();
      const state = bookState(book);
      const lock = noteLock(book, owner, `lock-${book}`);
      attachLockAuth(lock.tx, owner.key, book);
      assert.ok(lock.tx.lockAuth, `${book} lockAuth`);
      assert.equal(verifyLockAuth(lock.tx, book), owner.pub, `${book} verify`);
      const auth = reserveAuth(compactLock(lock.tx), state, null, book);
      assert.equal(auth.ok, true, `${book} JS reserveAuth ${auth.reason}`);
      const locked = applyReserveBlock({
        state,
        block: { height: LOCK_HEIGHT, txs: [cb(), lock.tx] },
        nowMs: T0,
        height: LOCK_HEIGHT,
        genesisMs: T0,
      });
      assert.equal(locked.ok, true, `${book} JS lock ${locked.reason}`);
      const session = await bootReserveEvm({ network: book });
      const evmLock = await executeBlockEvm(session, [cb(), lock.tx], T0, T0, undefined, undefined, { height: LOCK_HEIGHT, magic: book });
      assert.equal(evmLock.ok, true, `${book} EVM lock ${evmLock.reason}`);

      const drawAt = T0 + epochMs(book);
      const stub = arrivalStubNanos({ amount: PI_SHE_NANOS, lockHeight: LOCK_HEIGHT, magic: book, rate: GENESIS_BPS });
      const portal = lock.pid;
      const tx = withdrawTx({ from: owner.dest, to: owner.dest, nanos: PI_SHE_NANOS + Number(stub.nanos), id: `wd-${book}`, portalId: portal });
      const noteHex = lock.leaf.note.toString('hex');
      const stored = BigInt(state.vaultLeafUnlock[noteHex]);
      const period = chainPeriodIndex(state, drawAt);
      const retire = proveLeafRetire({
        scalar: lock.scalar,
        epochs: leafEpochsToBurn(state, noteHex, period),
        leaf: lock.leaf.note,
        txBind: txDigestV3(tx, book),
        unlockEpoch: period,
        magic: book,
      });
      assert.ok(retire, `${book} retire`);
      tx.principalProof = provePrincipalOpen(lock.leaf.commit, PI_SHE_NANOS, lock.blind, tx, portal, book, stored);
      tx.retireProof = retire.proof;
      signWithdrawReward(tx, owner.key, { portalId: portal, nanos: PI_SHE_NANOS, dest: withdrawSignedDest(tx), state, nowMs: drawAt });
      const owed = coinbaseRewardRoot(state, drawAt);
      const jsState = cloneVault(state);
      const drawn = applyReserveBlock({
        state: jsState,
        block: { height: LOCK_HEIGHT + 1, txs: [cb(), tx] },
        nowMs: drawAt,
        height: LOCK_HEIGHT + 1,
        genesisMs: T0,
      });
      assert.equal(drawn.ok, true, `${book} JS withdraw ${drawn.reason}`);
      const evmDraw = await executeBlockEvm(session, [{ ...cb(), rewardRoot: owed }, tx], drawAt, T0, owed, undefined, { height: LOCK_HEIGHT + 1, magic: book });
      assert.equal(evmDraw.ok, true, `${book} EVM withdraw ${evmDraw.reason}`);
    }
  });

  it('(b) a lockAuth signed for one book is refused on the other, JS and EVM', async () => {
    for (const book of BOOKS) {
      const owner = who();
      const lock = noteLock(other(book), owner, `x-${book}`);
      // Signed for the other book, presented to this one.
      attachLockAuth(lock.tx, owner.key, other(book));
      assert.ok(lock.tx.lockAuth);
      assert.equal(verifyLockAuth(lock.tx, other(book)), owner.pub, 'own book verifies');
      assert.equal(verifyLockAuth(lock.tx, book), null, `${book} refuses ${other(book)} lockAuth`);
      const auth = reserveAuth(compactLock(lock.tx), bookState(book), null, book);
      assert.equal(auth.ok, false, `${book} JS`);
      const session = await bootReserveEvm({ network: book });
      const ran = await executeBlockEvm(session, [cb(), lock.tx], T0, T0, undefined, undefined, { height: LOCK_HEIGHT, magic: book });
      assert.equal(ran.ok, false, `${book} EVM refuses`);
    }
  });

  it('(c) a missing magic throws unknown_magic on sign, verify and boot', async () => {
    const owner = who();
    const lock = noteLock(MAGIC_TESTNET, owner, 'no-magic');
    assert.throws(() => attachLockAuth(lock.tx, owner.key), /unknown_magic/);
    assert.throws(() => signSpendTx(lock.tx, owner.key), /unknown_magic/);
    attachLockAuth(lock.tx, owner.key, MAGIC_TESTNET);
    assert.throws(() => verifyLockAuth(lock.tx), /unknown_magic/);
    assert.throws(() => verifyLockAuth(lock.tx, ''), /unknown_magic/);
    await assert.rejects(() => bootReserveEvm(), /unknown_magic/);
    await assert.rejects(() => bootReserveEvm({}), /unknown_magic/);
    // The JS gate refuses, it does not default to testnet.
    const bare = emptyVault();
    delete bare.magic;
    for (const state of [null, bare]) {
      const got = reserveAuth(compactLock(lock.tx), state, null);
      assert.deepEqual({ ok: got.ok, reason: got.reason }, { ok: false, reason: 'unknown_magic' });
    }
    // A book that applies the block passes its own magic.
    assert.equal(reserveAuth(compactLock(lock.tx), null, null, MAGIC_TESTNET).ok, true);
    assert.equal(reserveAuth(compactLock(lock.tx), emptyVault(), null).ok, true);
    // A non-lock spend needs no book.
    const send = { kind: 'send', vin: [], vout: [] };
    assert.doesNotThrow(() => attachLockAuth(send, owner.key));
    // Chain id stays 2701 on both books.
    assert.equal(SHEAR_EVM_CHAIN_ID, 2701n);
    for (const book of BOOKS) {
      const s = await bootReserveEvm({ network: book });
      const m = await callReserve(s, selector('magic()'), { staticCall: true });
      assert.equal(Buffer.from(m.returnValue).equals(Buffer.from(shearMagicBytes(book))), true, book);
    }
  });

  it('(d) the fingerprint names LOCK_AUTH and no longer names FEE_TAU_MS', () => {
    for (const fp of [consensusFingerprint(MAGIC_TESTNET), consensusFingerprint(MAGIC_MAINNET), mainnetFingerprint()]) {
      const parts = fp.split(':');
      assert.ok(parts.includes('LOCK_AUTH=book-magic'), 'LOCK_AUTH token');
      // FEE_TAU_MS (90000) sat between DEST_HRP and FEE_TARGET_WEIGHT.
      const hrp = parts.indexOf(DEST_HRP);
      assert.ok(hrp > 0, 'DEST_HRP');
      assert.equal(parts[hrp + 1], String(FEE_TARGET_WEIGHT), 'FEE_TARGET_WEIGHT follows DEST_HRP');
    }
    assert.equal(Object.prototype.hasOwnProperty.call(consensusLaw(), 'feeTauMs'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(asert, 'FEE_TAU_MS'), false, 'asert export');
    assert.equal(Object.prototype.hasOwnProperty.call(levy, 'FEE_TAU_MS'), false, 'levy export');
  });

  it('(e) the supply spread is unchanged: honest lock blocks mint nothing on either book', () => {
    const counts = [1, 2, 3, 5, 8];
    for (const book of BOOKS) {
      for (const n of counts) {
        const state = bookState(book);
        const txs = [cb()];
        for (let i = 0; i < n; i += 1) {
          const owner = who();
          const lock = noteLock(book, owner, `spread-${book}-${n}-${i}`);
          attachLockAuth(lock.tx, owner.key, book);
          assert.equal(reserveAuth(compactLock(lock.tx), state, null, book).ok, true, `${book} ${n} ${i}`);
          txs.push(lock.tx);
        }
        const before = cloneVault(state);
        const got = applyReserveBlock({ state, block: { height: LOCK_HEIGHT, txs }, nowMs: T0, height: LOCK_HEIGHT, genesisMs: T0 });
        assert.equal(got.ok, true, `${book} ${n} ${got.reason}`);
        assert.equal(BigInt(state.mintBankNanos || 0), BigInt(before.mintBankNanos || 0), `${book} ${n} mint bank`);
        assert.equal(supply.vaultMintDeltaRejected(before, state, 0n), null, `${book} ${n} ledger delta`);
      }
    }
  });
});
