/**
 * Depth-1000 burial bookkeeping for one store.
 *
 * The reorg floor freezes the block at bootstrapCheckpoint(tip): every
 * chain this store can still adopt keeps that block, so its tip is at
 * least the floor. A block at or below floor - SAMPLE_PRUNE_CONFIRMATIONS
 * is buried under every such chain and can never be un-buried. Nothing
 * here keeps a row for it.
 *
 * The hold is archive data: a pruned block's packed body on disk, so an
 * un-bury can serve the full block again. Memory keeps only height by hash.
 *
 * The proof is consensus: the tip of a proven-work header chain this
 * store validated that buried the block. A pruned block whose credits
 * are bound by the coinbase credit root stays buried under that tip, so
 * archive, fast-sync, bootstrap, and restarted nodes verify it the same
 * way. The file is keyed by the per-install seal key, which lives outside
 * the datadir, so a copied datadir does not carry a proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SAMPLE_PRUNE_CONFIRMATIONS } from '../../crypto/asert.js';
import { shouldPruneSamples } from '../../crypto/chronoflux.js';
import { bootstrapCheckpoint, CHECKPOINT_FIRST_HEIGHT, CHECKPOINT_EVERY_BLOCKS } from './bootstrap.js';

const HOLD_NAME = /^(\d{1,12})-([0-9a-f]{64})$/;
const PROOF_DOMAIN = 'burialproof1';

export function reorgFloor(tipH, opts = {}) {
  const first = Math.max(1, Math.floor(Number(opts.first) || CHECKPOINT_FIRST_HEIGHT));
  const every = Math.max(1, Math.floor(Number(opts.every) || CHECKPOINT_EVERY_BLOCKS));
  const cp = bootstrapCheckpoint(Number(tipH) || 0, first, every);
  return cp >= first ? cp : 0;
}

/** Highest height every chain above the reorg floor buries. 0 before the first checkpoint. */
export function settledHeight(tipH, opts = {}) {
  const floor = reorgFloor(tipH, opts);
  return floor > SAMPLE_PRUNE_CONFIRMATIONS ? floor - SAMPLE_PRUNE_CONFIRMATIONS : 0;
}

export function createBurialHold({ dir, write = true, checkpoints = {} } = {}) {
  const folder = path.join(String(dir || '.'), 'burial-hold');
  const index = new Map();
  let bytes = 0;

  function fileOf(hex, height) {
    return path.join(folder, `${height}-${hex}`);
  }

  function drop(hex) {
    const h = index.get(hex);
    if (h == null) return;
    const file = fileOf(hex, h);
    try {
      bytes -= fs.statSync(file).size;
      fs.rmSync(file, { force: true });
    } catch { /* already gone */ }
    index.delete(hex);
  }

  function evict(tipH) {
    const settled = settledHeight(tipH, checkpoints);
    if (settled <= 0) return 0;
    let n = 0;
    for (const [hex, h] of [...index]) {
      if (h > settled) continue;
      drop(hex);
      n += 1;
    }
    return n;
  }

  /** Lists the folder only. A body is read when a block is lifted. */
  function load(tipH) {
    index.clear();
    bytes = 0;
    if (!write || !fs.existsSync(folder)) return;
    let names = [];
    try { names = fs.readdirSync(folder); } catch { return; }
    const settled = settledHeight(tipH, checkpoints);
    for (const name of names) {
      const m = HOLD_NAME.exec(name);
      const file = path.join(folder, name);
      if (!m || Number(m[1]) <= settled) {
        try { fs.rmSync(file, { force: true }); } catch { /* left for the next start */ }
        continue;
      }
      index.set(m[2], Number(m[1]));
      try { bytes += fs.statSync(file).size; } catch { /* counted on the next start */ }
    }
  }

  /**
   * `pack` runs only when the file is written. A block already settled
   * under this tip is not held.
   */
  function remember(hex, height, pack, tipH) {
    if (!write || !hex || index.has(hex)) return false;
    const h = Number(height);
    if (!Number.isInteger(h) || h <= settledHeight(tipH, checkpoints)) return false;
    try {
      fs.mkdirSync(folder, { recursive: true });
      const body = pack();
      const file = fileOf(hex, h);
      fs.writeFileSync(file, body);
      bytes += body.length;
      index.set(hex, h);
      return true;
    } catch {
      return false;
    }
  }

  function read(hex) {
    const h = index.get(hex);
    if (h == null) return null;
    try { return fs.readFileSync(fileOf(hex, h)); } catch { return null; }
  }

  return {
    load,
    remember,
    read,
    evict,
    drop,
    has: (hex) => index.has(hex),
    count: () => index.size,
    diskBytes: () => bytes,
    heights: () => [...index.values()].sort((a, b) => a - b),
  };
}

function proofMac(key, body) {
  return createHmac('sha256', key).update(PROOF_DOMAIN).update(body).digest('hex');
}

export function createBurialProof({ dir, key, checkpoints = {} } = {}) {
  const file = path.join(String(dir || '.'), 'burial-proof.json');
  const sealKey = key && Buffer.from(key).length === 32 ? Buffer.from(key) : null;
  const rows = new Map();
  let dirty = false;

  function load() {
    rows.clear();
    dirty = false;
    if (!sealKey || !fs.existsSync(file)) return;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const body = JSON.stringify(doc.rows || []);
      const want = Buffer.from(proofMac(sealKey, body), 'hex');
      const got = Buffer.from(String(doc.mac || ''), 'hex');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return;
      for (const r of doc.rows) {
        const [hex, height, tip] = r;
        if (!/^[0-9a-f]{64}$/.test(String(hex))) continue;
        if (!shouldPruneSamples(Number(height), Number(tip))) continue;
        rows.set(String(hex), { height: Number(height), tip: Number(tip) });
      }
    } catch {
      rows.clear();
    }
  }

  /** `tip` is the proven-work tip that buried this block. */
  function note(hex, height, tip) {
    const h = Number(height);
    const t = Number(tip);
    if (!hex || !Number.isInteger(h) || !Number.isInteger(t) || !shouldPruneSamples(h, t)) return false;
    const was = rows.get(hex);
    if (was && was.tip >= t) return false;
    rows.set(hex, { height: h, tip: t });
    dirty = true;
    return true;
  }

  function tipOf(hex, height) {
    const r = rows.get(hex);
    if (!r || r.height !== Number(height)) return null;
    return r.tip;
  }

  function evict(tipH) {
    const settled = settledHeight(tipH, checkpoints);
    if (settled <= 0) return 0;
    let n = 0;
    for (const [hex, r] of [...rows]) {
      if (r.height > settled) continue;
      rows.delete(hex);
      n += 1;
    }
    if (n) dirty = true;
    return n;
  }

  function save() {
    if (!dirty || !sealKey) return;
    const list = [...rows].map(([hex, r]) => [hex, r.height, r.tip]).sort((a, b) => a[1] - b[1]);
    const body = JSON.stringify(list);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ rows: list, mac: proofMac(sealKey, body) }));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch { /* the next save retries */ }
  }

  return {
    load,
    note,
    tipOf,
    evict,
    save,
    count: () => rows.size,
    heights: () => [...rows.values()].map((r) => r.height).sort((a, b) => a - b),
  };
}
