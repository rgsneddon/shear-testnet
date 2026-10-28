// A local v12 testnet seed for the wallet's Connect bare -> Run node test.
//
//   node test/fixtures/v12_seed_peer.mjs
//
// The v12 book has no live peers yet (V12_GENESIS_BLOCK_HASH is empty until
// the genesis cut), so a node started from an empty datadir has nothing to
// sync and writes no chain. This seed serves the three v12 wedge blocks
// (node/tests/fixtures/p2p-wedge-v12.json): every header nonce is a real
// ShearHash-v3 hit at GENESIS_BITS_PACKED and every share nonce a hit at its
// floor width, as test_p2p_wedge.js checks. Each block is appended to a fresh
// testnet store through the node's own append, so every consensus check runs.
// Then the node's own P2P listener serves them on loopback.
//
// Prints one JSON line: the P2P port and the tip. Serves until stdin closes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENESIS_BITS_PACKED, MAGIC_TESTNET } from '../../../crypto/asert.js';
import { decodeHeader, setNonce } from '../../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../../crypto/shear_hash.js';
import { createStore } from '../../../node/src/store.js';
import { createP2p, decodeWireBlock } from '../../../node/src/p2p.js';

try { setHashBackend('jit'); } catch { /* interpreter */ }

const fixture = JSON.parse(fs.readFileSync(
  new URL('../../../node/tests/fixtures/p2p-wedge-v12.json', import.meta.url),
  'utf8',
));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shear-v12-seed-'));
const store = createStore(dir);
fixture.blocks.forEach((raw, i) => {
  const block = decodeWireBlock(raw);
  const header = setNonce(Buffer.from(block.header), BigInt(fixture.headerNonces[i]));
  if (decodeHeader(header).bits !== GENESIS_BITS_PACKED) throw new Error(`block ${i + 1} bits`);
  const hash = shearHash(header);
  if (!meetsTarget(hash, GENESIS_BITS_PACKED)) throw new Error(`block ${i + 1} misses genesis bits`);
  const shareNonces = fixture.shareNonces[i];
  const got = store.append({
    header,
    hash,
    height: block.height,
    txs: block.txs,
    samples: block.samples || [],
    shareBatch: shareNonces
      ? (block.shareBatch || []).map((row, j) => (shareNonces[j] == null ? row : { ...row, nonce: shareNonces[j] }))
      : (block.shareBatch || []),
    hashCredits: block.hashCredits,
    hashSpill: block.hashSpill || [],
    miner: block.miner,
    poolDest: block.poolDest,
    aLeaves: block.aLeaves,
    bLeaves: block.bLeaves,
    rootA: block.rootA,
    rootB: block.rootB,
    weight: block.weight,
  });
  if (!got || got.ok !== true) throw new Error(`append h=${block.height} ${got?.reason || ''}`);
});

const p2p = createP2p({ store, port: 0, host: '127.0.0.1', magic: MAGIC_TESTNET });
const bound = await p2p.listen();
process.stdout.write(`${JSON.stringify({ port: bound.port, tip: store.tip().height })}\n`);
const stop = async () => {
  try { await p2p.close(); } catch { /* closing */ }
  try { store.close?.(); } catch { /* closing */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
