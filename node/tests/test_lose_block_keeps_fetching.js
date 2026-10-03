import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { jroot as jrootOf } from '../../crypto/admit.js';
import { encodeDest } from '../../crypto/address.js';
import {
  GENESIS_BITS_PACKED,
  MAGIC_TESTNET,
  TARGET_BLOCK_INTERVAL_MS,
  nextBits,
} from '../../crypto/asert.js';
import { decodeHeader, headerFromHex, setNonce } from '../../crypto/header.js';
import { pointFrom } from '../../crypto/note.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';
import { shouldAdopt } from '../src/chain.js';
import { createP2p, decodeWireBlock } from '../src/p2p.js';
import { createSoloStratum, soloMaySeal } from '../src/solo_stratum.js';
import { createStore } from '../src/store.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

// Same rewritten headers as test_p2p_wedge.js. Nonce 1014 is the fleet's
// height-1 block. lose-block-nonce.json is a different hit on that header
// whose hash is greater, so equal work keeps the fleet block.
const FLEET_HEADER_NONCE = [1014n, 5110n, 99739n];
const FLEET_SHARE_NONCE = [null, ['258'], ['515']];

function setHeaderBits(header, bits) {
  const h = Buffer.from(header);
  h.writeUInt32LE(bits >>> 0, 108);
  return h;
}

function setHeaderPrev(header, prevHash) {
  const h = Buffer.from(header);
  Buffer.from(prevHash).copy(h, 4, 0, 32);
  return h;
}

function admitPubsOf(block) {
  const pubs = [];
  for (const tx of block.txs || []) {
    for (const o of tx.vout || []) {
      if (!o?.admitPub) continue;
      try {
        pubs.push(typeof o.admitPub.toBytes === 'function' ? o.admitPub : pointFrom(o.admitPub));
      } catch { /* verify skips the same unreadable pub */ }
    }
  }
  return pubs;
}

function cloneBlock(block) {
  return {
    header: Buffer.from(block.header),
    hash: Buffer.from(block.hash),
    height: block.height,
    txs: block.txs,
    samples: block.samples || [],
    shareBatch: block.shareBatch || [],
    miner: block.miner,
    poolDest: block.poolDest,
    aLeaves: block.aLeaves,
    bLeaves: block.bLeaves,
    rootA: block.rootA,
    rootB: block.rootB,
    weight: block.weight,
  };
}

function legalFleet() {
  const childBits = nextBits(GENESIS_BITS_PACKED, TARGET_BLOCK_INTERVAL_MS);
  if (childBits !== GENESIS_BITS_PACKED) {
    throw new Error(`padded median would move genesis bits to ${childBits}`);
  }
  const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/p2p-wedge-blocks.json', import.meta.url), 'utf8'));
  const out = [];
  const pubs = [];
  for (let i = 0; i < FLEET_HEADER_NONCE.length; i += 1) {
    const block = cloneBlock(decodeWireBlock(raw.blocks[i]));
    let header = setHeaderBits(block.header, GENESIS_BITS_PACKED);
    if (i > 0) header = setHeaderPrev(header, out[i - 1].hash);
    header = setNonce(header, FLEET_HEADER_NONCE[i]);
    const hash = shearHash(header);
    if (!meetsTarget(hash, GENESIS_BITS_PACKED)) throw new Error(`fleet block ${i + 1} misses target`);
    block.header = header;
    block.hash = hash;
    const shareNonces = FLEET_SHARE_NONCE[i];
    if (shareNonces) {
      block.shareBatch = (block.shareBatch || []).map((row, j) => (
        shareNonces[j] == null ? row : { ...row, nonce: shareNonces[j] }
      ));
    }
    pubs.push(...admitPubsOf(block));
    const root = Buffer.from(jrootOf(pubs));
    block.txs = (block.txs || []).map((tx, idx) => (idx === 0 ? { ...tx, jroot: root } : tx));
    out.push(block);
  }
  return out;
}

function losingBlock(winner) {
  const found = JSON.parse(fs.readFileSync(new URL('./fixtures/lose-block-nonce.json', import.meta.url), 'utf8'));
  const header = setNonce(winner.header, BigInt(found.nonce));
  const hash = shearHash(header);
  const block = cloneBlock(winner);
  block.header = header;
  block.hash = hash;
  return block;
}

function tipHex(store) {
  const tip = store.tip();
  return tip?.hash ? Buffer.from(tip.hash).toString('hex') : '';
}

function blockHex(block) {
  return Buffer.from(block.hash).toString('hex');
}

function jobPrev(header) {
  return Buffer.from(decodeHeader(headerFromHex(header)).prevBlockHash).toString('hex');
}

function login(port, dest) {
  const sock = net.connect(port, '127.0.0.1');
  const lines = [];
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!raw) continue;
      try { lines.push(JSON.parse(raw)); } catch { /* ignore */ }
    }
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('login timeout')), 4000);
    sock.once('connect', () => {
      sock.write(`${JSON.stringify({
        method: 'login',
        id: 1,
        params: { login: `${dest}.solo`, threads: 2 },
      })}\n`);
    });
    sock.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    const wait = setInterval(() => {
      if (!lines.length) return;
      clearInterval(wait);
      clearTimeout(t);
      resolve({ sock, lines });
    }, 20);
  });
}

describe('solo block loses to the fleet', () => {
  it('a taller direct tip is not sealable when the sync height was clamped to local', () => {
    const peers = new Map([[1, {
      height: 5,
      hash: 'aa'.repeat(32),
      adHeight: 9,
      adHash: 'bb'.repeat(32),
    }]]);
    assert.equal(soloMaySeal({ height: 5, hash: 'aa'.repeat(32), peers }), false);
  });

  it('replay of an accepted chain does not ShearHash again', () => {
    const src = fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
    const body = src.split('function rebuildSpentB()')[1].split('function bounceMempool')[0];
    assert.match(body, /trustedPowHash/);
    assert.match(body, /skipSharePow:\s*true/);
    assert.doesNotMatch(body, /shearHash\(/);
  });

  it('after the losing block is discarded the node fetches the fleet tip and the miner gets that job', { timeout: 90_000 }, async () => {
    const fleet = legalFleet();
    const winner = fleet[0];
    const loser = losingBlock(winner);
    const loserHex = blockHex(loser);
    const winnerHex = blockHex(winner);
    assert.ok(meetsTarget(loser.hash, GENESIS_BITS_PACKED));
    assert.ok(loserHex > winnerHex, 'solo block must lose the equal-work tie');
    assert.equal(shouldAdopt([loser], [winner]), true);

    const dest = encodeDest(Buffer.alloc(20, 9));
    const local = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lose-local-')));
    const peer = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'shear-lose-peer-')));
    const localGot = local.append(cloneBlock(loser));
    assert.equal(localGot.ok, true, localGot.reason);
    const peerGot = peer.append(cloneBlock(winner));
    assert.equal(peerGot.ok, true, peerGot.reason);
    for (const block of fleet.slice(1)) {
      const got = peer.append(cloneBlock(block));
      assert.equal(got.ok, true, `${block.height} ${got.reason}`);
    }
    // Peer tip is two above the solo tip, so the winning parent has to be
    // fetched before the later fleet blocks.
    assert.equal(peer.tip().height, fleet.length);
    const fleetTip = tipHex(peer);
    assert.notEqual(fleetTip, loserHex);

    const localP2p = createP2p({ store: local, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const peerP2p = createP2p({ store: peer, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
    const stratum = createSoloStratum({
      store: local,
      port: 0,
      host: '127.0.0.1',
      restampMs: 200,
      peers: () => {
        if (localP2p.peers.size) return localP2p.peers;
        return new Map([['open', { height: local.tip().height, hash: tipHex(local) }]]);
      },
    });
    let sock;
    try {
      const peerBound = await peerP2p.listen();
      await localP2p.listen();
      const bound = await stratum.listen();
      const logged = await login(bound.port, dest);
      sock = logged.sock;
      const first = logged.lines.find((m) => m.job?.header || m.params?.header);
      const firstHeader = first?.job?.header || first?.params?.header;
      assert.ok(firstHeader, 'miner needs a job on the solo tip before the fleet block wins');
      assert.equal(jobPrev(firstHeader), loserHex);

      await localP2p.connect('127.0.0.1', peerBound.port);
      const deadline = Date.now() + 45_000;
      let nextHeader = '';
      while (Date.now() < deadline) {
        if (tipHex(local) === fleetTip) {
          const job = logged.lines.find((m) => {
            const header = m.job?.header || m.params?.header;
            return header && jobPrev(header) === fleetTip;
          });
          if (job) {
            nextHeader = job.job?.header || job.params?.header;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(tipHex(local), fleetTip, `tip stayed ${local.tip()?.height} ${tipHex(local)}`);
      assert.equal(local.blocks.some((b) => Buffer.from(b.hash).toString('hex') === loserHex), false);
      assert.ok(nextHeader, 'miner was left on the discarded tip');
      assert.equal(jobPrev(nextHeader), fleetTip);
    } finally {
      try { sock?.destroy(); } catch { /* ignore */ }
      stratum.close();
      localP2p.close();
      peerP2p.close();
    }
  });
});
