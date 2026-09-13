#!/usr/bin/env node
/**
 * Observe the 1000-conf sample prune. Fails if a pruned block lost txs/vouts.
 * Default archival: samples may go empty after 1000 conf; sealed txs stay.
 *
 *   SHEAR_DATA=/var/lib/shear/testnet-v3 node node/scripts/watch_prune.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
import { shouldPruneSamples, flowSkipAllowed } from '../../crypto/chronoflux.js';
import { readChainBin } from '../../crypto/chainbin.js';

const dir = process.env.SHEAR_DATA || path.join(process.env.HOME || '/var/lib/shear', '.shear', 'testnet-v3');
const bin = path.join(dir, 'chain.bin');
const jsonl = path.join(dir, 'chain.jsonl');

function load() {
  if (fs.existsSync(bin)) return readChainBin(bin);
  if (!fs.existsSync(jsonl)) return [];
  const out = [];
  for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* mid-append */ }
  }
  return out;
}

const blocks = load();
const tipH = Number(blocks.at(-1)?.height || 0);
const due = [];
const bad = [];
for (const b of blocks) {
  const h = Number(b.height || 0);
  const nTx = (b.txs || []).length;
  const nVout = (b.txs?.[0]?.vout || []).length;
  if (!nTx || !nVout) {
    bad.push({ height: h, reason: 'empty_txs_or_coinbase', nTx, nVout });
    continue;
  }
  const want = shouldPruneSamples(h, tipH);
  if (want) due.push(h);
  if (b.samplesPruned) {
    if (nTx < 1 || nVout < 1) bad.push({ height: h, reason: 'pruned_empty' });
    if ((b.samples || []).length) bad.push({ height: h, reason: 'pruned_still_has_samples' });
    if (!flowSkipAllowed(b, tipH) && tipH - h < SAMPLE_PRUNE_CONFIRMATIONS) {
      bad.push({ height: h, reason: 'pruned_too_early', tipH });
    }
  }
}
const report = {
  ok: bad.length === 0,
  data: dir,
  tip: tipH,
  n: blocks.length,
  pruneDepth: SAMPLE_PRUNE_CONFIRMATIONS,
  due: due.length,
  pruned: blocks.filter((b) => b.samplesPruned).length,
  firstDue: due[0] || null,
  genesisPruned: !!blocks[0]?.samplesPruned,
  genesisTxs: (blocks[0]?.txs || []).length,
  genesisVouts: (blocks[0]?.txs?.[0]?.vout || []).length,
  bad,
};
console.log(JSON.stringify(report));
if (bad.length) process.exit(2);
if (tipH >= SAMPLE_PRUNE_CONFIRMATIONS + 1 && blocks[0] && !blocks[0].samplesPruned) {
  console.error(JSON.stringify({ ok: false, reason: 'genesis_not_pruned_at_1001', tip: tipH }));
  process.exit(3);
}
