#!/usr/bin/env node
/**
 * Vault scale bench (Vault Y row (b), 28 Oct). Measures, at N live vault
 * leaves, what a node and a prover pay:
 *   - native FS-1 vault tree build (the rebuild after any withdraw, and the
 *     first append after cloneVault or restoreTrial), and a 16-leaf append;
 *   - FS-1 unlinked prove and verify against that tree (the membership core
 *     of the leaf-vote and claim proofs), and a linked FS-1 spend at depth;
 *   - the JS vault state at N: heap, JSON size, cloneVault, the live-note
 *     filter appendVaultLockNote runs per leaf, and commitVaultLockRoot.
 *
 * Usage: node --max-old-space-size=12000 scripts/vault_scale_bench.mjs 4096 65536 1048576
 * Add --native-only for a size where the JS state does not fit.
 * Read-only: no datadir, no network, no service. One line of JSON per size.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RistrettoPoint } from '@noble/curves/ed25519.js';
import { PI_SHE_NANOS } from '../crypto/asert.js';
import { scalarBytes, randomScalar } from '../crypto/note.js';
import {
  fs1NativeLoaded, fs1TreeNew, fs1TreeAppend, fs1TreeRoot, fs1ProveUnlinked, fs1VerifyUnlinked, fs1Prove, fs1Verify,
} from '../crypto/native_admit.js';
import { vaultLockNote } from '../crypto/vault_reward_fs1.js';
import { emptyVault, cloneVault, commitVaultLockRoot } from '../crypto/reserve_vault.js';

if (!fs1NativeLoaded()) {
  console.error('FS-1 native addon not loaded');
  process.exit(2);
}
const args = process.argv.slice(2);
const nativeOnly = args.includes('--native-only');
const sizes = args.filter((a) => /^\d+$/.test(a)).map(Number);
// --dump=DIR writes notes_N.bin and own_N.hex (a throwaway bench scalar) for the Dart bench.
const dumpDir = (args.find((a) => a.startsWith('--dump=')) || '').slice(7);

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const now = () => process.hrtime.bigint();
const mb = (n) => Math.round(n / 1048576);
function gc() { if (global.gc) global.gc(); }

/** N-1 distinct valid ristretto pairs by repeated addition, then one real π leaf. */
function notesOf(n) {
  const out = Buffer.alloc(64 * n);
  let p = RistrettoPoint.BASE.multiply(0x1234567n);
  let c = RistrettoPoint.BASE.multiply(0x7654321n);
  const step = RistrettoPoint.BASE;
  for (let i = 0; i < n - 1; i += 1) {
    out.set(p.toRawBytes(), 64 * i);
    out.set(c.toRawBytes(), 64 * i + 32);
    p = p.add(step);
    c = c.add(step);
  }
  const own = vaultLockNote(PI_SHE_NANOS, randomScalar(), randomScalar(), 32);
  out.set(own.note, 64 * (n - 1));
  return { buf: out, own };
}

function bench(n) {
  const row = { host: os.hostname(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model, n };
  let t = now();
  const { buf, own } = notesOf(n);
  row.genMs = Math.round(ms(t));
  if (dumpDir) {
    fs.writeFileSync(path.join(dumpDir, `notes_${n}.bin`), buf);
    fs.writeFileSync(path.join(dumpDir, `own_${n}.hex`), Buffer.from(scalarBytes(own.scalar)).toString('hex'));
    fs.writeFileSync(path.join(dumpDir, 'base.hex'), Buffer.from(RistrettoPoint.BASE.multiply(7n).toRawBytes()).toString('hex'));
  }
  gc();
  const rss0 = process.memoryUsage().rss;
  t = now();
  const h = fs1TreeNew();
  if (!h || !fs1TreeAppend(h, buf)) throw new Error('tree append');
  const root = fs1TreeRoot(h);
  row.treeBuildMs = Math.round(ms(t));
  row.treeRssMb = mb(process.memoryUsage().rss - rss0);
  // 16 more leaves on the live handle: one full lock's worth.
  const extra = notesOf(17).buf.subarray(0, 64 * 16);
  t = now();
  fs1TreeAppend(h, extra);
  fs1TreeRoot(h);
  row.append16Ms = +ms(t).toFixed(2);
  // Prove the real leaf at index n-1 (the 16 extras sit after it).
  const root2 = fs1TreeRoot(h);
  const digest = randomBytes(32);
  const nullBases = Buffer.from(RistrettoPoint.BASE.multiply(7n).toRawBytes());
  t = now();
  const pu = fs1ProveUnlinked(h, { indices: [n - 1], xs: [scalarBytes(own.scalar)], digest, anchor: 1, nullBases });
  row.proveUnlinkedMs = Math.round(ms(t));
  if (!pu) throw new Error('prove unlinked');
  row.unlinkedBytes = pu.fs1.length + pu.records.length + pu.link.length;
  const reps = 5;
  t = now();
  let ok = true;
  for (let i = 0; i < reps; i += 1) {
    ok = ok && fs1VerifyUnlinked({ fs1: pu.fs1, records: pu.records, link: pu.link, root: root2, digest, anchor: 1, nullBases });
  }
  row.verifyUnlinkedMs = +(ms(t) / reps).toFixed(1);
  row.verifyUnlinkedOk = ok;
  t = now();
  const ps = fs1Prove(h, { indices: [n - 1], xs: [scalarBytes(own.scalar)], digest, anchor: 1 });
  row.proveSpendMs = Math.round(ms(t));
  if (ps) {
    row.spendBytes = ps.fs1.length + ps.records.length;
    t = now();
    row.verifySpendOk = fs1Verify({ fs1: ps.fs1, records: ps.records, root: root2, digest, anchor: 1 });
    row.verifySpendMs = +ms(t).toFixed(1);
  }
  if (!nativeOnly) {
    gc();
    const heap0 = process.memoryUsage().heapUsed;
    t = now();
    const state = emptyVault();
    state.vaultLockNotes = new Array(n);
    state.vaultLockIndex = Object.create(null);
    state.vaultLeafBorn = Object.create(null);
    state.vaultLeafUnlock = Object.create(null);
    state.vaultLeafHeight = Object.create(null);
    for (let i = 0; i < n; i += 1) {
      const hex = buf.subarray(64 * i, 64 * i + 64).toString('hex');
      state.vaultLockNotes[i] = hex;
      state.vaultLockIndex[hex.slice(64)] = hex;
      state.vaultLeafBorn[hex] = 1;
      state.vaultLeafUnlock[hex] = '32';
      state.vaultLeafHeight[hex] = 100 + (i >> 9);
    }
    row.stateFillMs = Math.round(ms(t));
    gc();
    row.stateHeapMb = mb(process.memoryUsage().heapUsed - heap0);
    t = now();
    const live = state.vaultLockNotes.filter((x) => !state.vaultRetired?.[x]);
    row.liveFilterMs = +ms(t).toFixed(2);
    void live;
    // cloneVault and the snapshot are JSON round trips of the whole vault.
    // Past V8's string limit they throw; record that rather than stop.
    t = now();
    try {
      const json = JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      row.stateJsonMb = +(json.length / 1048576).toFixed(1);
      row.stringifyMs = Math.round(ms(t));
    } catch (err) {
      row.stringifyError = String(err?.message || err);
    }
    t = now();
    try {
      const copy = cloneVault(state);
      row.cloneVaultMs = Math.round(ms(t));
      void copy;
    } catch (err) {
      row.cloneVaultError = String(err?.message || err);
    }
    state.vaultLockDirty = true;
    t = now();
    const r = commitVaultLockRoot(state);
    row.rebuildRootMs = Math.round(ms(t));
    row.rebuildRootOk = r === Buffer.from(root).toString('hex');
  }
  row.rssMb = mb(process.memoryUsage().rss);
  console.log(JSON.stringify(row));
}

for (const n of sizes) bench(n);
