#!/usr/bin/env node
/**
 * Observe the 1000-conf sample prune. Fail on anything a bad actor could use
 * at the prune window: early skip-POW, sealed tx loss, genesis rewrite,
 * height gaps, FAST_SYNC on the live book.
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
const stateFile = path.join(dir, 'prune-watch-state.json');

function wireHash(h) {
  if (h == null || h === '') return '';
  if (Buffer.isBuffer(h) || h instanceof Uint8Array) return Buffer.from(h).toString('hex');
  if (typeof h === 'string') return h.toLowerCase();
  if (typeof h === 'object') {
    if (typeof h.$hex === 'string') return h.$hex.toLowerCase();
    if (h.type === 'Buffer' && Array.isArray(h.data)) return Buffer.from(h.data).toString('hex');
  }
  return String(h);
}

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

function sealedFingerprint(b) {
  const txs = Array.isArray(b.txs) ? b.txs : [];
  return txs.map((tx) => ({
    id: String(tx?.id || tx?.kind || (tx?.coinbase ? 'coinbase' : '')),
    kind: String(tx?.kind || (tx?.coinbase ? 'coinbase' : '')),
    nVout: (tx?.vout || []).length,
    dest20: tx?.vout?.[0]?.dest20
      ? wireHash(tx.vout[0].dest20).slice(0, 40)
      : '',
    portalId: tx?.portalId ? wireHash(tx.portalId).slice(0, 16) : '',
  }));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

const blocks = load();
const tipH = Number(blocks.at(-1)?.height || 0);
const genesis = blocks[0] || null;
const genesisHash = genesis ? wireHash(genesis.hash) : '';
const prev = loadState();
const due = [];
const dangers = [];

let expectH = genesis ? Number(genesis.height || 1) : 1;
for (const b of blocks) {
  const h = Number(b.height || 0);
  const nTx = (b.txs || []).length;
  const nVout = (b.txs?.[0]?.vout || []).length;
  if (h !== expectH) {
    dangers.push({
      height: h,
      reason: 'height_gap',
      detail: `expected ${expectH}`,
    });
  }
  expectH = h + 1;
  if (!nTx || !nVout) {
    dangers.push({ height: h, reason: 'empty_txs_or_coinbase', nTx, nVout });
    continue;
  }
  const want = shouldPruneSamples(h, tipH);
  if (want) due.push(h);
  const skipWould = flowSkipAllowed(b, tipH);
  if (skipWould && !want) {
    dangers.push({
      height: h,
      reason: 'skip_pow_without_depth',
      detail: 'share-POW skip would fire before 1000 conf — peer flag is not enough',
      tipH,
    });
  }
  if (b.samplesPruned) {
    if (nTx < 1 || nVout < 1) {
      dangers.push({ height: h, reason: 'pruned_empty' });
    }
    if ((b.samples || []).length) {
      dangers.push({ height: h, reason: 'pruned_still_has_samples' });
    }
    if ((b.shareBatch || []).length) {
      dangers.push({ height: h, reason: 'pruned_still_has_shares' });
    }
    if (!want) {
      dangers.push({
        height: h,
        reason: 'pruned_too_early',
        detail: 'samplesPruned set before 1000 confirmations — skip-POW attack window',
        tipH,
      });
    }
    for (const tx of (b.txs || []).slice(1)) {
      const kind = String(tx?.kind || '');
      if (kind === 'lock' || kind === 'vote' || kind === 'withdraw') {
        if (!tx.portalId && !tx.vout?.[0]?.dest20 && tx.valueProof?.v == null) {
          dangers.push({
            height: h,
            reason: 'pruned_stripped_reserve',
            detail: kind,
          });
        }
      }
    }
  }
  if (prev?.byHeight?.[String(h)]) {
    const was = prev.byHeight[String(h)];
    const nowFp = sealedFingerprint(b);
    if (was.nTx && nowFp.length < was.nTx) {
      dangers.push({
        height: h,
        reason: 'sealed_tx_count_dropped',
        detail: `${was.nTx} -> ${nowFp.length}`,
      });
    }
    if (was.hash && wireHash(b.hash) !== was.hash) {
      dangers.push({
        height: h,
        reason: 'hash_changed_after_seal',
        detail: 'block hash mutated after we had already seen it',
      });
    }
    const wasIds = new Set((was.ids || []).map((x) => x.id));
    for (const id of wasIds) {
      if (id && !nowFp.some((x) => x.id === id)) {
        dangers.push({
          height: h,
          reason: 'sealed_tx_missing',
          detail: id,
        });
      }
    }
  }
}

if (prev?.genesisHash && genesisHash && prev.genesisHash !== genesisHash) {
  dangers.push({
    height: 1,
    reason: 'genesis_hash_changed',
    detail: 'live book genesis replaced — different book or rewrite attack',
  });
}

if (fs.existsSync(bin) && fs.existsSync(jsonl)) {
  const jsonN = fs.readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim()).length;
  if (Math.abs(jsonN - blocks.length) > 1) {
    dangers.push({
      height: tipH,
      reason: 'bin_jsonl_count_mismatch',
      detail: `bin ${blocks.length} jsonl ${jsonN}`,
    });
  }
}

const fastSync = String(process.env.SHEAR_FAST_SYNC || '').trim() === '1';
if (fastSync) {
  dangers.push({
    height: tipH,
    reason: 'fast_sync_on_live_book',
    detail: 'SHEAR_FAST_SYNC=1 skips buried share POW — not allowed on the mining node',
  });
}

const byHeight = {};
for (const b of blocks) {
  const h = Number(b.height || 0);
  byHeight[String(h)] = {
    hash: wireHash(b.hash),
    nTx: (b.txs || []).length,
    ids: sealedFingerprint(b),
    samplesPruned: !!b.samplesPruned,
  };
}
try {
  fs.writeFileSync(stateFile, `${JSON.stringify({
    genesisHash,
    tip: tipH,
    n: blocks.length,
    byHeight,
    updatedAt: Date.now(),
  })}\n`);
} catch { /* observer must not take down the node */ }

const report = {
  ok: dangers.length === 0,
  data: dir,
  tip: tipH,
  n: blocks.length,
  pruneDepth: SAMPLE_PRUNE_CONFIRMATIONS,
  due: due.length,
  pruned: blocks.filter((b) => b.samplesPruned).length,
  firstDue: due[0] || null,
  genesisHash: genesisHash.slice(0, 16),
  genesisPruned: !!genesis?.samplesPruned,
  genesisTxs: (genesis?.txs || []).length,
  genesisVouts: (genesis?.txs?.[0]?.vout || []).length,
  skipPowPeerFlagAlone: flowSkipAllowed({ height: 1, samplesPruned: true }, 1) === false,
  dangers,
  bad: dangers,
};
console.log(JSON.stringify(report));
if (dangers.length) process.exit(2);
if (tipH >= SAMPLE_PRUNE_CONFIRMATIONS + 1 && genesis && !genesis.samplesPruned) {
  console.error(JSON.stringify({
    ok: false,
    reason: 'genesis_not_pruned_at_1001',
    tip: tipH,
    danger: 'prune did not run — samples still on a 1000-conf block',
  }));
  process.exit(3);
}
