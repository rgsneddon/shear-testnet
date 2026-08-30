#!/usr/bin/env node
/**
 * shear-watch — not a consensus peer. Reads validating RPC. Writes watch.jsonl.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';

export const WATCH_FILE = 'watch.jsonl';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

export function alertFor({ depth = 0, sideLeadHeld = false, h_ratio = 1 } = {}) {
  if (depth >= 10) return { freeze: true, reason: 'd_max', depth };
  if (sideLeadHeld) return { freeze: true, reason: 'side_lead' };
  if (h_ratio < 0.5) return { freeze: true, reason: 'h_ratio', h_ratio };
  if (depth >= 3) return { freeze: false, reason: 'reorg_risk', depth };
  return { freeze: false, reason: '' };
}

export async function sampleRpc(base) {
  const root = String(base || '').replace(/\/$/, '');
  const policy = await getJson(`${root}/policy`);
  const tips = await getJson(`${root}/chaintips`);
  const reorgs = await getJson(`${root}/reorgs`);
  return { policy, tips: tips.tips || [], reorgs: reorgs.reorgs || [] };
}

export function tickWatch({ policy, tips, reorgs, nowMs = Date.now() }) {
  const last = (reorgs || []).at(-1) || null;
  const depth = Number(last?.depth || policy?.d_max || 0);
  const sideLeadHeld = Number(policy?.side_lead || 0) > 0;
  const h_ratio = Number(policy?.h_ratio ?? 1);
  const alert = alertFor({ depth, sideLeadHeld: sideLeadHeld && depth >= 0, h_ratio });
  const active = (tips || []).find((t) => t.status === 'active');
  const side = (tips || []).filter((t) => t.status !== 'active');
  return {
    at: nowMs,
    intervalMs: TARGET_BLOCK_INTERVAL_MS,
    tip: active?.hash || '',
    height: active?.height || 0,
    side_tips: side.length,
    d_max: policy?.d_max || 0,
    h_ratio,
    side_lead: policy?.side_lead || 0,
    frozen: !!policy?.frozen || alert.freeze,
    alert,
    last_reorg: last,
  };
}

export function appendWatch(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export async function pushFreeze(poolBase, row) {
  if (!poolBase || !row.frozen) return { ok: true, skipped: true };
  const url = new URL('/api/credits_frozen', poolBase);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ frozen: row.frozen, reason: row.alert?.reason || '', sample: row });
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{"ok":true}')); }
        catch { resolve({ ok: true }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function runWatch({
  rpc = process.env.SHEAR_WATCH_RPC || 'http://127.0.0.1:18332',
  pool = process.env.SHEAR_WATCH_POOL || '',
  dataDir = process.env.SHEAR_WATCH_DIR || path.join(os.homedir(), '.shear', 'watch'),
} = {}) {
  const urls = String(rpc).split(',').map((s) => s.trim()).filter(Boolean);
  const file = path.join(dataDir, WATCH_FILE);
  const samples = [];
  for (const u of urls) {
    try {
      samples.push(await sampleRpc(u));
    } catch (e) {
      samples.push({ error: String(e?.message || e), url: u });
    }
  }
  const live = samples.find((s) => s.policy);
  const row = tickWatch(live || { policy: { frozen: false, h_ratio: 1, d_max: 0, side_lead: 0 }, tips: [], reorgs: [] });
  row.sources = urls.length;
  appendWatch(file, row);
  if (pool) await pushFreeze(pool, row);
  return { file, row };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runWatch().then((got) => {
    console.log(JSON.stringify({ ok: true, file: got.file, frozen: got.row.frozen, alert: got.row.alert }));
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
