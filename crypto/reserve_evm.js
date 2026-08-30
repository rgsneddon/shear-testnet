import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEVM } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { hexToBytes, bytesToHex, createAddressFromString } from '@ethereumjs/util';
import { keccak_256 } from '@noble/hashes/sha3.js';

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

export async function callReserve(session, data, { staticCall = false } = {}) {
  const { evm, address } = session;
  const res = await evm.runCall({
    caller: SYSTEM,
    to: address,
    data: data instanceof Uint8Array ? data : hexToBytes(data),
    gasLimit: 8_000_000n,
    origin: SYSTEM,
    isStatic: staticCall,
  });
  if (res.execResult.exceptionError) {
    return { ok: false, reason: String(res.execResult.exceptionError.error || 'revert'), returnValue: res.execResult.returnValue };
  }
  return { ok: true, returnValue: res.execResult.returnValue };
}

export { bytesToHex, SYSTEM, createAddressFromString };
