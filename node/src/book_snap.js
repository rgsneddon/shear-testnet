/**
 * Keyed verified-state snapshot for an own-install book.
 * HMAC-SHA256 under the per-datadir seal key. A copied datadir does not
 * carry that key. The payload binds the rules id, the genesis pin, the
 * checkpoint, the tip, the disk bytes, the packed frames, and the state
 * a restart would otherwise replay.
 */
import fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { packEpochBlock } from '../../crypto/chainbin.js';

export const BOOK_SNAP_DOMAIN = 'booksnap1';
const MAGIC = Buffer.from('booksnap1\0');
const VERSION = 1;

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function bytesOf(v, len) {
  if (v == null) return null;
  let b;
  try { b = Buffer.from(v); } catch { return null; }
  if (len != null && b.length !== len) return null;
  return b;
}

function pub32(p) {
  if (Buffer.isBuffer(p) && p.length === 32) return p;
  if (p instanceof Uint8Array && p.length === 32) return Buffer.from(p);
  if (p && typeof p.toBytes === 'function') {
    const b = Buffer.from(p.toBytes());
    return b.length === 32 ? b : null;
  }
  return null;
}

function putStr(parts, s) {
  const b = Buffer.from(String(s ?? ''), 'utf8');
  parts.push(u32(b.length), b);
}

function putRow(parts, row) {
  const nc = bytesOf(row?.noteCommit, 32);
  const d20 = bytesOf(row?.dest20, 20);
  const base = bytesOf(row?.admitBase, 32) || Buffer.alloc(32);
  if (!nc || !d20) throw new Error('snap_row');
  let nanos;
  try { nanos = BigInt(row.nanos); } catch { throw new Error('snap_row'); }
  if (nanos < 0n || nanos > 0xffffffffffffffffn) throw new Error('snap_row');
  const since = Number(row.sinceHeight) || 0;
  if (!Number.isInteger(since) || since < 0) throw new Error('snap_row');
  parts.push(nc, d20, base, u64(nanos), u32(since));
}

/** sha256 over packed epoch frames, including the bSpendIds trailer. */
export function frameDigest(blocks) {
  const h = createHash('sha256');
  h.update('bookframe1');
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const rec = packEpochBlock(block);
    h.update(u32(rec.length));
    h.update(rec);
  }
  return h.digest('hex');
}

function hex32(hex) {
  const s = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

export function encodeBookSnap(state, key) {
  const k = bytesOf(key, 32);
  if (!k) throw new Error('seal_key');
  const tip = bytesOf(state?.tipHash, 32);
  const disk = hex32(state?.diskDigest);
  const frame = hex32(state?.frameDigest);
  const vault = hex32(state?.vaultCommitment);
  if (!tip || !disk || !frame || !vault) throw new Error('snap_bind');
  const height = Number(state.height);
  if (!Number.isInteger(height) || height < 1) throw new Error('snap_bind');
  const genesisMs = BigInt(state.genesisMs || 0);
  if (genesisMs <= 0n || genesisMs > 0xffffffffffffffffn) throw new Error('snap_bind');
  const parts = [u32(VERSION)];
  putStr(parts, state.rules);
  putStr(parts, state.genesisPin || '');
  const cpH = Math.floor(Number(state.checkpointHeight) || 0);
  parts.push(u32(cpH));
  putStr(parts, cpH > 0 ? String(state.checkpointHash || '') : '');
  parts.push(u32(height), tip, disk, frame, u64(genesisMs), vault);
  const rows = Array.isArray(state.owedRows) ? state.owedRows : [];
  parts.push(u32(rows.length));
  for (const row of rows) putRow(parts, row);
  const series = Array.isArray(state.acceptedSeries) ? state.acceptedSeries : [];
  parts.push(u32(series.length));
  for (const n of series) {
    const v = BigInt(n);
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error('snap_series');
    parts.push(u64(v));
  }
  const spent = Array.isArray(state.spentIds) ? state.spentIds.map((id) => String(id)) : [];
  spent.sort();
  parts.push(u32(spent.length));
  for (const id of spent) putStr(parts, id);
  const pubs = Array.isArray(state.pubs) ? state.pubs : [];
  const commits = Array.isArray(state.commits) ? state.commits : [];
  if (pubs.length !== commits.length) throw new Error('snap_flux');
  parts.push(u32(pubs.length));
  for (let i = 0; i < pubs.length; i += 1) {
    const p = pub32(pubs[i]);
    const c = bytesOf(commits[i], 32);
    if (!p || !c) throw new Error('snap_flux');
    parts.push(p, c);
  }
  const tags = Array.isArray(state.spendTags) ? state.spendTags.map((t) => String(t)) : [];
  tags.sort();
  parts.push(u32(tags.length));
  for (const tag of tags) putStr(parts, tag);
  const units = Array.isArray(state.unitAt) ? state.unitAt : [];
  parts.push(u32(units.length));
  for (const n of units) {
    const v = BigInt(n);
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error('snap_unit');
    parts.push(u64(v));
  }
  if (Array.isArray(state.owedCheckpoints) || Array.isArray(state.supplySnaps)) {
    const checkpoints = Array.isArray(state.owedCheckpoints) ? state.owedCheckpoints : [];
    parts.push(u32(checkpoints.length));
    for (const ck of checkpoints) {
      const at = Number(ck?.at);
      const end = Number(ck?.seriesEnd);
      if (!Number.isInteger(at) || at < 0 || !Number.isInteger(end) || end < 0) throw new Error('snap_ckpt');
      parts.push(u32(at), u32(end));
      const rows = Array.isArray(ck?.rows) ? ck.rows : [];
      parts.push(u32(rows.length));
      for (const row of rows) putRow(parts, row);
    }
  }
  if (Array.isArray(state.supplySnaps)) {
    parts.push(u32(state.supplySnaps.length));
    for (const s of state.supplySnaps) {
      const hash = bytesOf(s?.blockHash, 32);
      const at = Number(s?.height);
      if (!hash || !Number.isInteger(at) || at < 1) throw new Error('snap_supply');
      parts.push(u32(at), hash);
      const nums = [
        s.schedulePot, s.carry, s.mintedPot, s.mintedHash, s.mintedLevy,
        s.permittedHashAll, s.acceptedHash, s.dust, s.overflow, s.liveUnit, s.genesisMs,
      ];
      for (const n of nums) {
        const v = BigInt(n ?? 0);
        if (v < 0n || v > 0xffffffffffffffffn) throw new Error('snap_supply');
        parts.push(u64(v));
      }
    }
    const anchors = Array.isArray(state.anchorWindow) ? state.anchorWindow : [];
    parts.push(u32(anchors.length));
    for (const a of anchors) {
      const root = bytesOf(a?.jroot, 32);
      const at = Number(a?.height);
      const n = Number(a?.n);
      if (!root || !Number.isInteger(at) || at < 1 || !Number.isInteger(n) || n < 0) throw new Error('snap_supply');
      parts.push(u32(at), u32(n), root);
    }
  }
  const payload = Buffer.concat(parts);
  const mac = createHmac('sha256', k).update(MAGIC).update(payload).digest();
  return Buffer.concat([MAGIC, u32(payload.length), payload, mac]);
}

function take(buf, o, n) {
  if (o + n > buf.length) return null;
  return buf.subarray(o, o + n);
}

function readU32(buf, o) {
  const b = take(buf, o, 4);
  if (!b) return null;
  return { v: b.readUInt32LE(0), o: o + 4 };
}

function readU64(buf, o) {
  const b = take(buf, o, 8);
  if (!b) return null;
  return { v: b.readBigUInt64LE(0), o: o + 8 };
}

function readStr(buf, o) {
  const n = readU32(buf, o);
  if (!n) return null;
  const b = take(buf, n.o, n.v);
  if (!b) return null;
  return { v: b.toString('utf8'), o: n.o + n.v };
}

export function decodeBookSnap(buf, key, expected = {}) {
  const k = bytesOf(key, 32);
  const raw = bytesOf(buf);
  if (!k || !raw || raw.length < MAGIC.length + 4 + 32) return null;
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const len = raw.readUInt32LE(MAGIC.length);
  const start = MAGIC.length + 4;
  if (len > raw.length - start - 32) return null;
  const payload = raw.subarray(start, start + len);
  const mac = raw.subarray(start + len, start + len + 32);
  const want = createHmac('sha256', k).update(MAGIC).update(payload).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  let o = 0;
  const ver = readU32(payload, o);
  if (!ver || ver.v !== VERSION) return null;
  o = ver.o;
  const rules = readStr(payload, o);
  if (!rules) return null;
  o = rules.o;
  const pin = readStr(payload, o);
  if (!pin) return null;
  o = pin.o;
  const cpH = readU32(payload, o);
  if (!cpH) return null;
  o = cpH.o;
  const cpHash = readStr(payload, o);
  if (!cpHash) return null;
  o = cpHash.o;
  const height = readU32(payload, o);
  if (!height || height.v < 1) return null;
  o = height.o;
  const tip = take(payload, o, 32);
  if (!tip) return null;
  o += 32;
  const disk = take(payload, o, 32);
  if (!disk) return null;
  o += 32;
  const frame = take(payload, o, 32);
  if (!frame) return null;
  o += 32;
  const genesis = readU64(payload, o);
  if (!genesis || genesis.v <= 0n) return null;
  o = genesis.o;
  const vault = take(payload, o, 32);
  if (!vault) return null;
  o += 32;
  const nrow = readU32(payload, o);
  if (!nrow) return null;
  o = nrow.o;
  const owedRows = [];
  for (let i = 0; i < nrow.v; i += 1) {
    const nc = take(payload, o, 32);
    const d20 = take(payload, o + 32, 20);
    const base = take(payload, o + 52, 32);
    const nanos = readU64(payload, o + 84);
    const since = readU32(payload, o + 92);
    if (!nc || !d20 || !base || !nanos || !since) return null;
    owedRows.push({
      noteCommit: Buffer.from(nc),
      dest20: Buffer.from(d20),
      admitBase: Buffer.from(base),
      nanos: nanos.v,
      sinceHeight: since.v,
    });
    o = since.o;
  }
  const nser = readU32(payload, o);
  if (!nser) return null;
  o = nser.o;
  const acceptedSeries = [];
  for (let i = 0; i < nser.v; i += 1) {
    const n = readU64(payload, o);
    if (!n) return null;
    acceptedSeries.push(n.v);
    o = n.o;
  }
  const nspent = readU32(payload, o);
  if (!nspent) return null;
  o = nspent.o;
  const spentIds = [];
  for (let i = 0; i < nspent.v; i += 1) {
    const id = readStr(payload, o);
    if (!id) return null;
    spentIds.push(id.v);
    o = id.o;
  }
  const npub = readU32(payload, o);
  if (!npub) return null;
  o = npub.o;
  const pubs = [];
  const commits = [];
  for (let i = 0; i < npub.v; i += 1) {
    const p = take(payload, o, 32);
    const c = take(payload, o + 32, 32);
    if (!p || !c) return null;
    pubs.push(Buffer.from(p));
    commits.push(Buffer.from(c));
    o += 64;
  }
  const ntag = readU32(payload, o);
  if (!ntag) return null;
  o = ntag.o;
  const spendTags = [];
  for (let i = 0; i < ntag.v; i += 1) {
    const tag = readStr(payload, o);
    if (!tag) return null;
    spendTags.push(tag.v);
    o = tag.o;
  }
  const nunit = readU32(payload, o);
  if (!nunit) return null;
  o = nunit.o;
  const unitAt = [];
  for (let i = 0; i < nunit.v; i += 1) {
    const n = readU64(payload, o);
    if (!n) return null;
    unitAt.push(Number(n.v));
    o = n.o;
  }
  let owedCheckpoints = null;
  if (o < payload.length) {
    const nck = readU32(payload, o);
    if (!nck) return null;
    o = nck.o;
    owedCheckpoints = [];
    for (let i = 0; i < nck.v; i += 1) {
      const at = readU32(payload, o);
      if (!at) return null;
      o = at.o;
      const end = readU32(payload, o);
      if (!end) return null;
      o = end.o;
      const nrow = readU32(payload, o);
      if (!nrow) return null;
      o = nrow.o;
      const rows = [];
      for (let r = 0; r < nrow.v; r += 1) {
        const nc = take(payload, o, 32);
        const d20 = take(payload, o + 32, 20);
        const base = take(payload, o + 52, 32);
        const nanos = readU64(payload, o + 84);
        const since = readU32(payload, o + 92);
        if (!nc || !d20 || !base || !nanos || !since) return null;
        rows.push({
          noteCommit: Buffer.from(nc),
          dest20: Buffer.from(d20),
          admitBase: Buffer.from(base),
          nanos: nanos.v,
          sinceHeight: since.v,
        });
        o = since.o;
      }
      owedCheckpoints.push({ at: at.v, seriesEnd: end.v, rows });
    }
  }
  let supplySnaps = null;
  let anchorWindow = null;
  if (o < payload.length) {
    const nsc = readU32(payload, o);
    if (!nsc) return null;
    o = nsc.o;
    supplySnaps = [];
    for (let i = 0; i < nsc.v; i += 1) {
      const h = readU32(payload, o);
      if (!h || h.v < 1) return null;
      o = h.o;
      const hash = take(payload, o, 32);
      if (!hash) return null;
      o += 32;
      const nums = [];
      for (let k = 0; k < 11; k += 1) {
        const n = readU64(payload, o);
        if (!n) return null;
        nums.push(n.v);
        o = n.o;
      }
      supplySnaps.push({
        height: h.v,
        blockHash: Buffer.from(hash),
        schedulePot: nums[0],
        carry: nums[1],
        mintedPot: nums[2],
        mintedHash: nums[3],
        mintedLevy: nums[4],
        permittedHashAll: nums[5],
        acceptedHash: nums[6],
        dust: nums[7],
        overflow: nums[8],
        liveUnit: Number(nums[9]),
        genesisMs: Number(nums[10]),
      });
    }
    const nanc = readU32(payload, o);
    if (!nanc) return null;
    o = nanc.o;
    anchorWindow = [];
    for (let i = 0; i < nanc.v; i += 1) {
      const ah = readU32(payload, o);
      if (!ah || ah.v < 1) return null;
      o = ah.o;
      const an = readU32(payload, o);
      if (!an) return null;
      o = an.o;
      const root = take(payload, o, 32);
      if (!root) return null;
      o += 32;
      anchorWindow.push({ height: ah.v, n: an.v, jroot: Buffer.from(root) });
    }
  }
  if (o !== payload.length) return null;
  const state = {
    rules: rules.v,
    genesisPin: pin.v,
    checkpointHeight: cpH.v,
    checkpointHash: cpHash.v,
    height: height.v,
    tipHash: Buffer.from(tip),
    diskDigest: Buffer.from(disk).toString('hex'),
    frameDigest: Buffer.from(frame).toString('hex'),
    genesisMs: Number(genesis.v),
    vaultCommitment: Buffer.from(vault).toString('hex'),
    owedRows,
    acceptedSeries,
    spentIds,
    pubs,
    commits,
    spendTags,
    unitAt,
    owedCheckpoints,
    supplySnaps,
    anchorWindow,
  };
  if (expected.rules != null && state.rules !== String(expected.rules)) return null;
  if (expected.genesisPin != null && state.genesisPin !== String(expected.genesisPin)) return null;
  if (expected.checkpoint) {
    const h = Math.floor(Number(expected.checkpoint.height) || 0);
    const hash = h > 0 ? String(expected.checkpoint.hash || '') : '';
    if (state.checkpointHeight !== h || state.checkpointHash !== hash) return null;
  }
  if (state.acceptedSeries.length !== state.height) return null;
  if (state.unitAt.length !== state.height) return null;
  return state;
}

export function readBookSnap(file, key, expected = {}) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return decodeBookSnap(fs.readFileSync(file), key, expected);
  } catch {
    return null;
  }
}

export function writeBookSnap(file, key, state) {
  const raw = encodeBookSnap(state, key);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, file);
}
