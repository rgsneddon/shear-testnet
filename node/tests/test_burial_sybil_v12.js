/**
 * PSA-pr74c-1 and the offer rate limit.
 *
 * Before an honest peer's first proof, sybils on many addresses try to evict
 * its cached headers. Header-offer slots are keyed by network group (IPv4
 * /24, IPv6 /64) for inbound and outbound peers. Outbound, pinned and local
 * callers have their own reserved pool that inbound peers cannot take, and an
 * outbound peer cannot evict a pinned one. A slot holding a header on the
 * best cached path above the tip is never evicted.
 *
 * 1 and 4 honest peers against 8, 32 and 256 sybils, in four layouts:
 * inbound sybils on distinct /24s against honest outbound peers; sybils on
 * one IPv6 /64; outbound sybils (addr-gossip dials) against pinned honest
 * peers; and inbound-only honest peers holding the proof path against
 * inbound sybils. Every sybil offers a full-length forged run that passes the
 * cheap check, then a second wave on fresh addresses churns the pool before
 * any block is proven.
 *
 * Inbound and outbound slots read at most OFFER_RATE_BURST rows at once,
 * refilled at OFFER_RATE_PER_SEC, so 1.6M junk rows cost one burst per slot.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newIdentity } from '../../crypto/address.js';
import { SAMPLE_PRUNE_CONFIRMATIONS, SHARE_FLOOR_BITS, TARGET_BLOCK_INTERVAL_MS } from '../../crypto/asert.js';
import { destForLogin } from '../../crypto/flow_sheet.js';
import { decodeHeader, encodeHeader } from '../../crypto/header.js';
import { decodeWireBlock, encodeWireBlock, offerTierOf, peerNetGroup, selectHeadersAfterLocator } from '../src/p2p.js';
import {
  createStore,
  OFFER_PEER_CAP,
  OFFER_PEER_SLOTS,
  OFFER_RATE_BURST,
  OFFER_RATE_PER_SEC,
} from '../src/store.js';

const PRUNE = SAMPLE_PRUNE_CONFIRMATIONS;
const STEP = TARGET_BLOCK_INTERVAL_MS;
const PRUNED = 4;
const TIP = PRUNE + PRUNED;
const HONEST = [1, 4];
const SYBILS = [8, 32, 256];

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `shear-sybil-${tag}-`));
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
    shareBatch: tpl.shareBatch || [],
    aLeaves: tpl.aLeaves,
    bLeaves: tpl.bLeaves,
    rootA: tpl.rootA,
    rootB: tpl.rootB,
    weight: tpl.weight,
  }, { trustedPowHash: easyPow(), skipSharePow: true });
}

function wire(block) {
  return decodeWireBlock(JSON.parse(JSON.stringify(encodeWireBlock(block))));
}

function forgedHash() {
  const h = randomBytes(32);
  h.fill(0, 0, 5);
  return h;
}

/** A full-length forged run above page[at] that passes the cheap check. */
function forgeRun(page, at) {
  const out = [];
  let prev = Buffer.from(page[at].hash, 'hex');
  for (let i = at + 1; i <= at + PRUNE && i < page.length; i += 1) {
    const d = decodeHeader(Buffer.from(page[i].header, 'hex'));
    const header = encodeHeader({ ...d, prevBlockHash: prev, nonce: randomBytes(8).readBigUInt64LE() });
    const hash = forgedHash();
    out.push({ header: header.toString('hex'), hash: hex(hash), height: page[i].height });
    prev = hash;
  }
  return out;
}

/** A p2p peer record the way p2p.js builds one, offered the way p2p.js offers. */
function peerRec(remote, { inbound = true, pinned = false } = {}) {
  return { remote, inbound, pinned: !inbound && pinned };
}

function offerAs(store, rec, rows, nowMs) {
  return store.offerHeaders(rows, {
    peer: `p2p:${rec.remote}`,
    tier: offerTierOf(rec),
    group: peerNetGroup(rec.remote),
    ...(nowMs != null ? { nowMs } : {}),
  });
}

const LAYOUTS = {
  'inbound sybils on distinct /24s vs outbound honest': {
    honest: (i) => peerRec(`203.0.${100 + i}.7`, { inbound: false }),
    sybil: (wave, i) => peerRec(`10.${wave}.${i}.1`),
    honestFirst: false,
  },
  'sybils on one IPv6 /64 vs inbound honest': {
    honest: (i) => peerRec(`198.51.${100 + i}.9`),
    sybil: (wave, i) => peerRec(`2001:db8:5:6:${wave.toString(16)}:${i.toString(16)}::1`),
    honestFirst: false,
  },
  'outbound sybils (addr gossip) vs pinned honest': {
    honest: (i) => peerRec(`192.0.2.${10 + i}`, { inbound: false, pinned: true }),
    sybil: (wave, i) => peerRec(`172.${16 + wave}.${i % 256}.3`, { inbound: false }),
    honestFirst: false,
  },
  'inbound honest holds the proof path vs inbound sybils': {
    honest: (i) => peerRec(`198.18.${i}.4`),
    sybil: (wave, i) => peerRec(`100.${64 + wave}.${i % 256}.5`),
    honestFirst: true,
    oneHonestKept: true,
  },
};

describe('v12 burial offers against sybils', () => {
  const net = {};
  before(() => {
    const id = newIdentity();
    const dest = destForLogin(id.address, { viewKey: id.viewKey, height: 1 });
    net.S = createStore(tmp('source'), { fastSync: true });
    for (let h = 1; h <= TIP; h += 1) {
      const got = sealNext(net.S, dest);
      assert.equal(got.ok, true, `${got.reason} at ${h}`);
    }
    net.page = selectHeadersAfterLocator(net.S.blocks, { locator: [] });
    net.trusted = new Set(net.page.map((r) => r.hash));
    net.served = net.S.blocks.slice(0, PRUNED).map((b) => wire(net.S.servableBlock(b)));
    for (const b of net.served) assert.equal(b.samplesPruned, true);
  });

  it('groups peers by /24 and /64 and names the offer tier', () => {
    assert.equal(peerNetGroup('10.1.2.3'), '10.1.2.0/24');
    assert.equal(peerNetGroup('::ffff:10.1.2.250'), '10.1.2.0/24');
    assert.equal(peerNetGroup('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(peerNetGroup('2001:db8:1:2::ffff'), '2001:db8:1:2::/64');
    assert.notEqual(peerNetGroup('2001:db8:1:3::1'), peerNetGroup('2001:db8:1:2::1'));
    assert.equal(offerTierOf({ inbound: true }), 'inbound');
    assert.equal(offerTierOf({ inbound: false }), 'outbound');
    assert.equal(offerTierOf({ inbound: false, pinned: true }), 'pinned');
    const src = fs.readFileSync(new URL('../src/p2p.js', import.meta.url), 'utf8');
    assert.match(src, /ensurePeer\(host, port, \{ pinned: true \}\)/, 'seeds are pinned');
    assert.match(src, /pinned: !inbound && extra\.pinned === true/);
    const rpc = fs.readFileSync(new URL('../src/rpc.js', import.meta.url), 'utf8');
    assert.match(rpc, /p2p\.connect\(hostP, portP, \{ pinned: true \}\)/, 'RPC connect is pinned');
  });

  for (const [layout, spec] of Object.entries(LAYOUTS)) {
    for (const honestN of HONEST) {
      for (const sybilN of SYBILS) {
        it(`${layout}: ${honestN} honest vs ${sybilN} sybils`, async () => {
          const { page, trusted, served } = net;
          const E = createStore(tmp('cell'), { fastSync: true });
          const honest = Array.from({ length: honestN }, (_, i) => spec.honest(i));
          const honestKeys = new Set();
          const keyOf = (rec) => {
            const tier = offerTierOf(rec);
            return tier === 'pinned' ? `p2p:${rec.remote}` : `${tier === 'inbound' ? 'in' : 'out'}:${peerNetGroup(rec.remote)}`;
          };
          for (const rec of honest) honestKeys.add(keyOf(rec));
          const t0 = performance.now();
          const runs = [];
          const wave = (w) => {
            for (let i = 0; i < sybilN; i += 1) {
              const rec = spec.sybil(w, i);
              const run = runs.length < 64 ? forgeRun(page, 0) : runs[i % runs.length];
              if (runs.length < 64) runs.push(run);
              offerAs(E, rec, [page[0], ...run]);
            }
          };
          const offerHonest = () => {
            for (const rec of honest) assert.equal(offerAs(E, rec, page).dropped, false);
          };
          if (spec.honestFirst) offerHonest();
          wave(1);
          if (!spec.honestFirst) offerHonest();
          const present = () => {
            const rows = E.burialView().offerPeerRows;
            return [...honestKeys].filter((k) => rows[k] > 0).length;
          };
          if (!spec.oneHonestKept) assert.equal(present(), honestKeys.size, 'every honest slot after the first wave');
          // A second wave on fresh addresses churns the pool before any proof.
          wave(2);
          wave(3);
          const view = E.burialView();
          if (spec.oneHonestKept) assert.ok(present() >= 1, 'the honest slot holding the proof path is kept');
          else assert.equal(present(), honestKeys.size, 'no honest slot is evicted before its first proof');
          const tiers = Object.values(view.offerSlotTiers);
          assert.ok(tiers.filter((t) => t === 'inbound').length <= OFFER_PEER_SLOTS);
          assert.ok(tiers.filter((t) => t !== 'inbound').length <= OFFER_PEER_SLOTS);
          for (const n of Object.values(view.offerPeerRows)) assert.ok(n <= OFFER_PEER_CAP);
          if (layout.startsWith('sybils on one IPv6')) {
            assert.equal(tiers.filter((t) => t === 'inbound').length, honestKeys.size + 1, 'one /64 is one slot');
          }
          const offerMs = performance.now() - t0;
          const hashed = [];
          for (let b = 0; b < PRUNED; b += 1) {
            const before = E.burialView().hashed;
            const got = await E.append(served[b], {
              trustedPowHash: Buffer.from(served[b].hash),
              skipSharePow: true,
              trustedHeaderHashes: trusted,
              nowMs: Date.now(),
            });
            assert.equal(got.ok, true, `${got.reason} at ${b + 1}`);
            hashed.push(E.burialView().hashed - before);
          }
          assert.equal(E.tip().height, PRUNED);
          assert.deepEqual(hashed.slice(1), [0, 0, 0], 'the proven run is preferred');
          assert.ok(hashed[0] <= OFFER_PEER_SLOTS, `block 1 hashed ${hashed[0]}`);
          const end = E.burialView();
          process.stderr.write(`${JSON.stringify({
            layout, honest: honestN, sybils: sybilN * 3, hashedPerBlock: hashed,
            slots: tiers.length, refused: end.refused, limited: end.limited, dropped: end.dropped,
            offered: view.offered, offerMs: Math.round(offerMs),
          })}\n`);
        });
      }
    }
  }

  it('a peer reads at most a burst of rows, refilled over time, and local callers are not limited', () => {
    const { page } = net;
    const E = createStore(tmp('rate'), { fastSync: true });
    const flood = [];
    const runs = Array.from({ length: 4 }, () => forgeRun(page, 0));
    for (let i = 0; i < 1600; i += 1) flood.push(...runs[i % runs.length].slice(0, 1000));
    assert.equal(flood.length, 1_600_000);
    const now = Date.now();
    const recs = Array.from({ length: 4 }, (_, i) => peerRec(`10.77.${i}.1`));
    offerAs(E, peerRec('10.88.0.1', { inbound: false }), page.slice(0, 1), now);
    const t0 = performance.now();
    let read = 0;
    let limited = 0;
    for (let i = 0; i < flood.length; i += 4000) {
      const got = offerAs(E, recs[(i / 4000) % 4], flood.slice(i, i + 4000), now);
      read += 4000 - got.limited;
      limited += got.limited;
    }
    const ms = performance.now() - t0;
    assert.ok(read <= 4 * OFFER_RATE_BURST, `read ${read}`);
    assert.equal(read + limited, flood.length);
    assert.ok(ms < 5000, `1.6M rows took ${Math.round(ms)} ms`);
    const later = offerAs(E, recs[0], flood.slice(0, 4000), now + 1000);
    assert.equal(4000 - later.limited, OFFER_RATE_PER_SEC, 'one second refills OFFER_RATE_PER_SEC rows');
    const local = E.offerHeaders(flood.slice(0, 8000), { peer: 'ipc', nowMs: now });
    assert.equal(local.limited, 0, 'IPC and local callers are not rate limited');
    process.stderr.write(`${JSON.stringify({ rateLimit: { rows: flood.length, read, limited, ms: Math.round(ms) } })}\n`);
  });
});
