// Floor-share search for the pruned P2P e2e.
// jit-full is a process-global ShearHash VM. Loading it in the miner process
// makes later light-jit header lanes about 5x slower, so this file is spawned
// as its own process. Digests match light ShearHash. A worker thread is the
// same isolate and is not the e2e path.
import readline from 'node:readline';
import { parentPort, workerData } from 'node:worker_threads';
import { setHashBackend } from '../../crypto/shear_hash.js';
import { findShare } from '../../crypto/share_batch.js';

const LOW = (1n << 56n) - 1n;

function headerOf(raw) {
  if (typeof raw === 'string') return Buffer.from(raw, 'hex');
  return Buffer.from(raw);
}

function searchShares(msg, emit) {
  const header = headerOf(msg.header);
  let cursor = BigInt(msg.startNonce || 0);
  const count = Math.floor(Number(msg.count) || 0);
  const shares = [];
  for (let i = 0; i < count; i += 1) {
    const found = findShare(header, {
      dest: msg.dest,
      floorBits: 8,
      maxTries: 2_000_000,
      startNonce: cursor,
    });
    if (!found) {
      emit({ type: 'fail', id: msg.id, found: i, reason: 'share_search' });
      return;
    }
    shares.push({
      dest: msg.dest,
      dest20: Buffer.from(found.dest20).toString('hex'),
      nonce: found.nonce.toString(),
      lz: found.lz,
    });
    cursor = (BigInt(found.nonce) & LOW) + 1n;
    if ((i + 1) % 256 === 0) emit({ type: 'progress', id: msg.id, n: i + 1, count });
  }
  emit({ type: 'done', id: msg.id, shares });
}

if (parentPort) {
  setHashBackend(workerData?.backend || 'jit-full');
  parentPort.on('message', (msg) => {
    if (!msg || msg.type !== 'find') return;
    searchShares(msg, (out) => parentPort.postMessage(out));
  });
} else {
  setHashBackend('jit-full');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch {
      process.stdout.write(`${JSON.stringify({ type: 'fail', id: 0, reason: 'bad_job' })}\n`);
      return;
    }
    if (!msg || msg.type !== 'find') return;
    searchShares(msg, (out) => {
      process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
  rl.on('close', () => process.exit(0));
}
