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
} from './chain.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { compactChainBlock } from '../../crypto/chronoflux.js';
import { setNonce } from '../../crypto/header.js';
import { requiredJobFields } from '../../crypto/header.js';

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
  const explorerFile = path.join(dir, 'explorer.jsonl');
  const blocks = [];
  const explorer = [];
  if (fs.existsSync(file)) {
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

  function persist(block) {
    fs.appendFileSync(file, `${JSON.stringify(toRow(block))}\n`);
  }

  function rewriteChain() {
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
    const check = verifyBlock(block, prev ? { hash: prev.hash } : null);
    if (!check.ok) return check;
    const stored = leanBlock({
      ...block,
      magic: MAGIC_TESTNET,
      hash: check.hash,
      height: prev ? prev.height + 1 : 1,
    });
    blocks.push(stored);
    persist(stored);
    indexSealed(stored);
    pruneBuried();
    return { ok: true, block: stored };
  }

  function historyFor(address) {
    const addr = String(address || '').trim();
    return explorer.filter((r) => r.to === addr || r.from === addr);
  }

  let jobSeq = 1;
  const jobs = new Map();
  const mempool = [];

  function template({ miner, samples = [], shareBits = 16, bits: bitsIn } = {}) {
    const t = tip();
    const height = t ? t.height + 1 : 1;
    const bits = bitsIn != null ? bitsIn : retarget(blocks);
    const lag1 = lag1Continuity(t ? t.header : null);
    const pendingTxs = mempool.map((m) => {
      const dest = destForLogin(m.to, { continuityRoot: lag1, height });
      return {
        id: m.id,
        from: m.from,
        to: dest,
        nanos: m.nanos,
        vin: [{ address: m.from }],
        vout: [{ address: dest, nanos: m.nanos }],
      };
    });
    const tpl = buildTemplate({
      prev: t ? t.hash : GENESIS_PREV,
      prevHeader: t ? t.header : null,
      height,
      miner,
      samples,
      txs: pendingTxs,
      now: Date.now(),
      bits,
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
      miner: miner || rec.tpl.miner,
    };
    return append(block);
  }

  return {
    dir,
    blocks,
    explorer,
    tip,
    append,
    template,
    submitHeader,
    jobs,
    mempool,
    hashHex,
    headerHash,
    historyFor,
    pruneBuried,
    pruneAfter,
  };
}
