import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEVM } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { hexToBytes, bytesToHex, createAddressFromString, createAccount } from '@ethereumjs/util';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hash20FromAddress } from './address.js';
import { RESERVE_PROGRAM, RESERVE_EPOCH_MS } from './asert.js';

function keccak256(data) {
  const u8 = data instanceof Uint8Array ? data : Buffer.from(data);
  return keccak_256(u8);
}

export const SHEAR_EVM_CHAIN_ID = 2701n;
export const GENESIS_HASH_BONUS_NANOS = 1n;
const PIN = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../contracts/Reserve.json'),
  'utf8',
));

export const RESERVE_ABI = PIN.abi;
export const RESERVE_BYTECODE = PIN.bytecode.startsWith('0x') ? PIN.bytecode : `0x${PIN.bytecode}`;

export function shearMagicBytes(network = 'shear-testnet-v2') {
  return keccak256(Buffer.from(String(network), 'utf8'));
}

export function reserveAddress() {
  return createAddressFromString(
    bytesToHex(keccak256(Buffer.from('shear-reserve-v1', 'utf8')).subarray(12)),
  );
}

function pad32(n) {
  const b = new Uint8Array(32);
  let x = BigInt(n);
  if (x < 0n) x = (1n << 256n) + x;
  for (let i = 31; i >= 0; i -= 1) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

function concat(...parts) {
  const arr = parts.map((p) => (p instanceof Uint8Array ? p : hexToBytes(p)));
  const len = arr.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of arr) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function selector(sig) {
  return keccak256(Buffer.from(sig, 'utf8')).subarray(0, 4);
}

export function encodeBytes(data) {
  const raw = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const len = pad32(raw.length);
  const padded = new Uint8Array(Math.ceil(raw.length / 32) * 32 || 32);
  padded.set(raw);
  return concat(len, padded);
}

export function encodeDeposit(dest, nanos, nowTs) {
  const body = encodeBytes(dest);
  return concat(
    selector('deposit(bytes,uint256,uint256)'),
    pad32(96),
    pad32(nanos),
    pad32(nowTs),
    body,
  );
}

export function encodeVote(dest, choice, nowTs) {
  const body = encodeBytes(dest);
  return concat(
    selector('vote(bytes,uint8,uint256)'),
    pad32(96),
    pad32(choice),
    pad32(nowTs),
    body,
  );
}

export function encodeWithdraw(dest, nowTs) {
  const body = encodeBytes(dest);
  return concat(
    selector('withdraw(bytes,uint256)'),
    pad32(64),
    pad32(nowTs),
    body,
  );
}

export function encodeEnact(nowTs) {
  return concat(selector('enact(uint256)'), pad32(nowTs));
}

export function encodeObserveRate(bps, nowTs) {
  return concat(selector('observeRate(uint256,uint256)'), pad32(bps), pad32(nowTs));
}

export function encodePublicView(nowTs) {
  return concat(selector('publicView(uint256)'), pad32(nowTs));
}

export function encodePortalOf(dest) {
  const body = encodeBytes(dest);
  return concat(selector('portalOf(bytes)'), pad32(32), body);
}

export function encodeLiveBonus() {
  return selector('liveHashBonusNanos()');
}

function readU256(buf, off = 0) {
  let n = 0n;
  for (let i = 0; i < 32; i += 1) n = (n << 8n) + BigInt(buf[off + i] || 0);
  return n;
}

export function decodePublicView(ret) {
  const b = ret instanceof Uint8Array ? ret : hexToBytes(ret);
  return {
    epochStartMs: Number(readU256(b, 0)),
    remainingDays: Number(readU256(b, 32)),
    totalLockedNanos: Number(readU256(b, 64)),
    votesIncrease: Number(readU256(b, 96)),
    votesDecrease: Number(readU256(b, 128)),
    votesHold: Number(readU256(b, 160)),
    oracleBps: Number(readU256(b, 192)),
    liveHashBonusNanos: Number(readU256(b, 224)),
    bonusEnacted: readU256(b, 256) !== 0n,
    currentEpoch: Number(readU256(b, 288)),
  };
}

export function decodePortal(ret) {
  const b = ret instanceof Uint8Array ? ret : hexToBytes(ret);
  const vote = Number(readU256(b, 64));
  const names = [null, 'increase bonus', 'decrease bonus', 'leave bonus as-is'];
  return {
    staked: Number(readU256(b, 0)),
    idle: Number(readU256(b, 32)),
    vote: names[vote] || null,
    joined: readU256(b, 96) !== 0n,
    voteEpoch: Number(readU256(b, 128)),
  };
}

export function decodeWithdraw(ret) {
  const b = ret instanceof Uint8Array ? ret : hexToBytes(ret);
  return {
    principal: Number(readU256(b, 0)),
    interest: Number(readU256(b, 32)),
  };
}

function shearCommon() {
  return createCustomCommon(
    { chainId: Number(SHEAR_EVM_CHAIN_ID), networkId: Number(SHEAR_EVM_CHAIN_ID) },
    Mainnet,
    { hardfork: Hardfork.Shanghai },
  );
}

const SYSTEM = createAddressFromString('0x0000000000000000000000000000000000002701');

export async function bootReserveEvm({ network = 'shear-testnet-v2' } = {}) {
  const common = shearCommon();
  const evm = await createEVM({ common });
  const magic = shearMagicBytes(network);
  const ctor = concat(hexToBytes(RESERVE_BYTECODE), magic);
  const created = await evm.runCall({
    caller: SYSTEM,
    data: ctor,
    gasLimit: 8_000_000n,
    origin: SYSTEM,
    block: { header: { timestamp: 0n, number: 0n, coinbase: SYSTEM, gasLimit: 30_000_000n, baseFeePerGas: 1n } },
  });
  if (created.execResult.exceptionError) {
    throw new Error(`reserve_deploy: ${created.execResult.exceptionError.error}`);
  }
  const to = created.createdAddress;
  if (!to) throw new Error('reserve_deploy: no address');
  return { evm, address: to, common };
}

export async function callReserve(session, data, { staticCall = false, value = 0n, caller } = {}) {
  const { evm, address } = session;
  const from = caller || SYSTEM;
  const val = BigInt(value || 0n);
  if (val > 0n) await fundAccount(evm, from, val + 1_000_000n);
  const res = await evm.runCall({
    caller: from,
    to: address,
    value: val,
    data: data instanceof Uint8Array ? data : hexToBytes(data),
    gasLimit: 8_000_000n,
    origin: from,
    isStatic: staticCall,
  });
  if (res.execResult.exceptionError) {
    return { ok: false, reason: String(res.execResult.exceptionError.error || 'revert'), returnValue: res.execResult.returnValue };
  }
  return { ok: true, returnValue: res.execResult.returnValue };
}

export function evmAddressFromDest(dest) {
  const h = hash20FromAddress(dest);
  if (!h || h.length < 20) return null;
  return createAddressFromString(`0x${Buffer.from(h).toString('hex')}`);
}

async function fundAccount(evm, addr, min) {
  const acc = await evm.stateManager.getAccount(addr);
  const bal = acc?.balance || 0n;
  const need = BigInt(min);
  if (bal >= need) return;
  await evm.stateManager.putAccount(addr, createAccount({
    nonce: acc?.nonce || 0n,
    balance: need,
  }));
}

export async function accountBalance(session, dest) {
  const addr = evmAddressFromDest(dest);
  if (!addr) return 0n;
  const acc = await session.evm.stateManager.getAccount(addr);
  return acc?.balance || 0n;
}

/** Native SHE as EVM value between ssa1 20-byte accounts. Empty data, EOA dest. */
export async function transferEvmShe(session, { from, to, nanos }) {
  const { evm } = session;
  const fromAddr = evmAddressFromDest(from);
  const toAddr = evmAddressFromDest(to);
  if (!fromAddr || !toAddr) return { ok: false, reason: 'bad_dest' };
  const value = BigInt(Math.floor(Number(nanos) || 0));
  if (value <= 0n) return { ok: false, reason: 'bad_nanos' };
  await fundAccount(evm, fromAddr, value + 1_000_000n);
  const beforeTo = (await evm.stateManager.getAccount(toAddr))?.balance || 0n;
  const res = await evm.runCall({
    caller: fromAddr,
    to: toAddr,
    value,
    data: new Uint8Array(),
    gasLimit: 100_000n,
    origin: fromAddr,
  });
  if (res.execResult.exceptionError) {
    return { ok: false, reason: String(res.execResult.exceptionError.error || 'revert') };
  }
  const afterTo = (await evm.stateManager.getAccount(toAddr))?.balance || 0n;
  return { ok: true, valueMoved: Number(afterTo - beforeTo) };
}

function txKindOf(tx) {
  return String(tx?.kind || tx?.vout?.[0]?.kind || '');
}

function txDestOf(tx) {
  return tx?.to || tx?.vout?.[0]?.address || '';
}

function txFromOf(tx) {
  return tx?.from || tx?.vin?.[0]?.address || '';
}

function txNanosOf(tx) {
  return Math.floor(Number(tx?.nanos || tx?.vout?.[0]?.nanos || 0));
}

export function isReserveCall(tx) {
  if (!tx || tx.coinbase) return false;
  if (String(tx.programId || '') !== RESERVE_PROGRAM) return false;
  const k = txKindOf(tx);
  return k === 'lock' || k === 'vote' || k === 'withdraw';
}

export function isEvmValueTx(tx) {
  if (!tx || tx.coinbase) return false;
  return txKindOf(tx) === 'evm-value';
}

export function blockNeedsEvm(txs) {
  const list = Array.isArray(txs) ? txs : [];
  return list.some((tx) => isReserveCall(tx) || isEvmValueTx(tx));
}

const VOTE_NUM = {
  increase: 1,
  'increase bonus': 1,
  decrease: 2,
  'decrease bonus': 2,
  hold: 3,
  'leave bonus as-is': 3,
};

export async function executeReserveTx(session, tx, nowMs) {
  const kind = txKindOf(tx);
  const dest = txDestOf(tx) || txFromOf(tx);
  const nanos = txNanosOf(tx);
  if (kind === 'evm-value') {
    return transferEvmShe(session, { from: txFromOf(tx), to: dest, nanos });
  }
  if (kind === 'lock') {
    return callReserve(session, encodeDeposit(dest, nanos, nowMs));
  }
  if (kind === 'vote') {
    const choice = VOTE_NUM[String(tx.choice || '').toLowerCase()] || Number(tx.choice) || 1;
    return callReserve(session, encodeVote(dest, choice, nowMs));
  }
  if (kind === 'withdraw') {
    const viewGot = await callReserve(session, encodePublicView(nowMs), { staticCall: true });
    if (viewGot.ok) {
      const view = decodePublicView(viewGot.returnValue);
      const ended = view.epochStartMs && nowMs >= view.epochStartMs + RESERVE_EPOCH_MS;
      if (ended && !view.bonusEnacted) {
        const en = await callReserve(session, encodeEnact(nowMs));
        if (!en.ok) return en;
      }
    }
    return callReserve(session, encodeWithdraw(txFromOf(tx) || dest, nowMs));
  }
  return { ok: false, reason: 'evm_kind' };
}

/** Run pinned Reserve bytecode + EVM SHE value for a block body. Fail closed. */
export async function executeBlockEvm(session, txs, nowMs) {
  const evm = { totalLocked: 0, valueMoved: 0, calls: 0 };
  const prior = await callReserve(session, encodePublicView(nowMs), { staticCall: true });
  if (prior.ok) {
    const view0 = decodePublicView(prior.returnValue);
    const ended = view0.epochStartMs && nowMs >= view0.epochStartMs + RESERVE_EPOCH_MS;
    if (ended && !view0.bonusEnacted) {
      const en = await callReserve(session, encodeEnact(nowMs));
      if (!en.ok) return { ok: false, reason: en.reason || 'enact' };
    }
  }
  for (const tx of (txs || []).slice(1)) {
    if (!isReserveCall(tx) && !isEvmValueTx(tx)) continue;
    const got = await executeReserveTx(session, tx, nowMs);
    if (!got.ok) {
      if (isEvmValueTx(tx)) {
        evm.calls += 1;
        evm.failed = (evm.failed || 0) + 1;
        continue;
      }
      return { ok: false, reason: got.reason || 'evm' };
    }
    evm.calls += 1;
    evm.valueMoved += Number(got.valueMoved || 0);
  }
  const view = decodePublicView(
    (await callReserve(session, encodePublicView(nowMs), { staticCall: true })).returnValue,
  );
  evm.totalLocked = view.totalLockedNanos;
  evm.liveHashBonusNanos = view.liveHashBonusNanos;
  return { ok: true, ...evm };
}

export { bytesToHex, SYSTEM, createAddressFromString, RESERVE_PROGRAM };
