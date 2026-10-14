// One jit-full lane. The parent owns the shared counters.
// Int32: 0 gen, 1 status, 2 done, 3 ready.
// BigUint64 at byte 16 is the winning nonce.
// Bytes 24..151 are the header. Bytes 152..183 are the digest.
import { parentPort, workerData } from 'node:worker_threads';
import { setNonce } from '../../crypto/header.js';
import { meetsTarget, setHashBackend, shearHash } from '../../crypto/shear_hash.js';

const sab = workerData.sab;
const i32 = new Int32Array(sab);
const nonce64 = new BigUint64Array(sab, 16, 1);
const bytes = new Uint8Array(sab);
const GEN = 0;
const STATUS = 1;
const DONE = 2;
const READY = 3;
const HEADER_AT = 24;
const HASH_AT = 152;

setHashBackend('jit-full');
Atomics.add(i32, READY, 1);
Atomics.notify(i32, READY, 1);

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'mine') return;
  const gen = msg.gen | 0;
  const lanes = msg.lanes | 0;
  const start = BigInt(msg.nonceStart);
  const limit = BigInt(msg.maxTries);
  const bits = msg.bits;
  const base = Buffer.from(msg.header);
  for (let i = 0n; i < limit; i += 1n) {
    if (Atomics.load(i32, GEN) !== gen) return;
    const n = start + i;
    const header = setNonce(base, n);
    const hash = Buffer.from(shearHash(header));
    if (!meetsTarget(hash, bits)) continue;
    if (Atomics.compareExchange(i32, GEN, gen, -gen) !== gen) return;
    nonce64[0] = n;
    bytes.set(header, HEADER_AT);
    bytes.set(hash, HASH_AT);
    Atomics.store(i32, STATUS, 1);
    Atomics.notify(i32, STATUS, 1);
    return;
  }
  if (Atomics.load(i32, GEN) !== gen) return;
  const done = Atomics.add(i32, DONE, 1) + 1;
  if (done === lanes) Atomics.compareExchange(i32, STATUS, 0, 2);
  Atomics.notify(i32, STATUS, 1);
});
