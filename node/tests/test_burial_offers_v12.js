/**
 * PSA-pr74b-1. Header offers for a pruned block's burial proof.
 *
 * A header is cached only after a cheap work check: it links to a known
 * parent, its ASERT bits and timestamp follow that parent, and its claimed
 * hash meets its own bits. No ShearHash runs at offer time. Each peer has
 * its own bounded bucket, so one peer's junk cannot push out another's run.
 * A peer that sends a bad link, at offer time or when proveBurial hashes it,
 * is dropped and its unproven headers go. Proven headers keep their bytes in
 * their own pool and are tried first.
 *
 * Matrix: junk ratio {0, 50%, 99%} x {1, 4} honest peers x {jit-full, light}.
 * Junk here is the expensive kind: full-length forged runs that pass the cheap
 * check and only fail a real ShearHash. Each block brings fresh attacker ids.
 * The test chain's honest headers are stand-ins, not ShearHash work, so their
 * hashes are passed as trustedHeaderHashes. Every junk header is hashed for
 * real in the selected mode: jit-full and light (jit) off-loop lanes, and the
 * in-process light interpreter on the sync path.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newIdentity } from '../../crypto/address.js';
import { SAMPLE_PRUNE_CONFIRMATIONS, SHARE_FLOOR_BITS, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { decodeWireBlock, encodeWireBlock, selectHeadersAfterLocator } from '../src/p2p.js';
import { createStore, OFFER_PEER_CAP, OFFER_PEER_SLOTS } from '../src/store.js';

const PRUNE = SAMPLE_PRUNE_CONFIRMATIONS;
const STEP = TARGET_BLOCK_INTERVAL_MS;
const PRUNED = 4;
const TIP = PRUNE + PRUNED;
const PAGE = 2000;
const RATIOS = [0, 0.5, 0.99];
const PEERS = [1, 4];
const MODES = {
  'jit-full': { backend: 'jit-full', paths: ['offloop'] },
  light: { backend: 'jit', paths: ['offloop', 'sync'] },
};
const MODE = process.env.BURIAL_OFFERS_MODE || '';
const SOURCE = process.env.BURIAL_OFFERS_SOURCE || '';
const self = fileURLToPath(import.meta.url);

let powTag = 1;
function easyPow() {
  const h = Buffer.alloc(32);
  h.writeUInt32LE(powTag >>> 0, 4);
  powTag += 1;
  return h;
}

function hex(b) {
  return Buffer.from(b).toString('hex');
}

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shear-offers-${tag}-`));
}

function headerTime(block) {
  return Number(decodeHeader(Buffer.from(block.header)).timestamp);
}

function sealNext(store, dest) {
  const t = store.tip();
  const now = t ? headerTime(t) + STEP : 1_700_000_000_000;
  const { tpl } = store.template({ miner: dest, now, shareBits: SHARE_FLOOR_BITS, shareBatch: [] });
  return store.append({
    header: tpl.header,
    txs: tpl.txs,
    samples: tpl.samples,
    shareBatch: tpl.shareBatch || [],
    miner: dest,
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: easyPow(), skipSharePow: true });
}

function buildSource(dir) {
  const id = newIdentity();
  const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
  const store = createStore(dir, { fastSync: true });
  for (let h = 1; h <= TIP; h += 1) {
    const got = sealNext(store, dest);
    assert.equal(got.ok, true, `${got.reason} at ${h}`);
  }
  return store;
}

function wire(block) {
  return decodeWireBlock(JSON.parse(JSON.stringify(encodeWireBlock(block))));
}

/** A claimed hash that meets any live bits and is not the header's ShearHash. */
function forgedHash() {
  const h = randomBytes(32);
  h.fill(0, 0, 5);
  return h;
}

/**
 * Full-length forged runs above the honest row at `at`: each copies the
 * honest timestamps and bits, so it passes the cheap check, with a fresh
 * nonce and a claimed hash that is not its ShearHash.
 */
function forgeRuns(page, at, runs) {
  const out = [];
  for (let r = 0; r < runs; r += 1) {
    let prev = Buffer.from(page[at].hash, 'hex');
    for (let i = at + 1; i <= at + PRUNE && i < page.length; i += 1) {
      const d = decodeHeader(Buffer.from(page[i].header, 'hex'));
      const header = encodeHeader({ ...d, prevBlockHash: prev, nonce: randomBytes(8).readBigUInt64LE() });
      const hash = forgedHash();
      out.push({ header: header.toString('hex'), hash: hex(hash), height: page[i].height });
      prev = hash;
    }
  }
  return out;
}

/** Random bytes that link to `parent` with a sane timestamp, so only the header itself is bad. */
function garbageAbove(parent) {
  const buf = randomBytes(128);
  Buffer.from(parent.hash, 'hex').copy(buf, 4);
  buf.writeBigUInt64LE(decodeHeader(Buffer.from(parent.header, 'hex')).timestamp + BigInt(STEP), 100);
  return buf;
}

function pagesOf(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i += PAGE) out.push(rows.slice(i, i + PAGE));
  return out;
}

if (!MODE) {
  describe('v12 burial header offers', () => {
    const net = {};
    before(() => {
      net.dir = tmp('source');
      net.S = buildSource(net.dir);
      net.page = selectHeadersAfterLocator(net.S.blocks, { locator: [] });
      assert.equal(net.page.length, TIP);
      assert.equal(net.S.blocks[PRUNED - 1].samplesPruned, true);
      assert.notEqual(net.S.blocks[PRUNED].samplesPruned, true);
    });

    it('checks work cheaply before caching, drops a peer on a bad link, and bounds each peer', async () => {
      const { page, S } = net;
      const E = createStore(tmp('unit'), { fastSync: true });
      const bent = (i, edit) => {
        const d = decodeHeader(Buffer.from(page[i].header, 'hex'));
        return { ...page[i], header: encodeHeader({ ...d, ...edit }).toString('hex') };
      };
      const cases = [
        ['garbage', [page[0], { header: garbageAbove(page[0]).toString('hex'), hash: hex(forgedHash()) }]],
        ['claimed hash misses bits', [page[0], { ...page[1], hash: 'ff'.repeat(32) }]],
        ['bits off ASERT', [page[0], bent(1, { bits: decodeHeader(Buffer.from(page[1].header, 'hex')).bits + 65536 })]],
        ['timestamp not after parent', [page[0], bent(1, { timestamp: decodeHeader(Buffer.from(page[0].header, 'hex')).timestamp })]],
        ['same hash, other header', [page[0], page[1], { ...bent(1, { nonce: 7n }), hash: page[1].hash }]],
      ];
      for (const [name, rows] of cases) {
        const peer = `bad:${name}`;
        const got = E.offerHeaders(rows, { peer });
        assert.equal(got.dropped, true, name);
        assert.equal(E.offerPeerDropped(peer), true, name);
        assert.equal(E.offerHeaders(page, { peer }).accepted, 0, `${name}: refused after the drop`);
      }
      assert.equal(E.burialView().hashed, 0, 'no ShearHash at offer time');
      assert.equal(E.burialView().offered, 0, 'a dropped peer leaves none of its headers');

      const orphan = E.offerHeaders(page.slice(5, 50), { peer: 'gap' });
      assert.equal(orphan.dropped, false, 'an unknown parent is ignored, not a strike');
      assert.equal(orphan.accepted, 0);
      const t0 = Number(decodeHeader(Buffer.from(page[0].header, 'hex')).timestamp);
      const late = E.offerHeaders([page[0], page[1]], { peer: 'clock', nowMs: t0 });
      assert.equal(late.dropped, false, 'a header ahead of this clock is ignored');
      assert.equal(late.accepted, 1);

      // One peer's junk cannot push out another peer's run.
      assert.equal(E.offerHeaders(page, { peer: 'honest' }).accepted, TIP - 1);
      for (const rows of pagesOf(forgeRuns(page, 0, 6))) E.offerHeaders(rows, { peer: 'flood' });
      const view = E.burialView();
      assert.equal(view.offerPeerRows.flood, OFFER_PEER_CAP);
      assert.equal(view.offerPeerRows.honest, TIP);
      for (let i = 0; i < OFFER_PEER_SLOTS + 2; i += 1) E.offerHeaders(forgeRuns(page, 0, 1).slice(0, 10), { peer: `sybil${i}` });
      assert.ok(E.burialView().offerPeers <= OFFER_PEER_SLOTS);
      assert.equal(E.burialView().offerPeerRows.honest, TIP, 'small sybil buckets go before a full run');

      // The forged runs fail their first real hash, and the honest run proves.
      const trusted = new Set(page.map((r) => r.hash));
      const block = wire(S.servableBlock(S.blocks[0]));
      const got = await E.append(block, {
        trustedPowHash: Buffer.from(block.hash),
        skipSharePow: true,
        trustedHeaderHashes: trusted,
        nowMs: Date.now(),
      });
      assert.equal(got.ok, true, got.reason);
      const after = E.burialView();
      assert.ok(after.hashed <= OFFER_PEER_SLOTS + 1, `hashed ${after.hashed}`);
      assert.equal(after.offerPeerRows.flood, undefined, 'the flooding peer is dropped');
      assert.ok(after.droppedPeers.includes('flood'));
      assert.ok(after.offerPeers <= OFFER_PEER_SLOTS);
      assert.equal(after.offerPeerRows.honest > 0, true, 'a proven peer keeps its slot');
      assert.ok(after.provenHeaders >= PRUNE);

      const p2pSrc = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
      assert.match(p2pSrc, /store\.offerHeaders\(page, \{ peer: `p2p:/);
      assert.match(p2pSrc, /offered\?\.dropped[\s\S]{0,80}sock\.destroy\(\)/);
      const ipcSrc = fs.readFileSync(new URL('../src/p2p_ipc.js', import.meta.url), 'utf8');
      assert.match(ipcSrc, /offerHeaders\(msg\.headers \|\| \[\], \{ peer: 'ipc' \}\)/);
    });

    for (const [mode, { backend }] of Object.entries(MODES)) {
      it(`junk ratio x peers in ${mode} mode`, { timeout: 3_600_000 }, () => {
        const env = { ...process.env, BURIAL_OFFERS_MODE: mode, BURIAL_OFFERS_SOURCE: net.dir, SHEAR_HASH_BACKEND: backend };
        delete env.NODE_TEST_CONTEXT;
        const run = spawnSync(process.execPath, [self], {
          env,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        process.stderr.write(run.stdout || '');
        process.stderr.write(run.stderr || '');
        assert.equal(run.status, 0, `${mode} matrix failed`);
        assert.match(run.stderr || '', new RegExp(`"backend":"${backend}"`), `${mode} lanes ran ${backend}`);
      });
    }
  });
} else {
  describe(`v12 burial header offers, ${MODE}`, () => {
    const net = {};
    before(() => {
      net.S = createStore(SOURCE, { fastSync: true });
      assert.equal(net.S.tip().height, TIP);
      net.page = selectHeadersAfterLocator(net.S.blocks, { locator: [] });
      net.trusted = new Set(net.page.map((r) => r.hash));
      net.served = net.S.blocks.slice(0, PRUNED).map((b) => wire(net.S.servableBlock(b)));
      for (const b of net.served) assert.equal(b.samplesPruned, true);
    });

    for (const how of MODES[MODE].paths) {
      for (const ratio of RATIOS) {
        for (const peers of PEERS) {
          it(`${how}: junk ${ratio * 100}% with ${peers} honest peer(s)`, async () => {
            const { page, trusted, served } = net;
            const E = createStore(tmp('cell'), { fastSync: true });
            const honest = Array.from({ length: peers }, (_, i) => `honest${i}`);
            // Junk is `ratio` of the rows offered for each block, in full-length forged runs.
            const junkRows = Math.round((page.length * peers * ratio) / (1 - ratio));
            const runsPerBlock = junkRows ? Math.max(1, Math.round(junkRows / PRUNE)) : 0;
            let sybil = 0;
            let offeredJunk = 0;
            const perBlock = [];
            const attackersPerBlock = [];
            let maxOffered = 0;
            const t0 = performance.now();
            for (let b = 0; b < PRUNED; b += 1) {
              for (const p of honest) {
                for (const rows of pagesOf(page)) assert.equal(E.offerHeaders(rows, { peer: p }).dropped, false);
              }
              const attackers = runsPerBlock ? Array.from({ length: peers }, () => `junk${sybil++}`) : [];
              const runs = forgeRuns(page, b, runsPerBlock);
              attackers.forEach((a, i) => {
                const share = runs.filter((_, k) => Math.floor(k / PRUNE) % attackers.length === i);
                offeredJunk += share.length;
                for (const rows of pagesOf(share)) E.offerHeaders(rows, { peer: a });
              });
              const view = E.burialView();
              maxOffered = Math.max(maxOffered, view.offered);
              for (const n of Object.values(view.offerPeerRows)) assert.ok(n <= OFFER_PEER_CAP);
              assert.ok(view.offerPeers <= OFFER_PEER_SLOTS);
              const before = view.hashed;
              const got = await E.append(served[b], {
                trustedPowHash: Buffer.from(served[b].hash),
                skipSharePow: true,
                offLoopPow: how === 'offloop',
                trustedHeaderHashes: trusted,
                nowMs: Date.now(),
              });
              assert.equal(got.ok, true, `${got.reason} at ${b + 1}`);
              perBlock.push(E.burialView().hashed - before);
              attackersPerBlock.push(attackers.length);
            }
            const ms = performance.now() - t0;
            const end = E.burialView();
            assert.equal(E.tip().height, PRUNED);
            assert.equal(E.provenBurialTip(E.blocks[0]), 1 + PRUNE);
            // Each attacker costs at most one starting batch (2 off-loop, 1 sync)
            // before it is dropped; a proven run costs nothing after.
            const perAttacker = how === 'offloop' ? 2 : 1;
            perBlock.forEach((n, b) => assert.ok(n <= attackersPerBlock[b] * perAttacker, `block ${b + 1} hashed ${n}`));
            assert.deepEqual(perBlock.slice(1), [0, 0, 0], 'later blocks prefer the proven run');
            if (ratio === 0) assert.deepEqual(perBlock, [0, 0, 0, 0]);
            assert.ok(maxOffered <= OFFER_PEER_SLOTS * OFFER_PEER_CAP);
            if (perBlock[0] > 0) assert.ok(end.dropped >= 1, 'a hashed bad run drops its peer');
            const share = offeredJunk / (offeredJunk + page.length * peers * PRUNED);
            process.stderr.write(`${JSON.stringify({
              mode: MODE, path: how, ratio, peers, junkShare: Number(share.toFixed(3)), junkRows: offeredJunk,
              hashedPerBlock: perBlock, dropped: end.dropped, maxOffered, provenHeaders: end.provenHeaders, ms: Math.round(ms),
            })}\n`);
          });
        }
      }
    }
  });
}
