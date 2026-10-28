/**
 * Publish B leaves by an FS-1 send that locks the unit in the conservation
 * equation. A hand-set bLeaves list is b_leaves. The native addon has to be
 * loaded (crypto/native shearadmit.node).
 */
import { hash20FromAddress } from '../../crypto/address.js';
import { walletAnchor } from '../../crypto/admit_v3.js';
import { MAGIC_TESTNET } from '../../crypto/asert.js';
import { compactTx } from '../../crypto/chronoflux.js';
import { viewTagOf } from '../../crypto/dummy.js';
import {
  fs1BlobLen,
  fs1ProveSpend,
  FS1_RECORD_BYTES,
  FS1_WIRE,
  resetFs1Tree,
  txBodyDigestFs1,
} from '../../crypto/fs1_spend.js';
import { levyNeed, LEVY_CAP_NANOS, LEVY_FLOOR_UNITS } from '../../crypto/levy.js';
import { fs1NativeLoaded } from '../../crypto/native_admit.js';
import {
  asU8,
  kernelExcess,
  sealHiddenNote,
  sealNote,
} from '../../crypto/note.js';
import { attachAdmitPub } from '../../crypto/admit.js';
import {
  appendTpl,
  potOutput,
  templateOn,
} from './b_leaf_fund.js';

function hiddenOut(nanos, dest20, admitBase, kind) {
  const sealed = admitBase
    ? sealHiddenNote(nanos, { dest20, kind, admitBase })
    : sealNote(nanos, { dest20, kind });
  let note = attachAdmitPub(sealed, admitBase ? { admitBase } : {});
  note = { ...note, kind, dest20: Buffer.from(dest20), viewTag: viewTagOf(note.noteCommit) };
  if (kind !== 'dummy') delete note.valueProof;
  return note;
}

function rangeSlack(outs) {
  let bytes = 0;
  for (const o of outs) {
    if (o?.rangeProof) bytes += Buffer.from(asU8(o.rangeProof)).length;
  }
  return Math.ceil((bytes * 2) / 2048) + 8;
}

function placeholders(k) {
  const fs1 = Buffer.alloc(fs1BlobLen(k), 255);
  fs1[0] = FS1_WIRE;
  const proofs = [];
  for (let i = 0; i < k; i += 1) {
    const blob = Buffer.alloc(FS1_RECORD_BYTES, 255);
    blob[0] = FS1_WIRE;
    proofs.push({
      admit_proof: true,
      v: 3,
      spendTag: Buffer.alloc(32, 255),
      blob,
      cTilde: Buffer.alloc(32, 255),
    });
  }
  return { fs1, proofs, vin: proofs.map(() => ({ commit: Buffer.alloc(32, 255) })) };
}

function indexedCoins(coins, live) {
  const at = new Map();
  for (let i = 0; i < live.n; i += 1) {
    at.set(Buffer.from(asU8(live.commits[i])).toString('hex'), i);
  }
  const out = [];
  for (const coin of coins) {
    const key = coin.commit.toString('hex');
    if (!at.has(key)) continue;
    out.push({ ...coin, index: at.get(key) });
  }
  return out;
}

async function growCoins(store, who, need) {
  const coins = [];
  for (let step = 0; step < 80; step += 1) {
    const height = (store.tip()?.height || 0) + 1;
    const anchor = walletAnchor(height);
    const live = anchor != null ? store.anchorNote(anchor) : null;
    if (live && live.n >= 1) {
      const ready = indexedCoins(coins, live);
      if (ready.length >= need) return { anchor, live, coins: ready };
    }
    // R28: who mines solo with option (b); the pot is its record coin.
    const tpl = templateOn(store, { miner: who.dest });
    const got = await appendTpl(store, tpl);
    if (!got.ok) {
      throw new Error(`grow ${store.tip()?.height || 0} ${got.reason || ''} ${got.error || ''}`);
    }
    const pot = potOutput(store.tip(), who.dest);
    if (pot && Number.isSafeInteger(pot.opened) && pot.opened > 0) {
      coins.push({ r: pot.r, v: pot.opened, commit: pot.commit, x: pot.x });
    }
  }
  throw new Error(`anchor never held ${need} pot notes`);
}

export function lockSend(who, spec, coin, anchor, live) {
  const dest20 = Buffer.from(hash20FromAddress(who.dest));
  const tag = spec.tag == null || spec.tag === '' ? 'b-extra' : String(spec.tag);
  const memoH = spec.memoH == null ? Buffer.alloc(32) : Buffer.from(spec.memoH);
  const unit = spec.unit;
  const nonce = spec.nonce;
  const k = 1;
  let fee = LEVY_FLOOR_UNITS;
  let outs = null;
  let draft = null;
  const ph = placeholders(k);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const room = coin.v - fee - unit;
    if (!Number.isSafeInteger(room) || room < 1) {
      throw new Error(`unit ${unit} does not fit in pot ${coin.v} at fee ${fee}`);
    }
    outs = [
      hiddenOut(room, dest20, who.id.admitBase, 'send'),
      hiddenOut(0, Buffer.alloc(20, 4), null, 'dummy'),
    ];
    draft = compactTx({
      id: spec.id,
      kind: 'send',
      anchor,
      fee,
      bFlag: 1,
      unit,
      nonce,
      tag,
      dest20,
      memoH,
      vin: ph.vin,
      vout: outs,
      fs1: ph.fs1,
      admit_proofs: ph.proofs,
      excess: Buffer.alloc(32, 255),
    });
    const need = levyNeed(draft);
    if (fee >= need && fee <= LEVY_CAP_NANOS) break;
    const next = need + rangeSlack(outs);
    if (!(next > fee && next <= LEVY_CAP_NANOS)) {
      throw new Error(`levy ${need} fee ${fee} unit ${unit}`);
    }
    fee = next;
    draft = null;
  }
  if (!draft) throw new Error(`fee did not settle for ${spec.id}`);
  const proven = fs1ProveSpend({
    live,
    anchor,
    indices: [coin.index],
    xs: [coin.x],
    tx: draft,
    magic: MAGIC_TESTNET,
  });
  if (!proven) throw new Error(`prove ${spec.id}`);
  const excess = kernelExcess(outs, [{ r: coin.r, t: proven.t[0] }]);
  if (!excess) throw new Error(`excess ${spec.id}`);
  const tx = compactTx({
    id: spec.id,
    kind: 'send',
    anchor,
    fee: draft.fee,
    bFlag: 1,
    unit,
    nonce,
    tag,
    dest20,
    memoH,
    vin: [{ commit: Buffer.from(proven.proofs[0].cTilde) }],
    vout: outs,
    fs1: proven.fs1,
    admit_proofs: proven.proofs,
    excess,
  });
  if (!txBodyDigestFs1(tx, MAGIC_TESTNET).equals(proven.digest)) {
    throw new Error(`digest ${spec.id}`);
  }
  if (levyNeed(tx) > tx.fee) throw new Error(`levy short ${spec.id}`);
  return tx;
}

/**
 * Grow until `specs.length` pot notes sit in the wallet anchor, then append
 * one block whose debited leaves are those specs, in order.
 * Returns { height, block, leaves }.
 */
export async function publishBLeaves(store, who, specs) {
  if (!fs1NativeLoaded()) throw new Error('shearadmit FS-1 addon is not loaded');
  if (!who?.dest || !who?.spendSeed || !who?.id?.admitBase) throw new Error('payer');
  if (!Array.isArray(specs) || !specs.length) throw new Error('specs');
  resetFs1Tree();
  const view = await growCoins(store, who, specs.length);
  const used = new Set();
  const txs = [];
  for (const spec of specs) {
    const coin = view.coins.find((c) => !used.has(c.index) && c.v > spec.unit + LEVY_CAP_NANOS);
    if (!coin) throw new Error(`no pot for unit ${spec.unit}`);
    used.add(coin.index);
    txs.push(lockSend(who, spec, coin, view.anchor, view.live));
  }
  const tpl = templateOn(store, { miner: who.dest, txs });
  const ids = new Set(specs.map((s) => s.id));
  const carried = (tpl.txs || []).filter((tx) => ids.has(tx.id));
  if (carried.length !== specs.length) throw new Error('template dropped a leaf debit');
  const got = await appendTpl(store, tpl);
  if (!got.ok) throw new Error(`leaf block ${got.reason || ''} ${got.error || ''}`);
  const block = store.tip();
  const leaves = Array.isArray(block?.bLeaves) ? block.bLeaves : [];
  if (leaves.length !== specs.length) {
    throw new Error(`leaf count ${leaves.length} wanted ${specs.length}`);
  }
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const leaf = leaves[i];
    const tag = spec.tag == null || spec.tag === '' ? 'b-extra' : String(spec.tag);
    if (!leaf || leaf.unit !== spec.unit || leaf.nonce !== spec.nonce || leaf.tag !== tag) {
      throw new Error(`leaf ${i} ${leaf?.unit}/${leaf?.nonce}/${leaf?.tag}`);
    }
  }
  return { height: Number(block.height), block, leaves };
}
