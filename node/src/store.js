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
} from './chain.js';
import { setNonce } from '../../crypto/header.js';
import { requiredJobFields } from '../../crypto/header.js';

export function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chain.jsonl');
  const blocks = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const b = JSON.parse(line);
      b.header = Buffer.from(b.header, 'hex');
      b.hash = Buffer.from(b.hash, 'hex');
      blocks.push(b);
    }
  }

  function persist(block) {
    const row = {
      ...block,
      header: Buffer.from(block.header).toString('hex'),
      hash: Buffer.from(block.hash).toString('hex'),
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  }

  function tip() {
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  function append(block) {
    const prev = tip();
    const check = verifyBlock(block, prev ? { hash: prev.hash } : null);
    if (!check.ok) return check;
    const stored = {
      ...block,
      magic: MAGIC_TESTNET,
      hash: check.hash,
      height: prev ? prev.height + 1 : 1,
    };
    blocks.push(stored);
    persist(stored);
    return { ok: true, block: stored };
  }

  let jobSeq = 1;
  const jobs = new Map();

  function template({ miner, samples = [], shareBits = 16, bits: bitsIn } = {}) {
    const t = tip();
    const height = t ? t.height + 1 : 1;
    const bits = bitsIn != null ? bitsIn : retarget(blocks);
    const tpl = buildTemplate({
      prev: t ? t.hash : GENESIS_PREV,
      height,
      miner,
      samples,
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
    tip,
    append,
    template,
    submitHeader,
    jobs,
    hashHex,
    headerHash,
  };
}
