import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEVM } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { hexToBytes, bytesToHex, createAddressFromString, createAccount } from '@ethereumjs/util';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { hash20FromAddress, encodeDest } from './address.js';
import { RESERVE_PROGRAM, RESERVE_EPOCH_MS, MAGIC_TESTNET } from './asert.js';
import { EMPTY_ROOT } from './merkle.js';
import { reserveAction, blockRewardRoot, packRewardProof, rewardOwnerCommit, packRewardAuth } from './reserve_vault.js';
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { ED25519_SPKI_PREFIX } from './address.js';
import { parseCoinbaseObserve } from './reserve_oracle.js';
import { asU8 } from './note.js';

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

export function shearMagicBytes(network = MAGIC_TESTNET) {
  return keccak256(Buffer.from(String(network), 'utf8'));
}

/** True when the pinned creation bytecode contains this book's magic.
 *  A miss is the constructor revert `reserve_deploy`. */
export function reservePinOk(network = MAGIC_TESTNET) {
  const hash = Buffer.from(shearMagicBytes(network)).toString('hex');
  const code = String(RESERVE_BYTECODE || '').replace(/^0x/i, '').toLowerCase();
  return hash.length === 64 && code.includes(hash);
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

function ownerWord(ownerCommit) {
  const word = new Uint8Array(32);
  if (ownerCommit == null || ownerCommit === '') return word;
  const raw = Buffer.isBuffer(ownerCommit)
    ? ownerCommit
    : Buffer.from(String(ownerCommit).replace(/^0x/i, ''), 'hex');
  if (raw.length === 32) word.set(raw);
  return word;
}

export function encodeDeposit(dest, nanos, nowTs, ownerCommit = null) {
  const body = encodeBytes(dest);
  return concat(
    selector('lock(bytes,uint256,uint256,bytes32)'),
    pad32(128),
    pad32(nanos),
    pad32(nowTs),
    ownerWord(ownerCommit),
    body,
  );
}

/** Time-locked note. The bool is the tranche flag withdraw() will not pay. */
export function encodeLockNote(dest, nanos, nowTs, notePrincipal = true, ownerCommit = null) {
  const body = encodeBytes(dest);
  return concat(
    selector('lockNote(bytes,uint256,uint256,bool,bytes32)'),
    pad32(160),
    pad32(nanos),
    pad32(nowTs),
    pad32(notePrincipal ? 1 : 0),
    ownerWord(ownerCommit),
    body,
  );
}

/** Keep this portal's legacy principal for the withdraw later in the block. */
export function encodeHoldWithdraw(dest) {
  const body = encodeBytes(dest);
  return concat(selector('holdWithdraw(bytes)'), pad32(32), body);
}

export function encodeClearWithdrawHolds() {
  return selector('clearWithdrawHolds()');
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

export function encodeCommitRewards(nowTs, rootHex = '') {
  const word = new Uint8Array(32);
  const raw = String(rootHex || '').replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(raw)) word.set(Buffer.from(raw, 'hex'));
  return concat(selector('commitRewards(uint256,bytes32)'), pad32(nowTs), word);
}

export function encodeClaim(nullifierHex, nanos, proof, rootIndex = 0, auth = new Uint8Array()) {
  const id = Buffer.from(String(nullifierHex || ''), 'hex');
  const word = new Uint8Array(32);
  if (id.length === 32) word.set(id);
  const raw = Buffer.isBuffer(proof) ? proof : Buffer.from(proof || []);
  const authRaw = Buffer.isBuffer(auth) ? auth : Buffer.from(auth || []);
  const proofBody = encodeBytes(raw);
  const authBody = encodeBytes(authRaw);
  const head = 32 * 5;
  return concat(
    selector('claim(bytes32,uint256,uint256,bytes,bytes)'),
    word,
    pad32(nanos),
    pad32(rootIndex),
    pad32(head),
    pad32(head + proofBody.length),
    proofBody,
    authBody,
  );
}

export function decodeBytes32(ret) {
  const b = ret instanceof Uint8Array ? ret : hexToBytes(ret);
  return Buffer.from(b.subarray(0, 32)).toString('hex');
}

export function encodeWithdraw(dest, nowTs, auth = new Uint8Array()) {
  const body = encodeBytes(dest);
  const authRaw = Buffer.isBuffer(auth) ? auth : Buffer.from(auth || []);
  const authBody = encodeBytes(authRaw);
  const head = 96;
  return concat(
    selector('withdraw(bytes,uint256,bytes)'),
    pad32(head),
    pad32(nowTs),
    pad32(head + body.length),
    body,
    authBody,
  );
}

export function encodeEnact(nowTs) {
  return concat(selector('enact(uint256)'), pad32(nowTs));
}

export function encodeObserveRate(bps, nowTs) {
  return concat(selector('observeRate(uint256,uint256)'), pad32(bps), pad32(nowTs));
}

export function encodeCommitRate(epochIdx, bps, nowTs, chainGenesis = 0) {
  return concat(
    selector('commitRate(uint256,uint256,uint256,uint256)'),
    pad32(epochIdx),
    pad32(bps),
    pad32(nowTs),
    pad32(chainGenesis),
  );
}

export function encodePinClock(chainGenesis) {
  return concat(selector('pinClock(uint256)'), pad32(chainGenesis));
}

export function encodeSyncEpoch(nowTs) {
  return concat(selector('syncEpoch(uint256)'), pad32(nowTs));
}

export function encodeHoldEpochRoll(hold) {
  return concat(selector('holdEpochRoll(bool)'), pad32(hold ? 1 : 0));
}

export function encodeRewardNanos(active, bps) {
  return concat(selector('rewardNanos(uint256,uint256)'), pad32(active), pad32(bps));
}

export function encodeTrimmedMean(tenths) {
  const vals = Array.isArray(tenths) ? tenths : [];
  return concat(
    selector('trimmedMeanBps(int256[])'),
    pad32(32),
    pad32(vals.length),
    ...vals.map((n) => pad32(n)),
  );
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

export function encodeCutoffLengthMs() {
  return selector('cutoffLengthMs()');
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

/** Qualified reward the withdraw left on the portal. The paid reward is zero. */
export function decodeWithdrawEarned(ret) {
  const b = ret instanceof Uint8Array ? ret : hexToBytes(ret);
  if (!b || b.length < 96) return 0;
  return Number(readU256(b, 64));
}

function evmRevertReason(res) {
  const ret = res?.execResult?.returnValue;
  if (ret && ret.length >= 4) {
    const sel = Buffer.from(ret.subarray(0, 4));
    if (sel.equals(Buffer.from(selector('ClaimUnavailable()')))) return 'claim_unavailable';
    if (sel.equals(Buffer.from(selector('OwnerMissing()')))) return 'owner_missing';
  }
  return String(res?.execResult?.exceptionError?.error || 'revert');
}

function shearCommon() {
  return createCustomCommon(
    { chainId: Number(SHEAR_EVM_CHAIN_ID), networkId: Number(SHEAR_EVM_CHAIN_ID) },
    Mainnet,
    { hardfork: Hardfork.Shanghai },
  );
}

const SYSTEM = createAddressFromString('0x0000000000000000000000000000000000002701');
const ED25519_PRECOMPILE = '0x0000000000000000000000000000000000000101';

/** Precompile 0x101. pubkey(32) || sig(64) || message → uint256 1 when the signature holds. */
function ed25519Precompile(opts) {
  const data = opts.data || new Uint8Array();
  const gasUsed = 3000n;
  const zero = new Uint8Array(32);
  if (opts.gasLimit < gasUsed) {
    return { executionGasUsed: opts.gasLimit, returnValue: zero };
  }
  if (data.length < 96) return { executionGasUsed: gasUsed, returnValue: zero };
  const pub = Buffer.from(data.subarray(0, 32));
  const sig = Buffer.from(data.subarray(32, 96));
  const msg = Buffer.from(data.subarray(96));
  let ok = false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pub]),
      format: 'der',
      type: 'spki',
    });
    ok = verifyEd25519(null, msg, key, sig);
  } catch {
    ok = false;
  }
  const out = new Uint8Array(32);
  if (ok) out[31] = 1;
  return { executionGasUsed: gasUsed, returnValue: out };
}

export async function bootReserveEvm({ network = MAGIC_TESTNET, bytecode = null } = {}) {
  const common = shearCommon();
  const evm = await createEVM({
    common,
    customPrecompiles: [{ address: ED25519_PRECOMPILE, function: ed25519Precompile }],
  });
  const magic = shearMagicBytes(network);
  const code = bytecode == null
    ? RESERVE_BYTECODE
    : (String(bytecode).startsWith('0x') ? String(bytecode) : `0x${bytecode}`);
  const ctor = concat(hexToBytes(code), magic);
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
  const gasUsed = res.execResult.executionGasUsed;
  if (res.execResult.exceptionError) {
    return {
      ok: false,
      reason: evmRevertReason(res),
      returnValue: res.execResult.returnValue,
      gasUsed,
    };
  }
  return { ok: true, returnValue: res.execResult.returnValue, gasUsed };
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
  return k === 'lock' || k === 'vote' || k === 'withdraw' || k === 'reward-claim';
}

export function isEvmValueTx(tx) {
  if (!tx || tx.coinbase) return false;
  return txKindOf(tx) === 'evm-value';
}

export function encodeNextEpochBps() {
  return selector('nextEpochBps()');
}

export function encodeRateCommitEpoch() {
  return selector('rateCommitEpoch()');
}

export function encodeEpochRateOf(epochIdx) {
  return concat(selector('epochRateOf(uint256)'), pad32(epochIdx));
}

export function decodeNextEpochBps(ret) {
  const b = ret instanceof Uint8Array ? ret : hexToBytes(ret);
  return Number(readU256(b, 0));
}

export function blockNeedsEvm(txs) {
  const list = Array.isArray(txs) ? txs : [];
  if (list[0]?.coinbase && (list[0].observe != null || list[0].rateCommit != null || list[0].rewardRoot)) return true;
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

function destBytesForEvm(tx, act) {
  const s = txDestOf(tx) || txFromOf(tx) || act?.dest || act?.payout || '';
  if (s) return s;
  const d20 = tx?.vout?.[0]?.dest20 || tx?.vin?.[0]?.dest20;
  if (d20) {
    try { return encodeDest(Buffer.from(asU8(d20))); } catch { return Buffer.from(asU8(d20)); }
  }
  return '';
}

export async function executeReserveTx(session, tx, nowMs) {
  const kind = txKindOf(tx);
  const act = reserveAction(tx);
  const dest = destBytesForEvm(tx, act);
  const nanos = act ? act.nanos : txNanosOf(tx);
  if (kind === 'evm-value') {
    return transferEvmShe(session, { from: txFromOf(tx), to: dest, nanos });
  }
  if (kind === 'lock') {
    if (!dest) return { ok: true };
    const pub = String(tx?.spendPub || '').replace(/^0x/i, '');
    const commit = /^[0-9a-fA-F]{64}$/.test(pub) ? rewardOwnerCommit(pub) : null;
    return callReserve(session, encodeDeposit(dest, nanos, nowMs, commit));
  }
  if (kind === 'vote') {
    const choice = VOTE_NUM[String(tx.choice || act?.choice || '').toLowerCase()] || Number(tx.choice) || 1;
    if (!dest) return { ok: true };
    return callReserve(session, encodeVote(dest, choice, nowMs));
  }
  if (kind === 'reward-claim') {
    const proof = tx?.evmProof || tx?.proof;
    const packed = Buffer.isBuffer(proof) ? proof : packRewardProof(proof);
    const auth = packRewardAuth({ ownerPub: tx.spendPub, sig: tx.sig, dest: tx.to || dest }) || new Uint8Array();
    const rootIndex = Math.floor(Number(tx.rootIndex) || 0);
    return callReserve(session, encodeClaim(tx?.nullifier || '', nanos || 0, packed || Buffer.alloc(0), rootIndex, auth));
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
    const from = txFromOf(tx) || dest;
    if (!from) return { ok: true };
    const auth = tx?.rewardSig
      ? packRewardAuth({ ownerPub: tx.spendPub, sig: tx.rewardSig, dest: tx.to || dest })
      : new Uint8Array();
    return callReserve(session, encodeWithdraw(from, nowMs, auth || new Uint8Array()));
  }
  return { ok: false, reason: 'evm_kind' };
}

/** Chain settlement index from the public view. Epoch 0 before it ends is 0. */
function evmSettlementIndex(view, nowMs, genesisMs) {
  const span = RESERVE_EPOCH_MS;
  const g = Number(genesisMs) || 0;
  const now = Number(nowMs) || 0;
  const chain = g > 0 && now > g ? Math.floor((now - g) / span) : 0;
  const start = Number(view?.epochStartMs) || 0;
  const ended = start > 0 && now >= start + span;
  if (chain <= 0 && !ended) return 0;
  return chain;
}

const EMPTY_REWARD_ROOT = Buffer.from(EMPTY_ROOT).toString('hex');

/** Run pinned Reserve bytecode + EVM SHE value for a block body. Fail closed. */
export async function executeBlockEvm(session, txs, nowMs, genesisMs = 0, owedRoot = undefined) {
  const evm = { totalLocked: 0, valueMoved: 0, calls: 0 };
  const list = Array.isArray(txs) ? txs : [];
  const cb = list[0] || null;
  let held = false;
  const fail = (reason) => ({ ok: false, reason });
  try {
    if (Number(genesisMs) > 0) {
      const pinned = await callReserve(session, encodePinClock(genesisMs));
      if (!pinned.ok) return fail(pinned.reason || 'clock');
      evm.calls += 1;
    }
    // Commit before the roll. Opening the epoch marks its rate known, and a
    // commit of that same index would then revert.
    if (cb?.rateCommit && typeof cb.rateCommit === 'object') {
      const epochIdx = Math.floor(Number(cb.rateCommit.epochIndex) || 0);
      const bps = Math.floor(Number(cb.rateCommit.epochBps) || 0);
      const committed = await callReserve(session, encodeCommitRate(epochIdx, bps, nowMs, genesisMs));
      if (!committed.ok) return fail(committed.reason || 'rate_commit');
      evm.calls += 1;
      evm.committedBps = bps;
    }
    let view0 = null;
    const prior = await callReserve(session, encodePublicView(nowMs), { staticCall: true });
    if (prior.ok) {
      view0 = decodePublicView(prior.returnValue);
      if (view0.bonusEnacted) {
        const rolled = await callReserve(session, encodeSyncEpoch(nowMs));
        if (!rolled.ok) return fail(rolled.reason || 'epoch');
        const again = await callReserve(session, encodePublicView(nowMs), { staticCall: true });
        if (again.ok) view0 = decodePublicView(again.returnValue);
      }
      const ended = view0.epochStartMs && nowMs >= view0.epochStartMs + RESERVE_EPOCH_MS;
      if (ended && !view0.bonusEnacted) {
        const en = await callReserve(session, encodeEnact(nowMs));
        if (!en.ok) return fail(en.reason || 'enact');
      }
    }
    const rootHex = blockRewardRoot({ txs: list });
    if (rootHex === 'bad') return fail('stake_reward');
    const withdrawing = list.some((tx) => tx && !tx.coinbase && txKindOf(tx) === 'withdraw');
    for (const tx of list) {
      if (!tx || tx.coinbase) continue;
      if (txKindOf(tx) !== 'withdraw') continue;
      const heldDest = txFromOf(tx) || destBytesForEvm(tx, reserveAction(tx));
      if (!heldDest) continue;
      const held = await callReserve(session, encodeHoldWithdraw(heldDest));
      if (!held.ok) return fail(held.reason || 'evm');
      evm.calls += 1;
    }
    // A withdraw does not excuse a missing root. The contract stores the
    // root it is given. It does not build the tree. A non-empty owed root
    // with nothing on the coinbase is stake_reward. An empty earning set
    // still commits the empty root and does not store it.
    const oweRoot = withdrawing && evmSettlementIndex(view0, nowMs, genesisMs) > 0;
    const owedGiven = owedRoot != null;
    const owed = !owedGiven || owedRoot === ''
      ? ''
      : String(owedRoot).replace(/^0x/i, '').toLowerCase();
    if (owed && owed !== rootHex) return fail('stake_reward');
    if (owedGiven && owed === '' && rootHex && rootHex !== EMPTY_REWARD_ROOT) return fail('stake_reward');
    // A withdraw after the epoch, with no root on the coinbase, and no
    // explicit empty expectation from JS, is not an empty earning set.
    if (oweRoot && !rootHex && owedRoot !== '') return fail('stake_reward');
    if (rootHex || oweRoot) {
      const pass = rootHex || EMPTY_REWARD_ROOT;
      const sm = session.evm.stateManager;
      await sm.checkpoint();
      const committed = await callReserve(session, encodeCommitRewards(nowMs, pass));
      const got = committed.ok ? decodeBytes32(committed.returnValue) : '';
      if (!committed.ok || got !== pass) {
        await sm.revert();
        return fail('stake_reward');
      }
      await sm.commit();
      evm.calls += 1;
    }
    if (list.slice(1).some((tx) => isReserveCall(tx) || isEvmValueTx(tx))) {
      const on = await callReserve(session, encodeHoldEpochRoll(true));
      if (!on.ok) return fail(on.reason || 'epoch');
      held = true;
    }
    for (const tx of list.slice(1)) {
      if (!isReserveCall(tx) && !isEvmValueTx(tx)) continue;
      const got = await executeReserveTx(session, tx, nowMs);
      if (!got.ok) {
        if (isEvmValueTx(tx)) {
          evm.calls += 1;
          evm.failed = (evm.failed || 0) + 1;
          continue;
        }
        return fail(got.reason || 'evm');
      }
      evm.calls += 1;
      evm.valueMoved += Number(got.valueMoved || 0);
      if (txKindOf(tx) === 'withdraw' && got.returnValue) {
        evm.withdrawInterest = decodeWithdraw(got.returnValue).interest;
        evm.withdrawEarned = decodeWithdrawEarned(got.returnValue);
      }
    }
    if (cb?.observe != null) {
      const parsed = parseCoinbaseObserve(cb);
      if (!parsed.ok || !parsed.observe) return fail('bad_rate');
      const called = await callReserve(
        session,
        encodeObserveRate(parsed.observe.annualBps, parsed.observe.observedAtMs),
      );
      if (!called.ok) return fail(called.reason || 'bad_rate');
      evm.calls += 1;
    }
    const view = decodePublicView(
      (await callReserve(session, encodePublicView(nowMs), { staticCall: true })).returnValue,
    );
    evm.totalLocked = view.totalLockedNanos;
    evm.liveHashBonusNanos = view.liveHashBonusNanos;
    const cleared = await callReserve(session, encodeClearWithdrawHolds());
    if (!cleared.ok) return fail(cleared.reason || 'evm');
    return { ok: true, ...evm };
  } finally {
    if (held) await callReserve(session, encodeHoldEpochRoll(false));
    if (session) await callReserve(session, encodeClearWithdrawHolds());
  }
}

export { bytesToHex, SYSTEM, createAddressFromString, RESERVE_PROGRAM };
