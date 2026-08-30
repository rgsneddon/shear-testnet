import fs from 'node:fs';
import path from 'node:path';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { hashHex } from '../../crypto/shear_hash.js';
import {
  buildTemplate,
  verifyBlock,
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

function toRow(block) {
  const compact = compactChainBlock(block);
  return {
    ...compact,
    header: Buffer.from(block.header).toString('hex'),
    hash: Buffer.from(block.hash).toString('hex'),
  };
}

export function createStore(dir, { pruneAfter = SAMPLE_PRUNE_CONFIRMATIONS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chain.jsonl');
  const binFile = path.join(dir, 'chain.bin');
  const explorerFile = path.join(dir, 'explorer.jsonl');
  const vaultFile = path.join(dir, 'reserve.json');
  const blocks = [];
  const explorer = [];
  const spentB = new Set();
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
    });
    if (!check.ok) return check;
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
    {
      const sealedIds = new Set((stored.txs || []).map((t) => String(t.id || '')));
      for (let i = mempool.length - 1; i >= 0; i -= 1) {
        if (sealedIds.has(String(mempool[i].id))) mempool.splice(i, 1);
      }
    }
    applyReserve(stored);
    applyJoin(stored);
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
    return { ok: true, block: stored };
  }

  function queueTx(tx) {
    let base = 1;
    const t = tip();
    try {
      if (t?.header) base = Number(decodeHeader(Buffer.from(t.header)).baseFee || 1n);
    } catch { base = 1; }
    const book = emptyMempool();
    book.txs = mempool;
    return admitMempool(book, tx, { baseFee: base });
  }

  function adopt(fork) {
    if (!Array.isArray(fork) || !fork.length) return { ok: false, reason: 'empty' };
    const accepted = [];
    let joinFunded = false;
    const trialJoin = emptyJoin();
    for (let i = 0; i < fork.length; i += 1) {
      const prev = i === 0 ? null : { hash: accepted[i - 1].hash, header: accepted[i - 1].header };
      const check = verifyBlock(fork[i], prev, { joinFunded });
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
      }));
    }
    if (!shouldAdopt(blocks, accepted)) {
      return { ok: false, reason: 'not_heavier', tip: tip() };
    }
    blocks.length = 0;
    for (const b of accepted) blocks.push(b);
    rewriteChain();
    rebuildExplorer();
    replayVault();
    replayJoin();
    pruneBuried();
    return { ok: true, reorg: true, tip: tip() };
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
    const now = nowIn != null ? Number(nowIn) : Date.now();
    const bits = bitsIn != null ? bitsIn : retarget(blocks, now);
    const lag1 = lag1Continuity(t ? t.header : null);
    let baseFeeNow = 1;
    try {
      if (t?.header) baseFeeNow = Number(decodeHeader(Buffer.from(t.header)).baseFee || 1n);
    } catch { baseFeeNow = 1; }
    const pendingTxs = mempool.map((m) => {
      const dest = destForLogin(m.to, { continuityRoot: lag1, height }) || m.to;
      return {
        id: m.id,
        from: m.from,
        to: dest,
        nanos: m.nanos,
        fee: m.fee,
        kind: m.kind,
        programId: m.programId,
        commit: m.commit,
        key: m.key,
        root: m.root,
        bFlag: m.kind === 'b-spend' || m.bFlag,
        vin: [{ address: m.from }],
        vout: [{ address: dest, nanos: m.nanos, kind: m.kind, memoCt: m.memoCt }],
      };
    }).filter((tx) => admitMempool({ txs: [], baseFee: baseFeeNow }, tx, { baseFee: baseFeeNow }).ok);
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
  };
}
