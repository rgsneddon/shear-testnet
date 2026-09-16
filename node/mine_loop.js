/**
 * 24h soak miner. Talks to the live node over loopback RPC so chain.bin
 * stays with the validating process. Persists the miner dest so a Flow
 * spend can unwrap rEph/rCt after 6 confirmations.
 *
 *   SHEAR_RPC=http://127.0.0.1:18332 node node/mine_loop.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { mineTemplate } from './src/chain.js';
import { setHashBackend } from '../crypto/shear_hash.js';
setHashBackend(process.env.SHEAR_HASH_BACKEND || 'jit');
import {
  newIdentity,
  freshStealthDest,
  destOpeningFromView,
  ed25519SeedOf,
} from '../crypto/address.js';
import { destAtIndex } from '../crypto/flow_sheet.js';
import { unwrapBlind } from '../crypto/note.js';
import { admitBaseScalar } from '../crypto/admit.js';
import { levyNanos, bindWeightFee } from '../crypto/levy.js';
import { attachDummyOuts } from '../crypto/dummy.js';
import { signSpendTx } from '../crypto/spend.js';
import { admitSend } from '../tests/spend_box.js';
import {
  BLOCK_SUBSIDY_NANOS,
  SPENDABLE_CONFIRMATIONS,
} from '../crypto/asert.js';

const rpc = (process.env.SHEAR_RPC || 'http://127.0.0.1:18332').replace(/\/$/, '');
const identPath = process.env.SHEAR_MINE_IDENT
  || path.join(process.env.SHEAR_DATA || '/var/lib/shear/testnet-v4', 'mine-ident.json');
const flowFlag = path.join(path.dirname(identPath), 'soak-flow.json');

function loadIdent() {
  try {
    if (fs.existsSync(identPath)) {
      return JSON.parse(fs.readFileSync(identPath, 'utf8'));
    }
  } catch { /* mint */ }
  const id = newIdentity();
  const pay = freshStealthDest(id.paymentCode);
  const rec = {
    dest: pay.dest,
    paymentCode: id.paymentCode,
    viewKey: id.viewKey,
    address: id.address,
    spendPub: Buffer.from(id.spendPub).toString('hex'),
    spendSeed: Buffer.from(id.spendSeed).toString('hex'),
    shared: Buffer.from(pay.shared).toString('hex'),
  };
  fs.mkdirSync(path.dirname(identPath), { recursive: true });
  fs.writeFileSync(identPath, JSON.stringify(rec));
  return rec;
}

const ident = loadIdent();
const dest = process.env.SHEAR_MINE_DEST || ident.dest;
const spendSeed = Buffer.from(ident.spendSeed, 'hex');
const xBase = admitBaseScalar(spendSeed);
const box = {
  dest,
  key: {
    type: 'ed25519-stealth',
    seed: ident.spendSeed ? spendSeed : ed25519SeedOf(ident.privateKey),
    shared: Buffer.from(ident.shared, 'hex'),
  },
};

async function rpcCall(method, params = {}) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  return res.json();
}

function b32(x) {
  if (!x) return null;
  const s = String(x);
  return Buffer.from(s.length === 64 && /^[0-9a-f]+$/i.test(s) ? s : s, 'hex');
}

async function trySoakFlow(tipHeight) {
  if (fs.existsSync(flowFlag)) return;
  if (tipHeight < SPENDABLE_CONFIRMATIONS + 1) return;
  const notes = await rpcCall('getnotes', { address: dest });
  const rows = notes?.notes || [];
  const pot = rows.find((n) => n.coinbase && n.kind === 'pot'
    && Number(n.height) + SPENDABLE_CONFIRMATIONS <= tipHeight
    && n.rEph && n.rCt && n.commit);
  if (!pot) return;
  const extra = Buffer.concat([b32(pot.noteCommit), b32(pot.commit)]);
  const r = unwrapBlind(b32(pot.rEph), b32(pot.rCt), xBase, extra);
  const spent = {
    commit: b32(pot.commit),
    noteCommit: b32(pot.noteCommit),
    r,
    kind: 'pot',
    admitPub: pot.admitPub ? b32(pot.admitPub) : undefined,
  };
  const flux = await rpcCall('getfluxset');
  const pubs = (flux.pubs || []).map((h) => b32(h));
  const commits = (flux.commits || pubs).map((h) => b32(h));
  const pay = 1;
  const fee = levyNanos(pay);
  const leftover = BLOCK_SUBSIDY_NANOS - pay - fee;
  const destB = destAtIndex(ident.address, { index: 1, viewKey: ident.viewKey });
  const destC = destAtIndex(ident.address, { index: 2, viewKey: ident.viewKey });
  const open = destOpeningFromView(ident.viewKey, Buffer.from(ident.spendPub, 'hex'), 0);
  const tx = attachDummyOuts({
    id: `soak-flow-${Date.now()}`,
    kind: 'send',
    from: dest,
    to: destB,
    nanos: pay,
    fee,
    maxLevy: fee,
    changeNanos: leftover,
    open,
    vin: [{ commit: spent.commit, r: spent.r, noteCommit: spent.noteCommit }],
    vout: [
      { address: destB, nanos: pay, kind: 'send' },
      { address: destC, nanos: leftover, kind: 'send' },
    ],
  }, { spent });
  admitSend(tx, {
    id: { spendSeed, privateKey: null },
    spent,
    fluxset: { pubs, commits },
  });
  bindWeightFee(tx);
  signSpendTx(tx, box.key);
  const queued = await rpcCall('queuetx', tx);
  if (queued?.ok) {
    fs.writeFileSync(flowFlag, JSON.stringify({
      ok: true,
      id: tx.id,
      at: new Date().toISOString(),
      height: tipHeight,
    }));
    console.log(JSON.stringify({ event: 'soak_flow_queued', id: tx.id, height: tipHeight }));
  } else {
    console.error(JSON.stringify({ event: 'soak_flow_fail', queued }));
  }
}

console.log(JSON.stringify({
  event: 'mine_loop_start',
  rpc,
  dest,
  admit: 'ADMITv2',
  at: new Date().toISOString(),
}));

let n = 0;
for (;;) {
  try {
    const tpl = await rpcCall('gettemplate', { miner: dest });
    if (!tpl?.ok || !tpl.header) {
      console.error(JSON.stringify({ event: 'template_fail', tpl }));
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const found = mineTemplate(
      { header: Buffer.from(tpl.header, 'hex'), bits: tpl.bits },
      { maxTries: 250_000, shareBits: tpl.bits },
    );
    if (!found || !found.block) {
      console.error(JSON.stringify({ event: 'pow_miss', height: tpl.height, bits: tpl.bits }));
      continue;
    }
    const got = await rpcCall('submitblock', {
      jobId: tpl.jobId,
      nonce: found.nonce.toString(),
      miner: dest,
      powHash: found.hash ? Buffer.from(found.hash).toString('hex') : undefined,
    });
    n += 1;
    console.log(JSON.stringify({
      event: 'mined',
      n,
      height: tpl.height,
      ok: !!got?.ok,
      reason: got?.reason || null,
      at: new Date().toISOString(),
    }));
    if (got?.ok) {
      try { await trySoakFlow(Number(tpl.height) || 0); } catch (e) {
        console.error(JSON.stringify({ event: 'soak_flow_err', err: String(e && e.message ? e.message : e) }));
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'mine_err', err: String(e && e.message ? e.message : e) }));
    await new Promise((r) => setTimeout(r, 3000));
  }
}
