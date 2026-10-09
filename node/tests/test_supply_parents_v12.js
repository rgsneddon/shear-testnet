/**
 * Supply is a chain property. A block whose parent is above the genesis
 * height is not verified from that parent alone. Every path that accepts a
 * block (direct verify, append, fork, load, ingest) has the genesis-rooted
 * parent list or it fails closed. A non-rooted list is the same failure.
 * Lengths below are a spread, not a special case.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { verifyBlock, historyPrefix } from '../src/chain.js';
import { bookSealKeyPath } from '../src/book_seal_key.js';
import { TARGET_BLOCK_INTERVAL_MS, RESERVE_PROGRAM, MAGIC_TESTNET } from '../../crypto/asert.js';
import { newIdentity } from '../../crypto/address.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { auditCirculatingSupply, foldSupply, supplyStep, supplyLinks } from '../src/supply.js';
import { fluxsetFromBlocks } from '../../crypto/admit.js';
import {
  verifyTypedAdmitFunding,
  anchorFluxRebuilds,
  resetAnchorFluxRebuilds,
} from '../../crypto/admit_v3.js';
import { VOTE_HOLD, unitsAlongChain, bonusUnitsBefore } from '../../crypto/reserve_vault.js';
import { recordProofFail, P2P_FAIL_DISCONNECT } from '../src/p2p.js';

const T = TARGET_BLOCK_INTERVAL_MS;
const T0 = 1_700_000_000_000;
const LENGTHS = [1, 2, 3, 5, 8];

function dest() {
  const id = newIdentity();
  return destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
}

let powTag = 1;
function easyPowHash() {
  const h = Buffer.alloc(32);
  h[4] = powTag & 0xff;
  h[5] = (powTag >> 8) & 0xff;
  h[6] = (powTag >> 16) & 0xff;
  powTag += 1;
  return h;
}

function parentView(block) {
  return {
    hash: block.hash,
    header: block.header,
    height: block.height,
    txs: block.txs,
    bLeaves: block.bLeaves,
    weight: block.weight,
    shareBatch: block.shareBatch,
    rootA: block.rootA,
    rootB: block.rootB,
  };
}

function cloneBlocks(blocks) {
  return blocks.map((b) => ({
    ...b,
    txs: (b.txs || []).map((tx) => ({
      ...tx,
      vout: (tx.vout || []).map((o) => ({
        ...o,
        commit: o.commit ? Buffer.from(o.commit) : o.commit,
      })),
    })),
  }));
}

function withPotFlipped(blocks, index) {
  const copy = cloneBlocks(blocks);
  const pot = (copy[index]?.txs?.[0]?.vout || []).find((o) => o.kind === 'pot');
  assert.ok(pot?.commit?.length > 0, `pot commit at ${index}`);
  pot.commit[0] ^= 0xff;
  return copy;
}

describe('v12 supply parents fail closed', () => {
  it('any chain length agrees on append, fork, load, and ingest, and a missing parent chain is supply', async () => {
    const dirs = [];
    const mk = (tag) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), tag));
      dirs.push(dir);
      return dir;
    };
    try {
      for (const n of LENGTHS) {
        const who = dest();
        const dir = mk('shear-supply-parents-');
        const store = createStore(dir);
        for (let i = 0; i < n; i += 1) {
          const now = T0 + i * T;
          const { tpl } = store.template({ miner: who, shareBits: 4, now });
          const block = {
            header: tpl.header,
            txs: tpl.txs,
            samples: tpl.samples,
            shareBatch: tpl.shareBatch || [],
            miner: who,
            aLeaves: tpl.aLeaves,
            bLeaves: tpl.bLeaves,
            rootA: tpl.rootA,
            rootB: tpl.rootB,
            weight: tpl.weight,
          };
          const got = await Promise.resolve(store.append(block, {
            trustedPowHash: easyPowHash(),
            skipSharePow: true,
          }));
          assert.equal(got.ok, true, `append len ${n} h ${i + 1} ${got.reason}`);
        }
        assert.equal(store.tip().height, n);
        const blocks = store.blocks;
        const live = auditCirculatingSupply(blocks);
        assert.equal(live.status, 'verified', `live ${n} ${live.reason}`);

        const forked = await Promise.resolve(store.verifyFork(blocks, {
          trustBlockHash: true,
          skipSharePow: true,
          nowMs: Date.now(),
        }));
        assert.equal(forked.ok, true, `fork ${n} ${forked.reason}`);
        assert.ok(supplyLinks(forked.supply, blocks[n - 1]), `fork supply ${n}`);
        const liveRoot = Buffer.from(store.jroot());
        const rebuiltRoot = Buffer.from(fluxsetFromBlocks(blocks).jroot);
        assert.ok(liveRoot.equals(rebuiltRoot), `live root ${n}`);

        if (n >= 2) {
          const last = blocks[n - 1];
          const parent = blocks[n - 2];
          assert.equal(Number(parent.height), n - 1);
          const opts = {
            trustedPowHash: last.hash,
            skipSharePow: true,
            nowMs: Date.now(),
            genesisMs: T0,
            parentFluxset: fluxsetFromBlocks(blocks.slice(0, -1)),
          };
          const bare = verifyBlock(last, parentView(parent), opts);
          if (n >= 3) {
            assert.ok(Number(parent.height) > 1);
            assert.equal(bare.ok, false, `bare ${n}`);
            assert.equal(bare.reason, 'supply_state', `bare ${n} ${bare.reason}`);
          } else {
            assert.equal(bare.ok, true, `child of genesis ${bare.reason}`);
          }
          const rooted = verifyBlock(last, parentView(parent), {
            ...opts,
            supplyParents: blocks.slice(0, -1),
          });
          assert.equal(rooted.ok, true, `rooted ${n} ${rooted.reason}`);
          const emptyParents = verifyBlock(last, parentView(parent), {
            ...opts,
            supplyParents: [],
          });
          assert.equal(emptyParents.ok, false, `empty parents ${n}`);
          assert.equal(emptyParents.reason, 'supply_state', emptyParents.reason);
          for (const at of [0, n - 2]) {
            const forged = withPotFlipped(blocks, at);
            const bad = verifyBlock(last, parentView(parent), {
              ...opts,
              supplyParents: forged.slice(0, -1),
            });
            assert.equal(bad.ok, false, `tamper ${n} at ${at}`);
            assert.equal(bad.reason, 'supply', `tamper ${n} at ${at} ${bad.reason}`);
          }
          assert.equal(store.tip().height, n);

          const rival = createStore(mk('shear-supply-rival-'));
          const { tpl } = rival.template({
            miner: dest(),
            shareBits: 4,
            now: T0 + 60_000,
          });
          const rivalBlock = {
            header: tpl.header,
            txs: tpl.txs,
            samples: tpl.samples,
            shareBatch: tpl.shareBatch || [],
            miner: tpl.miner,
            aLeaves: tpl.aLeaves,
            bLeaves: tpl.bLeaves,
            rootA: tpl.rootA,
            rootB: tpl.rootB,
            weight: tpl.weight,
          };
          const seeded = await Promise.resolve(rival.append(rivalBlock, {
            trustedPowHash: easyPowHash(),
            skipSharePow: true,
          }));
          assert.equal(seeded.ok, true, seeded.reason);
          const adopted = await Promise.resolve(rival.ingest(blocks, {
            trustBlockHash: true,
            skipSharePow: true,
            nowMs: Date.now(),
          }));
          assert.equal(adopted.ok, true, `ingest fork ${n} ${adopted.reason}`);
          assert.equal(rival.tip().height, n);
          assert.ok(Buffer.from(rival.tip().hash).equals(Buffer.from(last.hash)));
          const rivalRoot = Buffer.from(rival.jroot());
          assert.ok(rivalRoot.equals(Buffer.from(fluxsetFromBlocks(rival.blocks).jroot)), `adopt root ${n}`);
          const { tpl: moreTpl } = rival.template({ miner: who, shareBits: 4, now: T0 + n * T });
          const extended = await Promise.resolve(rival.append({
            header: moreTpl.header,
            txs: moreTpl.txs,
            samples: moreTpl.samples,
            shareBatch: moreTpl.shareBatch || [],
            miner: who,
            aLeaves: moreTpl.aLeaves,
            bLeaves: moreTpl.bLeaves,
            rootA: moreTpl.rootA,
            rootB: moreTpl.rootB,
            weight: moreTpl.weight,
          }, {
            trustedPowHash: easyPowHash(),
            skipSharePow: true,
          }));
          assert.equal(extended.ok, true, `post-adopt append ${n} ${extended.reason}`);
          assert.equal(rival.tip().height, n + 1);
        }

        if (n >= 3) {
          const last = blocks[n - 1];
          const parent = blocks[n - 2];
          const windowed = verifyBlock(last, parentView(parent), {
            trustedPowHash: last.hash,
            skipSharePow: true,
            nowMs: Date.now(),
            genesisMs: T0,
            parentFluxset: fluxsetFromBlocks(blocks.slice(0, -1)),
            evmHistory: blocks.slice(1, -1),
          });
          assert.equal(windowed.ok, false, `window ${n}`);
          assert.equal(windowed.reason, 'supply_state', `window ${n} ${windowed.reason}`);

          const suffixStore = createStore(mk('shear-supply-suffix-'));
          const opened = await Promise.resolve(suffixStore.ingest([blocks[0]], {
            trustBlockHash: true,
            skipSharePow: true,
            nowMs: Date.now(),
          }));
          assert.equal(opened.ok, true, opened.reason);
          const { tpl } = suffixStore.template({
            miner: dest(),
            shareBits: 4,
            now: T0 + T + 7_000,
          });
          const sibling = await Promise.resolve(suffixStore.append({
            header: tpl.header,
            txs: tpl.txs,
            samples: tpl.samples,
            shareBatch: tpl.shareBatch || [],
            miner: tpl.miner,
            aLeaves: tpl.aLeaves,
            bLeaves: tpl.bLeaves,
            rootA: tpl.rootA,
            rootB: tpl.rootB,
            weight: tpl.weight,
          }, {
            trustedPowHash: easyPowHash(),
            skipSharePow: true,
          }));
          assert.equal(sibling.ok, true, sibling.reason);
          const suffix = await Promise.resolve(suffixStore.ingest(blocks.slice(1), {
            trustBlockHash: true,
            skipSharePow: true,
            nowMs: Date.now(),
          }));
          assert.equal(suffix.ok, true, `suffix ${n} ${suffix.reason}`);
          assert.equal(suffixStore.tip().height, n);
          assert.ok(Buffer.from(suffixStore.tip().hash).equals(Buffer.from(last.hash)));
          const { tpl: sufTpl } = suffixStore.template({ miner: who, shareBits: 4, now: T0 + n * T });
          const sufNext = await Promise.resolve(suffixStore.append({
            header: sufTpl.header,
            txs: sufTpl.txs,
            samples: sufTpl.samples,
            shareBatch: sufTpl.shareBatch || [],
            miner: who,
            aLeaves: sufTpl.aLeaves,
            bLeaves: sufTpl.bLeaves,
            rootA: sufTpl.rootA,
            rootB: sufTpl.rootB,
            weight: sufTpl.weight,
          }, {
            trustedPowHash: easyPowHash(),
            skipSharePow: true,
          }));
          assert.equal(sufNext.ok, true, `post-suffix append ${n} ${sufNext.reason}`);
        }

        const prefix = historyPrefix(blocks, Math.max(0, n - 1));
        assert.equal(prefix.length, Math.max(0, n - 1));
        if (n > 1) {
          assert.equal(prefix[0], blocks[0]);
          let seen = 0;
          for (const row of prefix) {
            assert.equal(row, blocks[seen]);
            seen += 1;
          }
          assert.equal(seen, n - 1);
        }

        if (n === LENGTHS[LENGTHS.length - 1]) {
          const shortFold = foldSupply(blocks.slice(0, 1));
          const tallFold = foldSupply(blocks.slice(0, n - 1));
          assert.equal(shortFold.ok, true, shortFold.reason);
          assert.equal(tallFold.ok, true, tallFold.reason);
          const rounds = 40;
          const timeSteps = (state, block, height) => {
            const t0 = performance.now();
            let last = null;
            for (let r = 0; r < rounds; r += 1) {
              last = supplyStep(state, block, {
                height,
                tipHeight: height,
                blockHash: block.hash,
                genesisMs: T0,
              });
            }
            return { ms: performance.now() - t0, last };
          };
          const shortStep = timeSteps(shortFold.state, blocks[1], 2);
          const tallStep = timeSteps(tallFold.state, blocks[n - 1], n);
          assert.equal(shortStep.last.ok, true, shortStep.last.reason);
          assert.equal(tallStep.last.ok, true, tallStep.last.reason);
          const low = Math.max(shortStep.ms, 0.001);
          const high = Math.max(tallStep.ms, 0.001);
          assert.ok(high <= low * 3, `supply step grew ${high} vs ${low}`);
          assert.ok(low <= high * 3, `supply step shrank ${low} vs ${high}`);

          resetAnchorFluxRebuilds();
          const queued = store.queueTx({
            id: `cheap-lock-${n}`,
            kind: 'lock',
            programId: RESERVE_PROGRAM,
            anchor: 8,
            vin: [{ commit: Buffer.alloc(32, 4), anchor: 8 }],
            admit_proofs: [{ blob: Buffer.alloc(40), cTilde: Buffer.alloc(32, 4) }],
          });
          assert.equal(queued.ok, false, queued.reason);
          assert.notEqual(queued.proofChecked, true);
          assert.equal(anchorFluxRebuilds(), 0);
        }

        const snapDir = mk('shear-supply-snap-');
        fs.cpSync(dir, snapDir, { recursive: true });
        fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(snapDir));
        const snapped = createStore(snapDir);
        assert.equal(snapped.loadMode, 'snap', `snap ${n} ${snapped.loadMode}`);
        assert.equal(snapped.tip().height, n);
        assert.ok(Buffer.from(snapped.jroot()).equals(Buffer.from(store.jroot())), `snap root ${n}`);

        const replayDir = mk('shear-supply-replay-');
        fs.cpSync(dir, replayDir, { recursive: true });
        fs.copyFileSync(bookSealKeyPath(dir), bookSealKeyPath(replayDir));
        fs.rmSync(path.join(replayDir, 'book.snap'), { force: true });
        const loaded = createStore(replayDir);
        assert.equal(loaded.loadMode, 'full', `load ${n} ${loaded.loadMode}`);
        assert.equal(loaded.tip().height, n);
        assert.ok(Buffer.from(loaded.tip().hash).equals(Buffer.from(store.tip().hash)));
        const replayed = auditCirculatingSupply(loaded.blocks);
        assert.equal(replayed.status, 'verified', `replay ${n} ${replayed.reason}`);
      }
    } finally {
      for (const dir of dirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
        try { fs.rmSync(bookSealKeyPath(dir), { force: true }); } catch { /* temp key */ }
      }
    }
  });

  it('a rejected reserve apply stops the unit walk, and a shaped bad proof does not rebuild J', () => {
    const portalId = 'ab'.repeat(32);
    const voteBlock = {
      header: Buffer.alloc(80),
      txs: [{
        programId: RESERVE_PROGRAM,
        kind: 'vote',
        portalId,
        choice: VOTE_HOLD,
      }],
    };
    assert.equal(bonusUnitsBefore([voteBlock]), null);
    const walked = unitsAlongChain({ fork: [voteBlock] });
    assert.equal(walked.ok, false);
    assert.equal(walked.reason, 'not_voter');
    assert.equal(walked.at, 0);
    assert.equal(walked.units.length, 1);

    const commit = Buffer.alloc(32, 7);
    const blob = Buffer.alloc(40, 3);
    blob[0] = 3;
    let lookups = 0;
    resetAnchorFluxRebuilds();
    const junk = verifyTypedAdmitFunding({
      kind: 'vote',
      anchor: 8,
      vin: [{ commit, anchor: 8 }],
      admit_proofs: [{ blob, cTilde: commit, spendTag: Buffer.alloc(32, 1) }],
    }, {
      height: 24,
      magic: MAGIC_TESTNET,
      blocks: [voteBlock, voteBlock, voteBlock],
      noteAtAnchor: () => {
        lookups += 1;
        return { jroot: Buffer.alloc(32, 9), n: 1 };
      },
    });
    assert.equal(junk.ok, false);
    assert.equal(junk.proofChecked, true);
    assert.equal(lookups, 1);
    assert.equal(anchorFluxRebuilds(), 0);

    resetAnchorFluxRebuilds();
    const malformed = verifyTypedAdmitFunding({
      kind: 'lock',
      anchor: 8,
      vin: [{ commit, anchor: 8 }],
      admit_proofs: [{ blob: Buffer.from([9]), cTilde: commit }],
    }, {
      height: 24,
      magic: MAGIC_TESTNET,
      blocks: [voteBlock, voteBlock, voteBlock, voteBlock],
    });
    assert.equal(malformed.ok, false);
    assert.notEqual(malformed.proofChecked, true);
    assert.equal(anchorFluxRebuilds(), 0);

    const rec = { expensiveFails: 0 };
    for (let i = 0; i < P2P_FAIL_DISCONNECT - 1; i += 1) {
      assert.equal(recordProofFail(rec), false);
    }
    assert.equal(recordProofFail(rec), true);
    assert.equal(rec.expensiveFails, P2P_FAIL_DISCONNECT);
  });
});
