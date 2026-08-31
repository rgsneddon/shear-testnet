import fs from 'node:fs';
import path from 'node:path';
import { MAGIC_TESTNET, templateStampMs } from '../../crypto/asert.js';
import { hashHex } from '../../crypto/shear_hash.js';
import {
  buildTemplate,
  verifyBlock,
  blockNeedsEvm,
  retarget,
  GENESIS_PREV,
  publicJob,
  headerHash,
  SAMPLE_PRUNE_CONFIRMATIONS,
  shouldPruneSamples,
  pruneSamples,
  leanBlock,
  sealedExplorerRows,
  lag1Continuity,
  shouldAdopt,
  chainWorkOf,
} from './chain.js';
import { decodeHeader } from '../../crypto/header.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { compactChainBlock } from '../../crypto/chronoflux.js';
import { setNonce } from '../../crypto/header.js';
import { requiredJobFields } from '../../crypto/header.js';
import { emptyVault, applyReserveBlock } from '../../crypto/reserve_vault.js';
import { emptyOracle } from '../../crypto/reserve_oracle.js';
import { emptyJoin, applyJoinBlock, validateJoinBlock } from '../../crypto/join_vault.js';
import { explorerSpendable } from '../../crypto/chronoflux.js';
import { createVorticeCatalog } from './vortice.js';
import { writeChainBin, readChainBin } from '../../crypto/chainbin.js';
import { blockWeight } from '../../crypto/levy.js';
import { admitMempool, emptyMempool, retargetMempool } from '../../crypto/mempool.js';
import { blockWork } from '../../crypto/asert.js';
import {
  emptyPolicyState,
  recordReorg,
  applySignals,
  getpolicy as policyView,
  hashRatioFromHours,
} from '../../crypto/confirm_policy.js';

function toRow(block) {
  const compact = compactChainBlock(block);
  return {
    ...compact,
    header: Buffer.from(block.header).toString('hex'),
    hash: Buffer.from(block.hash).toString('hex'),
  };
}

function hex32(h) {
  if (Buffer.isBuffer(h)) return h.toString('hex');
  return String(h || '');
}

function workOfBlock(block) {
  try {
    return blockWork(decodeHeader(Buffer.from(block.header)).bits);
  } catch {
    return 0;
  }
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i += 1) {
    if (!Buffer.from(a[i].hash).equals(Buffer.from(b[i].hash))) break;
  }
  return i;
}

function txIdOf(tx) {
  return String(tx?.id || '');
}

function potIdsOf(block) {
  const hid = hex32(block.hash);
  const ids = [];
  const cb = (block.txs || [])[0];
  if (cb?.coinbase && Array.isArray(cb.vout)) {
    for (const o of cb.vout) {
      if (o.kind === 'hash' || o.kind === 'finder-fee' || o.kind === 'reserve-fee') continue;
      ids.push(`${hid}-${o.kind || 'cb'}`);
    }
  }
  return ids;
}

export function createStore(dir, {
  pruneAfter = SAMPLE_PRUNE_CONFIRMATIONS,
  reorgHaltDepth = Number(process.env.SHEAR_REORG_HALT_DEPTH || 0),
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chain.jsonl');
  const binFile = path.join(dir, 'chain.bin');
  const explorerFile = path.join(dir, 'explorer.jsonl');
  const vaultFile = path.join(dir, 'reserve.json');
  const blocks = [];
  const explorer = [];
  const spentB = new Set();
  const headers = new Map();
  const forks = new Map();
  const listeners = { reorg: [], credits_frozen: [], tip: [] };
  const reorgs = [];
  let policyState = emptyPolicyState();
  const pause = { join: false, reserveInterest: false, poolWithdraw: false };
  const haltDepth = Math.max(0, Math.floor(Number(reorgHaltDepth) || 0));
  let evmSession = null;

  if (fs.existsSync(binFile)) {
    for (const b of readChainBin(binFile)) {
      blocks.push(b);
    }
  } else if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const b = JSON.parse(line);
      b.header = Buffer.from(b.header, 'hex');
      b.hash = Buffer.from(b.hash, 'hex');
      blocks.push(b);
    }
  }

  function on(ev, fn) {
    if (!listeners[ev]) listeners[ev] = [];
    listeners[ev].push(fn);
    return () => {
      listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn);
    };
  }

  function emit(ev, payload) {
    for (const fn of listeners[ev] || []) {
      try { fn(payload); } catch { /* keep */ }
    }
  }

  function rememberHeaders(chain, status) {
    if (!Array.isArray(chain)) return;
    for (const b of chain) {
      let prev = '';
      try {
        prev = Buffer.from(decodeHeader(Buffer.from(b.header)).prevBlockHash).toString('hex');
      } catch { prev = ''; }
      const h = hex32(b.hash);
      headers.set(h, {
        hash: h,
        height: Number(b.height || 0),
        work: workOfBlock(b),
        status,
        prev,
      });
    }
  }

  function rememberFork(chain, status) {
    if (!Array.isArray(chain) || !chain.length) return;
    rememberHeaders(chain, status);
    const tipB = chain[chain.length - 1];
    forks.set(hex32(tipB.hash), { blocks: chain.slice(), work: chainWorkOf(chain), status });
  }

  function writeExplorer() {
    const body = explorer.map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(explorerFile, body ? `${body}\n` : '');
  }

  function rebuildExplorer() {
    explorer.length = 0;
    for (const b of blocks) explorer.push(...sealedExplorerRows(b));
    writeExplorer();
  }

  function indexSealed(block) {
    const rows = sealedExplorerRows(block);
    explorer.push(...rows);
    if (rows.length) {
      fs.appendFileSync(explorerFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    }
    return rows;
  }

  rebuildExplorer();
  rememberHeaders(blocks, 'active');

  const reserveVault = emptyVault();
  const loadedOracle = (() => {
    if (!fs.existsSync(vaultFile)) return emptyOracle();
    try {
      const raw = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
      return raw?.oracle || emptyOracle();
    } catch {
      return emptyOracle();
    }
  })();
  reserveVault.oracle = loadedOracle;

  function saveReserve() {
    fs.writeFileSync(vaultFile, JSON.stringify(reserveVault));
  }

  function blockTimeMs(block) {
    try {
      return Number(decodeHeader(Buffer.from(block.header)).timestamp);
    } catch {
      return Date.now();
    }
  }

  function applyReserve(block) {
    applyReserveBlock({ state: reserveVault, block, nowMs: blockTimeMs(block) });
    saveReserve();
  }

  function replayVault() {
    const oracle = reserveVault.oracle || emptyOracle();
    const fresh = emptyVault();
    fresh.oracle = oracle;
    for (const k of Object.keys(reserveVault)) delete reserveVault[k];
    Object.assign(reserveVault, fresh);
    reserveVault.portals = Object.create(null);
    reserveVault.votes = { increase: 0, decrease: 0, hold: 0 };
    for (const b of blocks) {
      applyReserveBlock({ state: reserveVault, block: b, nowMs: blockTimeMs(b) });
    }
    saveReserve();
  }

  replayVault();

  const joinFile = path.join(dir, 'join.json');
  const joinVault = emptyJoin();
  function saveJoin() {
    fs.writeFileSync(joinFile, JSON.stringify(joinVault));
  }
  function applyJoin(block) {
    applyJoinBlock({ state: joinVault, block, nowMs: blockTimeMs(block) });
    saveJoin();
  }
  function replayJoin() {
    const fresh = emptyJoin({
      genesisMs: 0,
      root: joinVault.root,
      circulatingNanos: 0,
    });
    for (const k of Object.keys(joinVault)) delete joinVault[k];
    Object.assign(joinVault, fresh);
    joinVault.claimed = Object.create(null);
    for (const b of blocks) {
      applyJoinBlock({ state: joinVault, block: b, nowMs: blockTimeMs(b) });
    }
    saveJoin();
  }
  replayJoin();

  const vortice = createVorticeCatalog(dir);

  function persist(_block) {
    rewriteChain();
  }

  function rewriteChain() {
    writeChainBin(binFile, blocks);
    const body = blocks.map((b) => JSON.stringify(toRow(b))).join('\n');
    fs.writeFileSync(file, body ? `${body}\n` : '');
  }

  function tip() {
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  function pruneBuried() {
    const tipH = tip()?.height || 0;
    let dirty = false;
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      if (b.samplesPruned) continue;
      if (!shouldPruneSamples(b.height, tipH, pruneAfter)) continue;
      blocks[i] = pruneSamples(b);
      dirty = true;
    }
    if (dirty) rewriteChain();
    return dirty;
  }

  function hourlyWork(nowMs) {
    const buckets = Array(24).fill(0);
    for (const b of blocks) {
      const ts = blockTimeMs(b);
      const ago = nowMs - ts;
      if (ago < 0 || ago >= 24 * 3_600_000) continue;
      const i = 23 - Math.floor(ago / 3_600_000);
      if (i >= 0 && i < 24) buckets[i] += workOfBlock(b);
    }
    return buckets;
  }

  function sideLeadWork() {
    const active = blocks.length ? chainWorkOf(blocks) : 0;
    const activeHash = tip() ? hex32(tip().hash) : '';
    let best = 0;
    for (const [h, f] of forks) {
      if (h === activeHash) continue;
      const w = Number(f.work) || 0;
      if (w > best) best = w;
    }
    return best - active;
  }

  function refreshPolicy({ newBlock = false, reorgDepth = 0, nowMs = Date.now() } = {}) {
    if (reorgDepth > 0) {
      policyState = recordReorg(policyState, { depth: reorgDepth, atMs: nowMs });
    }
    const before = policyState.frozen;
    policyState = applySignals(policyState, {
      nowMs,
      h_ratio: hashRatioFromHours(hourlyWork(nowMs)),
      side_lead: sideLeadWork(),
      newBlock,
    });
    if (before !== policyState.frozen) {
      emit('credits_frozen', {
        frozen: policyState.frozen,
        reason: policyState.freezeReason,
        d_max: policyState.d_max,
        side_lead: policyState.side_lead,
        h_ratio: policyState.h_ratio,
      });
    }
  }

  function rebuildSpentB() {
    spentB.clear();
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      const prev = i === 0 ? null : {
        hash: blocks[i - 1].hash,
        header: blocks[i - 1].header,
        height: blocks[i - 1].height,
        rootA: blocks[i - 1].rootA,
        rootB: blocks[i - 1].rootB,
        txs: blocks[i - 1].txs,
        bLeaves: blocks[i - 1].bLeaves,
        weight: blocks[i - 1].weight,
      };
      const spentCheck = verifyBlock(b, prev, {
        buried: !!b.samplesPruned,
        joinFunded: !!joinVault.genesisMs,
        spentB,
        tipHeight: b.height,
        hashBonusNanos: reserveVault.liveHashBonusNanos || 1,
      });
      if (spentCheck && typeof spentCheck.then === 'function') {
        spentCheck.catch(() => {});
      }
    }
  }

  function bounceMempool(disconnected, connected) {
    const winnerIds = new Set();
    const winnerInputs = new Set();
    for (const b of connected || []) {
      for (const tx of (b.txs || []).slice(1)) {
        const id = txIdOf(tx);
        if (id) winnerIds.add(id);
        for (const vin of tx.vin || []) {
          winnerInputs.add(`${vin.prev || ''}:${vin.index}`);
        }
      }
    }
    for (let i = mempool.length - 1; i >= 0; i -= 1) {
      const tx = mempool[i];
      const id = txIdOf(tx);
      const spent = (tx.vin || []).some((v) => winnerInputs.has(`${v.prev || ''}:${v.index}`));
      if ((id && winnerIds.has(id)) || spent) mempool.splice(i, 1);
    }
    let base = 1;
    const t = tip();
    try {
      if (t?.header) base = Number(decodeHeader(Buffer.from(t.header)).baseFee || 1n);
    } catch { base = 1; }
    const book = emptyMempool();
    book.txs = mempool;
    for (const b of disconnected || []) {
      for (const tx of (b.txs || []).slice(1)) {
        if (tx?.coinbase) continue;
        const id = txIdOf(tx);
        if (id && winnerIds.has(id)) continue;
        const spent = (tx.vin || []).some((v) => winnerInputs.has(`${v.prev || ''}:${v.index}`));
        if (spent) continue;
        if (id && mempool.some((m) => txIdOf(m) === id)) continue;
        admitMempool(book, {
          ...tx,
          kind: tx.kind || 'send',
          to: tx.to || tx.vout?.[0]?.address,
          from: tx.from || tx.vin?.[0]?.address,
          nanos: tx.nanos || tx.vout?.[0]?.nanos,
          fee: tx.fee,
        }, { baseFee: base });
      }
    }
    mempool.length = 0;
    mempool.push(...book.txs);
  }

  function makeReorgEvent({ fromBlocks, toBlocks, lca }) {
    const disconnected = fromBlocks.slice(lca);
    const connected = toBlocks.slice(lca);
    const fromB = fromBlocks[fromBlocks.length - 1];
    const toB = toBlocks[toBlocks.length - 1];
    const forkB = lca > 0 ? fromBlocks[lca - 1] : null;
    const depth = disconnected.length;
    const forkHeight = lca > 0 ? Number(fromBlocks[lca - 1].height || lca) : 0;
    const tipH = Number(toB?.height || toBlocks.length);
    const samples_pruned = forkHeight > 0 && (tipH - forkHeight) >= SAMPLE_PRUNE_CONFIRMATIONS;
    const orphaned_txids = [];
    const orphaned_pots = [];
    for (const b of disconnected) {
      orphaned_pots.push(...potIdsOf(b));
      for (const tx of (b.txs || []).slice(1)) {
        const id = txIdOf(tx);
        if (id) orphaned_txids.push(id);
      }
    }
    return {
      type: 'reorg',
      from_hash: fromB ? hex32(fromB.hash) : '',
      to_hash: toB ? hex32(toB.hash) : '',
      fork_hash: forkB ? hex32(forkB.hash) : '',
      from_height: Number(fromB?.height || fromBlocks.length),
      to_height: Number(toB?.height || toBlocks.length),
      depth,
      work_delta: chainWorkOf(toBlocks) - chainWorkOf(fromBlocks),
      orphaned_txids,
      orphaned_pots,
      disconnected: disconnected.map((b) => Number(b.height || 0)),
      connected: connected.map((b) => Number(b.height || 0)),
      samples_pruned,
    };
  }

  function getchaintips() {
    const activeHash = tip() ? hex32(tip().hash) : '';
    const inActive = new Set(blocks.map((b) => hex32(b.hash)));
    const hasChild = new Set();
    for (const rec of headers.values()) {
      if (rec.prev) hasChild.add(rec.prev);
    }
    const out = [];
    const seen = new Set();
    if (tip()) {
      out.push({
        height: Number(tip().height || blocks.length),
        hash: activeHash,
        branchlen: 0,
        status: 'active',
      });
      seen.add(activeHash);
    }
    for (const rec of headers.values()) {
      if (hasChild.has(rec.hash)) continue;
      if (seen.has(rec.hash)) continue;
      seen.add(rec.hash);
      let lca = 0;
      let walk = rec;
      let guard = 0;
      while (walk && !inActive.has(walk.hash) && guard++ < 10_000) {
        lca += 1;
        walk = walk.prev ? headers.get(walk.prev) : null;
      }
      out.push({
        height: rec.height,
        hash: rec.hash,
        branchlen: lca,
        status: rec.status === 'valid-headers' ? 'valid-headers' : 'valid-fork',
      });
    }
    return out.sort((a, b) => b.height - a.height || a.status.localeCompare(b.status));
  }

  function settleCheck(check, onOk) {
    if (check && typeof check.then === 'function') {
      return check.then((c) => (c?.ok ? onOk(c) : c));
    }
    if (!check?.ok) return check;
    return onOk(check);
  }

  function append(block) {
    const prev = tip();
    const check = verifyBlock(block, prev ? {
      hash: prev.hash,
      header: prev.header,
      height: prev.height,
      rootA: prev.rootA,
      rootB: prev.rootB,
      txs: prev.txs,
      bLeaves: prev.bLeaves,
      weight: prev.weight,
    } : null, {
      joinFunded: !!joinVault.genesisMs,
      spentB,
      tipHeight: prev ? prev.height + 1 : 1,
      hashBonusNanos: reserveVault.liveHashBonusNanos || 1,
      buried: !!block.samplesPruned,
      evmSession,
      evmHistory: blocks,
    });
    return settleCheck(check, (okCheck) => completeAppend(okCheck, block));
  }

  function completeAppend(check, block) {
    if (!check.ok) return check;
    const prev = tip();
    const gated = validateJoinBlock({
      state: joinVault,
      block,
      nowMs: blockTimeMs(block),
    });
    if (!gated.ok) return gated;
    const stored = leanBlock({
      ...block,
      magic: MAGIC_TESTNET,
      hash: check.hash,
      height: prev ? prev.height + 1 : 1,
      weight: block.weight ?? blockWeight(block.txs || [], block.bLeaves || []),
    });
    blocks.push(stored);
    persist(stored);
    indexSealed(stored);
    rememberHeaders([stored], 'active');
    {
      const sealedIds = new Set((stored.txs || []).map((t) => String(t.id || '')));
      for (let i = mempool.length - 1; i >= 0; i -= 1) {
        if (sealedIds.has(String(mempool[i].id))) mempool.splice(i, 1);
      }
    }
    applyReserve(stored);
    applyJoin(stored);
    for (const tx of (stored.txs || []).slice(1)) {
      if (String(tx.kind || '') === 'vortice-register' && typeof vortice.registerFromTx === 'function') {
        vortice.registerFromTx(tx);
      }
    }
    pruneBuried();
    try {
      const bf = Number(decodeHeader(Buffer.from(stored.header)).baseFee || 1n);
      const book = emptyMempool();
      book.txs = mempool.slice();
      const { dropped } = retargetMempool(book, bf);
      mempool.length = 0;
      mempool.push(...book.txs);
      void dropped;
    } catch { /* keep */ }
    refreshPolicy({ newBlock: true, nowMs: blockTimeMs(stored) });
    emit('tip', { hash: hex32(stored.hash), height: stored.height });
    if (check.evmSession) evmSession = check.evmSession;
    return { ok: true, block: stored, evmSession: check.evmSession || evmSession };
  }

  function queueTx(tx) {
    if (pause.join && String(tx?.kind || '') === 'claim') {
      return { ok: false, reason: 'paused' };
    }
    if (pause.reserveInterest && tx?.mint && String(tx.kind || '') !== 'lock' && String(tx.kind || '') !== 'vote') {
      return { ok: false, reason: 'paused' };
    }
    if (pause.poolWithdraw && String(tx?.kind || '') === 'pool-withdraw') {
      return { ok: false, reason: 'paused' };
    }
    let base = 1;
    const t = tip();
    try {
      if (t?.header) base = Number(decodeHeader(Buffer.from(t.header)).baseFee || 1n);
    } catch { base = 1; }
    const book = emptyMempool();
    book.txs = mempool;
    return admitMempool(book, tx, { baseFee: base });
  }

  function verifyOneForkBlock(fork, i, accepted, joinFunded, trialSpent, trialSession = null) {
    const prev = i === 0 ? null : {
      hash: accepted[i - 1].hash,
      header: accepted[i - 1].header,
      height: accepted[i - 1].height,
      rootA: accepted[i - 1].rootA,
      rootB: accepted[i - 1].rootB,
      txs: accepted[i - 1].txs,
      bLeaves: accepted[i - 1].bLeaves,
      weight: accepted[i - 1].weight,
    };
    return verifyBlock(fork[i], prev, {
      joinFunded,
      buried: !!fork[i].samplesPruned,
      spentB: trialSpent,
      tipHeight: i + 1,
      hashBonusNanos: reserveVault.liveHashBonusNanos || 1,
      evmSession: trialSession,
      evmHistory: trialSession ? [] : accepted,
    });
  }

  function verifyFork(fork) {
    const needs = (fork || []).some((b) => blockNeedsEvm(b?.txs || []));
    if (needs) return verifyForkAsync(fork);
    const accepted = [];
    let joinFunded = false;
    const trialJoin = emptyJoin();
    const trialSpent = new Set();
    for (let i = 0; i < fork.length; i += 1) {
      const check = verifyOneForkBlock(fork, i, accepted, joinFunded, trialSpent);
      if (!check.ok) return { ok: false, reason: check.reason, at: i };
      const gated = validateJoinBlock({
        state: trialJoin,
        block: fork[i],
        nowMs: blockTimeMs(fork[i]),
      });
      if (!gated.ok) return { ok: false, reason: gated.reason, at: i };
      applyJoinBlock({ state: trialJoin, block: fork[i], nowMs: blockTimeMs(fork[i]) });
      if (trialJoin.genesisMs) joinFunded = true;
      accepted.push(leanBlock({
        ...fork[i],
        magic: MAGIC_TESTNET,
        hash: check.hash,
        height: i + 1,
        weight: fork[i].weight ?? blockWeight(fork[i].txs || [], fork[i].bLeaves || []),
      }));
    }
    return { ok: true, accepted };
  }

  async function verifyForkAsync(fork) {
    const accepted = [];
    let joinFunded = false;
    const trialJoin = emptyJoin();
    const trialSpent = new Set();
    let trialSession = null;
    for (let i = 0; i < fork.length; i += 1) {
      const check = await Promise.resolve(
        verifyOneForkBlock(fork, i, accepted, joinFunded, trialSpent, trialSession),
      );
      if (check.evmSession) trialSession = check.evmSession;
      if (!check.ok) return { ok: false, reason: check.reason, at: i };
      const gated = validateJoinBlock({
        state: trialJoin,
        block: fork[i],
        nowMs: blockTimeMs(fork[i]),
      });
      if (!gated.ok) return { ok: false, reason: gated.reason, at: i };
      applyJoinBlock({ state: trialJoin, block: fork[i], nowMs: blockTimeMs(fork[i]) });
      if (trialJoin.genesisMs) joinFunded = true;
      accepted.push(leanBlock({
        ...fork[i],
        magic: MAGIC_TESTNET,
        hash: check.hash,
        height: i + 1,
        weight: fork[i].weight ?? blockWeight(fork[i].txs || [], fork[i].bLeaves || []),
      }));
    }
    return { ok: true, accepted };
  }

  function adopt(fork) {
    if (!Array.isArray(fork) || !fork.length) return { ok: false, reason: 'empty' };
    const verified = verifyFork(fork);
    if (verified && typeof verified.then === 'function') {
      return verified.then((v) => finishAdopt(v));
    }
    return finishAdopt(verified);
  }

  function finishAdopt(verified) {
    if (!verified.ok) return verified;
    const accepted = verified.accepted;
    rememberFork(accepted, 'valid-fork');
    if (!shouldAdopt(blocks, accepted)) {
      return { ok: false, reason: 'not_heavier', tip: tip() };
    }
    const fromBlocks = blocks.slice();
    const lca = commonPrefixLen(fromBlocks, accepted);
    const depth = fromBlocks.length - lca;
    if (haltDepth > 0 && depth >= haltDepth) {
      console.error(JSON.stringify({ type: 'REORG_HALT', depth, halt: haltDepth }));
      return { ok: false, reason: 'reorg_halt', depth, halt: haltDepth, tip: tip() };
    }
    const disconnected = fromBlocks.slice(lca);
    const connected = accepted.slice(lca);
    if (fromBlocks.length) rememberFork(fromBlocks, 'valid-fork');
    const event = makeReorgEvent({ fromBlocks, toBlocks: accepted, lca });
    blocks.length = 0;
    for (const b of accepted) blocks.push(b);
    rememberHeaders(accepted, 'active');
    rewriteChain();
    rebuildExplorer();
    replayVault();
    replayJoin();
    rebuildSpentB();
    bounceMempool(disconnected, connected);
    pruneBuried();
    reorgs.push(event);
    if (reorgs.length > 64) reorgs.splice(0, reorgs.length - 64);
    refreshPolicy({ reorgDepth: event.depth, nowMs: Date.now() });
    emit('reorg', event);
    emit('tip', { hash: hex32(tip().hash), height: tip().height, reorg: true });
    evmSession = null;
    return { ok: true, reorg: true, tip: tip(), event };
  }

  function ingest(fork) {
    if (!Array.isArray(fork) || !fork.length) return { ok: false, reason: 'empty' };
    const t = tip();
    let decoded;
    try {
      decoded = decodeHeader(Buffer.from(fork[0].header));
    } catch {
      return { ok: false, reason: 'bad_header' };
    }
    const extendsTip = t
      ? decoded.prevBlockHash.equals(Buffer.from(t.hash))
      : decoded.prevBlockHash.equals(GENESIS_PREV);
    if (extendsTip) {
      if (fork.some((b) => blockNeedsEvm(b?.txs || []))) {
        return (async () => {
          let last = null;
          for (const b of fork) {
            const got = await Promise.resolve(append(b));
            if (!got.ok) return last || got;
            last = got;
          }
          return last;
        })();
      }
      let last = null;
      for (const b of fork) {
        const got = append(b);
        if (!got.ok) return last || got;
        last = got;
      }
      return last;
    }
    return adopt(fork);
  }

  function historyFor(address) {
    const addr = String(address || '').trim();
    return explorer.filter((r) => r.to === addr || r.from === addr);
  }

  function spendableNanos(address) {
    return explorerSpendable(explorer, address);
  }

  const viewByAddress = new Map();
  const addressByView = new Map();
  function registerViewKey(address, viewKey) {
    const addr = String(address || '').trim();
    const vk = String(viewKey || '').trim();
    if (!addr || !vk) return { ok: false };
    viewByAddress.set(addr, vk);
    addressByView.set(vk, addr);
    return { ok: true, address: addr };
  }
  function addressForViewKey(viewKey) {
    return addressByView.get(String(viewKey || '').trim()) || '';
  }
  function viewKeyForAddress(address) {
    return viewByAddress.get(String(address || '').trim()) || '';
  }

  let jobSeq = 1;
  const jobs = new Map();
  const mempool = [];

  function template({ miner, samples = [], shareBits = 16, bits: bitsIn, potShares = null, now: nowIn } = {}) {
    const t = tip();
    const height = t ? t.height + 1 : 1;
    const wall = nowIn != null ? Number(nowIn) : Date.now();
    let now = wall;
    if (bitsIn == null && t?.header) {
      try {
        const parent = decodeHeader(Buffer.from(t.header));
        now = templateStampMs(parent.timestamp, wall);
      } catch { /* keep wall */ }
    }
    const bits = bitsIn != null ? bitsIn : retarget(blocks, now);
    const lag1 = lag1Continuity(t ? t.header : null);
    let baseFeeNow = 1;
    try {
      if (t?.header) baseFeeNow = Number(decodeHeader(Buffer.from(t.header)).baseFee || 1n);
    } catch { baseFeeNow = 1; }
    const book = emptyMempool();
    book.baseFee = baseFeeNow;
    const pendingTxs = [];
    for (const m of mempool) {
      const dest = destForLogin(m.to, { continuityRoot: lag1, height }) || m.to;
      const tx = {
        ...m,
        to: dest,
        bFlag: m.kind === 'b-spend' || m.bFlag,
        vin: m.vin || [{ address: m.from }],
        vout: m.vout || [{ address: dest, nanos: m.nanos, kind: m.kind, memoCt: m.memoCt }],
      };
      if (pause.join && tx.kind === 'claim') continue;
      if (pause.reserveInterest && tx.mint) continue;
      if (pause.poolWithdraw && tx.kind === 'pool-withdraw') continue;
      const got = admitMempool(book, tx, { baseFee: baseFeeNow });
      if (got.ok) pendingTxs.push(got.tx);
    }
    const tpl = buildTemplate({
      prev: t ? t.hash : GENESIS_PREV,
      prevHeader: t ? t.header : null,
      prevBlock: t,
      parentWeight: t ? (t.weight ?? undefined) : 1,
      height,
      miner,
      samples,
      potShares,
      txs: pendingTxs,
      now,
      bits,
      hashBonusNanos: reserveVault.liveHashBonusNanos || 1,
    });
    const jobId = `shear-${height}-${jobSeq++}`;
    const job = publicJob(tpl, { jobId, shareBits });
    const gate = requiredJobFields(job);
    if (!gate.ok) throw new Error(`incomplete_job:${gate.missing.join(',')}`);
    jobs.set(jobId, { tpl, job, shareBits });
    return { tpl, job };
  }

  function submitHeader({ jobId, nonce, miner }) {
    const rec = jobs.get(String(jobId));
    if (!rec) return { ok: false, reason: 'stale_job' };
    const header = setNonce(rec.tpl.header, BigInt(nonce));
    const block = {
      header,
      txs: rec.tpl.txs,
      samples: rec.tpl.samples,
      miner: destForLogin(miner) || miner || rec.tpl.miner,
      aLeaves: rec.tpl.aLeaves,
      bLeaves: rec.tpl.bLeaves,
      rootA: rec.tpl.rootA,
      rootB: rec.tpl.rootB,
    };
    return append(block);
  }

  return {
    dir,
    blocks,
    explorer,
    tip,
    append,
    verifyFork,
    adopt,
    ingest,
    template,
    submitHeader,
    jobs,
    mempool,
    spentB,
    queueTx,
    hashHex,
    headerHash,
    historyFor,
    spendableNanos,
    pruneBuried,
    pruneAfter,
    registerViewKey,
    addressForViewKey,
    viewKeyForAddress,
    reserveVault,
    saveReserve,
    joinVault,
    saveJoin,
    vortice,
    mintVorticeDeployKey: vortice.mintVorticeDeployKey,
    mintVorticeFromOrigin: vortice.mintFromOrigin,
    lookupVorticeKey: vortice.lookupByKey,
    listPublicVortices: vortice.listPublic,
    on,
    emit,
    getpolicy: () => policyView(policyState),
    getchaintips,
    getreorgs: () => reorgs.slice(),
    pause,
    reorgHaltDepth: haltDepth,
    headers,
    policyState,
  };
}
